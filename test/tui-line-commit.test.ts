import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCommittableUnits } from '../src/tui.js';

// Line-granular streaming commit (the "Claude Code feel"): prose commits per line so the live region
// stays ~1 line and the composer holds still, while multi-line constructs stay grouped so nothing
// misrenders. `rest` is what remains in the live region. Each unit carries `pad` — a gap is owed
// before it — mirroring the non-streamed Markdown renderer EXACTLY: a gap at every source blank line
// AND at every block boundary (heading/rule/list/quote/table/fence, before and after); only
// prose-after-prose hugs, because consecutive prose lines are one paragraph. Streamed and
// non-streamed output must be rhythm-identical regardless of where the stream is cut.

const texts = (r: { units: { text: string }[] }): string[] => r.units.map((u) => u.text);

test('prose commits per line; the still-typing tail stays live', () => {
  const r = extractCommittableUnits('line one\nline two\nlin');
  assert.deepEqual(texts(r), ['line one', 'line two']);
  assert.equal(r.rest, 'lin', 'the final partial line is still being typed → live');
});

test('a completed prose line commits immediately (buffer ends with newline)', () => {
  const r = extractCommittableUnits('hello world\n');
  assert.deepEqual(texts(r), ['hello world']);
  assert.equal(r.rest, '', 'nothing left live');
});

test('an OPEN code fence stays entirely live (never split)', () => {
  const r = extractCommittableUnits('```js\nconst a = 1\nconst b = 2\n');
  assert.deepEqual(texts(r), [], 'nothing committed while the fence is open');
  assert.equal(r.rest, '```js\nconst a = 1\nconst b = 2\n', 'held live WITH the trailing newline preserved');
});

test('a CLOSED code fence commits as ONE unit', () => {
  const r = extractCommittableUnits('```js\ncode\n```\n');
  assert.deepEqual(texts(r), ['```js\ncode\n```']);
  assert.equal(r.rest, '');
});

test('prose BEFORE a fence commits per line; the fence stays whole', () => {
  const r = extractCommittableUnits('intro line\n```\ncode\n');
  assert.deepEqual(texts(r), ['intro line']);
  assert.equal(r.rest, '```\ncode\n', 'open fence held live (trailing newline preserved)');
});

test('a list is kept grouped (held live) until it ends', () => {
  const r = extractCommittableUnits('- one\n- two\n');
  assert.deepEqual(texts(r), [], 'list items are not committed one-by-one (would break numbering/grouping)');
  assert.equal(r.rest, '- one\n- two\n');
  // once a blank line ends the list, it commits as a single block
  const done = extractCommittableUnits('- one\n- two\n\n');
  assert.deepEqual(texts(done), ['- one\n- two']);
  assert.equal(done.rest, '');
});

test('blockquotes and pipe/table rows are kept grouped', () => {
  assert.deepEqual(texts(extractCommittableUnits('> quoted\n> more\n')), [], 'quote held live until it ends');
  const table = extractCommittableUnits('| a | b |\n| - | - |\n\n');
  assert.deepEqual(texts(table), ['| a | b |\n| - | - |'], 'a table commits whole so rows align');
});

test('headings and rules commit standalone', () => {
  const r = extractCommittableUnits('# Title\ntext after\n---\n');
  assert.deepEqual(texts(r), ['# Title', 'text after', '---']);
});

// ── Paragraph rhythm (`pad`) ─────────────────────────────────────────────────
// The #1 "cluttered output" bug: dropping every blank separator glued ALL streamed blocks
// together. `pad` preserves the source's blank-line rhythm through the per-line commit.

test('a blank line between paragraphs marks the NEXT unit pad=true; hard-wrapped lines stay tight', () => {
  const r = extractCommittableUnits('para one line a\npara one line b\n\npara two\n');
  assert.deepEqual(
    r.units.map((u) => ({ text: u.text, pad: u.pad })),
    [
      { text: 'para one line a', pad: false },
      { text: 'para one line b', pad: false }, // same paragraph → hugs
      { text: 'para two', pad: true }, // blank line before it → breathes
    ],
  );
});

test('block boundaries pad on BOTH sides: a heading pads itself and the text after it', () => {
  // parseMarkdown renders heading + paragraph as two blocks with a gap between them (even with no
  // source blank line), so the streamed commit must match: '# Section' is a block → pad, and
  // 'body line' follows a block → pad.
  const r = extractCommittableUnits('intro\n\n# Section\nbody line\n');
  assert.deepEqual(
    r.units.map((u) => ({ text: u.text, pad: u.pad })),
    [
      { text: 'intro', pad: false },
      { text: '# Section', pad: true },
      { text: 'body line', pad: true },
    ],
  );
});

test('abutting blocks with NO source blank still pad (streamed === non-streamed rhythm)', () => {
  // The verifier's repro set: prose→list, list→prose, fence→prose — all render with a gap
  // non-streamed (Markdown puts marginTop between every block pair), so streamed must too.
  const proseList = extractCommittableUnits('Steps to reproduce:\n1. run it\n2. watch\n\ndone\n');
  assert.deepEqual(
    proseList.units.map((u) => ({ text: u.text, pad: u.pad })),
    [
      { text: 'Steps to reproduce:', pad: false },
      { text: '1. run it\n2. watch', pad: true }, // list is a block → gap even without a blank
      { text: 'done', pad: true }, // follows a block → gap
    ],
  );
  const fenceProse = extractCommittableUnits('```\ncode\n```\nafter fence\n');
  assert.deepEqual(
    fenceProse.units.map((u) => ({ text: u.text, pad: u.pad })),
    [
      { text: '```\ncode\n```', pad: true },
      { text: 'after fence', pad: true },
    ],
  );
});

test('a ``` inside a ~~~ fence is literal content — only the SAME marker closes (parseMarkdown parity)', () => {
  const r = extractCommittableUnits('~~~\ncode\n```\nmore\n~~~\n\nend\n');
  assert.deepEqual(
    r.units.map((u) => u.text),
    ['~~~\ncode\n```\nmore\n~~~', 'end'],
    'the inner ``` did not split the ~~~ fence',
  );
});

test('trailingBlank survives a delta-batch boundary via startPadded (paragraph break on the seam)', () => {
  // Batch 1 ends exactly on the blank separator…
  const a = extractCommittableUnits('first para\n\n');
  assert.deepEqual(texts(a), ['first para']);
  assert.equal(a.trailingBlank, true, 'the consumed blank is reported back to the caller');
  // …batch 2 starts with the next paragraph: seeding startPadded pads it.
  const b = extractCommittableUnits('second para\n', a.trailingBlank);
  assert.deepEqual(
    b.units.map((u) => ({ text: u.text, pad: u.pad })),
    [{ text: 'second para', pad: true }],
  );
});

test('a grouped construct after a blank keeps its pad across the rest carry', () => {
  const r = extractCommittableUnits('intro\n\n- item1\n- item2\n\n');
  assert.deepEqual(
    r.units.map((u) => ({ text: u.text, pad: u.pad })),
    [
      { text: 'intro', pad: false },
      { text: '- item1\n- item2', pad: true }, // the blank preceded the list
    ],
  );
});

test('incremental streaming (deltas fed one at a time) commits every line exactly once, in order', () => {
  // Mirrors the real handler: accumulate deltas, extract units, carry `rest` AND `trailingBlank`
  // forward, commit the leftover on done. This is the path that would drop/duplicate content if the
  // split were wrong, because a construct can straddle delta boundaries.
  const answer =
    'Here is the plan.\nIt has two parts.\n\nSteps:\n- First step\n- Second step\n\n```js\nconst x = 1\nconsole.log(x)\n```\n\nAll done.';
  const deltas: string[] = [];
  for (let i = 0; i < answer.length; i += 3) deltas.push(answer.slice(i, i + 3)); // 3-char chunks split lines/fences

  let buf = '';
  let carry = false;
  const committed: { text: string; pad: boolean }[] = [];
  for (const d of deltas) {
    buf += d;
    const { units, rest, trailingBlank } = extractCommittableUnits(buf, carry);
    for (const u of units) if (u.text.trim()) committed.push(u);
    carry = trailingBlank;
    buf = rest;
  }
  if (buf.trim()) committed.push({ text: buf, pad: carry }); // assistant_done commits the leftover

  const got = committed.map((u) => u.text).join('\n').split('\n').filter((l) => l.trim() !== '');
  const want = answer.split('\n').filter((l) => l.trim() !== '');
  assert.deepEqual(got, want, 'streamed content is fully reconstructed with nothing lost or duplicated');
  // the fence survived as one contiguous unit across delta boundaries
  assert.ok(committed.some((u) => u.text.startsWith('```js') && u.text.includes('console.log(x)') && u.text.trimEnd().endsWith('```')), 'the code fence committed whole');
  // and the block rhythm survived the 3-char chunking: "Steps:" (blank before), the list (a block),
  // the fence (a block), and the closer (blank before) all pad — matching the non-streamed render.
  const padded = committed.filter((u) => u.pad).map((u) => u.text.split('\n')[0]);
  assert.deepEqual(padded, ['Steps:', '- First step', '```js', 'All done.'], 'every block boundary keeps its gap');
});

test('no content is lost or duplicated: every non-blank line appears exactly once, in order', () => {
  const buf = 'para a\npara b\n\n- item1\n- item2\n\n```\ncode\n```\ntail';
  const r = extractCommittableUnits(buf);
  const flat = [...texts(r), r.rest].join('\n').split('\n').filter((l) => l.trim() !== '');
  const original = buf.split('\n').filter((l) => l.trim() !== '');
  assert.deepEqual(flat, original, 'reconstruction (minus dropped blank separators) matches the input, in order');
});
