import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, parseInline, matchFence, closesFence, type MdBlock } from '../src/util/markdown.js';

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

test('parseInline splits links into an accented label + a dim "(url)" span, and leaves code contents literal', () => {
  assert.deepEqual(parseInline('see [docs](https://x.y)'), [
    { text: 'see ' },
    { text: 'docs', linkLabel: true, url: 'https://x.y' },
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

test('P1A-13: matchFence classifies only legal fence lines (<=3 indent, >=3 ticks)', () => {
  assert.ok(matchFence('```'), '3 ticks open');
  assert.ok(matchFence('   ```ts'), '3-space indent allowed');
  assert.ok(matchFence('~~~~'), '4 tildes');
  assert.ok(matchFence('````md'), '4-tick fence with lang');
  assert.equal(matchFence('    ```'), null, '4-space-indented line is NOT a fence');
  assert.equal(matchFence('``'), null, '2 ticks are not a fence');
  assert.equal(matchFence('backticks in prose'), null, 'inline code not a fence');
});

test('P1A-13: closesFence is width-correct — same char required, width must be >= opener', () => {
  const open4 = { char: '`' as const, width: 4 };
  assert.ok(closesFence('````', open4), '4-tick close ends a 4-tick fence');
  assert.ok(closesFence('``````', open4), 'wider close ends a 4-tick fence');
  assert.equal(closesFence('```', open4), false, 'a 3-tick line does NOT close a 4-tick fence');
  assert.equal(closesFence('~~~', open4), false, 'a tilde line does NOT close a backtick fence');
  const open3 = { char: '`' as const, width: 3 };
  assert.ok(closesFence('```', open3), '3-tick close ends a 3-tick fence');
  assert.equal(closesFence('``', open3), false, 'narrower close does not end a 3-tick fence');
});

test('P1A-13: parseMarkdown renders a 4-tick fence containing 3-tick lines as ONE code block', () => {
  const blocks = parseMarkdown(['````md', 'code ```here```', 'more', '````'].join('\n'));
  assert.equal(blocks.length, 1, 'the inner 3-tick line did not close the 4-tick fence');
  const code = blocks[0] as Extract<MdBlock, { type: 'code' }>;
  assert.equal(code.type, 'code');
  assert.equal(code.lang, 'md');
  assert.equal(code.code, 'code ```here```\nmore');
  assert.equal(code.closed, true);
});

test('P1A-13: parseMarkdown treats a 4-space-indented ``` as indented code, not a fence', () => {
  const blocks = parseMarkdown('    ```\n    not a fence\n    ```\n');
  // No fence is opened, so nothing collapses; the lines are ordinary paragraph text.
  assert.ok(blocks.every((b) => b.type !== 'code'), 'no code fence opened');
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
  assert.deepEqual(lists.map((l) => l.start ?? 1), [1, 2, 3], 'each keeps its source start number');
});
