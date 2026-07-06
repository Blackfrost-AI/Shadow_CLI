import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout, fitsWideBanner, formatStatusStrip, SHADOW_LOGO_WIDTH } from '../src/tui/layout.js';

test('computeLayout reserves chrome rows for transcript', () => {
  const l = computeLayout(120, 40, { panelRows: 2, overlayRows: 3 });
  assert.equal(l.transcriptMaxHeight, 40 - 1 - 3 - 2 - 3);
  assert.equal(l.wideBanner, true);
});

test('computeLayout marks narrow terminals', () => {
  const l = computeLayout(60, 24);
  assert.equal(l.wideBanner, false);
  assert.ok(l.transcriptMaxHeight >= 4);
});

test('fitsWideBanner requires room for left column and full wordmark', () => {
  const left = 48; // typical welcome cwd line
  const min = left + SHADOW_LOGO_WIDTH + 6 + 2;
  assert.equal(fitsWideBanner(min - 1, left), false);
  assert.equal(fitsWideBanner(min, left), true);
  // Old threshold (LOGO_W + 34) wrongly allowed wide at 90 cols — would clip the art.
  assert.equal(fitsWideBanner(90, left), false);
});

test('computeLayout reserves live welcome banner rows', () => {
  const l = computeLayout(120, 30, { bannerRows: 8 });
  assert.equal(l.transcriptMaxHeight, 30 - 1 - 3 - 8);
});

test('formatStatusStrip truncates on narrow cols', () => {
  const long = formatStatusStrip(
    {
      provider: 'openai',
      model: 'gpt-5.1-codex-max',
      autonomy: 'auto-edit',
      planStatus: ' · plan: planning',
      todoStatus: ' · todo 2/5',
      status: '12k tokens · $0.04',
    },
    30,
  );
  assert.ok(long.length <= 30);
  assert.match(long, /auto-edit/);
});