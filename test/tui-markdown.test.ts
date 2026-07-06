import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { Markdown } from '../src/tui.js';

/** Render a markdown string through the chat canvas and return the terminal frame. */
function frameOf(source: string): string {
  const { lastFrame, unmount } = render(React.createElement(Markdown, { source }));
  const frame = lastFrame() ?? '';
  unmount();
  return frame;
}

test('Markdown canvas renders headings, bullets, and a fenced code block', () => {
  const frame = frameOf(['# Title', '', 'do **this**', '', '- one', '- two', '', '```ts', 'const x = 1;', '```'].join('\n'));
  assert.match(frame, /Title/);
  assert.match(frame, /• one/);
  assert.match(frame, /• two/);
  assert.match(frame, /this/);
  assert.match(frame, /const x = 1;/);
});

test('Markdown canvas leaves plain text intact (round-trips unchanged)', () => {
  const frame = frameOf('just a normal sentence with no markup');
  assert.match(frame, /just a normal sentence with no markup/);
});

test('Markdown canvas numbers ordered lists', () => {
  const frame = frameOf(['1. first', '2. second'].join('\n'));
  assert.match(frame, /1\. first/);
  assert.match(frame, /2\. second/);
});
