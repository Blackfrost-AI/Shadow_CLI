// Regression contract for Snowfall's terminal-width layout.
//
// 10.6.2 introduced a fixed 100-column reading measure that shrank every surface into a centered
// column. On normal-width terminals that reads as a broken, boxed-in window, so content spans the
// full terminal width again (10.6.0/10.6.1 behavior). These tests pin that contract.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Container, type Component } from '@earendil-works/pi-tui';
import { renderLayoutFrame } from '@earendil-works/pi-tui/dist/layout.js';
import { visibleWidth } from '@earendil-works/pi-tui';
import { stripTerminalSequences } from '@earendil-works/pi-tui/dist/utils.js';
import { contentMetrics as snowfallContentMetrics, centeredRow as snowfallCenteredRow } from '../src/app/contentLayout.js';

function fixed(text: string): Component {
  const cell = new Container();
  cell.render = (width) => [(text + ' '.repeat(width)).slice(0, width)];
  return cell;
}

test('the shared measure uses the full terminal width at every size', () => {
  for (const width of [1, 2, 20, 79, 80, 99, 100, 101, 119, 120, 160, 200, 240, 300]) {
    assert.deepEqual(
      snowfallContentMetrics(width),
      { contentWidth: width, left: 0, right: 0 },
      `full width at ${width}`,
    );
  }
});

test('the measure never emits a negative or fractional width', () => {
  assert.deepEqual(snowfallContentMetrics(0), { contentWidth: 1, left: 0, right: 0 });
  assert.deepEqual(snowfallContentMetrics(-5), { contentWidth: 1, left: 0, right: 0 });
  assert.deepEqual(snowfallContentMetrics(120.7), { contentWidth: 120, left: 0, right: 0 });
});

test('content rows fill the viewport with no gutters at resize boundaries', () => {
  for (const width of [1, 20, 80, 99, 100, 101, 102, 119, 120, 200, 300]) {
    const frame = renderLayoutFrame(snowfallCenteredRow(fixed('EDITOR')), width, 1, () => {});
    const line = stripTerminalSequences(frame.lines[0]!);
    if (width >= 6) assert.equal(line.indexOf('EDITOR'), 0, `content starts at column 0 at ${width}`);
    assert.equal(visibleWidth(frame.lines[0]!), width, `row spans the viewport at ${width}`);
  }
});

test('wide terminals are not collapsed into a centered reading measure', () => {
  // The 10.6.2 regression: at 200 columns the editor began at column 20 and stopped at 180.
  const frame = renderLayoutFrame(snowfallCenteredRow(fixed('EDITOR')), 200, 1, () => {});
  const line = stripTerminalSequences(frame.lines[0]!);
  assert.equal(line.indexOf('EDITOR'), 0);
  assert.equal(visibleWidth(frame.lines[0]!), 200);
  assert.ok(!line.startsWith(' '), 'no left gutter is introduced');
});