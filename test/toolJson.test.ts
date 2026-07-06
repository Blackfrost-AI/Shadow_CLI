import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToolArgs } from '../src/provider/toolJson.js';

test('parseToolArgs: strict-valid and empty', () => {
  assert.deepEqual(parseToolArgs('{"path":"a.txt"}').value, { path: 'a.txt' });
  assert.equal(parseToolArgs('{"path":"a.txt"}').repaired, undefined);
  assert.deepEqual(parseToolArgs('').value, {}, 'empty args → {}');
  assert.deepEqual(parseToolArgs('   ').value, {});
});

test('parseToolArgs: strips a ```json code fence', () => {
  const r = parseToolArgs('```json\n{"path":"x"}\n```');
  assert.ok(r.ok && r.repaired);
  assert.deepEqual(r.value, { path: 'x' });
});

test('parseToolArgs: drops surrounding prose, keeps the object span', () => {
  const r = parseToolArgs('Sure! Here are the args: {"command":"ls -la"} — hope that helps');
  assert.ok(r.ok);
  assert.deepEqual(r.value, { command: 'ls -la' });
});

test('parseToolArgs: removes trailing commas', () => {
  assert.deepEqual(parseToolArgs('{"a":1,"b":2,}').value, { a: 1, b: 2 });
  assert.deepEqual(parseToolArgs('{"xs":[1,2,3,]}').value, { xs: [1, 2, 3] });
});

test('parseToolArgs: Python literals → JSON', () => {
  assert.deepEqual(parseToolArgs('{"all":True,"none":None,"off":False}').value, {
    all: true,
    none: null,
    off: false,
  });
});

test('parseToolArgs: single-quoted object → double quotes', () => {
  assert.deepEqual(parseToolArgs("{'path':'a.txt'}").value, { path: 'a.txt' });
});

test('parseToolArgs: double-encoded JSON string is unwrapped', () => {
  assert.deepEqual(parseToolArgs('"{\\"path\\":\\"a.txt\\"}"').value, { path: 'a.txt' });
});

test('parseToolArgs: unrepairable → ok:false with a message', () => {
  const r = parseToolArgs('this is not json at all <<<');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /not valid JSON/);
});

test('parseToolArgs: escapes literal newlines inside a string value', () => {
  // a weak model wrote a multi-line value with RAW newlines — JSON.parse rejects this
  const raw = '{"content":"line1\nline2\nline3"}';
  const r = parseToolArgs(raw);
  assert.ok(r.ok && r.repaired, 'should repair, not strict-parse');
  assert.equal(r.value.content, 'line1\nline2\nline3');
});

test('parseToolArgs: escapes literal tabs inside a string value', () => {
  const r = parseToolArgs('{"content":"col1\tcol2"}');
  assert.ok(r.ok && r.repaired);
  assert.equal(r.value.content, 'col1\tcol2');
});

test('parseToolArgs: a write_file with a multi-line JSON document as content', () => {
  // the exact failure: inner quotes escaped, but RAW newlines inside the content value
  const raw = '{"path":"ds.json","content":"{\n  \\"batch\\": 4,\n  \\"lr\\": 0.001\n}"}';
  const r = parseToolArgs(raw);
  assert.ok(r.ok && r.repaired);
  assert.equal(r.value.path, 'ds.json');
  assert.equal(r.value.content, '{\n  "batch": 4,\n  "lr": 0.001\n}');
});

test('parseToolArgs: properly-escaped newlines parse strictly, untouched', () => {
  const r = parseToolArgs('{"content":"a\\nb"}');
  assert.ok(r.ok);
  assert.equal(r.repaired, undefined, 'strict parse, no repair');
  assert.equal(r.value.content, 'a\nb');
});
