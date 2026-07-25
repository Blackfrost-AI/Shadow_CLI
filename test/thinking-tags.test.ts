import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThinkingSplitter, type SplitSpan } from '../src/util/thinkingTags.js';

/** Feed chunks through a splitter and collect all spans (push each, then flush). */
function run(chunks: string[]): SplitSpan[] {
  const s = new ThinkingSplitter();
  const out: SplitSpan[] = [];
  for (const c of chunks) out.push(...s.push(c));
  out.push(...s.flush());
  return out;
}

/** Collapse adjacent same-kind spans so assertions don't depend on chunk granularity. */
function merge(spans: SplitSpan[]): SplitSpan[] {
  const out: SplitSpan[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && last.kind === s.kind) last.text += s.text;
    else out.push({ ...s });
  }
  return out;
}

test('splits an inline <think> block from surrounding text', () => {
  assert.deepEqual(merge(run(['before<think>reasoning</think>after'])), [
    { kind: 'text', text: 'before' },
    { kind: 'thinking', text: 'reasoning' },
    { kind: 'text', text: 'after' },
  ]);
});

test('handles the <thinking> variant too', () => {
  assert.deepEqual(merge(run(['<thinking>r</thinking>answer'])), [
    { kind: 'thinking', text: 'r' },
    { kind: 'text', text: 'answer' },
  ]);
});

test('reassembles a tag split across chunk boundaries', () => {
  assert.deepEqual(merge(run(['a<thi', 'nk>b</thi', 'nk>c'])), [
    { kind: 'text', text: 'a' },
    { kind: 'thinking', text: 'b' },
    { kind: 'text', text: 'c' },
  ]);
});

test('plain text with no tags passes through unchanged', () => {
  assert.deepEqual(merge(run(['hello ', 'world'])), [{ kind: 'text', text: 'hello world' }]);
});

test('an unclosed thinking tag still surfaces its content as reasoning', () => {
  assert.deepEqual(merge(run(['a<think>still going'])), [
    { kind: 'text', text: 'a' },
    { kind: 'thinking', text: 'still going' },
  ]);
});

test('a lone "<" is not mistaken for a tag', () => {
  assert.deepEqual(merge(run(['1 < 2 and 3 > 2'])), [{ kind: 'text', text: '1 < 2 and 3 > 2' }]);
});

// ── regression: the Qwen / local-model messes that used to break ──────────────

test('whitespace/variant closer still closes — no "thinks forever" stall', () => {
  // `</think >` (space before >) used to never match, swallowing the whole answer into thinking.
  assert.deepEqual(merge(run(['<think>reason</think >answer'])), [
    { kind: 'thinking', text: 'reason' },
    { kind: 'text', text: 'answer' },
  ]);
  // `< / think >` — spaces around the slash, too.
  assert.deepEqual(merge(run(['<think>r< / think >a'])), [
    { kind: 'thinking', text: 'r' },
    { kind: 'text', text: 'a' },
  ]);
});

test('bare closer (no opener) routes the lead to reasoning and strips the tag', () => {
  // Qwen chat templates emit reasoning with NO opening tag, then a lone </think>, then the answer.
  // The raw </think> must not leak into the answer, and the lead is reasoning.
  assert.deepEqual(merge(run(['let me reason</think>The answer is 42.'])), [
    { kind: 'thinking', text: 'let me reason' },
    { kind: 'text', text: 'The answer is 42.' },
  ]);
});

test('variant closer split across chunk boundaries still reassembles', () => {
  assert.deepEqual(merge(run(['<think>hidden</thi', 'nk >visible'])), [
    { kind: 'thinking', text: 'hidden' },
    { kind: 'text', text: 'visible' },
  ]);
});

// ── namespaced reasoning tags (MiniMax-M `mm:think`) ─────────────────────────────────────────
// The matchers required `think` immediately after `<` / `</`, so `</mm:think>` matched nothing
// and fell through to the TEXT channel: it rendered at the head of the answer AND was persisted
// into history, replayed to the model every later turn.

/** Just the visible text, which is what leaked. */
const textOf = (spans: SplitSpan[]): string =>
  merge(spans).filter((s) => s.kind === 'text').map((s) => s.text).join('');
const thinkOf = (spans: SplitSpan[]): string =>
  merge(spans).filter((s) => s.kind === 'thinking').map((s) => s.text).join('');

test('a bare namespaced closer means everything before it was reasoning', () => {
  const spans = run(['</mm:think>Here are the top results']);
  assert.equal(textOf(spans), 'Here are the top results');
  assert.equal(thinkOf(spans), '');
});

test('a full namespaced block splits like an un-namespaced one', () => {
  const spans = run(['<mm:think>reasoning</mm:think>X']);
  assert.equal(thinkOf(spans), 'reasoning');
  assert.equal(textOf(spans), 'X');
});

test('namespaced tags are case-insensitive and whitespace-tolerant', () => {
  assert.equal(textOf(run(['</MM:THINKING>Answer'])), 'Answer');
  assert.equal(textOf(run(['</ mm : think >Answer'])), 'Answer');
  assert.equal(textOf(run(['< mm : thinking >r</ mm : thinking >Answer'])), 'Answer');
});

test('ordinary HTML is NOT mistaken for a reasoning tag', () => {
  assert.equal(textOf(run(['<p>hello</p>'])), '<p>hello</p>');
  assert.equal(textOf(run(['</div>hello'])), '</div>hello');
  assert.equal(textOf(run(['a <b>bold</b> word'])), 'a <b>bold</b> word');
});

test('a namespaced tag split across chunks never leaks its head', () => {
  // The case PARTIAL_RE protects: without namespace awareness the first chunk emits '</mm' as
  // visible text and only the second chunk recognizes ':think>' — a partial leak that does not
  // reproduce reliably.
  const s = new ThinkingSplitter();
  const first = s.push('Hello </mm');
  assert.equal(first.filter((x) => x.kind === 'text').map((x) => x.text).join(''), 'Hello ',
    "the '</mm' head must be held back, not emitted");
  const rest = [...s.push(':think>World'), ...s.flush()];
  const all = merge([...first, ...rest]);
  const text = all.filter((x) => x.kind === 'text').map((x) => x.text).join('');
  assert.equal(text, 'Hello World');
  assert.ok(!text.includes('</mm'), 'the tag head must never reach the text channel');
});

test('held-back text is a DELAY, never data loss — flush() releases it', () => {
  // push() emits everything up to the maybe-tag and holds only the tail; flush() releases the
  // tail. Across both, nothing is lost — that is the whole cost of the wider PARTIAL_RE.
  assert.equal(textOf(run(['some text <div'])), 'some text <div');
  assert.equal(textOf(run(['ends with <'])), 'ends with <');
  assert.equal(textOf(run(['a <span', ' class=x>b'])), 'a <span class=x>b');
});
