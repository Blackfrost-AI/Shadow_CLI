// Mission HUD rendering (Sprint 3 item 3.2, Package 8) — the one-line law: whatever
// the mission holds, it renders as ONE line while running and ONE row in the idle
// PinnedState block. Row-count parity with the old standing-goal is what keeps the
// frame budget (fitHud/layout.ts hasGoal accounting) correct.

import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { MissionState } from '../src/agent/mission.js';
import { missionHudLine, missionPinnedRow, missionStatusLines } from '../src/tui/missionHud.js';
import { PinnedState } from '../src/tui/chrome.js';

function snap() {
  const m = new MissionState();
  m.begin('ship the retry fix');
  return { m, s: m.snapshot() };
}

test('missionHudLine: empty when inactive, one line when active', () => {
  assert.equal(missionHudLine(null), '');
  assert.equal(missionHudLine(new MissionState().snapshot()), '');
  const { s } = snap();
  const line = missionHudLine(s);
  assert.ok(line.startsWith('🎯 '));
  assert.ok(line.includes('ship the retry fix'));
  assert.ok(line.includes('planning'));
  assert.equal(line.split('\n').length, 1, 'ONE line, always');
});

test('missionHudLine: carries phase + done/total counts', () => {
  const { m } = snap();
  m.onPlanApproved({ tasks: ['a', 'b', 'c'] });
  m.updateTasks([{ id: 'm-1', status: 'done' }]);
  const line = missionHudLine(m.snapshot());
  assert.ok(line.includes('executing 1/3'), line);
});

test('missionHudLine truncates long missions to one visual line budget', () => {
  const m = new MissionState();
  m.begin('x'.repeat(500));
  const line = missionHudLine(m.snapshot());
  assert.ok(line.length <= 81, `truncated well below raw length (got ${line.length})`);
  assert.ok(line.endsWith('…'));
});

test('missionPinnedRow: null when inactive, otherwise one truncated row', () => {
  assert.equal(missionPinnedRow(null), null);
  assert.equal(missionPinnedRow(new MissionState().snapshot()), null);
  const { s } = snap();
  const row = missionPinnedRow(s);
  assert.ok(row);
  assert.ok(row!.startsWith('🎯 Mission: '));
  assert.equal(row!.split('\n').length, 1);
});

test('missionStatusLines: full status for /goal and /status, honest when empty', () => {
  assert.equal(missionStatusLines(null).length, 1);
  const { m } = snap();
  m.onPlanApproved({ path: '/w/plans/x.md', tasks: ['a'] });
  const lines = missionStatusLines(m.snapshot());
  assert.ok(lines.some((l) => l.includes('Mission: ship the retry fix')));
  assert.ok(lines.some((l) => l.includes('Phase: executing')));
  assert.ok(lines.some((l) => l.includes('/w/plans/x.md')));
  assert.ok(lines.some((l) => l.includes('m-1. [pending] a')));
});

test('PinnedState row count: mission row ≡ goal row (layout budget parity)', () => {
  // The block's physical row count with an active mission must EQUAL the row count with
  // an old-style goal string — the hasGoal accounting in layout.ts charges exactly one.
  const base = {
    plan: { mode: 'implement' as const },
    todos: [],
    showPlan: false,
    showTodo: false,
    collapsed: true,
    cols: 100,
  };
  const countRows = (jsx: React.ReactElement): number =>
    (render(jsx).lastFrame() ?? '').split('\n').length;
  const withGoal = countRows(
    React.createElement(PinnedState, { ...base, goal: '🎯 Goal: old style goal' }),
  );
  const withMission = countRows(
    React.createElement(PinnedState, { ...base, goal: missionPinnedRow(snap().s) }),
  );
  const without = countRows(React.createElement(PinnedState, { ...base, goal: null }));
  assert.equal(withMission, withGoal, 'mission row occupies exactly the goal row slot');
  assert.equal(without, withGoal - 1, 'no mission = one row fewer (the slot is real)');
});

test('hudPinnedLine wiring: tui.tsx composes the mission line, not raw goal text', () => {
  // Structural pin (plan-toggle.test.ts pattern): the HUD reads missionHudLine output —
  // `goal` is the DERIVED one-liner — and PinnedState receives missionPinnedRow.
  const src = readFileSync(new URL('../src/tui.tsx', import.meta.url), 'utf8');
  assert.match(src, /const goal = missionHudLine\(missionSnap\)/, 'HUD line derives from missionHudLine');
  assert.match(src, /goal=\{missionPinnedRow\(missionSnap\)\}/, 'PinnedState gets missionPinnedRow');
  assert.ok(!src.includes('Standing goal'), 'the old standing-goal injection is gone');
});
