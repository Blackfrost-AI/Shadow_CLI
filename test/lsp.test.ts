// LSP (plan 3.1): framing, note rendering, dedupe, and note budgets — the pure core.
// No process spawning here (see lsp-service.test.ts); no HOME isolation needed (no config import).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { frameMessage, LspDecoder, MAX_BUFFERED_BYTES } from '../src/agent/lsp/framing.js';
import { renderDiagnostics, NoteDeduper } from '../src/agent/lsp/note.js';
import { createLspNoteBudget } from '../src/agent/lsp/noteBudget.js';
import { MAX_DIAGS_PER_FILE, SERVER_BY_EXT } from '../src/agent/lsp/protocol.js';
import type { LspDiagnostic } from '../src/agent/lsp/protocol.js';

// ── framing ─────────────────────────────────────────────────────────────────────

test('framing: frameMessage wraps JSON with a byte-accurate Content-Length (multi-byte counted)', () => {
  const json = '{"msg":"菜鸟"}'; // 6 two-byte chars → body longer than its string length? bytes ≠ chars
  const frame = frameMessage(json);
  const bodyBytes = Buffer.byteLength(json, 'utf8');
  assert.match(frame, new RegExp(`^Content-Length: ${bodyBytes}\\r\\n\\r\\n`));
  assert.equal(frame.endsWith(json), true);
});

test('framing: frameMessage strips a trailing newline so the byte count stays honest', () => {
  const frame = frameMessage('{"a":1}\n');
  const body = '{"a":1}';
  assert.equal(frame, `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
});

test('framing: one complete frame per chunk decodes immediately', () => {
  const d = new LspDecoder();
  assert.deepEqual(d.push(frameMessage('{"a":1}')), ['{"a":1}']);
  assert.equal(d.buffered(), 0);
});

test('framing: a frame split MID-HEADER across chunks still decodes', () => {
  const d = new LspDecoder();
  const frame = Buffer.from(frameMessage('{"ok":true}'), 'utf8');
  const cut = 8; // inside "Content-Length"
  assert.deepEqual(d.push(frame.subarray(0, cut)), []);
  assert.deepEqual(d.push(frame.subarray(cut)), ['{"ok":true}']);
});

test('framing: a frame split MID-BODY across chunks (through a multi-byte char) still decodes', () => {
  const json = '{"note":"并行"}';
  const frame = Buffer.from(frameMessage(json), 'utf8');
  // Find a cut point inside the body that lands between the two bytes of a CJK character.
  const bodyStart = frame.indexOf('\r\n\r\n') + 4;
  const bodyBytes = Buffer.byteLength(json, 'utf8');
  const cut = bodyStart + 2; // inside the body, before the multi-byte chars at the tail
  const d = new LspDecoder();
  assert.deepEqual(d.push(frame.subarray(0, cut)), []);
  assert.deepEqual(d.push(frame.subarray(cut)), [json]);
  assert.equal(bodyBytes > json.length, true); // sanity: the fixture really is multi-byte
});

test('framing: two frames in one chunk both decode, in order', () => {
  const d = new LspDecoder();
  const two = frameMessage('{"n":1}') + frameMessage('{"n":2}');
  assert.deepEqual(d.push(two), ['{"n":1}', '{"n":2}']);
  assert.equal(d.buffered(), 0);
});

test('framing: a bare-\\n header terminator (non-spec server) is tolerated', () => {
  const d = new LspDecoder();
  const body = '{"x":9}';
  d.push(`Content-Length: ${Buffer.byteLength(body)}\n\n${body}`);
  assert.deepEqual(d.buffered(), 0); // header consumed — nothing stuck
});

test('framing: a garbage header block resyncs to the next real frame in the SAME push', () => {
  const d = new LspDecoder();
  const real = frameMessage('{"real":true}');
  const garbage = `total junk\r\n\r\n${real}`;
  assert.deepEqual(d.push(garbage), ['{"real":true}']);
});

test('framing: a stream that never completes a frame cannot grow the buffer past the cap', () => {
  const d = new LspDecoder();
  const junk = Buffer.alloc(MAX_BUFFERED_BYTES + 1024, 0x2e); // '.': no blank line, no header
  d.push(junk);
  assert.equal(d.buffered(), 0); // nothing plausible in sight → dropped wholesale
  // And a real frame afterwards still decodes.
  assert.deepEqual(d.push(frameMessage('{"after":1}')), ['{"after":1}']);
});

// ── note rendering ──────────────────────────────────────────────────────────────

function diag(severity: LspDiagnostic['severity'], line: number, message: string, code?: string): LspDiagnostic {
  return { uri: 'file:///w/src/a.ts', line, col: 5, severity, message, ...(code ? { code } : {}) };
}

test('note: info and hint diagnostics are dropped — errors and warnings only', () => {
  const out = renderDiagnostics({
    serverId: 'typescript',
    relPath: 'src/a.ts',
    diags: [diag('error', 10, 'boom'), diag('warning', 20, 'careful'), diag('info', 30, 'meh'), diag('hint', 40, 'nit')],
  });
  assert.ok(out);
  assert.match(out, /1 error, 1 warning/);
  assert.doesNotMatch(out, /meh|nit/);
});

test('note: header pluralizes counts and names the server + file', () => {
  const one = renderDiagnostics({ serverId: 'pyright', relPath: 'x.py', diags: [diag('error', 1, 'e')] });
  assert.match(one!, /\[lsp: pyright\] 1 error, 0 warnings in x\.py/);
  const two = renderDiagnostics({
    serverId: 'pyright',
    relPath: 'x.py',
    diags: [diag('error', 1, 'e'), diag('error', 2, 'e2'), diag('warning', 3, 'w')],
  });
  assert.match(two!, /2 errors, 1 warning in x\.py/);
});

test('note: at most MAX_DIAGS_PER_FILE lines render, the rest collapse into (+N more)', () => {
  const many = Array.from({ length: MAX_DIAGS_PER_FILE + 5 }, (_, i) => diag('error', i + 1, `e${i}`));
  const out = renderDiagnostics({ serverId: 'gopls', relPath: 'm.go', diags: many })!;
  const emitted = out.split('\n').filter((l) => l.startsWith('m.go:'));
  assert.equal(emitted.length, MAX_DIAGS_PER_FILE);
  assert.match(out, /\(\+5 more\)/);
});

test('note: a clean file (no error/warning diagnostics) renders null — silence is free', () => {
  assert.equal(
    renderDiagnostics({ serverId: 'typescript', relPath: 'a.ts', diags: [diag('info', 1, 'x'), diag('hint', 2, 'y')] }),
    null,
  );
  assert.equal(renderDiagnostics({ serverId: 'typescript', relPath: 'a.ts', diags: [] }), null);
});

test('note: multi-line diagnostic messages collapse to one line; code and severity ride along', () => {
  const out = renderDiagnostics({ serverId: 'typescript', relPath: 'a.ts', diags: [diag('error', 3, "line1\nline2 boom", 'TS2339')] });
  assert.match(out!, /a\.ts:3:5 — line1 line2 boom \(error, TS2339\)/);
  const noCode = renderDiagnostics({ serverId: 'gopls', relPath: 'm.go', diags: [diag('warning', 7, 'w')] });
  assert.match(noCode!, /\(warning\)/);
});

// ── dedupe ──────────────────────────────────────────────────────────────────────

test('dedupe: an unchanged signature for the same uri is suppressed; any change emits again', () => {
  const dd = new NoteDeduper();
  assert.equal(dd.shouldEmit('file:///a.ts', 'sig-1'), true); // first sight
  assert.equal(dd.shouldEmit('file:///a.ts', 'sig-1'), false); // unchanged
  assert.equal(dd.shouldEmit('file:///a.ts', 'sig-2'), true); // changed
  assert.equal(dd.shouldEmit('file:///a.ts', 'sig-1'), true); // changed back
});

test('dedupe: different uris are independent', () => {
  const dd = new NoteDeduper();
  assert.equal(dd.shouldEmit('file:///a.ts', 'sig'), true);
  assert.equal(dd.shouldEmit('file:///b.ts', 'sig'), true);
});

// ── note budget ─────────────────────────────────────────────────────────────────

test('budget: allows inside both caps, records, and blocks past the session cap (latched)', () => {
  const b = createLspNoteBudget({ maxTurnChars: 100, maxSessionChars: 150 });
  assert.equal(b.allows(100), true);
  b.record(100);
  assert.equal(b.allows(50), false); // turn cap would be exceeded (turn counter still at 100)
  b.beginTurn();
  assert.equal(b.allows(50), true); // session 100+50 ≤ 150
  b.record(50);
  assert.equal(b.exhausted(), true); // 150/150 session
  b.beginTurn();
  assert.equal(b.allows(1), false); // latched: session cap hit
  assert.deepEqual(b.snapshot(), { turnChars: 0, sessionChars: 150, maxTurnChars: 100, maxSessionChars: 150, exhausted: true });
});

test('budget: beginTurn resets the per-turn counter only; the turn cap blocks without latching', () => {
  const b = createLspNoteBudget({ maxTurnChars: 100, maxSessionChars: 10_000 });
  b.record(100); // exactly at the turn cap
  assert.equal(b.allows(1), false); // turn cap would be exceeded
  assert.equal(b.exhausted(), false); // but the budget as a whole is not exhausted
  b.beginTurn();
  assert.equal(b.allows(100), true);
});

test('budget: announceExhausted fires exactly once', () => {
  const b = createLspNoteBudget({ maxTurnChars: 10, maxSessionChars: 10 });
  assert.equal(b.announceExhausted(), false); // not exhausted yet
  b.record(11);
  assert.equal(b.announceExhausted(), true); // first transition
  assert.equal(b.announceExhausted(), false); // and never again
});

test('budget: a note blocked by the session cap can latch exhaustion itself (markExhausted)', () => {
  // The hook never records a refused note — so a FIRST note bigger than the session cap must
  // be able to latch exhaustion without record(), or its one finding never fires.
  const b = createLspNoteBudget({ maxTurnChars: 1_000, maxSessionChars: 50 });
  assert.equal(b.allows(80), false);
  assert.equal(b.blockedBySession(80), true); // session cap, not the turn cap
  b.markExhausted();
  assert.equal(b.exhausted(), true);
  assert.equal(b.announceExhausted(), true);
  // The transient turn cap does NOT look like session exhaustion.
  const t = createLspNoteBudget({ maxTurnChars: 50, maxSessionChars: 100_000 });
  t.record(50);
  assert.equal(t.allows(10), false);
  assert.equal(t.blockedBySession(10), false);
});

// ── extension map sanity (protocol) ─────────────────────────────────────────────

test('protocol: the extension → server map covers the four v1 languages and nothing else', () => {
  assert.equal(SERVER_BY_EXT['ts'], 'typescript');
  assert.equal(SERVER_BY_EXT['py'], 'pyright');
  assert.equal(SERVER_BY_EXT['go'], 'gopls');
  assert.equal(SERVER_BY_EXT['rs'], 'rust-analyzer');
  assert.equal(SERVER_BY_EXT['md'], undefined);
});

// ── detection (plan 3.1, Package 2) ─────────────────────────────────────────────

import { detectLspServers } from '../src/agent/lsp/detect.js';

test('detection: a local node_modules typescript yields the tsserver flavor under execPath (trusted)', () => {
  const specs = detectLspServers('/w', {
    exists: (p) => p === '/w/node_modules/typescript/lib/tsserver.js',
    which: () => null,
    execPath: '/usr/bin/node',
    trustNodeModules: true,
  });
  assert.deepEqual(specs, [
    {
      id: 'typescript',
      flavor: 'tsserver',
      command: '/usr/bin/node',
      args: ['/w/node_modules/typescript/lib/tsserver.js'],
      projectSourced: true,
    },
  ]);
});

test('detection: a local node_modules typescript WITHOUT the trust opt-in is never a spawn target', () => {
  // The repo-controlled file exists, but without trustNodeModules it must not be returned —
  // and a machine-resolved PATH server (if any) is used instead.
  const withPath = detectLspServers('/w', {
    exists: (p) => p === '/w/node_modules/typescript/lib/tsserver.js',
    which: (bin) => (bin === 'typescript-language-server' ? '/opt/bin/typescript-language-server' : null),
  });
  assert.deepEqual(withPath, [
    { id: 'typescript', flavor: 'lsp', command: '/opt/bin/typescript-language-server', args: ['--stdio'], projectSourced: false },
  ]);
  const noPath = detectLspServers('/w', {
    exists: (p) => p === '/w/node_modules/typescript/lib/tsserver.js',
    which: () => null,
  });
  assert.deepEqual(noPath, []); // untrusted local + nothing on PATH → no typescript server at all
});

test('detection: with no local typescript, a PATH typescript-language-server is the fallback', () => {
  const specs = detectLspServers('/w', {
    exists: () => false,
    which: (bin) => (bin === 'typescript-language-server' ? '/opt/bin/typescript-language-server' : null),
  });
  assert.deepEqual(specs, [
    { id: 'typescript', flavor: 'lsp', command: '/opt/bin/typescript-language-server', args: ['--stdio'], projectSourced: false },
  ]);
});

test('detection: the local node_modules install is preferred over a PATH server when trusted', () => {
  const specs = detectLspServers('/w', {
    exists: (p) => p === '/w/node_modules/typescript/lib/tsserver.js',
    which: (bin) => (bin === 'typescript-language-server' ? '/opt/bin/typescript-language-server' : null),
    trustNodeModules: true,
  });
  assert.equal(specs.length, 1);
  assert.equal(specs[0]!.flavor, 'tsserver');
  assert.equal(specs[0]!.projectSourced, true);
});

test('detection: pyright, gopls, and rust-analyzer resolve from PATH', () => {
  const specs = detectLspServers('/w', {
    exists: () => false,
    which: (bin) => (bin === 'pyright-langserver' || bin === 'gopls' || bin === 'rust-analyzer' ? `/bin/${bin}` : null),
  });
  assert.deepEqual(
    specs.map((s) => [s.id, s.command, s.args]),
    [
      ['pyright', '/bin/pyright-langserver', ['--stdio']],
      ['gopls', '/bin/gopls', []],
      ['rust-analyzer', '/bin/rust-analyzer', []],
    ],
  );
});

test('detection: nothing installed → no servers (and no throw)', () => {
  assert.deepEqual(detectLspServers('/w', { exists: () => false, which: () => null }), []);
});

test('detection: a config override replaces the detected entry for that id', () => {
  const specs = detectLspServers('/w', {
    exists: () => false,
    which: () => null,
    overrides: { typescript: { command: '/custom/ts-lsp', args: ['--stdio', '--slow'] } },
  });
  assert.deepEqual(specs, [
    { id: 'typescript', flavor: 'lsp', command: '/custom/ts-lsp', args: ['--stdio', '--slow'], projectSourced: false },
  ]);
});

test('detection: a user-defined server id passes through with the lsp flavor', () => {
  const specs = detectLspServers('/w', {
    exists: () => false,
    which: () => null,
    overrides: { zls: { command: '/bin/zls' } },
  });
  assert.deepEqual(specs, [{ id: 'zls', flavor: 'lsp', command: '/bin/zls', args: [], projectSourced: false }]);
});

test('detection: an override with an empty command is ignored, not spawned', () => {
  const specs = detectLspServers('/w', {
    exists: () => false,
    which: () => null,
    overrides: { typescript: { command: '   ' } },
  });
  assert.deepEqual(specs, []);
});
