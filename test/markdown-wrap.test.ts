import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapSpans, parseInline, type MdSpan } from '../src/util/markdown.js';

const plain = (lines: MdSpan[][]): string[] => lines.map((ln) => ln.map((s) => s.text).join(''));

test('wrapSpans wraps flush — no leading space on continuation lines (the Ink trim:false bug)', () => {
  const spans = parseInline('I am going to build a genuinely modern housesitting service landing page and make it feel organic');
  const lines = plain(wrapSpans(spans, 30));
  assert.ok(lines.length > 1, 'should wrap onto multiple lines');
  for (const l of lines) {
    assert.equal(l, l.trimStart(), `line "${l}" must be flush-left (no leading space)`);
  }
});

test('wrapSpans reflows source newlines to spaces (hard-wrapped paragraph → one flow)', () => {
  const spans = parseInline('first line\nsecond line');
  assert.deepEqual(plain(wrapSpans(spans, 100)), ['first line second line']);
});

test('wrapSpans collapses runs of whitespace to a single space', () => {
  const spans: MdSpan[] = [{ text: 'a     b\t\tc' }];
  assert.deepEqual(plain(wrapSpans(spans, 100)), ['a b c']);
});

test('wrapSpans preserves inline formatting per word', () => {
  const flat = wrapSpans(parseInline('run **bold** then `code` end'), 100).flat();
  assert.ok(flat.some((s) => s.text === 'bold' && s.bold), 'bold word keeps bold');
  assert.ok(flat.some((s) => s.text === 'code' && s.code), 'code word keeps code');
});

test('wrapSpans emits an over-long word whole rather than splitting it (URLs/code safe)', () => {
  const url = 'https://example.com/really/long/path/that/exceeds/the/width';
  const lines = plain(wrapSpans([{ text: `see ${url} now` }], 12));
  assert.ok(lines.some((l) => l.includes(url)), 'long token stays intact');
});

test('wrapSpans handles degenerate widths without throwing (returns unwrapped)', () => {
  const spans: MdSpan[] = [{ text: 'hello world' }];
  assert.deepEqual(plain(wrapSpans(spans, 0)), ['hello world']);
  assert.deepEqual(plain(wrapSpans(spans, -5)), ['hello world']);
});
