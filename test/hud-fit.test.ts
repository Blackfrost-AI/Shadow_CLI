import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitHud } from '../src/tui.js';

// Every combination of "what the HUD wants to show". The invariant must hold for ALL of them.
const WANTS = [
  { liveWant: 2, pinned: true, queued: true, custom: true },   // worst case (everything)
  { liveWant: 2, pinned: false, queued: false, custom: false },
  { liveWant: 0, pinned: false, queued: false, custom: false }, // idle
  { liveWant: 0, pinned: true, queued: true, custom: true },
  { liveWant: 1, pinned: true, queued: false, custom: true },
];

test('fitHud: the live frame is ALWAYS strictly under the terminal height (no Ink wipe) for rows >= 4', () => {
  for (let rows = 4; rows <= 120; rows++) {
    for (const w of WANTS) {
      const f = fitHud(rows, w);
      assert.ok(
        f.height < rows,
        `rows=${rows} want=${JSON.stringify(w)} → height ${f.height} must be < ${rows} (Ink wipes at >=)`,
      );
      // the reported height must equal the actual sum of the rows it enabled
      const composer = 3 + (f.hint ? 1 : 0);
      const sum =
        composer + (f.strip ? 1 : 0) + (f.status ? 1 : 0) + f.liveRows +
        (f.pinned ? 1 : 0) + (f.queued ? 1 : 0) + (f.custom ? 1 : 0) + (f.marginTop ? 1 : 0);
      assert.equal(f.height, sum, `height ${f.height} must equal the enabled-row sum ${sum}`);
    }
  }
});

test('fitHud: a normal-size terminal shows everything', () => {
  const f = fitHud(40, { liveWant: 2, pinned: true, queued: true, custom: true });
  assert.equal(f.liveRows, 2);
  assert.ok(f.strip && f.status && f.hint && f.pinned && f.queued && f.custom && f.marginTop);
});

test('fitHud: drops lowest-priority rows first as the terminal shrinks', () => {
  const want = { liveWant: 2, pinned: true, queued: true, custom: true };
  // Everything fits at rows>=13 (height 12); at rows=12 the cosmetic blank is the first casualty.
  assert.equal(fitHud(13, want).marginTop, true, 'blank spacer still present when it fits');
  const tight = fitHud(12, want);
  assert.equal(tight.marginTop, false, 'cosmetic blank drops first');
  assert.ok(tight.strip && tight.status && tight.liveRows === 2, 'higher-priority rows survive');
  // Very short: only the composer input+borders (3 rows) survive under a 4-row terminal.
  const min = fitHud(4, want);
  assert.equal(min.height, 3);
  assert.ok(!min.strip && !min.status && min.liveRows === 0 && !min.hint, 'everything optional dropped');
});

test('fitHud: liveRows honors liveWant (the caller zeroes it when nothing is live)', () => {
  assert.equal(fitHud(40, { liveWant: 0, pinned: false, queued: false, custom: false }).liveRows, 0);
  assert.equal(fitHud(40, { liveWant: 1, pinned: false, queued: false, custom: false }).liveRows, 1);
  assert.equal(fitHud(40, { liveWant: 2, pinned: false, queued: false, custom: false }).liveRows, 2);
});
