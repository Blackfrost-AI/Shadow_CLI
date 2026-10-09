import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThinkingSplitter, type SplitSpan } from '../src/util/thinkingTags.js';

function run(chunks: string[]): { text: string; thinking: string } {
  const splitter = new ThinkingSplitter();
  const spans: SplitSpan[] = [];
  for (const chunk of chunks) spans.push(...splitter.push(chunk));
  spans.push(...splitter.flush());
  return {
    text: spans.filter((s) => s.kind === 'text').map((s) => s.text).join(''),
    thinking: spans.filter((s) => s.kind === 'thinking').map((s) => s.text).join(''),
  };
}

// Every possible two-chunk split, and character-sized chunks, must agree. The old
// bare-closer heuristic changed already-emitted prose only in larger SSE frames.
function checkChunking(source: string, expected: { text: string; thinking: string }): void {
  assert.deepEqual(run([source]), expected);
  assert.deepEqual(run([...source]), expected, 'character chunks');
  for (let i = 0; i <= source.length; i++) {
    assert.deepEqual(run([source.slice(0, i), source.slice(i)]), expected, `split at ${i}`);
  }
}

test('only a leading structural block is split, with variant and namespaced tags', () => {
  for (const [open, close] of [
    ['<think>', '</think>'], ['<thinking>', '</thinking>'],
    ['<think>', '</think >'], ['<think>', '< / think >'],
    ['<mm:think>', '</mm:think>'], ['< mm : thinking >', '</ MM : THINKING >'],
  ]) {
    checkChunking(` \n${open}reasoning${close}Answer`, { text: 'Answer', thinking: 'reasoning' });
  }
});

test('unclosed structural reasoning still surfaces', () => {
  checkChunking('<think>still going', { text: '', thinking: 'still going' });
});

test('bare closing tags are structural only at the start', () => {
  for (const close of ['</think>', '</mm:think>', '</ MM : THINKING >']) {
    checkChunking(` \n${close}Answer`, { text: 'Answer', thinking: '' });
    const prose = `Document ${close} here.`;
    checkChunking(prose, { text: prose, thinking: '' });
  }
});

test('literal tags in prose, quotes, and code never swallow the answer', () => {
  for (const source of [
    'Document `<think>` as a literal XML token; keep the rest.',
    'before<think>example</think>after',
    'The closing tag is </think> and this is still an answer.',
    '"<think>demo</think>" is a string.',
    '```xml\n<think>demo</think>\n```\nMore text.',
    '    <think>indented code</think>',
    'hello world', '<p>hello</p>', '</div>hello',
    '1 < 2 and 3 > 2', 'ends with <', 'some text <div',
  ]) checkChunking(source, { text: source, thinking: '' });
});

test('after the leading block closes, every later tag is answer content', () => {
  const answer = 'Use <think>demo</think> then </think> literally.';
  checkChunking(`<think>reasoning</think>${answer}`, { text: answer, thinking: 'reasoning' });
});

test('unfinished potential tags and whitespace are preserved at EOF', () => {
  for (const source of ['<', '<thi', '</mm', ' \n', '  <div']) {
    checkChunking(source, { text: source, thinking: '' });
  }
});
