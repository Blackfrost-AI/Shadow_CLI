import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inlineImageEsc, supportsInlineImages, formatBytes } from '../src/util/termImage.js';

// A real 1×1 PNG (valid header so any terminal that decodes won't choke on garbage).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

/** Run `fn` with TERM env vars overridden, then restore. inlineProtocol() reads process.env live. */
function withTerm(env: Record<string, string | undefined>, fn: () => void): void {
  const keys = ['TERM_PROGRAM', 'TERM', 'LC_TERMINAL'] as const;
  const prev: Record<string, string | undefined> = {};
  for (const k of keys) prev[k] = process.env[k];
  try {
    for (const k of keys) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test('supportsInlineImages: gated on TTY + known terminal (env-explicit, deterministic)', () => {
  assert.equal(supportsInlineImages({ isTTY: false, env: {} }), false, 'never when not a TTY');
  assert.equal(supportsInlineImages({ isTTY: true, env: { TERM_PROGRAM: 'iTerm.app' } }), true);
  assert.equal(supportsInlineImages({ isTTY: true, env: { TERM_PROGRAM: 'ghostty' } }), true);
  assert.equal(supportsInlineImages({ isTTY: true, env: { TERM: 'kitty' } }), true);
  assert.equal(supportsInlineImages({ isTTY: true, env: { TERM_PROGRAM: 'WezTerm' } }), true);
  assert.equal(supportsInlineImages({ isTTY: true, env: { TERM: 'xterm-256color' } }), false, 'unknown terminal');
  // tmux forwards only when the outer terminal (LC_TERMINAL) is identifiable + capable.
  assert.equal(supportsInlineImages({ isTTY: true, env: { TERM_PROGRAM: 'tmux', LC_TERMINAL: 'iTerm2' } }), true);
  assert.equal(supportsInlineImages({ isTTY: true, env: { TERM_PROGRAM: 'tmux' } }), false, 'tmux with no outer hint');
});

test('inlineImageEsc: iTerm2 → OSC 1337 with inline=1, width, name, and inlined base64', () => {
  withTerm({ TERM_PROGRAM: 'iTerm.app' }, () => {
    const esc = inlineImageEsc(PNG, { cols: 40, name: 'dot.png' });
    assert.ok(esc, 'iTerm2 is supported → non-null');
    assert.ok(esc!.startsWith('\x1b]1337;File=inline=1;'), 'OSC 1337 inline header');
    assert.ok(esc!.includes('width=40;'), 'cell width set');
    assert.ok(esc!.includes('name=dot.png;'), 'name set');
    assert.ok(esc!.endsWith('\x07'), 'BEL-terminated');
    assert.ok(esc!.includes(PNG.toString('base64')), 'base64 bytes inlined');
  });
});

test('inlineImageEsc: Kitty → the APC G graphics protocol (transmit-as-file)', () => {
  withTerm({ TERM_PROGRAM: 'kitty' }, () => {
    const esc = inlineImageEsc(PNG, { cols: 20 });
    assert.ok(esc!.startsWith('\x1bG'), 'Kitty APC opener');
    assert.ok(esc!.includes('a=T,t=f'), 'transmit-as-file controls on the first chunk');
    assert.ok(esc!.includes('\x1b\\'), 'ST-terminated');
    assert.ok(esc!.includes(PNG.toString('base64')), 'base64 bytes present');
  });
});

test('inlineImageEsc: null on an unsupported terminal', () => {
  withTerm({}, () => {
    assert.equal(inlineImageEsc(PNG), null, 'unknown terminal → no inline escape');
  });
});

test('inlineImageEsc: null when the image exceeds the inline size cap (even on a capable terminal)', () => {
  withTerm({ TERM_PROGRAM: 'iTerm.app' }, () => {
    const big = Buffer.alloc(1_100_000, 0);
    assert.equal(inlineImageEsc(big), null, 'too large to inline cleanly → save/open fallback');
  });
});

test('formatBytes: B / KB / MB tiers', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(1_500_000), '1.4 MB');
});
