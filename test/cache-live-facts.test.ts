/**
 * 11.6.0 CACHE slice — cache-safe live memory + control-state delivery (spec B4 + items 1-6).
 *
 * Regressions guarded here:
 *   - the workspace-facts index is rendered LIVE per provider request (mid-session memory
 *     writes surface on the NEXT request), never baked into deps.system at bootstrap;
 *   - on prompt-caching providers ALL volatile per-turn state (facts, effort, plan/mission/
 *     todo, iteration budget) rides the uncached message-tail suffix — the system prompt
 *     stays byte-identical across turns (todo_write must not bust the cached prefix);
 *   - non-caching providers keep the legacy all-in-system placement, byte-identical to the
 *     pre-11.6.0 baked layout, with the tail carrying only the budget counter;
 *   - exactly ONE 'Known workspace facts' section per rendered request (no double-render);
 *   - the budget block is LAST in the tail and excluded from compaction continuity;
 *   - nothing is emitted when every tail component is empty (|| undefined guard).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Budget } from '../src/agent/budget.js';
import { Context } from '../src/agent/context.js';
import { EventBus } from '../src/agent/events.js';
import { AgentLoop, type LoopDeps } from '../src/agent/loop.js';
import { TodoList } from '../src/agent/todo.js';
import { capabilityAwareFactsIndex } from '../src/agent/bootstrap.js';
import type { PromptCapabilityView } from '../src/system/resolveSystem.js';
import { buildStyledSystem, factsSection } from '../src/agent/system.js';
import { ProjectMemory } from '../src/state/memory.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/index.js';
import { makeMemoryTool } from '../src/tools/memory.js';
import { makeTodoTool } from '../src/tools/todo.js';
import { makeAgentTool } from '../src/tools/agentTool.js';
import { ScriptedApprovalGate } from '../src/agent/approval.js';
import { AnthropicProvider, buildAnthropicBody, toAnthropicMessages } from '../src/provider/anthropic.js';
import {
  estimateTokensFromMessages,
  type CompletionRequest,
  type Message,
  type Provider,
  type ProviderEvent,
} from '../src/provider/provider.js';
import type { ToolContext } from '../src/tools/types.js';

const PRICE = { mock: { input: 1, output: 1 } };
const FACTS_HEADER = '## Known workspace facts (index)';
const countSections = (s: string, header: string): number => s.split(header).length - 1;

/**
 * Records system + volatile suffix of every request. `caching` simulates the declaration-driven
 * Provider.promptCaching capability; omitted = legacy mock behaviour (non-caching).
 */
class CapturingProvider implements Provider {
  readonly name = 'mock';
  readonly promptCaching?: boolean;
  readonly systems: string[] = [];
  readonly suffixes: string[] = [];
  readonly requests: CompletionRequest[] = [];
  private i = 0;
  constructor(
    private readonly turns: ProviderEvent[][],
    opts?: { caching?: boolean },
  ) {
    if (opts?.caching !== undefined) this.promptCaching = opts.caching;
  }
  async *send(req: CompletionRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(req);
    this.systems.push(req.system ?? '');
    this.suffixes.push(req.systemVolatileSuffix ?? '');
    const turn = this.turns[this.i] ?? [{ type: 'done', stopReason: 'end_turn' }];
    this.i += 1;
    for (const e of turn) yield e;
  }
  estimateTokens(messages: Parameters<Provider['estimateTokens']>[0]): number {
    return estimateTokensFromMessages(messages);
  }
}

/** Context subclass that captures the compaction continuity feed without triggering summarization. */
class CapturingContext extends Context {
  readonly continuityFeeds: (string | undefined)[] = [];
  override async maybeSummarize(
    provider: Provider,
    model: string,
    force?: boolean,
    signal?: AbortSignal,
    countCtx?: { continuity?: string },
  ): ReturnType<Context['maybeSummarize']> {
    this.continuityFeeds.push(countCtx?.continuity);
    return super.maybeSummarize(provider, model, force, signal, countCtx);
  }
}

const done = (text = 'done'): ProviderEvent[] => [
  { type: 'text', delta: text },
  { type: 'done', stopReason: 'end_turn' },
];
const todoCall = (id: string, todos: Array<{ subject: string; status: string }>): ProviderEvent[] => [
  { type: 'tool_call', call: { id, name: 'todo_write', input: { todos } } },
  { type: 'done', stopReason: 'tool_use' },
];

async function runLoop(deps: LoopDeps, prompt: string): Promise<void> {
  deps.context.append({ role: 'user', content: [{ type: 'text', text: prompt }] });
  await new AgentLoop(deps, 'full').run();
}

function makeDeps(
  ws: string,
  provider: Provider,
  maxIterations: number,
  extras?: { registry?: ToolRegistry; context?: Context },
): LoopDeps {
  const reg = extras?.registry ?? new ToolRegistry();
  if (!extras?.registry) registerBuiltinTools(reg);
  return {
    provider,
    registry: reg,
    gate: new ScriptedApprovalGate([], 'approve'),
    bus: new EventBus(),
    budget: new Budget({ maxIterations }, 'mock', PRICE, Date.now()),
    context: extras?.context ?? new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 }),
    signal: new AbortController().signal,
    model: 'mock',
    system: 'test-system',
    maxOutputTokens: 1024,
    workspaceRoot: ws,
    dryRun: false,
    maxToolResultChars: 16_000,
    contextBudget: 1_000_000,
  };
}

/** Registry with the real memory + todo tools bound to live stores (capability-gate parity). */
function liveRegistry(ws: string): { reg: ToolRegistry; memory: ProjectMemory; todos: TodoList } {
  const reg = new ToolRegistry();
  const memory = ProjectMemory.load(ws);
  reg.register(makeMemoryTool(memory));
  const todos = new TodoList();
  reg.register(makeTodoTool(todos));
  return { reg, memory, todos };
}

/** Bootstrap's exact factsProvider construction: live asIndex through the capability gate. */
function liveFactsProvider(memory: ProjectMemory, caps: PromptCapabilityView): () => string {
  return () => capabilityAwareFactsIndex(memory.asIndex(), caps);
}

// ── Item 1: declaration-driven capability, no name-matching ─────────────────────────────────

test('capability: AnthropicProvider.promptCaching follows the declaration; mocks default non-caching', () => {
  const mk = (capabilities?: { promptCache?: boolean }) =>
    new AnthropicProvider({ model: 'claude-opus-4-6', apiKey: 'test-key', ...(capabilities ? { capabilities } : {}) });
  assert.equal(mk().promptCaching, true, 'undeclared = caching (adapter default behaviour)');
  assert.equal(mk({ promptCache: true }).promptCaching, true);
  assert.equal(mk({ promptCache: false }).promptCaching, false, 'explicit opt-out turns caching off');
  // Name must never drive routing: a non-Anthropic-named provider that DECLARES caching is caching.
  const declared = new CapturingProvider([done()], { caching: true });
  assert.equal(declared.promptCaching, true);
  const legacyMock = new CapturingProvider([done()]);
  assert.equal(legacyMock.promptCaching, undefined, 'mocks stay non-caching by default');
});

// ── Items 2+5: live facts, single render site ───────────────────────────────────────────────

test('caching: a mid-session memory write appears in the NEXT request tail, never in the system', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'cache-facts-live-'));
  try {
    const { reg, memory } = liveRegistry(ws);
    memory.set('alpha', 'first fact');
    const provider = new CapturingProvider([done('turn one'), done('turn two')], { caching: true });
    const deps = makeDeps(ws, provider, 0, { registry: reg });
    deps.factsProvider = liveFactsProvider(memory, { has: () => true });

    await runLoop(deps, 'first');
    assert.equal(provider.suffixes.length, 1);
    assert.match(provider.suffixes[0], /alpha/);
    assert.doesNotMatch(provider.suffixes[0], /beta/);
    assert.doesNotMatch(provider.systems[0], /alpha/, 'facts must not be baked into the cached system');

    // Mid-session write (what the memory tool does), then a second user turn.
    memory.set('beta', 'second fact written mid-session');
    await runLoop(deps, 'second');
    assert.equal(provider.suffixes.length, 2);
    assert.match(provider.suffixes[1], /alpha/);
    assert.match(provider.suffixes[1], /beta/, 'the new fact must surface on the next request');
    assert.doesNotMatch(provider.systems[1], /beta/);
    assert.equal(provider.systems[1], provider.systems[0], 'cached system stays byte-identical');
    // Exactly ONE facts section per rendered request (system + folded suffix).
    for (let i = 0; i < provider.requests.length; i++) {
      const rendered = provider.systems[i] + '\n\n' + provider.suffixes[i];
      assert.equal(countSections(rendered, FACTS_HEADER), 1, `request ${i} must render facts exactly once`);
    }
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('non-caching: live facts render in the SYSTEM at the legacy baked position; tail stays budget-only', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'cache-facts-legacy-'));
  try {
    const { reg, memory } = liveRegistry(ws);
    memory.set('alpha', 'first fact');
    const provider = new CapturingProvider([done('one'), done('two')]); // no promptCaching → legacy
    const deps = makeDeps(ws, provider, 0, { registry: reg });
    deps.factsProvider = liveFactsProvider(memory, { has: () => true });

    await runLoop(deps, 'first');
    memory.set('beta', 'second fact');
    await runLoop(deps, 'second');

    assert.equal(countSections(provider.systems[0], FACTS_HEADER), 1);
    assert.match(provider.systems[0], /alpha/);
    assert.doesNotMatch(provider.systems[0], /beta/);
    assert.match(provider.systems[1], /beta/, 'non-caching system carries the fresh index per request');
    assert.equal(countSections(provider.systems[1], FACTS_HEADER), 1);
    for (const s of provider.suffixes) {
      assert.equal(s, '', 'unlimited non-caching loop emits no suffix');
    }
    // Byte-exact legacy layout: facts sit right after the styled base, exactly where the old
    // bootstrap bake put them (buildStyledSystem with the same index). deps.system arrives
    // pre-styled; an unregistered style name contributes no block, isolating the facts position.
    const expectedPrefix = buildStyledSystem('test-system', 'plain' as never, memory.asIndex());
    assert.ok(
      provider.systems[1].startsWith(expectedPrefix),
      'non-caching system must keep the pre-11.6.0 baked facts position byte-for-byte',
    );
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('capability gate: removing the memory tool hides the facts index on BOTH paths', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'cache-facts-gate-'));
  try {
    const { reg, memory } = liveRegistry(ws);
    memory.set('alpha', 'still stored, but the tool is gone');
    const removed: PromptCapabilityView = { has: (name) => name !== 'memory' };
    for (const caching of [true, false]) {
      const provider = new CapturingProvider([done()], { caching });
      const deps = makeDeps(ws, provider, 0, { registry: reg });
      deps.factsProvider = liveFactsProvider(memory, removed);
      await runLoop(deps, 'go');
      const rendered = provider.systems[0] + '\n\n' + provider.suffixes[0];
      assert.doesNotMatch(rendered, /Known workspace facts/, `caching=${caching}: gated index must not render`);
      assert.doesNotMatch(rendered, /alpha/);
    }
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('facts are best-effort: a throwing factsProvider never kills the turn', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'cache-facts-throw-'));
  try {
    const provider = new CapturingProvider([done()], { caching: true });
    const deps = makeDeps(ws, provider, 0);
    deps.factsProvider = () => { throw new Error('memory store unreadable'); };
    await runLoop(deps, 'go');
    assert.equal(provider.systems.length, 1, 'the request still went out');
    assert.doesNotMatch(provider.suffixes[0], /Known workspace facts/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── Items 3+5: control blocks in the tail; system stability across todo_write ───────────────

test('caching: todo_write between turns keeps system byte-identical and updates the tail blocks', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'cache-todo-stable-'));
  try {
    const { reg, todos } = liveRegistry(ws);
    const provider = new CapturingProvider([done('one'), done('two')], { caching: true });
    const deps = makeDeps(ws, provider, 0, { registry: reg });
    deps.todoList = todos;

    await runLoop(deps, 'first');
    // Before any todo exists the tail carries the (always-present) effort directive but NO task list.
    assert.match(provider.suffixes[0], /## Operating effort:/);
    assert.doesNotMatch(provider.suffixes[0], /## Task list/);

    todos.write([{ subject: 'verify the slice', status: 'in_progress' }]);
    await runLoop(deps, 'second');
    assert.equal(provider.systems[1], provider.systems[0], 'todo state must not bust the cached system');
    assert.doesNotMatch(provider.systems[1], /## Task list/);
    assert.match(provider.suffixes[1], /## Task list/);
    assert.match(provider.suffixes[1], /verify the slice/);

    todos.write([{ subject: 'verify the slice', status: 'completed' }]);
    await runLoop(deps, 'third');
    assert.equal(provider.systems[2], provider.systems[0]);
    assert.match(provider.suffixes[2], /\[done\] verify the slice/, 'tail reflects the updated list');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('caching: a real todo_write TOOL CALL mid-run updates the next request tail, system unchanged', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'cache-todo-tool-'));
  try {
    const { reg, todos } = liveRegistry(ws);
    // Mark the task completed so the loop's pre-existing completion-check nudge (which fires on
    // unresolved pending/in_progress todos) does not add extra turns — isolating the tail update.
    const provider = new CapturingProvider(
      [todoCall('t1', [{ subject: 'ship the slice', status: 'completed' }]), done('shipped')],
      { caching: true },
    );
    const deps = makeDeps(ws, provider, 0, { registry: reg });
    deps.todoList = todos;
    await runLoop(deps, 'go');
    assert.equal(provider.systems.length, 2, 'tool call must have produced a second request');
    assert.doesNotMatch(provider.suffixes[0], /## Task list/);
    assert.match(provider.suffixes[1], /## Task list/);
    assert.match(provider.suffixes[1], /ship the slice/);
    assert.equal(provider.systems[1], provider.systems[0], 'system stable across the tool turn');
    for (let i = 0; i < 2; i++) {
      assert.doesNotMatch(provider.systems[i], /## Task list/);
    }
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('non-caching: todo blocks stay in the SYSTEM exactly as before (tail budget-only)', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'cache-todo-legacy-'));
  try {
    const { reg, todos } = liveRegistry(ws);
    const provider = new CapturingProvider(
      [todoCall('t1', [{ subject: 'legacy placement', status: 'completed' }]), done()],
    );
    const deps = makeDeps(ws, provider, 0, { registry: reg });
    deps.todoList = todos;
    await runLoop(deps, 'go');
    assert.doesNotMatch(provider.systems[0], /## Task list/);
    assert.match(provider.systems[1], /## Task list/, 'legacy path renders controls in system');
    assert.match(provider.systems[1], /legacy placement/);
    for (const s of provider.suffixes) assert.equal(s, '');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── Items 3+4: budget last, continuity exclusion, empty-tail guard ──────────────────────────

test('caching: tail order is facts → effort → controls → budget LAST; budget excluded from continuity', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'cache-tail-order-'));
  try {
    const { reg, memory, todos } = liveRegistry(ws);
    memory.set('alpha', 'ordering fact');
    todos.write([{ subject: 'ordered task', status: 'pending' }]);
    const ctx = new CapturingContext({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 });
    const provider = new CapturingProvider([done()], { caching: true });
    const deps = makeDeps(ws, provider, 10, { registry: reg, context: ctx });
    deps.factsProvider = liveFactsProvider(memory, { has: () => true });
    deps.todoList = todos;
    deps.continuityState = 'standing goal: finish the slice';

    await runLoop(deps, 'go');
    const suffix = provider.suffixes[0];
    const iFacts = suffix.indexOf(FACTS_HEADER);
    const iEffort = suffix.indexOf('## Operating effort:');
    const iTodo = suffix.indexOf('## Task list');
    const iBudget = suffix.indexOf('## Iteration budget');
    assert.ok(iFacts >= 0 && iEffort > iFacts && iTodo > iEffort && iBudget > iTodo,
      `tail order must be facts→effort→controls→budget, got indices ${iFacts},${iEffort},${iTodo},${iBudget}`);
    assert.ok(suffix.trimEnd().endsWith(suffix.slice(iBudget).trimEnd()), 'budget block must be LAST');
    assert.doesNotMatch(provider.systems[0], /## Iteration budget|## Task list|Known workspace facts/);

    // Continuity feed: standing goal + control blocks, but NEVER the budget counter or facts.
    assert.ok(ctx.continuityFeeds.length >= 1, 'maybeCompact must have run');
    const feed = ctx.continuityFeeds[0] ?? '';
    assert.match(feed, /standing goal: finish the slice/);
    assert.match(feed, /## Task list/);
    assert.doesNotMatch(feed, /## Iteration budget/, 'budget counter must stay out of compaction continuity');
    assert.doesNotMatch(feed, /Known workspace facts/, 'facts are not control context');
    // The suffix itself never enters the persisted history sent to the provider.
    const wire = JSON.stringify(provider.requests[0].messages);
    assert.doesNotMatch(wire, /## Iteration budget/);
    assert.doesNotMatch(wire, /Known workspace facts/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('empty-tail guard: non-caching unlimited loop with no live state emits NO suffix (|| undefined)', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'cache-empty-tail-'));
  try {
    // The non-caching tail carries ONLY the budget counter; unlimited → '' → || undefined.
    // This is the exact contract subagent-iteration-budget.test.ts:122 asserts (suffixes[0]==='').
    const provider = new CapturingProvider([done()]); // no promptCaching → non-caching
    const deps = makeDeps(ws, provider, 0);
    deps.factsProvider = () => '';
    await runLoop(deps, 'go');
    assert.equal(provider.requests[0].systemVolatileSuffix, undefined, 'nothing emitted when all tail components empty');
    assert.equal(provider.suffixes[0], '');
    assert.doesNotMatch(provider.systems[0], /## Iteration budget/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('caching tail always carries the effort directive (never empty), keeping system stable', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'cache-effort-tail-'));
  try {
    // On the caching path effort rides the uncached tail (plan M-1), so even with no facts/todos/
    // budget the suffix is the effort directive — the system stays byte-stable regardless.
    const provider = new CapturingProvider([done()], { caching: true });
    const deps = makeDeps(ws, provider, 0);
    deps.factsProvider = () => '';
    await runLoop(deps, 'go');
    assert.match(provider.suffixes[0], /## Operating effort:/);
    assert.doesNotMatch(provider.suffixes[0], /Known workspace facts|## Task list|## Iteration budget/);
    assert.doesNotMatch(provider.systems[0], /## Operating effort:/, 'effort must not bust the cached system');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── Item 2: subagent concatenation must not inherit lead facts ──────────────────────────────

test('subagent: system concatenation carries no lead facts (factory omits factsProvider)', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'cache-subagent-facts-'));
  try {
    const provider = new CapturingProvider([done('findings')], { caching: true });
    const tool = makeAgentTool({
      // Mirrors the production factory: base deps WITHOUT factsProvider.
      makeLoopDeps: () => makeDeps(ws, provider, 5),
      getAutonomy: () => 'full',
      contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6, maxIterations: 5, priceTable: PRICE,
    });
    const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false };
    await tool.run({ prompt: 'review', subagent_type: 'explore' }, ctx);
    const sys = provider.systems[0];
    assert.doesNotMatch(sys, /Known workspace facts/, 'delegates must not inherit the lead facts index');
    assert.doesNotMatch(provider.suffixes[0], /Known workspace facts/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── Item 3 (wire): the caching adapter places the whole tail after the rolling breakpoint ───

test('anthropic wire: multi-block volatile tail stays uncached AFTER the persisted-history breakpoint', () => {
  const tail = [
    factsSection('- alpha: ordering fact'),
    '## Operating effort: high\nWork at **high** effort this session.',
    '\n\n## Task list\n1. [pending] ordered task',
    '## Iteration budget\nTurns used: 1/10 · 9 left.',
  ].join('\n\n');
  const req = {
    model: 'claude-opus-4-6',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    system: 'you are shadow',
    systemVolatileSuffix: tail,
    maxOutputTokens: 4096,
  } as CompletionRequest;
  const b = buildAnthropicBody(req, 'fb', true, undefined);
  const sys = b.system as Array<Record<string, unknown>>;
  assert.equal(sys.length, 1, 'system stays a single cached block — no volatile second block');
  assert.ok(sys[0].cache_control);
  assert.doesNotMatch(String(sys[0].text), /Known workspace facts|## Task list|## Iteration budget/);
  const msgs = b.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  const last = msgs[msgs.length - 1];
  assert.ok(last.content[0].cache_control, 'rolling breakpoint sits on the last PERSISTED block');
  const tailText = last.content.slice(1).map((c) => String(c.text)).join('\n');
  assert.match(tailText, /Known workspace facts/);
  assert.match(tailText, /## Task list/);
  assert.ok(tailText.indexOf('## Iteration budget') > tailText.indexOf('## Task list'), 'budget stays last on the wire');
  for (const c of last.content.slice(1)) {
    assert.equal(c.cache_control, undefined, 'volatile tail blocks must NOT carry breakpoints');
  }
});

// ── adj2 (integration review): the volatile tail is COUNTED by the compaction trigger ────────

/** Summarizer stand-in: streams one fixed summary via send() without a real model. */
const SUMMARY_PROVIDER = {
  async *send(): AsyncIterable<ProviderEvent> {
    yield { type: 'text', delta: 'TASK: t\nALREADY DONE: d\nDECISIONS & FACTS: f\nCURRENT WORK: w\nNEXT STEP: n' };
    yield { type: 'done', stopReason: 'end_turn' };
  },
  estimateTokens: estimateTokensFromMessages,
} as unknown as Provider;

test('adj2: a fat volatile tail crosses the compaction trigger even when history alone would not', async () => {
  const ctx = new Context({ contextBudget: 1_000, triggerRatio: 0.75, keepLastTurns: 2 });
  // Tiny history: ~a dozen tokens — far below the 750-token trigger on its own.
  ctx.append({ role: 'user', content: [{ type: 'text', text: 'short question' }] });
  ctx.append({ role: 'assistant', content: [{ type: 'text', text: 'short answer' }] });
  ctx.append({ role: 'user', content: [{ type: 'text', text: 'another short question' }] });
  ctx.append({ role: 'assistant', content: [{ type: 'text', text: 'another short answer' }] });
  ctx.append({ role: 'user', content: [{ type: 'text', text: 'go on' }] });
  const fatTail = 'x'.repeat(8_000); // ≈ 2 100 heuristic tokens — over trigger by itself
  const result = await ctx.maybeSummarize(SUMMARY_PROVIDER, 'mock', false, undefined, {
    system: 'sys',
    volatileSuffix: fatTail,
    continuity: 'mission: keep going',
  });
  assert.equal(result, 'summarized', 'history + tail must trip the trigger (tail was invisible pre-adj2)');
});

test('adj2: without the tail the same history stays under trigger (control)', async () => {
  const ctx = new Context({ contextBudget: 1_000, triggerRatio: 0.75, keepLastTurns: 2 });
  ctx.append({ role: 'user', content: [{ type: 'text', text: 'short question' }] });
  ctx.append({ role: 'assistant', content: [{ type: 'text', text: 'short answer' }] });
  ctx.append({ role: 'user', content: [{ type: 'text', text: 'go on' }] });
  const result = await ctx.maybeSummarize(SUMMARY_PROVIDER, 'mock', false, undefined, { system: 'sys' });
  assert.equal(result, false, 'no tail, no compaction — the fix is additive, not a trigger change');
});

test('adj2: the loop forwards the assembled volatile suffix into maybeSummarize on the caching path', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'cache-adj2-'));
  try {
    const provider = new CapturingProvider([done()], { caching: true });
    const ctx = new CapturingContext({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 });
    const seen: (string | undefined)[] = [];
    const orig = ctx.maybeSummarize.bind(ctx);
    ctx.maybeSummarize = ((p: Provider, m: string, f?: boolean, s?: AbortSignal, c?: { volatileSuffix?: string }) => {
      seen.push(c?.volatileSuffix);
      return orig(p, m, f, s, c as never);
    }) as typeof ctx.maybeSummarize;
    const { reg, todos } = liveRegistry(ws);
    const deps = makeDeps(ws, provider, 10, { registry: reg, context: ctx });
    deps.todoList = todos;
    deps.factsProvider = () => '- adj2-probe: the tail must be counted';
    await runLoop(deps, 'count my tail');
    assert.ok(seen.length >= 1, 'proactive compaction check ran');
    assert.ok(seen[0] && seen[0].includes('adj2-probe'), 'facts tail forwarded to the compaction estimate');
    assert.equal(provider.suffixes[0], seen[0], 'the counted tail is exactly the sent tail');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── G1 (integration review): the volatile tail must NEVER mutate persisted history ──────────

test('G1: buildAnthropicBody appends the tail without mutating context messages or the wire array', () => {
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'do the thing' }] },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a.ts' } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', toolCallId: 'tu_1', ok: true, content: 'file body' }],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'done reading' }] },
  ];
  const before = structuredClone(messages);
  const fatTail =
    '## Known workspace facts (index)\n- g1-probe: live fact\n\n' +
    '## Task list\n1. [in-progress] verify G1\n\n[Iteration budget: 3/10]';
  const req: CompletionRequest = {
    model: 'claude-sonnet-5',
    system: 'stable system prompt',
    messages,
    tools: [],
    maxOutputTokens: 1024,
    systemVolatileSuffix: fatTail,
  };

  // Drive the EXACT production path send() uses: buildAnthropicBody internally runs
  // toAnthropicMessages(req.messages) then appends the tail to the last block.
  const wire = toAnthropicMessages(messages, 'claude-sonnet-5');
  const wireBefore = structuredClone(wire);
  const body = buildAnthropicBody(req, 'claude-sonnet-5', true);

  // 1. Persisted context messages are byte-identical — the tail never leaked into history.
  assert.deepEqual(messages, before, 'context messages must be untouched by the tail append');

  // 2. The wire array is request-local: the tail rides the body, not the shared array.
  assert.deepEqual(wire, wireBefore, 'toAnthropicMessages output must not be mutated in place');

  // 3. The tail IS present in the sent body, exactly once, on the last message.
  const bodyMessages = body.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
  const last = bodyMessages[bodyMessages.length - 1];
  const tailBlocks = last.content.filter((c) => c.type === 'text' && c.text === fatTail);
  assert.equal(tailBlocks.length, 1, 'tail appears exactly once in the sent body');

  // 4. A second build from the SAME messages does not accumulate a second tail.
  const body2 = buildAnthropicBody(req, 'claude-sonnet-5', true);
  const body2Messages = body2.messages as typeof bodyMessages;
  const last2 = body2Messages[body2Messages.length - 1];
  assert.equal(
    last2.content.filter((c) => c.type === 'text' && c.text === fatTail).length,
    1,
    'rebuilding must not stack tails (no accumulation across turns)',
  );
  assert.deepEqual(messages, before, 'still untouched after a second build');
});
