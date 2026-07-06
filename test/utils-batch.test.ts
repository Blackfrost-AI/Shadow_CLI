import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyRank, fuzzyScore, isSubsequence, containsCI } from '../src/util/fuzzy.js';
import { supportsHyperlinks, hyperlink } from '../src/util/hyperlinks.js';
import { copyToClipboard, hasClipboard, resolveClipboardBin } from '../src/util/clipboard.js';
import { categorizeContext, contextSuggestions, blockTokenEstimate } from '../src/tui/contextViz.js';
import type { Message } from '../src/provider/provider.js';

// ---- fuzzy ----
test('fuzzy: subsequence + contains', () => {
  assert.equal(isSubsequence('apple', 'app'), true);
  assert.equal(isSubsequence('apple', 'pl'), true);
  assert.equal(isSubsequence('apple', 'xyz'), false);
  assert.equal(containsCI('OpenAI', 'open'), true);
});

test('fuzzy: exact substring beats subsequence; earlier beats later', () => {
  assert.ok(fuzzyScore('model picker', 'model') > fuzzyScore('picker', 'model'));
  // 'app' exact-in 'application' (boundary, pos 0) > exact-in 'wrapper' (pos 4, no boundary)
  assert.ok(fuzzyScore('application', 'app') > fuzzyScore('wrapper', 'app'));
});

test('fuzzyRank drops non-matches and sorts', () => {
  const items = ['model', '/cost', '/compact', 'mode'];
  const ranked = fuzzyRank(items, 'co', (s) => s).map((r) => r.item);
  assert.ok(ranked.includes('/cost'));
  assert.ok(ranked.includes('/compact'));
  assert.ok(!ranked.includes('mode')); // 'mode' has no 'c','o' subsequence in order? m-o-d-e: c? no 'c'. dropped.
});

// ---- hyperlinks ----
test('hyperlinks: detection is conservative (no TTY → false)', () => {
  assert.equal(supportsHyperlinks({ isTTY: false, env: { TERM_PROGRAM: 'iTerm.app' } }), false);
  assert.equal(supportsHyperlinks({ isTTY: true, env: { TERM_PROGRAM: 'iTerm.app' } }), true);
  assert.equal(supportsHyperlinks({ isTTY: true, env: { TERM: 'xterm-256color' } }), false);
  assert.equal(supportsHyperlinks({ isTTY: true, env: { TERM: 'xterm-kitty' } }), true);
});

test('hyperlinks: wrapper emits OSC 8 and strips control chars from url (no injection)', () => {
  const h = hyperlink('docs', 'https://shadow.dev/x');
  assert.match(h, /\x1b\]8;;https:\/\/shadow\.dev\/x\x07docs\x1b\]8;;\x07/);
  const evil = hyperlink('x', 'https://evil.dev/\x07\x1b]8;;evil\x07');
  assert.ok(!evil.includes('evil\x07evil')); // no second injected link payload
});

// ---- clipboard (no network/spawn of text; just resolution + promise shape) ----
test('clipboard: resolveClipboardBin returns a spec or null; copy resolves boolean', async () => {
  // We can't assume a helper in CI; just assert the contract holds either way.
  const spec = resolveClipboardBin();
  assert.equal(typeof spec === 'object' || spec === null, true);
  assert.equal(typeof hasClipboard(), 'boolean');
  const ok = await copyToClipboard('shadow-test');
  assert.equal(typeof ok, 'boolean');
});

// ---- context viz ----
const msgs: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'a'.repeat(400) }] }, // ~100 tok
  { role: 'assistant', content: [{ type: 'text', text: 'b'.repeat(80) }, { type: 'tool_use', id: '1', name: 'run_shell', input: { command: 'ls' } }] },
  {
    role: 'user',
    content: [{ type: 'tool_result', toolCallId: '1', ok: true, content: 'c'.repeat(4000) }], // ~1000 tok
  },
];

test('contextViz: categorizes tokens by type and ranks the dominant bucket', () => {
  const b = categorizeContext(msgs, 2000, 100000);
  assert.ok(b.categories.length >= 1);
  assert.equal(b.categories[0]!.label, 'Tool results'); // the 4000-char result dominates
  assert.ok(b.total >= b.messageTokens);
  assert.ok(b.pct >= 0 && b.pct < 1);
});

test('contextViz: suggestions fire near/over budget', () => {
  const over = categorizeContext(msgs, 120000, 100000); // over budget
  const sOver = contextSuggestions(over);
  assert.ok(sOver.some((s) => s.severity === 'critical'));
  const near = categorizeContext(msgs, 80000, 100000); // 80%
  const sNear = contextSuggestions(near);
  assert.ok(sNear.some((s) => s.severity === 'warn'));
});

test('contextViz: blockTokenEstimate covers every block type', () => {
  assert.ok(blockTokenEstimate({ type: 'text', text: 'abcd' }) > 0);
  assert.ok(blockTokenEstimate({ type: 'image', mediaType: 'image/png', data: '' }) === 4000);
  assert.ok(blockTokenEstimate({ type: 'thinking', thinking: 'abcd', signature: 's' }) > 0);
});
