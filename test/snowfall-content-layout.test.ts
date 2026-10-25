// Regression contract for Snowfall's wide-terminal reading measure.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Container, type Component } from '@earendil-works/pi-tui';
import { renderLayoutFrame, getLayoutBoxesAt } from '@earendil-works/pi-tui/dist/layout.js';
import { visibleWidth } from '@earendil-works/pi-tui';
import { stripTerminalSequences } from '@earendil-works/pi-tui/dist/utils.js';
import { contentMetrics as snowfallContentMetrics, centeredRow as snowfallCenteredRow } from '../src/app/contentLayout.js';

function fixed(text: string): Component {
  const cell = new Container();
  cell.render = (width) => [(text + ' '.repeat(width)).slice(0, width)];
  return cell;
}

test('the shared reading measure keeps narrow widths and caps wide content at 100', () => {
  assert.deepEqual(snowfallContentMetrics(1), { contentWidth: 1, left: 0, right: 0 });
  assert.deepEqual(snowfallContentMetrics(80), { contentWidth: 80, left: 0, right: 0 });
  assert.deepEqual(snowfallContentMetrics(100), { contentWidth: 100, left: 0, right: 0 });
  assert.deepEqual(snowfallContentMetrics(101), { contentWidth: 100, left: 0, right: 1 });
  assert.deepEqual(snowfallContentMetrics(120), { contentWidth: 100, left: 10, right: 10 });
  assert.deepEqual(snowfallContentMetrics(200), { contentWidth: 100, left: 50, right: 50 });
});

test('centered rows expose identical visual and mouse geometry at resize boundaries', () => {
  for (const width of [1, 20, 80, 99, 100, 101, 102, 119, 120, 200]) {
    const metrics = snowfallContentMetrics(width);
    const child = fixed('EDITOR');
    const row = snowfallCenteredRow(child);
    const frame = renderLayoutFrame(row, width, 1, () => {});
    if (width >= 6) assert.equal(stripTerminalSequences(frame.lines[0]!).indexOf('EDITOR'), metrics.left, `visual origin at ${width}`);
    assert.equal(visibleWidth(frame.lines[0]!), width);
    const target = getLayoutBoxesAt(frame, metrics.left, 0).find((box) => box.component === child);
    assert.ok(target, 'content is a real mouse layout box');
    assert.equal(target.rect.x, metrics.left);
    assert.equal(target.rect.width, metrics.contentWidth);
  }
});

test('a centered row uses explicit non-shrinking margins, including odd extra columns', () => {
  const row = snowfallCenteredRow(fixed('1234567890'));
  const frame = renderLayoutFrame(row, 101, 1, () => {});
  assert.equal(stripTerminalSequences(frame.lines[0]!).indexOf('1234567890'), 0);
  assert.equal(visibleWidth(frame.lines[0]!), 101);
  const wide = renderLayoutFrame(snowfallCenteredRow(fixed('1234567890')), 103, 1, () => {});
  assert.equal(stripTerminalSequences(wide.lines[0]!).indexOf('1234567890'), 1);
  assert.equal(visibleWidth(wide.lines[0]!), 103);
});
