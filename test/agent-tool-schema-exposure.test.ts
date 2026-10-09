import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CompletionRequest, Provider, ProviderEvent } from '../src/provider/provider.js';
import type { LoopDeps } from '../src/agent/loop.js';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

const isolated = isolateHome('agent-schema-exposure');
const { GLOBAL_DIR } = await import('../src/state/globalStore.js');
assertStoreIsolated(GLOBAL_DIR, isolated.home);
const { makeAgentTool } = await import('../src/tools/agentTool.js');
const { makeRepositoryContextTool, registerBuiltinTools } = await import('../src/tools/index.js');
const { ToolRegistry } = await import('../src/tools/registry.js');
const { Context } = await import('../src/agent/context.js');
const { Budget } = await import('../src/agent/budget.js');
const { EventBus } = await import('../src/agent/events.js');
const { AutoApproveGate } = await import('../src/agent/approval.js');
after(() => rmSync(isolated.home, { recursive: true, force: true }));

for (const mode of ['reviewer', 'explore', 'consultation'] as const) {
  test(`${mode} exposes explicitly allowed deferred repository schemas without widening its tool scope`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'shadow-agent-schema-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, 'fixture.ts'), 'export const fixture = true;\n');
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    const repository = { ...makeRepositoryContextTool(), deferred: true };
    registry.register(repository);
    const requests: CompletionRequest[] = [];
    const provider: Provider = {
      name: 'fixture', estimateTokens: () => 20,
      async *send(request): AsyncIterable<ProviderEvent> {
        requests.push(request);
        if (requests.length === 1) {
          yield { type: 'tool_call', call: { id: 'repo-fixture', name: 'repository_context', input: { action: 'range', path: 'fixture.ts', startLine: 1, endLine: 1 } } };
          yield { type: 'done', stopReason: 'tool_use' };
        } else {
          yield { type: 'text', delta: 'Inspected the source fixture.' };
          yield { type: 'done', stopReason: 'end_turn' };
        }
      },
    };
    const policy = { contextBudget: 32768, triggerRatio: .8, keepLastTurns: 4 };
    const bus = new EventBus();
    let repositorySucceeded = false;
    bus.on((event) => { if (event.type === 'tool_end' && event.call.name === 'repository_context') repositorySucceeded = event.result.ok; });
    const makeLoopDeps = (): LoopDeps => ({
      provider, registry, gate: new AutoApproveGate(), bus, budget: new Budget({ maxIterations: 4 }, 'fixture', {}, Date.now()),
      context: new Context(policy), signal: new AbortController().signal, model: 'fixture', system: 'Controlled fixture.',
      maxOutputTokens: 256, workspaceRoot: root, dryRun: false, maxToolResultChars: 8000, contextBudget: policy.contextBudget,
    });
    const tool = makeAgentTool({ makeLoopDeps, getAutonomy: () => 'auto-read', ...policy, maxIterations: 4, priceTable: {},
      getConsultation: mode === 'consultation' ? () => ({ context: new Context(policy) }) : undefined });
    const result = await tool.run({ prompt: 'Read the fixture through repository context.',
      subagent_type: mode === 'consultation' ? 'general-purpose' : mode,
      consultation_id: mode === 'consultation' ? 'fixture-consultation' : undefined,
    }, { workspaceRoot: root, signal: new AbortController().signal, log: () => {}, dryRun: false });
    assert.equal(result.ok, true);
    assert.equal(requests.length, 2, 'the allowed repository tool executes and the model receives its result');
    for (const request of requests) {
      assert.deepEqual(request.tools.map((schema) => schema.name).sort(), ['glob', 'grep', 'read_file', 'repository_context']);
      assert.equal(request.tools.some((schema) => ['run_shell', 'write_file', 'tool_search'].includes(schema.name)), false);
    }
    assert.equal(repositorySucceeded, true, 'source navigation is executable as well as advertised');
    assert.equal(registry.get('repository_context'), repository, 'the role keeps a clone rather than mutating the lead tool');
    assert.equal(repository.deferred, true);
    assert.equal(registry.toSchemas().some((schema) => schema.name === 'repository_context'), false, 'lead discovery remains deferred');
  });
}
