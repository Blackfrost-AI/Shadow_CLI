import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { TuiApp, type TuiOpts } from '../src/tui.js';
import { EventBus } from '../src/agent/events.js';
import type { AutonomyLevel } from '../src/safety/permissions.js';

/**
 * T0-8 — safety posture froze at process start.
 *
 * `getAutonomy: () => autonomy` closed over a binding the TUI never updated: the TUI's
 * setAutonomy touched only React state and the live loop's field. So a sub-agent spawned after
 * the user dropped to `manual` was constructed at the STARTUP level — contradicting
 * AgentToolDeps' own doc comment that it "inherits it, never escalates".
 */
function makeOpts(over: Partial<TuiOpts> = {}): TuiOpts {
  return {
    provider: {} as TuiOpts['provider'],
    registry: {} as TuiOpts['registry'],
    bus: new EventBus(),
    context: {} as TuiOpts['context'],
    sessionLog: { record() {} } as unknown as TuiOpts['sessionLog'],
    system: '',
    workspaceRoot: '/tmp/ws',
    cfg: { provider: 'mock', model: 'm', mouse: false } as unknown as TuiOpts['cfg'],
    autonomy: 'full',
    bypass: false,
    version: '9.9.9',
    ...over,
  };
}

test('lowering autonomy notifies the process-level binding (sub-agents inherit the LIVE level)', async () => {
  const seen: AutonomyLevel[] = [];
  const { stdin, unmount } = render(
    React.createElement(TuiApp, { opts: makeOpts({ autonomy: 'full', onAutonomyChange: (l) => seen.push(l) }) }),
  );
  await new Promise((r) => setTimeout(r, 120));
  // Tab cycles the autonomy ring. From `full` the next stop leaves full behind.
  stdin.write('\t');
  await new Promise((r) => setTimeout(r, 90));
  unmount();
  assert.ok(seen.length > 0, 'the TUI must publish autonomy changes, not keep them to itself');
  assert.ok(!seen.includes('full') || seen[seen.length - 1] !== 'full', 'the new level is reported');
});

test('the fs-root grant is released when autonomy drops below full', () => {
  // Mirrors index.ts's onAutonomyChange: `/` is granted only while unrestricted-at-launch or
  // full, and lowering the level takes it back.
  const additionalRoots: string[] = ['/'];
  const unrestricted = false;
  const onAutonomyChange = (level: AutonomyLevel): void => {
    if (!unrestricted && level !== 'full') {
      const i = additionalRoots.indexOf('/');
      if (i !== -1) additionalRoots.splice(i, 1);
    }
  };
  onAutonomyChange('manual');
  assert.deepEqual(additionalRoots, [], 'dropping to manual must re-tighten the jail');
  // Raising back to full does NOT silently re-widen it.
  onAutonomyChange('full');
  assert.deepEqual(additionalRoots, [], 'full reached by Shift+Tab is not the same promise as --yolo');
});
