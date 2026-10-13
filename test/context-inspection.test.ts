import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '../src/agent/context.js';
import { buildContextInspection, pinContextFile, excludeContextFile } from '../src/context/inspection.js';
import { ContextInspector } from '../src/app/contextInspector.js';
import { MockProvider } from '../src/provider/mock.js';
import { estimateTokensFromMessages, type CompletionRequest, type Provider, type ProviderEvent } from '../src/provider/provider.js';
import { makeRepositoryContextTool } from '../src/tools/repositoryContext.js';
import type { ToolContext } from '../src/tools/types.js';
import { isolateHome } from './helpers/isolateHome.js';
import { removeFixtureTree } from './helpers/removeFixtureTree.js';

const isolated = isolateHome('context-inspection');
const { AgentLoop } = await import('../src/agent/loop.js');
const { Budget } = await import('../src/agent/budget.js');
const { EventBus } = await import('../src/agent/events.js');
const { ToolRegistry } = await import('../src/tools/registry.js');
const { AutoApproveGate } = await import('../src/agent/approval.js');
const { hydrateContext, serializeContext } = await import('../src/state/snapshot.js');
after(async () => { await removeFixtureTree(isolated.home); });

const opts = { contextBudget: 100_000, triggerRatio: .8, keepLastTurns: 2 };
function context() { const ctx = new Context(opts); ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'Inspect the fixture.' }] }); return ctx; }
const source = { id: 'note:contract', label: 'Pinned contract', origin: 'user note', kind: 'note' as const, content: 'PINNED_EXACT_SENTINEL\nKeep the transport compatible.' };

test('pins remain verbatim across successful and failed compaction, overflow, snapshot hydration, and reset', async () => {
  const ctx = context(); ctx.pinSource(source);
  for (let i = 0; i < 12; i++) ctx.append({ role: i % 2 ? 'user' : 'assistant', content: [{ type: 'text', text: `filler ${i}` }] });
  const originalPin = structuredClone(ctx.requestMessages()[0]);
  assert.equal(await ctx.maybeSummarize(new MockProvider([[{ type: 'text', delta: 'NEXT STEP — inspect the fixture.' }]]), 'mock', true), 'summarized');
  assert.deepEqual(ctx.requestMessages()[0], originalPin);
  assert.ok(!JSON.stringify(ctx.messages()).includes('PINNED_EXACT_SENTINEL'), 'pins do not become lossy summary or harvested instructions');
  ctx.append({ role: 'assistant', content: [{ type: 'tool_use', id: 'old', name: 'read_file', input: { path: 'old.ts' } }] });
  ctx.append({ role: 'user', content: [{ type: 'tool_result', toolCallId: 'old', ok: true, content: 'X'.repeat(50_000) }] });
  for (let i = 0; i < 10; i++) ctx.append({ role: 'assistant', content: [{ type: 'text', text: `tail ${i}` }] });
  ctx.setBudget(100);
  ctx.microcompact(new MockProvider());
  await ctx.maybeSummarize(new MockProvider(), 'mock', true);
  ctx.shrinkForOverflow();
  assert.deepEqual(ctx.requestMessages()[0], originalPin, 'emergency recovery never silently truncates pins');
  const restored = hydrateContext(serializeContext(ctx), opts);
  assert.deepEqual(restored.requestMessages()[0], originalPin);
  restored.reset();
  assert.deepEqual(restored.sources(), []);
  assert.deepEqual(restored.requestMessages(), []);
});

test('exclusions change the next provider request but preserve transcript/tool pairs and are restorable', async () => {
  const ctx = context(); ctx.pinSource(source);
  ctx.append({ role: 'assistant', content: [{ type: 'tool_use', id: 'read-1', name: 'read_file', input: { path: 'before.ts' } }] });
  ctx.append({ role: 'user', content: [{ type: 'tool_result', toolCallId: 'read-1', ok: true, content: 'Historical bytes stay in history.' }] });
  const history = structuredClone(ctx.messages());
  const sent: CompletionRequest[] = [];
  const provider: Provider = { name: 'mock', estimateTokens: estimateTokensFromMessages,
    async *send(request): AsyncIterable<ProviderEvent> { sent.push(structuredClone(request)); yield { type: 'text', delta: 'Finished.' }; yield { type: 'done', stopReason: 'end_turn' }; } };
  const registry = new ToolRegistry();
  const run = async () => new AgentLoop({ provider, context: ctx, registry, gate: new AutoApproveGate(), bus: new EventBus(),
    budget: new Budget({ maxIterations: 4 }, 'mock', {}, Date.now()), signal: new AbortController().signal,
    model: 'mock', system: 'Fixture runtime system.', workspaceRoot: isolated.home, maxOutputTokens: 1024,
    dryRun: false, maxToolResultChars: 16384, contextBudget: 100_000 }, 'full').run();
  await run();
  assert.match(JSON.stringify(sent[0]!.messages), /PINNED_EXACT_SENTINEL/);
  ctx.excludeSource(source.id);
  await run();
  assert.doesNotMatch(JSON.stringify(sent[1]!.messages), /PINNED_EXACT_SENTINEL/);
  assert.deepEqual(ctx.messages().slice(0, history.length), history, 'conversation including paired tool result unchanged');
  assert.ok(sent[1]!.messages.some((message) => message.content.some((block) => block.type === 'tool_result' && block.toolCallId === 'read-1')));
  const restored = hydrateContext(serializeContext(ctx), opts);
  assert.ok(restored.isSourceExcluded('note:contract'));
  assert.doesNotMatch(JSON.stringify(restored.requestMessages()), /PINNED_EXACT_SENTINEL/);
  restored.removeSource('note:contract'); assert.equal(restored.isSourceExcluded('note:contract'), false);
});

test('inspector measures the actual next request inputs, distinguishes prior usage, and attributes tool history', async () => {
  const ctx = context(); ctx.pinSource(source); ctx.recordActualTokens(777);
  ctx.append({ role: 'assistant', content: [{ type: 'tool_use', id: 'call-a', name: 'read_file', input: { path: 'src/example.ts' } }] });
  ctx.append({ role: 'user', content: [{ type: 'tool_result', toolCallId: 'call-a', ok: true, content: 'READ_RESULT_SENTINEL' }] });
  const provider = new MockProvider();
  const system = 'Instructions source. Actual system.';
  const tools = [{ name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } }];
  const inspection = buildContextInspection({ context: ctx, provider, model: 'fixture', system, tools,
    origins: [{ label: 'Project instructions', origin: '/project/AGENTS.md', content: 'Instructions source.' }, { label: 'Not actually included', origin: 'other', content: 'ABSENT' }] });
  assert.equal(inspection.estimatedTokens, provider.estimateTokens(ctx.requestMessages()) + Math.ceil(system.length / 4) + Math.ceil(JSON.stringify(tools).length / 4));
  assert.equal(inspection.lastActualTokens, 777, 'measured usage is not attributed to current categories');
  assert.equal(inspection.messageCount, ctx.requestMessages().length);
  assert.match(inspection.entries[0]!.origin, /AGENTS\.md/); assert.doesNotMatch(inspection.entries[0]!.origin, /Not actually included/);
  const output = inspection.entries.find((entry) => entry.preview === 'READ_RESULT_SENTINEL')!;
  assert.match(output.origin, /read_file · src\/example\.ts/); assert.equal(output.mutable, false);
  assert.match(inspection.compaction.description, /never silently removed/);
  assert.match(inspection.notices.join(' '), /No remote token-count request/);
});

test('captured request inspection shows dynamic system/schema inputs and stays historical after source controls change', () => {
  const ctx = context(); ctx.pinSource(source);
  const provider = new MockProvider();
  const exactMessages = structuredClone(ctx.requestMessages());
  const metadata = { system: 'DYNAMIC_TODO_AND_MISSION_STATE', tools: [{ name: 'filtered_tool', description: 'Selected for this turn.', parameters: {} }],
    messages: exactMessages, model: 'captured-model', provider: 'mock' };
  ctx.captureRequestMetadata(metadata); ctx.recordActualTokens(900);
  metadata.system = 'MUTATED_CALLER_VALUE'; metadata.messages.length = 0;
  ctx.excludeSource(source.id);
  ctx.append({ role: 'user', content: [{ type: 'text', text: 'AFTER_CAPTURE_SENTINEL' }] });
  const inspection = buildContextInspection({ context: ctx, provider, model: 'fallback', system: 'INCOMPLETE_APP_SYSTEM', tools: [] });
  assert.equal(inspection.basis, 'prepared-request'); assert.ok(inspection.preparedAt);
  assert.equal(inspection.model, 'captured-model'); assert.equal(inspection.lastActualTokens, 900);
  assert.equal(inspection.entries[0]!.preview, 'DYNAMIC_TODO_AND_MISSION_STATE');
  assert.match(inspection.entries[1]!.preview, /filtered_tool/);
  assert.doesNotMatch(inspection.entries.filter((entry) => entry.kind === 'history').map((entry) => entry.preview).join('\n'), /AFTER_CAPTURE_SENTINEL/);
  assert.match(inspection.notices.join(' '), /historical/);
  const control = inspection.entries.find((entry) => entry.kind === 'source')!;
  assert.equal(control.state, 'excluded'); assert.match(control.reason, /not a category of the historical totals/);
  assert.doesNotMatch(JSON.stringify(ctx.requestMessages()), /PINNED_EXACT_SENTINEL/);
  assert.match(JSON.stringify(ctx.preparedRequestMetadata()!.messages), /PINNED_EXACT_SENTINEL/);
  const altered = ctx.preparedRequestMetadata()!; altered.system = 'MODIFIED_BY_VIEW';
  assert.equal(ctx.preparedRequestMetadata()!.system, 'DYNAMIC_TODO_AND_MISSION_STATE');
  assert.equal((serializeContext(ctx) as unknown as Record<string, unknown>).preparedRequest, undefined, 'request capture is memory-only');
});

test('excluded sources cannot reappear via ranked retrieval, map, range, instructions or navigation; file aliases obey exclusion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-context-controls-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root }); mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/a.ts'), 'export const confidentialContract = "EXCLUDED_PAYLOAD_SENTINEL";');
    writeFileSync(join(root, 'src/b.ts'), 'const publicContract = confidentialContract;');
    writeFileSync(join(root, 'AGENTS.md'), 'EXCLUDED_INSTRUCTIONS_SENTINEL');
    const ctx = context(); pinContextFile(ctx, root, 'src/a.ts'); excludeContextFile(ctx, root, 'src/a.ts'); excludeContextFile(ctx, root, 'AGENTS.md');
    const tool = makeRepositoryContextTool({ enabled: false }, { isPathExcluded: (path) => ctx.isSourceExcluded(path) });
    const run = (input: Parameters<typeof tool.run>[0]) => tool.run(input, { workspaceRoot: root } as ToolContext);
    for (const input of [{ action: 'context' as const, query: 'confidentialContract' }, { action: 'map' as const }, { action: 'instructions' as const },
      { action: 'definition' as const, path: 'src/b.ts', line: 1, col: 29 }, { action: 'references' as const, path: 'src/b.ts', line: 1, col: 29 }]) {
      const result = await run(input); assert.equal(result.ok, true, JSON.stringify(result.error));
      assert.doesNotMatch(JSON.stringify(result.data), /EXCLUDED_PAYLOAD_SENTINEL|EXCLUDED_INSTRUCTIONS_SENTINEL|src\/a\.ts/);
    }
    const blocked = await run({ action: 'range', path: 'src/a.ts' }); assert.equal(blocked.error?.code, 'context_excluded');
    if (process.platform !== 'win32') {
      symlinkSync(join(root, 'src/a.ts'), join(root, 'src/alias.ts'));
      assert.equal((await run({ action: 'range', path: 'src/alias.ts' })).error?.code, 'context_excluded');
    }
    const sourceId = ctx.sources().find((item) => item.label === join('src', 'a.ts'))!.id;
    ctx.removeSource(sourceId);
    assert.match(JSON.stringify((await run({ action: 'context', query: 'confidentialContract' })).data), /EXCLUDED_PAYLOAD_SENTINEL/);
    assert.throws(() => pinContextFile(ctx, root, '../outside.txt'), /outside the workspace/);
    assert.throws(() => excludeContextFile(ctx, root, 'src'), /directory exclusions are not supported/);
  } finally { await removeFixtureTree(root); }
});

test('inspector UI exposes read-only history honestly, scopes actions, and handles failure without claiming success', async () => {
  const ctx = context(); ctx.pinSource(source);
  let closed = false;
  const actions: string[] = [];
  const view = new ContextInspector({ snapshot: () => buildContextInspection({ context: ctx, provider: new MockProvider(), model: 'fixture', system: 'sys', tools: [] }),
    rows: () => 30, repaint: () => {}, close: () => { closed = true; }, action: (entry, action) => { actions.push(`${entry.id}:${action}`); if (action === 'exclude') ctx.excludeSource(entry.source!.id); else throw new Error('Fixture read failed.'); } });
  assert.match(view.render(130).join('\n'), /Provisional next-request draft:.*estimate/);
  view.handleInput('x'); assert.deepEqual(actions, [], 'essential instructions cannot be excluded');
  view.handleInput('\x1b[B'); view.handleInput('\x1b[B'); view.handleInput('x');
  await new Promise((done) => setImmediate(done));
  assert.equal(ctx.sources()[0]!.state, 'excluded');
  view.handleInput('p'); await new Promise((done) => setImmediate(done));
  assert.match(view.render(130).join('\n'), /Fixture read failed/);
  view.handleInput('\r'); assert.match(view.render(130).join('\n'), /Origin:/);
  view.handleInput('\x1b'); assert.equal(closed, false); view.handleInput('\x1b'); assert.equal(closed, true);
});
