import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isolateHome } from './helpers/isolateHome.js';

isolateHome('snowfall-stream-footer');

const { EventBus } = await import('../src/agent/events.js');
const { Context } = await import('../src/agent/context.js');
const { loadConfig } = await import('../src/config.js');
const { SessionLog } = await import('../src/state/session.js');
const { ShadowApp } = await import('../src/app/app.js');
const { ToolRegistry } = await import('../src/tools/registry.js');
const { HeadlessTerminal, snowfallFixtureState } = await import('./helpers/snowfallTerminal.js');
const { SnowfallStatus } = await import('../src/app/snowfall.js');
const { visibleWidth } = await import('@earendil-works/pi-tui');

type Deferred = { promise: Promise<void>; release: () => void };
function deferred(): Deferred {
  let release!: () => void;
  return { promise: new Promise<void>((resolve) => { release = resolve; }), release: () => release() };
}
async function until(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`);
    await delay(10);
  }
}
function footerRate(terminal: InstanceType<typeof HeadlessTerminal>): number | null {
  const match = terminal.lines().at(-1)!.match(/(\d+) tok\/s/);
  return match ? Number(match[1]) : null;
}

test('the throughput chip stays inside the footer and degrades as a whole at content-width boundaries', () => {
  for (const width of [80, 100, 101, 120]) {
    for (const costUSD of [0, 1.2345]) {
      const state = { ...snowfallFixtureState(), running: true, tokPerSec: '42 tok/s', toolLine: null, costUSD };
      const row = new SnowfallStatus(() => state, () => state.startedAt).render(width)[0]!;
      assert.equal(visibleWidth(row), width, `${width} columns retains its exact footer geometry`);
      assert.ok(row.includes('42 tok/s'), `${width} columns with cost $${costUSD} retains the rate`);
      const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
      const rate = plain.indexOf('42 tok/s');
      assert.ok(rate >= 2 && rate + '42 tok/s'.length <= width - 2, 'the chip respects outer footer padding');
    }
  }
  const narrow = { ...snowfallFixtureState(), running: true, tokPerSec: '42 tok/s', toolLine: null };
  const row = new SnowfallStatus(() => narrow).render(30)[0]!;
  assert.equal(visibleWidth(row), 30);
  assert.ok(!row.includes('tok/s'), 'a constrained footer drops the complete optional chip instead of clipping it');
});

test('the production footer measures only root-agent deltas and resets between turns', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-stream-footer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const gates: Deferred[] = [];
  let calls = 0;
  const provider = {
    name: 'mock', estimateTokens: () => 20,
    async *send() {
      const turn = ++calls;
      const gate = deferred();
      gates.push(gate);
      yield { type: 'text' as const, delta: 'a'.repeat(80) };
      await gate.promise;
      if (turn === 1) {
        await delay(150);
        yield { type: 'text' as const, delta: 'b'.repeat(80) };
        await delay(1200);
        yield { type: 'thinking' as const, delta: 'c'.repeat(80) };
      }
      yield { type: 'done' as const, stopReason: 'end_turn' as const };
    },
  };
  const cfg = loadConfig(root, { provider: 'mock', model: 'fixture', reducedMotion: true, notify: 'off', instructionAutopilot: false });
  const log = SessionLog.open(root);
  const bus = new EventBus();
  let releaseCollaboration!: () => void;
  const collaborationGate = new Promise<void>((resolve) => { releaseCollaboration = resolve; });
  const app = new ShadowApp({
    runNativeTool: async (_name, _input, _signal) => {
      await collaborationGate;
      return { ok: true, summary: 'Collaboration complete.', meta: { tool: 'collaborate', durationMs: 1, risk: 'read' as const } };
    },
    provider, cfg, bus, registry: new ToolRegistry(), sessionLog: log,
    context: new Context({ contextBudget: 32768, triggerRatio: 0.8, keepLastTurns: 4 }),
    system: 'Footer stream test.', workspaceRoot: root,
    autonomy: 'manual', bypass: false, offline: true, version: '10.0.0-test',
  }, new HeadlessTerminal(120, 36));
  const terminal = (app as unknown as { terminal: InstanceType<typeof HeadlessTerminal> }).terminal;
  const inspect = app as unknown as { running: boolean };
  const run = app.run();
  try {
    terminal.input('Measure a live answer.'); terminal.input('\r');
    await until(() => calls === 1 && gates.length === 1, 'the first provider call starts');
    await terminal.flush();
    assert.match(terminal.lines().at(-1)!, /—/, 'a single first delta remains in warmup');
    assert.equal(footerRate(terminal), null);

    gates[0]!.release();
    await until(() => footerRate(terminal) !== null, 'the real HUD ticker publishes a live rate');
    const early = footerRate(terminal)!;
    await until(() => footerRate(terminal) !== null && footerRate(terminal)! < early, 'the slower decode window replaces the early rate');
    await until(() => !inspect.running, 'the first turn completes');
    await terminal.flush();
    assert.equal(footerRate(terminal), null, 'the throughput chip is absent while idle');

    terminal.input('Start a fresh measurement.'); terminal.input('\r');
    await until(() => calls === 2 && gates.length === 2, 'the second provider call starts');
    await terminal.flush();
    assert.match(terminal.lines().at(-1)!, /—/, 'a new turn does not reuse the previous frozen rate');
    // SubagentBus adds this runtime tag while forwarding events; it is not part of the public
    // loop emitter's input shape, so model that existing bus boundary explicitly in this test.
    const taggedBus = bus as unknown as { emit(event: { type: 'text'; delta: string; subagent: string }): void };
    taggedBus.emit({ type: 'text', delta: 'sub-agent output '.repeat(1000), subagent: 'child' });
    await delay(200);
    await terminal.flush();
    assert.equal(footerRate(terminal), null, 'sub-agent text cannot fabricate the root-agent rate');
    gates[1]!.release();
    await until(() => !inspect.running, 'the second turn completes');

    void (app as unknown as { runTeam(input: { preset: string; prompt: string }): Promise<void> })
      .runTeam({ preset: 'lead', prompt: 'Check the result.' });
    await until(() => inspect.running, 'the non-agent activity starts');
    await delay(200); await terminal.flush();
    assert.equal(footerRate(terminal), null, 'non-agent busy state never revives a frozen stream rate');
    assert.doesNotMatch(terminal.lines().at(-1)!, /tok\/s|—/, 'the throughput chip is hidden outside a root stream');
    releaseCollaboration();
    await until(() => !inspect.running, 'collaboration completes');
  } finally {
    releaseCollaboration();
    for (const gate of gates) gate.release();
    app.stop(); await run; log.close(); terminal.screen.dispose();
  }
});

test('interrupt hides the footer chip, freezes the estimator, and starts the next turn clean', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-stream-interrupt-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const provider = {
    name: 'mock', estimateTokens: () => 20,
    async *send(options: { signal?: AbortSignal }) {
      calls++;
      yield { type: 'text' as const, delta: 'a'.repeat(80) };
      await delay(150);
      yield { type: 'text' as const, delta: 'b'.repeat(80) };
      if (calls === 1) {
        const signal = options.signal;
        assert.ok(signal, 'runTurn supplies the interrupt signal to its provider');
        await Promise.race([first, new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))]);
        signal.throwIfAborted();
      }
      yield { type: 'done' as const, stopReason: 'end_turn' as const };
    },
  };
  const cfg = loadConfig(root, { provider: 'mock', model: 'fixture', reducedMotion: true, notify: 'off', instructionAutopilot: false });
  const log = SessionLog.open(root);
  const bus = new EventBus();
  const app = new ShadowApp({
    provider, cfg, bus, registry: new ToolRegistry(), sessionLog: log,
    context: new Context({ contextBudget: 32768, triggerRatio: 0.8, keepLastTurns: 4 }),
    system: 'Footer interrupt test.', workspaceRoot: root,
    autonomy: 'manual', bypass: false, offline: true, version: '10.0.0-test',
  }, new HeadlessTerminal(120, 36));
  const terminal = (app as unknown as { terminal: InstanceType<typeof HeadlessTerminal> }).terminal;
  const inspect = app as unknown as { running: boolean; streamRate: { read(at: number, live: boolean): number | null } };
  const run = app.run();
  try {
    terminal.input('Interrupt this stream.'); terminal.input('\r');
    await until(() => calls === 1 && footerRate(terminal) !== null, 'the first stream publishes a rate');
    terminal.input('\x1b');
    await until(() => !inspect.running, 'Escape interrupts and cleans up the stream');
    await terminal.flush();
    assert.equal(footerRate(terminal), null, 'the chip hides immediately after interruption');
    const frozen = inspect.streamRate.read(Date.now(), false);
    assert.ok(frozen !== null && frozen > 0);
    await delay(600);
    assert.equal(inspect.streamRate.read(Date.now(), false), frozen, 'idle wall time cannot change the frozen estimate');
    terminal.input('Measure the next turn.'); terminal.input('\r');
    await until(() => inspect.running && calls === 2, 'the next turn begins');
    assert.equal(inspect.streamRate.read(Date.now(), true), null, 'reset prevents the interrupted rate leaking into a new turn');
  } finally {
    releaseFirst(); app.stop(); await run; log.close(); terminal.screen.dispose();
  }
});
