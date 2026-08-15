import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { searchHistoryBack, historySearchPrompt } from '../src/tui/composer.js';
import { TuiApp, type TuiOpts } from '../src/tui.js';
import { EventBus } from '../src/agent/events.js';
import { Context } from '../src/agent/context.js';
import { MockProvider } from '../src/provider/mock.js';
import { ToolRegistry } from '../src/tools/registry.js';

/** B2 — Ctrl+R reverse history search, the last readline key still missing. */

const H = ['npm test', 'git status', 'npm run build', 'git log --oneline'];

test('searchHistoryBack walks NEWEST to oldest, as readline does', () => {
  assert.equal(searchHistoryBack(H, 'git', H.length - 1), 3, 'the most recent git… first');
  assert.equal(searchHistoryBack(H, 'git', 2), 1, 'stepping back finds the older one');
  assert.equal(searchHistoryBack(H, 'npm', H.length - 1), 2);
  assert.equal(searchHistoryBack(H, 'nope', H.length - 1), -1, 'no match');
  assert.equal(searchHistoryBack(H, '', H.length - 1), -1, 'an empty query matches nothing');
});

test('search is case-insensitive and matches anywhere in the entry', () => {
  assert.equal(searchHistoryBack(H, 'STATUS', H.length - 1), 1);
  assert.equal(searchHistoryBack(H, 'oneline', H.length - 1), 3);
});

test('the prompt mirrors readline, including the failed state', () => {
  assert.equal(historySearchPrompt({ query: 'git', index: 3, saved: '' }, H), "(reverse-i-search)`git': git log --oneline");
  assert.match(historySearchPrompt({ query: 'zzz', index: -1, saved: '' }, H), /^\(failed reverse-i-search\)/);
});

function makeOpts(): TuiOpts {
  return {
    // A REAL context + provider: submitting a turn is how history gets populated, and the stub
    // object every other test uses has no pinTask.
    // A real (non-empty) answer so the turn COMPLETES immediately. An empty end_turn now triggers
    // the empty-response corrective-retry backoff (~350ms of running), and P1A-15 correctly forbids
    // opening reverse-search mid-turn — this test is about history search on an IDLE composer.
    provider: new MockProvider([[{ type: 'text', delta: 'ok' }, { type: 'done', stopReason: 'end_turn' }] as never]) as unknown as TuiOpts['provider'],
    registry: new ToolRegistry() as unknown as TuiOpts['registry'],
    bus: new EventBus(),
    context: new Context({ contextBudget: 100000, triggerRatio: 0.75, keepLastTurns: 6 }) as TuiOpts['context'],
    sessionLog: { record() {} } as unknown as TuiOpts['sessionLog'],
    system: '',
    workspaceRoot: '/tmp/ws',
    cfg: {
      provider: 'mock',
      model: 'm',
      mouse: false,
      maxIterations: 2,
      budget: {},
      priceTable: {},
      contextBudget: 100000,
      summarizeTriggerRatio: 0.75,
      keepLastTurns: 6,
    } as unknown as TuiOpts['cfg'],
    autonomy: 'auto-edit',
    bypass: false,
    version: '9.9.9',
  };
}

test('Ctrl+R opens a live search over the real session history', async (t) => {
  const { lastFrame, stdin, unmount } = render(React.createElement(TuiApp, { opts: makeOpts() }));
  t.after(() => unmount());
  await new Promise((r) => setTimeout(r, 120));
  const frame = async (): Promise<string> => {
    await new Promise((r) => setTimeout(r, 90));
    return (lastFrame() ?? '').replace(/\x1b\[[0-9;]*m/g, '');
  };
  // Build history the way a user would: type and submit.
  stdin.write('remember this line');
  stdin.write('\r');
  await new Promise((r) => setTimeout(r, 90));

  stdin.write('\x12'); // Ctrl+R
  stdin.write('remember');
  const f = await frame();
  assert.match(f, /reverse-i-search/, 'the readline prompt is shown');
  assert.match(f, /remember this line/, 'and the matching entry is in the composer');

  // Esc restores what was there before the search.
  stdin.write('\x1b');
  const after = await frame();
  assert.doesNotMatch(after, /reverse-i-search/, 'Esc closes the search');
});
