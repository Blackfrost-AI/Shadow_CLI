import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitHud, reflowSequence } from '../src/tui.js';

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

test('fitHud: strip:false reclaims the permanent status-strip row (Phase B merge)', () => {
  const withStrip = fitHud(40, { liveWant: 0, pinned: false, queued: false, custom: false });
  const merged = fitHud(40, { liveWant: 0, pinned: false, queued: false, custom: false, strip: false });
  assert.equal(withStrip.strip, true);
  assert.equal(merged.strip, false);
  assert.equal(merged.height, withStrip.height - 1, 'merged chrome is one row shorter');
});

test('fitHud: constant liveWant=2 (idle or running) still stays under terminal height', () => {
  // Phase C: live slot is always reserved so the composer never jumps at turn boundaries.
  for (const rows of [17, 24, 40, 80]) {
    const f = fitHud(rows, { liveWant: 2, pinned: true, queued: false, custom: false, strip: false });
    assert.ok(f.height < rows, `rows=${rows} height=${f.height}`);
    assert.equal(f.liveRows, 2, 'full 2-row slot when the budget allows');
  }
  // Tiny terminal: live rows drop first as needed, still under height.
  const tiny = fitHud(8, { liveWant: 2, pinned: true, queued: true, custom: true, strip: false });
  assert.ok(tiny.height < 8);
  assert.ok(tiny.liveRows <= 2);
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

test('reflowSequence: soft keeps scrollback; hard wipes it', () => {
  assert.equal(reflowSequence('soft'), '\x1b[2J\x1b[H');
  assert.equal(reflowSequence('hard'), '\x1b[2J\x1b[3J\x1b[H');
  assert.ok(!reflowSequence('soft').includes('3J'), 'soft must not nuke scrollback');
  assert.ok(reflowSequence('hard').includes('3J'), 'hard clears scrollback for resize/clear');
});

test('fitHud liveBlank: the hint outranks BLANK idle live-slot rows on short terminals', () => {
  // 7-row split pane, idle: base 3 + status 1 leaves 2 spare rows (cap rows-1=6).
  // Without liveBlank the two blank slot rows consumed them and the hint vanished.
  const idle = fitHud(7, { liveWant: 2, liveBlank: true, pinned: false, queued: false, custom: false, strip: false });
  assert.ok(idle.hint, 'hint (merged strip: model/mode/ctx/OFFLINE) survives');
  assert.ok(idle.liveRows < 2, 'blank rows are what gets dropped');
  // Running (liveBlank false): the streaming preview keeps its priority above the hint.
  const run = fitHud(7, { liveWant: 2, liveBlank: false, pinned: false, queued: false, custom: false, strip: false });
  assert.equal(run.liveRows, 2, 'live preview wins while running');
  // On a tall terminal both fit either way — constant-height invariant intact.
  const tallIdle = fitHud(40, { liveWant: 2, liveBlank: true, pinned: true, queued: false, custom: false, strip: false });
  const tallRun = fitHud(40, { liveWant: 2, liveBlank: false, pinned: true, queued: false, custom: false, strip: false });
  assert.equal(tallIdle.height, tallRun.height, 'idle and running frames match on tall terminals');
});

test('fitHud: a multi-row composer never pushes the live frame to terminal height (Ink wipe guard)', () => {
  // The regression: a tall draft on a short terminal made base = 2 + inputRows reach `rows`,
  // tripping Ink's whole-screen wipe on every keystroke. inputRows must be clamped to rows-3.
  for (let rows = 4; rows <= 30; rows++) {
    for (const req of [1, 2, 5, 8, 20]) {
      const f = fitHud(rows, { liveWant: 2, pinned: true, queued: true, custom: true, strip: false, composerInputRows: req });
      assert.ok(f.height < rows, `rows=${rows} composerInputRows=${req}: height ${f.height} must be < ${rows}`);
    }
  }
  // The specific case from the finding: fitHud(8, {composerInputRows: 8}) must stay under 8.
  assert.ok(fitHud(8, { liveWant: 0, pinned: false, queued: false, custom: false, strip: false, composerInputRows: 8 }).height <= 7);
});
