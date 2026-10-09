import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';
import type { CompletionRequest, Provider, ProviderEvent } from '../src/provider/provider.js';
import type { LoopDeps } from '../src/agent/loop.js';

const isolated = isolateHome('role-profiles');
process.env.SHADOW_ALLOW_IMPORT = '0';
const store = await import('../src/state/globalStore.js');
assertStoreIsolated(store.GLOBAL_DIR, isolated.home);
const { loadConfig } = await import('../src/config.js');
const { ModelProfileResolver, findRoleProfile } = await import('../src/agent/modelProfiles.js');
const { ConsultationService, parseReviewFindings } = await import('../src/agent/consultation.js');
const { makeAgentTool } = await import('../src/tools/agentTool.js');
const { Context } = await import('../src/agent/context.js');
const { Budget } = await import('../src/agent/budget.js');
const { EventBus } = await import('../src/agent/events.js');
const { WorkCenter } = await import('../src/app/workCenter.js');
const { ScriptedApprovalGate } = await import('../src/agent/approval.js');
const { ToolRegistry } = await import('../src/tools/registry.js');
const { registerBuiltinTools } = await import('../src/tools/index.js');
const { SessionLog } = await import('../src/state/session.js');
const { setEgressResolverForTests, closeAgentsForTests, flushEgressLogForTests } = await import('../src/safety/egress.js');
const { serializeAgentDef, resolveAgentDef } = await import('../src/agent/defs.js');
after(async () => { await flushEgressLogForTests(); await closeAgentsForTests(); rmSync(isolated.home, { recursive: true, force: true }); });

function workspace(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'shadow-consult-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('full profile resolution changes actual adapter, endpoint and credential without changing lead policy', async (t) => {
  const root = workspace(t);
  const cfg = loadConfig(root, { provider: 'mock', model: 'lead' });
  cfg.contextBudget = 40_000;
  cfg.effort = 'high';
  cfg.models = [{ label: 'Reviewer', provider: 'anthropic', model: 'claude-fixture', baseUrl: 'https://reviewer.example.test',
    apiKey: 'fixture-reviewer-credential', contextWindow: 12_000, capabilities: { effortScale: ['high'], maxOutputTokens: 2048 } }];
  const lead: Provider = { name: 'mock', async *send() { yield* []; throw new Error('lead must not run'); }, estimateTokens: () => 1 };
  const resolver = new ModelProfileResolver({ cfg, current: () => ({ provider: lead, model: 'lead' }) });
  const result = await resolver.resolve('Reviewer');
  assert.equal(result.client.name, 'anthropic');
  assert.equal(result.model, 'claude-fixture');
  assert.equal(result.maxOutputTokens, 2048);
  assert.ok(result.policy.contextBudget < cfg.contextBudget);
  assert.equal(cfg.contextBudget, 40_000, 'role resolution leaves lead policy untouched');
  assert.match(result.fingerprint!, /^profile-v1:[a-f0-9]{64}$/);
  cfg.models[0]!.apiKey = 'different-credential';
  assert.equal((await resolver.resolve('Reviewer')).fingerprint, result.fingerprint, 'auth rotation is excluded from persisted comparison identity');
  cfg.models[0]!.apiKey = 'fixture-reviewer-credential';
  cfg.budget.maxTotalTokens = 500;
  assert.notEqual((await resolver.resolve('Reviewer')).fingerprint, result.fingerprint, 'changing execution caps versions comparable observations');
  const previousFetch = globalThis.fetch;
  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  setEgressResolverForTests(async () => ['203.0.113.12']);
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    const frames = [
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reviewed' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ];
    return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''),
      { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  try {
    const events: ProviderEvent[] = [];
    for await (const event of result.client.send({ model: result.model, system: 'Review fixture', tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'Review fixture' }] }], maxOutputTokens: result.maxOutputTokens, signal: new AbortController().signal })) events.push(event);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, 'https://reviewer.example.test/v1/messages');
    assert.equal(requests[0]!.headers.get('x-api-key'), 'fixture-reviewer-credential');
    assert.equal(requests[0]!.body.model, 'claude-fixture');
    assert.ok(events.some((event) => event.type === 'text' && event.delta === 'Reviewed'));
  } finally { globalThis.fetch = previousFetch; setEgressResolverForTests(null); }
  await assert.rejects(resolver.resolve('Reviewer', { effort: 'low' }), /supports effort high/);
  await assert.rejects(resolver.resolve('Reviewer', { signal: AbortSignal.abort() }), /abort/i);
});

test('profile lookup rejects ambiguity/disabled presets and role frontmatter keeps full profile and effort', async (t) => {
  const root = workspace(t);
  assert.throws(() => findRoleProfile([{ label: 'One', provider: 'openai', model: 'same' }, { label: 'Two', provider: 'openai', model: 'same' }], 'same'), /ambiguous/);
  assert.throws(() => findRoleProfile([{ label: 'Off', provider: 'mock', model: 'mock', disabled: true }], 'Off'), /disabled/);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(root, '.shadow', 'agents'), { recursive: true });
  writeFileSync(join(root, '.shadow', 'agents', 'independent.md'), serializeAgentDef({
    name: 'independent', description: 'Review', tools: ['read_file'], profile: 'Remote reviewer', effort: 'medium', systemPrompt: 'Read the fixture.',
  }));
  const def = resolveAgentDef('independent', root);
  assert.equal(def?.profile, 'Remote reviewer');
  assert.equal(def?.effort, 'medium');
});

function fixture(root: string, selected: Provider) {
  const cfg = loadConfig(root, { provider: 'mock', model: 'lead' });
  cfg.models = [{ label: 'Review', provider: 'mock', model: 'review-wire' }];
  cfg.priceTable = { 'review-wire': { input: 1, output: 1 } };
  cfg.budget.maxTotalTokens = 200;
  const lead: Provider = { name: 'mock', async *send() { yield* []; throw new Error('lead must not run'); }, estimateTokens: () => 1 };
  const bus = new EventBus();
  const work = new WorkCenter();
  work.subscribe(bus);
  const registry = new ToolRegistry();
  registerBuiltinTools(registry);
  const gate = new ScriptedApprovalGate([], 'deny');
  let log = SessionLog.open(root);
  const leadContext = new Context({ contextBudget: 40_000, triggerRatio: 0.8, keepLastTurns: 4 });
  log.bindSessionState(leadContext, () => ({ version: 1, mission: { active: false, mission: '', phase: 'planning', tasks: [], updatedAt: '' }, plan: { mode: 'implement' }, todos: [] }));
  const profiles = new ModelProfileResolver({ cfg, current: () => ({ provider: lead, model: 'lead' }) });
  profiles.resolve = async () => ({ profile: 'Review', provider: 'mock', model: 'review-wire', client: selected, policy: { contextBudget: 40_000, triggerRatio: 0.8, keepLastTurns: 4 }, maxOutputTokens: 1000, effort: 'medium' });
  let service: InstanceType<typeof ConsultationService>;
  const base = (): LoopDeps => ({ provider: lead, registry, gate, bus, budget: new Budget({ maxIterations: 10 }, 'lead', {}, Date.now()), context: leadContext,
    signal: new AbortController().signal, model: 'lead', system: 'Fixture', maxOutputTokens: 2000, workspaceRoot: root, dryRun: false, maxToolResultChars: 16000, contextBudget: 40_000, sessionLog: log });
  const agent = makeAgentTool({ makeLoopDeps: base, getAutonomy: () => 'full', contextBudget: 40_000, triggerRatio: 0.8, keepLastTurns: 4, maxIterations: 10, priceTable: cfg.priceTable,
    resolveProfile: (reference, options) => profiles.resolve(reference, options), getConsultation: (id) => service.continuation(id) });
  const create = () => new ConsultationService({ cfg, profiles, agent: () => agent, workspaceRoot: root, sessionLog: () => log });
  service = create();
  return { get service() { return service; }, reload: () => { service = create(); return service; }, setLog: (next: typeof log) => { log = next; }, cfg,
    get log() { return log; }, gate, work, leadContext, bus };
}

test('consultation uses the selected native runner, preserves follow-up/restart context, and rolls up budgets', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'fixture.txt'), 'evidence');
  const requests: CompletionRequest[] = [];
  const selected: Provider = { name: 'mock', estimateTokens: () => 1, async *send(request) {
    requests.push(request);
    assert.equal(request.model, 'review-wire');
    assert.equal(request.maxOutputTokens, 1000);
    assert.equal(request.effort, 'medium');
    assert.ok(request.tools?.every((tool) => ['read_file', 'grep', 'glob'].includes(tool.name)));
    if (requests.length === 1) {
      yield { type: 'usage', inputTokens: 5, outputTokens: 2 };
      yield { type: 'tool_call', call: { id: 'read-1', name: 'read_file', input: { path: 'fixture.txt' } } };
      yield { type: 'done', stopReason: 'tool_use' };
    } else {
      yield { type: 'usage', inputTokens: 3, outputTokens: 1 };
      yield { type: 'text', delta: requests.length === 2 ? 'First findings' : 'Follow-up findings' };
      yield { type: 'done', stopReason: 'end_turn' };
    }
  } };
  const harness = fixture(root, selected);
  t.after(() => harness.log.close());
  const parent = new Budget({ maxIterations: 10, maxTotalTokens: 100 }, 'lead', {}, Date.now());
  const runtime = { signal: new AbortController().signal, gate: harness.gate, parentBudget: parent };
  const first = await harness.service.start({ profile: 'Review', prompt: 'Inspect fixture' }, runtime);
  assert.equal(first.status, 'completed');
  assert.equal(first.answer, 'First findings');
  assert.equal(parent.totalInputTokens + parent.totalOutputTokens, 11);
  assert.equal(harness.leadContext.messages().length, 0, 'consultation remains outside the lead conversation');
  assert.equal(harness.work.get(first.taskId!)?.model, 'review-wire');
  const restored = harness.reload();
  assert.equal(restored.list()[0]?.id, first.id);
  const next = await restored.followUp(first.id, 'Explain the evidence', runtime);
  assert.equal(next.answer, 'Follow-up findings');
  assert.equal(next.turns, 2);
  assert.equal(parent.totalInputTokens + parent.totalOutputTokens, 15);
  assert.equal(next.usage.inputTokens + next.usage.outputTokens, 15);
  assert.ok(JSON.stringify(requests.at(-1)!.messages).includes('First findings'));
  assert.equal(next.verification, 'unverified');
  assert.equal(next.usage.costKnown, true);
  assert.equal(harness.work.list().filter((item) => item.type === 'subagent').length, 2);
});

test('prepared consultation retries use the restored conversation and append a linked native attempt', async (t) => {
  const root = workspace(t);
  const { JobStore } = await import('../src/state/jobStore.js');
  const requests: CompletionRequest[] = [];
  const selected: Provider = { name: 'mock', estimateTokens: () => 1, async *send(request) {
    requests.push(request); yield { type: 'usage', inputTokens: 2, outputTokens: 1 };
    yield { type: 'text', delta: requests.length === 1 ? 'Initial evidence' : 'Retry evidence' };
    yield { type: 'done', stopReason: 'end_turn' };
  } };
  const harness = fixture(root, selected);
  t.after(() => harness.log.close());
  const runtime = { signal: new AbortController().signal, gate: harness.gate };
  const first = await harness.service.start({ profile: 'Review', prompt: 'Inspect' }, runtime);
  const jobs = new JobStore(root);
  try {
    const initial = jobs.findByAttempt(first.taskId!)!;
    const prepared = jobs.prepareRetry(initial.id, 'Explain the evidence');
    const result = await harness.reload().followUp(first.id, prepared.input.prompt, { ...runtime, jobId: initial.id });
    assert.equal(result.status, 'completed');
    assert.equal(jobs.list().length, 1, 'explicit retry preserves the original durable job');
    assert.equal(jobs.get(initial.id)?.attempts.length, 2);
    assert.equal(jobs.get(initial.id)?.attempts[1]?.retryOf, first.taskId);
    assert.match(JSON.stringify(requests[1]!.messages), /Initial evidence/);
  } finally { jobs.close(); }
});

test('consultation cannot expose write tools even with full session autonomy', async (t) => {
  const root = workspace(t);
  let calls = 0;
  const selected: Provider = { name: 'mock', estimateTokens: () => 1, async *send(request) {
    assert.ok(!request.tools?.some((tool) => ['write_file', 'agent', 'run_shell', 'memory'].includes(tool.name)));
    if (calls++ === 0) { yield { type: 'tool_call', call: { id: 'write-attempt', name: 'write_file', input: { path: 'unexpected.txt', content: 'x' } } }; yield { type: 'done', stopReason: 'tool_use' }; }
    else { yield { type: 'text', delta: 'Write was unavailable.' }; yield { type: 'done', stopReason: 'end_turn' }; }
  } };
  const harness = fixture(root, selected);
  t.after(() => harness.log.close());
  await harness.service.start({ profile: 'Review', prompt: 'Inspect only' }, { signal: new AbortController().signal, gate: harness.gate });
  assert.equal(existsSync(join(root, 'unexpected.txt')), false);
});

test('consultation cancellation reaches the native loop and exhausted caller budget buys no provider call', async (t) => {
  const root = workspace(t);
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  let calls = 0;
  const selected: Provider = { name: 'mock', estimateTokens: () => 1, async *send(request) {
    calls++; started();
    await new Promise<void>((resolve) => { request.signal?.addEventListener('abort', () => resolve(), { once: true }); });
    yield { type: 'done', stopReason: 'end_turn' };
  } };
  const harness = fixture(root, selected);
  t.after(() => harness.log.close());
  const runtime = { signal: new AbortController().signal, gate: harness.gate };
  const resultPromise = harness.service.start({ profile: 'Review', prompt: 'Wait' }, runtime);
  await running;
  const id = harness.service.list()[0]!.id;
  await assert.rejects(harness.service.followUp(id, 'Another question', runtime), /already running/);
  assert.equal(harness.service.cancel(id), true);
  assert.equal((await resultPromise).status, 'cancelled');
  const budget = new Budget({ maxIterations: 10, maxTotalTokens: 1 }, 'lead', {}, Date.now());
  budget.accrueSubagent({ inputTokens: 1 });
  const stopped = await harness.service.start({ profile: 'Review', prompt: 'No spend remains' }, { ...runtime, parentBudget: budget });
  assert.equal(stopped.status, 'partial');
  assert.equal(calls, 1);
});

test('review parser rejects missing/invalid evidence and never implies verification', () => {
  assert.equal(parseReviewFindings('Looks good'), undefined);
  assert.equal(parseReviewFindings('{"findings":[{"severity":"high","path":"a.ts","title":"Bug"}]}'), undefined);
  assert.deepEqual(parseReviewFindings('{"findings":[]}'), []);
  assert.equal(parseReviewFindings('{"findings":[{"severity":"high","path":"a.ts","line":2,"title":"Bug","evidence":"Expected value differs"}]}')?.[0]?.line, 2);
});

test('an interrupted consultation reloads without execution and resumed lineage excludes later source updates', async (t) => {
  const root = workspace(t);
  let calls = 0;
  const selected: Provider = { name: 'mock', estimateTokens: () => 1, async *send() {
    calls++; yield { type: 'text', delta: 'Durable findings' }; yield { type: 'done', stopReason: 'end_turn' };
  } };
  const harness = fixture(root, selected);
  const original = harness.log;
  t.after(() => original.close());
  const result = await harness.service.start({ profile: 'Review', prompt: 'Inspect' }, { signal: new AbortController().signal, gate: harness.gate });
  const latest = (SessionLog.load(original.path) as Array<{ kind?: string; data?: { summary: Record<string, unknown> } }>).filter((event) => event.kind === 'consultation_snapshot').at(-1)!;
  original.record({ kind: 'consultation_snapshot', data: { ...latest.data, summary: { ...latest.data!.summary, status: 'running' } } });
  const restored = harness.reload();
  assert.equal(restored.list()[0]?.status, 'ready');
  await assert.rejects(restored.followUp(result.id, 'Continue under the old ceiling', { signal: new AbortController().signal, gate: harness.gate }), /unrecorded usage/);
  assert.equal(restored.list()[0]?.interrupted, true);
  assert.equal(calls, 1, 'loading historical state never restarts a provider');
  const nextLog = SessionLog.open(root);
  t.after(() => nextLog.close());
  nextLog.record({ kind: 'resumed_from', path: original.path });
  harness.setLog(nextLog);
  restored.adopt(nextLog, original.path);
  original.record({ kind: 'consultation_snapshot', data: { ...latest.data, summary: { ...latest.data!.summary, id: 'consult_future', title: 'Later source-only work' } } });
  assert.deepEqual(harness.reload().list().map((item) => item.id), [result.id]);
  assert.equal(calls, 1);
});
