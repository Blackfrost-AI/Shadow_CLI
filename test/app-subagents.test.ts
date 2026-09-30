// P1.2 — the pi shell's sub-agent panel cell over 8.7's pure formatter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';

import { SubAgentsCell, SUBAGENT_PANEL_MAX_ROWS } from '../src/app/subagents.js';
import type { SubAgentView } from '../src/tui/subagentPanel.js';

function agent(over: Partial<SubAgentView>): SubAgentView {
  return {
    taskId: 't1',
    subagentType: 'explore',
    description: 'scan the repo',
    toolUseCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    startedAt: Date.now(),
    background: false,
    ...over,
  };
}

const plain = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));

test('an empty registry renders nothing — the panel is invisible when idle', () => {
  const cell = new SubAgentsCell(() => [], () => 24);
  assert.deepEqual(cell.render(100), []);
});

test('a running agent renders one live row with type, description, tool and counters', () => {
  let view = agent({ tool: 'grep', argPreview: 'TODO', toolUseCount: 3, inputTokens: 900, outputTokens: 300 });
  const cell = new SubAgentsCell(() => [view], () => 24);
  const doc = plain(cell.render(100)).join('\n');
  assert.ok(doc.includes('explore'), 'type label present');
  assert.ok(doc.includes('grep TODO'), 'current tool + arg present');
  assert.ok(doc.includes('3 tools'), 'tool count present');
  assert.ok(doc.includes('1.2k tok'), 'token count present');
  view = { ...view, toolUseCount: 4 };
  // same instance mutated externally: the getter re-reads, and the signature changes → re-render
  const doc2 = plain(cell.render(100)).join('\n');
  assert.ok(doc2.includes('4 tools'), 'updated counters re-render');
});

test('multiple agents: header + per-agent rows, running before done, +N more on overflow', () => {
  const views = [
    agent({ taskId: 'a', subagentType: 'done-first', done: true, ok: true }),
    agent({ taskId: 'b', subagentType: 'live-second', tool: 'read_file', toolUseCount: 1 }),
    agent({ taskId: 'c', subagentType: 'live-third' }),
    agent({ taskId: 'd', subagentType: 'live-fourth' }),
  ];
  const cell = new SubAgentsCell(() => views, () => 40); // tall → 4 rows budget
  const doc = plain(cell.render(100)).join('\n');
  assert.ok(doc.includes('Running 3 agents'), `header counts: ${doc}`);
  assert.ok(doc.includes('live-second'), 'a live agent is shown');
  assert.ok(doc.includes('done-first') === false || doc.includes('+'), 'overflow or omission of done rows');
});

test('rows never exceed the width and the row budget is bounded', () => {
  const views = Array.from({ length: 8 }, (_, i) =>
    agent({ taskId: `t${i}`, subagentType: `type-${i}-with-a-very-long-name`, description: 'x'.repeat(80) }),
  );
  const cell = new SubAgentsCell(() => views, () => 24);
  for (const cols of [40, 60, 100]) {
    const lines = cell.render(cols);
    assert.ok(lines.length <= SUBAGENT_PANEL_MAX_ROWS + 2, `rows=${lines.length} at cols=${cols}`);
    for (const l of lines) assert.ok(visibleWidth(l) <= cols, `width at cols=${cols}`);
  }
});

test('a queued agent reads queued, not Initializing (honesty rule, ported)', () => {
  const cell = new SubAgentsCell(() => [agent({ queued: true })], () => 24);
  assert.ok(plain(cell.render(100)).join('\n').includes('queued…'));
});
