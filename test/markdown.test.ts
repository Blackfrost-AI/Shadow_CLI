import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, parseInline, type MdBlock } from '../src/util/markdown.js';

test('parseInline splits bold, italic, and inline code', () => {
  const spans = parseInline('a **b** c *d* e `f`');
  assert.deepEqual(spans, [
    { text: 'a ' },
    { text: 'b', bold: true },
    { text: ' c ' },
    { text: 'd', italic: true },
    { text: ' e ' },
    { text: 'f', code: true },
  ]);
});

test('parseInline splits links into label + a dim "(url)" span, and leaves code contents literal', () => {
  assert.deepEqual(parseInline('see [docs](https://x.y)'), [
    { text: 'see ' },
    { text: 'docs' },
    { text: ' (https://x.y)', link: true },
  ]);
  assert.deepEqual(parseInline('`a**b**c`'), [{ text: 'a**b**c', code: true }]);
});

test('parseMarkdown handles headings, lists, quotes, and rules', () => {
  const blocks = parseMarkdown(
    ['# Title', '', 'para line', '', '- one', '- two', '', '> quoted', '', '---'].join('\n'),
  );
  const types = blocks.map((b) => b.type);
  assert.deepEqual(types, ['heading', 'paragraph', 'list', 'quote', 'rule']);
  const heading = blocks[0] as Extract<MdBlock, { type: 'heading' }>;
  assert.equal(heading.level, 1);
  assert.equal(heading.spans[0]!.text, 'Title');
  const list = blocks[2] as Extract<MdBlock, { type: 'list' }>;
  assert.equal(list.ordered, false);
  assert.equal(list.items.length, 2);
  assert.equal(list.items[1]![0]!.text, 'two');
});

test('parseMarkdown captures a closed fenced code block with language', () => {
  const blocks = parseMarkdown(['```ts', 'const x = 1;', 'const y = 2;', '```'].join('\n'));
  assert.equal(blocks.length, 1);
  const code = blocks[0] as Extract<MdBlock, { type: 'code' }>;
  assert.equal(code.type, 'code');
  assert.equal(code.lang, 'ts');
  assert.equal(code.code, 'const x = 1;\nconst y = 2;');
  assert.equal(code.closed, true);
});

test('parseMarkdown treats an unterminated fence as an open code block (streaming tail)', () => {
  // A half-streamed code block must not swallow rendering or render a broken fence.
  const blocks = parseMarkdown(['text before', '', '```py', 'print(1)'].join('\n'));
  assert.deepEqual(blocks.map((b) => b.type), ['paragraph', 'code']);
  const code = blocks[1] as Extract<MdBlock, { type: 'code' }>;
  assert.equal(code.lang, 'py');
  assert.equal(code.code, 'print(1)');
  assert.equal(code.closed, false);
});

test('parseMarkdown keeps ordered-list numbering distinct from bullets', () => {
  const blocks = parseMarkdown(['1. first', '2. second'].join('\n'));
  const list = blocks[0] as Extract<MdBlock, { type: 'list' }>;
  assert.equal(list.ordered, true);
  assert.equal(list.items.length, 2);
  assert.equal(list.items[0]![0]!.text, 'first');
});

test('ordered lists keep their SOURCE numbers (blank-separated steps no longer all render "1.")', () => {
  const blocks = parseMarkdown('1. first\n\n2. second\n\n3. third\n');
  const lists = blocks.filter((b) => b.type === 'list');
  assert.equal(lists.length, 3, 'blank-separated items parse as three lists');
  // @ts-expect-error narrow
  assert.deepEqual(lists.map((l) => l.start ?? 1), [1, 2, 3], 'each keeps its source start number');
});
