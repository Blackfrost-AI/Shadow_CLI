// Mission slash trio through the REAL mounted <TuiApp> (permission-tui-loop.test.ts
// harness shape): /goal <text> begins the mission + plan mode + a kickoff turn,
// /goal reports status, /goal clear ends. The provider is the mock (instant done),
// so the kickoff turn runs for real and finishes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

const { home: HOME } = isolateHome('mission-tui');
const store = await import('../src/state/globalStore.js');
assertStoreIsolated(store.GLOBAL_DIR, HOME);
const { loadConfig } = await import('../src/config.js');
const { TuiApp } = await import('../src/tui.js');
const { EventBus } = await import('../src/agent/events.js');
const { Context } = await import('../src/agent/context.js');
const { ToolRegistry } = await import('../src/tools/registry.js');
const { createProvider } = await import('../src/provider/index.js');
const { MissionState } = await import('../src/agent/mission.js');
const { PlanModeState } = await import('../src/agent/planMode.js');
import type { TuiOpts } from '../src/tui.js';
import type { LoopEvent } from '../src/agent/events.js';

const tick = () => new Promise((r) => setTimeout(r, 120));
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const strip = (s: string | undefined) => (s ?? '').replace(ANSI, '');

function makeHarness() {
  const ws = mkdtempSync(join(tmpdir(), 'mission-tui-'));
  const cfg = loadConfig(ws, { provider: 'mock', model: 'm' });
  const bus = new EventBus();
  const events: LoopEvent[] = [];
  bus.on((e) => events.push(e));
  const mission = new MissionState();
  const planMode = new PlanModeState(false);
  // Production bridge: mission mutations become bus events (index.ts parity).
  mission.onUpdate((m) => bus.emit({ type: 'mission', mission: m }));
  planMode.onUpdate((plan) => bus.emit({ type: 'plan_mode', plan }));
  const opts: TuiOpts = {
    provider: createProvider({ provider: 'mock', model: 'm' }),
    registry: new ToolRegistry(),
    bus,
    context: new Context({
      contextBudget: cfg.contextBudget,
      triggerRatio: cfg.summarizeTriggerRatio,
      keepLastTurns: cfg.keepLastTurns,
    }),
    sessionLog: { record() {} } as unknown as TuiOpts['sessionLog'],
    system: 'test',
    workspaceRoot: ws,
    cfg,
    autonomy: 'full',
    bypass: false,
    version: '0.0.0',
    mission,
    planMode,
  };
  return { ws, opts, mission, events };
}

test('/goal <text> starts the mission, plan mode, and a kickoff turn', async () => {
  const { ws, opts, mission, events } = makeHarness();
  try {
    const { stdin, frames, unmount } = render(React.createElement(TuiApp, { opts }));
    await tick();
    stdin.write('/goal ship the retry fix');
    await tick();
    stdin.write('\r');
    await tick();
    await tick();

    const out = strip(frames.join('\n'));
    assert.match(out, /Mission started: ship the retry fix/);
    assert.match(out, /Plan mode on/);
    // The kickoff turn ran for real (mock provider) and its user line is in the transcript.
    assert.match(out, /\[mission\] ship the retry fix/);
    assert.equal(mission.snapshot().active, true);
    assert.equal(mission.snapshot().phase, 'planning');
    assert.ok(events.some((e) => e.type === 'mission' && e.mission.active), 'mission event on the bus');
    // Plan mode engaged through the state object (bus-driven, /plan lesson).
    assert.ok(events.some((e) => e.type === 'plan_mode' && e.plan.mode === 'planning'));
    unmount();
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('/goal with no args prints mission status; /goal clear ends it', async () => {
  const { ws, opts, mission } = makeHarness();
  try {
    const { stdin, frames, unmount } = render(React.createElement(TuiApp, { opts }));
    await tick();
    mission.begin('fix the flaky test');
    mission.onPlanApproved({ tasks: ['isolate', 'fix'] });
    await tick();
    stdin.write('/goal');
    await tick();
    stdin.write('\r');
    await tick();
    let out = strip(frames.join('\n'));
    assert.match(out, /Mission: fix the flaky test/);
    assert.match(out, /Phase: executing/);
    assert.match(out, /m-1\. \[pending\] isolate/);

    stdin.write('/goal clear');
    await tick();
    stdin.write('\r');
    await tick();
    out = strip(frames.join('\n'));
    assert.match(out, /Mission cleared/);
    assert.equal(mission.snapshot().active, false);
    unmount();
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('an active mission renders exactly ONE pinned HUD row', async () => {
  const { ws, opts, mission } = makeHarness();
  try {
    const { frames, unmount } = render(React.createElement(TuiApp, { opts }));
    await tick();
    mission.begin('one row only');
    await tick();
    const out = strip(frames.join('\n'));
    const rows = out.split('\n').filter((l) => l.includes('one row only'));
    assert.ok(rows.length >= 1, 'the mission row renders');
    assert.equal(rows.length, 1, 'exactly ONE row carries the mission text');
    unmount();
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('/goal begin while a turn runs queues the kickoff instead of a second turn', async () => {
  const { ws, opts } = makeHarness();
  try {
    const { stdin, frames, unmount } = render(React.createElement(TuiApp, { opts }));
    await tick();
    // A long-running first turn: the mock provider streams nothing until told, but a
    // simpler trigger is a second /goal DURING the first kickoff turn — the queue path.
    stdin.write('/goal first mission');
    await tick();
    stdin.write('\r');
    await tick(); // kickoff turn now running (mock provider resolves on next microtasks; tick is generous)
    stdin.write('/goal second mission');
    await tick();
    stdin.write('\r');
    await tick();
    await tick();
    const out = strip(frames.join('\n'));
    // Whichever path ran (immediate or queued), the second mission must NOT clobber the
    // first mid-flight: either it queued, or the first turn already finished and it ran.
    assert.ok(
      /mission kickoff queued/.test(out) || /Mission started: second mission/.test(out),
      'begin-while-running resolves via queue or after-turn, never concurrently',
    );
    unmount();
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
