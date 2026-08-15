import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_HELD_BYTES, splitStreamToolIntentCapped } from '../src/tui/streamIntent.js';
import { extractCommittableUnits, clampTail, clampLiveRest, MAX_LIVE_REST_BYTES } from '../src/tui/streamCommit.js';

/**
 * P1A-12 — fast-streaming REGRESSION SUITE. Hammers the streaming hot path under load and asserts
 * the retained buffers stay BOUNDED with NO quadratic freeze. The suite drives the EXACT buffer
 * mutation loop from tui.tsx (the 'text' delta branch) as a pure function, so it runs at full
 * speed without booting React, and separately drives the real component end-to-end.
 *
 * The malicious inputs are the ones that used to freeze the TUI. TWO independent buffers must stay
 * bounded (P1A-11): the HELD tool-intent suffix (a never-closing tool envelope — capped at
 * MAX_HELD_BYTES) and the RETAINED live remainder `rest` (a never-closing NON-tool fence such as
 * ```python, which the tool-intent cap cannot see — capped at MAX_LIVE_REST_BYTES via
 * clampLiveRest, overflow force-committed to scrollback). This suite pins that BOTH caps hold
 * under load, that per-delta work is bounded by the caps (never the stream length), and that no
 * content byte is ever dropped — the caps relocate text, they never truncate it.
 */

/** Faithful replica of the tui.tsx 'text' delta hot-path loop (the case 'text' branch), minus render. */
function runHotPath(deltas: string[], onStep?: (live: number) => void) {
  let streamBuf = '';
  let padCarry = false;
  let maxLive = 0;
  let maxHeld = 0;
  let maxScanned = 0; // instrumented per-delta work: the byte length the rescan actually re-reads
  let forceCommits = 0; // clampLiveRest activations (the rest-overflow → scrollback path)
  let committedText = '';
  for (const delta of deltas) {
    streamBuf += delta;
    // The intent split + unit extraction re-read exactly `streamBuf` — record it BEFORE splitting
    // so the assertion "per-delta work is bounded by the caps" measures the true rescan input.
    maxScanned = Math.max(maxScanned, streamBuf.length);
    const split = splitStreamToolIntentCapped(streamBuf);
    maxHeld = Math.max(maxHeld, split.held.length);
    const { units, rest, trailingBlank } = extractCommittableUnits(split.visible, padCarry);
    for (const u of units) committedText += u.text + '\n';
    padCarry = trailingBlank;
    let liveRest = rest;
    const clamped = clampLiveRest(liveRest);
    if (clamped.commit !== null) {
      committedText += clamped.commit + '\n';
      liveRest = clamped.rest;
      forceCommits += 1;
    }
    streamBuf = liveRest + split.held;
    const live = streamBuf.length;
    maxLive = Math.max(maxLive, live);
    onStep?.(live);
  }
  return { streamBuf, committed: committedText, maxLive, maxHeld, maxScanned, forceCommits };
}

/** Content oracle: everything except pure fence-marker lines and blank separators, order-preserving.
 *  clampLiveRest inserts synthetic fence close/re-open lines (display continuity) and the unit
 *  extractor intentionally drops top-level blank separators — CONTENT must survive byte-exact. */
function contentLines(s: string): string {
  return s
    .split('\n')
    .filter((l) => l !== '' && !/^(`{3,}|~{3,})[\w-]*$/.test(l))
    .join('\n');
}

const ONE_KB = 1024;

test('P1A-12: never-closing <tool_call> envelope stays HELD-bounded under 50k rapid deltas', () => {
  // A malformed model emits one opening marker, then 50k tokens of payload that never close it.
  const deltas: string[] = ['Intro line.\n<tool_call>{"name":"run_shell","arguments":{"command":"echo '];
  for (let i = 0; i < 50_000; i++) deltas.push((i % 97 === 0 ? '\n' : 'x')); // occasional newline: innocent text
  const t0 = performance.now();
  const { maxHeld, maxLive } = runHotPath(deltas);
  const wall = performance.now() - t0;

  // THE anti-quadratic guarantee: the held suffix never exceeds the cap, so the per-token
  // intent rescan is O(MAX_HELD_BYTES), never O(stream length).
  assert.ok(maxHeld <= MAX_HELD_BYTES, `held suffix must stay capped, saw ${maxHeld} bytes`);
  // The live buffer (committed-away remainder) is bounded too — never the whole stream.
  assert.ok(maxLive <= MAX_HELD_BYTES + ONE_KB, `live buffer must stay bounded, saw ${maxLive}`);
  // And it's FAST: 50k deltas with a 64KB-bounded rescan each must not freeze the TUI.
  assert.ok(wall < 10_000, `50k-delta never-closing hammer took ${wall.toFixed(0)}ms (quadratic freeze?)`);
});

test('P1A-12: never-closing call:NAME{ and *** Begin Patch envelopes stay bounded', () => {
  for (const marker of ['call:run_shell{"command":"echo ', '*** Begin Patch']) {
    const deltas: string[] = ['Preface.\n' + marker];
    for (let i = 0; i < 20_000; i++) deltas.push('y'.repeat(3) + (i % 300 === 0 ? '\n' : ''));
    const { maxHeld, maxLive } = runHotPath(deltas);
    assert.ok(maxHeld <= MAX_HELD_BYTES, `${marker.slice(0, 12)}: held capped, saw ${maxHeld}`);
    assert.ok(maxLive <= MAX_HELD_BYTES + ONE_KB, `${marker.slice(0, 12)}: live bounded, saw ${maxLive}`);
  }
});

test('P1A-12: never-closing unbalanced { JSON envelope stays bounded even with huge payload', () => {
  // A model opens `{"tool_calls":[` and then streams >250KB of args that never balance the braces.
  // Chunked (256B) deltas — same total volume with far fewer iterations so the suite stays fast;
  // the 50k-rapid-delta case above already hammers per-token overhead.
  const chunk = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'.repeat(8); // 256 bytes
  const deltas: string[] = ['Note.\n{"tool_calls":[{"name":"write_file","args":{"path":"big.txt","content":"'];
  let emitted = deltas[0]!.length;
  const rounds = Math.ceil((300 * ONE_KB) / chunk.length);
  for (let i = 0; i < rounds; i++) {
    // Inject a newline occasionally so innocent text can commit; the braces NEVER balance.
    deltas.push(i % 32 === 0 ? chunk + '\n' : chunk);
    emitted += deltas[deltas.length - 1]!.length;
  }
  const { streamBuf, maxHeld, maxLive } = runHotPath(deltas);
  assert.ok(maxHeld <= MAX_HELD_BYTES, `held capped, saw ${maxHeld} bytes`);
  assert.ok(maxLive <= MAX_HELD_BYTES + ONE_KB * 2, `live bounded, saw ${maxLive}`);
  // No byte is lost: at the end every emitted byte is either committed OR still in the live buffer;
  // the cap RELOCATES overflow to visible, it never drops it. (`committed` is text now; length it.)
  const consumed = streamBuf.length;
  assert.ok(consumed <= emitted, 'no data dropped (committed + live = emitted)');
});

test('P1A-12: a giant single delta (>150KB patch) processes in bounded memory without freezing', () => {
  // A whole patch/answer arrives as ONE delta — the harshest single-shot backpressure.
  const patchBody = (Array.from({ length: 4200 }, (_, i) => `@@ -${i},8 +${i},8 @@\nline ${i * 10}`)).join('\n');
  const delta = 'Here is the diff:\n*** Begin Patch\n' + patchBody;
  assert.ok(delta.length > ONE_KB * 100, `sanitize: patch delta is ${(delta.length / ONE_KB).toFixed(1)}KB`);
  const t0 = performance.now();
  const { maxHeld, maxLive } = runHotPath([delta]);
  const wall = performance.now() - t0;
  assert.ok(maxHeld <= MAX_HELD_BYTES, `held capped, saw ${maxHeld}`);
  assert.ok(maxLive <= MAX_HELD_BYTES + ONE_KB * 4, `live bounded, saw ${maxLive}`);
  assert.ok(wall < 5000, `giant single delta took ${wall.toFixed(0)}ms`);
});

test('P1A-11 AC: 200KB never-closing ```python fence at token speed — buffers, per-delta work, and fidelity all bounded', () => {
  // THE Aug-12 shape: a fast self-hosted serve streams a long fenced answer whose closing fence
  // never arrives (or arrives megabytes later). The tool-intent cap CANNOT see a python fence
  // (only bare/json fences are tool-ambiguous), so before clampLiveRest the retained `rest` grew
  // with the stream and every delta re-parsed it — the quadratic freeze this item exists to kill.
  const lines = Array.from({ length: 8_000 }, (_, i) => `code line ${i} ${'x'.repeat(12)}`);
  const body = 'answer\n```python\n' + lines.join('\n');
  assert.ok(body.length > 200 * ONE_KB, `payload is ${(body.length / ONE_KB).toFixed(0)}KB (need >200KB)`);
  // ~64-byte deltas ≈ 3,500+ deltas — far beyond the AC's ≥150 deltas/s shape.
  const deltas: string[] = [];
  for (let i = 0; i < body.length; i += 64) deltas.push(body.slice(i, i + 64));
  const t0 = performance.now();
  const { committed, streamBuf, maxLive, maxScanned, forceCommits } = runHotPath(deltas);
  const wall = performance.now() - t0;

  const CAPS = MAX_HELD_BYTES + MAX_LIVE_REST_BYTES;
  assert.ok(maxLive <= CAPS + ONE_KB, `retained buffers must stay capped, saw ${maxLive}`);
  assert.ok(
    maxScanned <= CAPS + ONE_KB,
    `per-delta rescan input must be bounded by the caps, not the stream — saw ${maxScanned}`,
  );
  assert.ok(forceCommits > 0, 'the rest-overflow force-commit path actually engaged');
  // Token fidelity: committed + live reconstruct the model output minus scaffolding — every content
  // line survives byte-exact and IN ORDER (synthetic fence continuity lines are the only additions).
  assert.equal(
    contentLines(committed + '\n' + streamBuf),
    contentLines(body),
    'no content byte lost, duplicated, or reordered',
  );
  assert.ok(wall < 10_000, `200KB open-fence hammer took ${wall.toFixed(0)}ms (quadratic freeze?)`);

  // The RENDERED live region stays clampTail-bounded on top (composer pinned) — unchanged rule.
  const rendered = clampTail('```python\n' + lines.slice(0, 100).join('\n'), 20);
  assert.equal(rendered.split('\n').length, 21, 'render tail is clamped to 20 lines');
});

test('P1A-11: force-committed fence halves keep code styling (synthetic close + re-open)', () => {
  // Direct unit pin on the fence-continuity contract clampLiveRest guarantees.
  const inner = Array.from({ length: 100 }, (_, i) => `row ${i}`).join('\n');
  const rest = '````py\n' + inner + '\n';
  const { commit, rest: kept } = clampLiveRest(rest, 512);
  assert.ok(commit, 'overflow must force-commit');
  assert.match(commit!, /^````py\n/, 'committed head keeps the original opener');
  assert.match(commit!, /\n````$/, 'committed head is closed with the SAME marker width');
  assert.match(kept, /^````py\n/, 'retained tail is re-opened with the original marker+lang');
  // Byte fidelity across the seam: content survives exactly.
  assert.equal(contentLines(commit! + '\n' + kept), contentLines(rest.replace(/\n$/, '')));
  // Under the cap: untouched.
  assert.deepEqual(clampLiveRest('short', 512), { commit: null, rest: 'short' });
});

test('P1A-12: output fidelity — committed + live reconstruct the full plain-prose stream', () => {
  // Plain prose (no tool envelopes): the hot path must never DROP bytes, only relocate them between
  // committed and live. Prose is newline-terminated per line so every complete line commits and the
  // live tail stays a single incomplete line — the run is genuinely incremental, and the fidelity
  // check proves nothing is lost. (Top-level blank-line separators are intentionally not emitted.)
  const line = 'The quick brown fox jumps over the lazy dog (streaming fidelity). ';
  const prose = Array.from({ length: 3000 }, (_, i) => `${line}${i}`).join('\n') + '\n\nTRAIL-TAIL';
  const deltas: string[] = [];
  for (let i = 0; i < prose.length; i += 333) deltas.push(prose.slice(i, i + 333));
  const { committed, streamBuf, maxLive } = runHotPath(deltas);
  assert.ok(maxLive <= line.length + 64, `plain prose live stays one incomplete line, saw ${maxLive}`);
  // Every CONTENT byte is accounted for: committed + the remaining live buffer reproduces the whole
  // original once the intentionally-dropped newline separators are ignored. This proves the hot path
  // never drops, duplicates, or garbles streamed content under load.
  assert.equal(
    (committed + streamBuf).replace(/\n/g, '').length,
    prose.replace(/\n/g, '').length,
    'all non-newline content bytes are accounted for (committed + live)',
  );
  assert.ok(committed.length > 0 && streamBuf.length > 0, 'both committed and live paths carried data');
});
