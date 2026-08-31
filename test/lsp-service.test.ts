// LSP service + client supervision tests (plan 3.1, Package 3). REAL child processes — fake
// servers written into mkdtemp fixtures and spawned through the production spawn path
// (scrubbedEnv, unref'd pipes, Content-Length framing on both wires).
//
// Two fakes:
//   fake-lsp.mjs      — JSON-RPC LSP server (the pyright/gopls/rust-analyzer dialect).
//                       Flags: --silent (never publishes), --die-after-init (exits post-handshake).
//   node_modules/typescript/lib/tsserver.js — tsserver's NATIVE {seq,type,command} dialect,
//                       placed where the real detector looks, proving the local-install branch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { getLspService, lspNoteFor, stopLspServices } from '../src/agent/lsp/index.js';
import { createLspService, type LspService, type LspServiceConfig } from '../src/agent/lsp/service.js';
import { EventBus } from '../src/agent/events.js';

// ── helpers ─────────────────────────────────────────────────────────────────────

/** Poll without blind sleeps (acp-jsonrpc.test.ts pattern); never rejects. */
async function until(cond: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const FAKE_LSP = `import { writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const pidfile = argv.find((a) => !a.startsWith('--'));
if (pidfile) writeFileSync(pidfile, String(process.pid));
const SILENT = argv.includes('--silent');
const DIE = argv.includes('--die-after-init');
let buf = '';
const send = (msg) => {
  const body = JSON.stringify(msg);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);
};
const diagsFor = (text) => {
  const out = [];
  if (text.includes('BOOM')) out.push({ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, severity: 1, message: 'this exploded', code: 1000, source: 'ts' });
  if (text.includes('WARN')) out.push({ range: { start: { line: 1, character: 2 } }, severity: 2, message: 'be careful', source: 'ts' });
  return out;
};
const handle = (msg) => {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } });
    if (DIE) setTimeout(() => process.exit(0), 5);
    return;
  }
  if (msg.id !== undefined && msg.method) { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'textDocument/didOpen' || msg.method === 'textDocument/didChange') {
    if (SILENT) return;
    const td = msg.params.textDocument;
    const text = (msg.params.contentChanges && msg.params.contentChanges[0] && msg.params.contentChanges[0].text) || td.text || '';
    setTimeout(() => send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: td.uri, version: td.version, diagnostics: diagsFor(text) } }), 10);
  }
};
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  for (;;) {
    const sep = buf.indexOf('\\r\\n\\r\\n');
    if (sep < 0) return;
    const m = /Content-Length:\\s*(\\d+)/i.exec(buf.slice(0, sep));
    if (!m) { buf = buf.slice(sep + 4); continue; }
    const len = Number(m[1]);
    if (buf.length < sep + 4 + len) return;
    const body = buf.slice(sep + 4, sep + 4 + len);
    buf = buf.slice(sep + 4 + len);
    let msg; try { msg = JSON.parse(body); } catch { continue; }
    handle(msg);
  }
});
setInterval(() => {}, 1 << 30);
`;

const FAKE_TSSERVER = `let buf = '';
let outSeq = 1;
const send = (msg) => {
  const body = JSON.stringify(msg);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);
};
const openFiles = new Map();
const handle = (msg) => {
  if (msg.type !== 'request') return;
  send({ seq: outSeq++, type: 'response', request_seq: msg.seq, success: true, body: {} });
  if (msg.command === 'open') openFiles.set(msg.arguments.file, msg.arguments.fileContent || '');
  if (msg.command === 'geterr') {
    for (const file of msg.arguments.files || []) {
      const text = openFiles.get(file) || '';
      const diags = text.includes('BOOM')
        ? [{ start: { line: 2, offset: 7 }, end: { line: 2, offset: 11 }, text: 'fake tsserver: exploded', code: 1234, category: 'error' }]
        : [];
      setTimeout(() => {
        send({ seq: outSeq++, type: 'event', event: 'syntaxDiag', body: { file, diagnostics: [] } });
        send({ seq: outSeq++, type: 'event', event: 'semanticDiag', body: { file, diagnostics: diags } });
        send({ seq: outSeq++, type: 'event', event: 'suggestionDiag', body: { file, diagnostics: [{ start: { line: 1, offset: 1 }, text: 'sugg', category: 'suggestion' }] } });
      }, 10);
    }
  }
};
process.stdin.on('data', (chunk) => {
  // REAL tsserver contract (typescript 5.9.3): stdin is line-delimited JSON; only the
  // OUTPUT direction is Content-Length framed. The fake matches the real wire shape.
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).replace(/\\r$/, '');
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
setInterval(() => {}, 1 << 30);
`;

interface Fixture {
  root: string;
  write(rel: string, text: string): string;
  service(config?: Partial<LspServiceConfig>): LspService;
  cleanup(): void;
}

function makeFixture(fake: 'lsp' | 'tsserver', flags: string[] = []): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'shadow-lsp-'));
  const script = join(root, fake === 'lsp' ? 'fake-lsp.mjs' : 'node_modules/typescript/lib/tsserver.js');
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, fake === 'lsp' ? FAKE_LSP : FAKE_TSSERVER);
  return {
    root,
    write(rel, text) {
      const p = join(root, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
      return p;
    },
    service(config) {
      const cfg: LspServiceConfig = { timeoutMs: 1500, ...config };
      if (fake === 'lsp') {
        cfg.servers = { typescript: { command: process.execPath, args: [script, ...flags] } };
      }
      return createLspService({ projectDir: root, config: cfg });
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Wait for the (lazily started) server to be ready: poke collect on a DEDICATED warm-up
 *  file until the snapshot says ready — never touch the files a test is asserting on. */
async function waitReady(fx: Fixture, svc: LspService): Promise<boolean> {
  fx.write('__warmup.ts', 'const warm = 1;');
  await until(async () => {
    await svc.collect(join(fx.root, '__warmup.ts'));
    return svc.snapshot().servers.some((s) => s.state === 'ready');
  }, 8000);
  return svc.snapshot().servers.some((s) => s.state === 'ready');
}

// ── LSP-flavor service ──────────────────────────────────────────────────────────

test('service (lsp): first collect during cold start is null (honesty), then diagnostics flow', async () => {
  const fx = makeFixture('lsp');
  try {
    const svc = fx.service();
    const abs = fx.write('a.ts', 'const x: number = 1; BOOM');
    // Cold start: the server is warming, THIS write gets no note, nothing blocks.
    assert.equal(await svc.collect(abs), null);
    assert.ok(await waitReady(fx, svc), 'server became ready');
    const diags = await svc.collect(abs);
    assert.ok(diags && diags.length === 1);
    assert.equal(diags[0]!.severity, 'error');
    assert.equal(diags[0]!.line, 1); // 0-based wire → 1-based ours
    assert.equal(diags[0]!.col, 1);
    assert.equal(diags[0]!.code, '1000');
    assert.equal(svc.serverIdFor(abs), 'typescript');
    svc.stop();
  } finally {
    fx.cleanup();
  }
});

test('service (lsp): warnings ride, clean files answer []', async () => {
  const fx = makeFixture('lsp');
  try {
    const svc = fx.service();
    assert.ok(await waitReady(fx, svc));
    const warn = await svc.collect(fx.write('w.ts', 'let y = 2; // WARN'));
    assert.ok(warn && warn.length === 1 && warn[0]!.severity === 'warning');
    const clean = await svc.collect(fx.write('c.ts', 'const z = 3;'));
    assert.deepEqual(clean, []);
    svc.stop();
  } finally {
    fx.cleanup();
  }
});

test('service (lsp): a silent server resolves [] at the deadline — the turn stays bounded', async () => {
  const fx = makeFixture('lsp', ['--silent']);
  try {
    const svc = fx.service();
    assert.ok(await waitReady(fx, svc));
    const t0 = Date.now();
    const out = await svc.collect(fx.write('s.ts', 'BOOM'));
    const elapsed = Date.now() - t0;
    assert.deepEqual(out, []);
    assert.ok(elapsed < 3200, `deadline respected (took ${elapsed}ms)`);
    svc.stop();
  } finally {
    fx.cleanup();
  }
});

test('service (lsp): stop() kills the spawned server (pid gone from the process table)', async () => {
  const pidfile = join(tmpdir(), `shadow-lsp-pid-${process.pid}-${Date.now()}`);
  const root = mkdtempSync(join(tmpdir(), 'shadow-lsp-'));
  const script = join(root, 'fake-lsp.mjs');
  writeFileSync(script, FAKE_LSP);
  try {
    const svc = createLspService({
      projectDir: root,
      config: { timeoutMs: 1500, servers: { typescript: { command: process.execPath, args: [script, pidfile] } } },
    });
    const fxWrite = (rel: string, text: string): string => {
      const p = join(root, rel);
      writeFileSync(p, text);
      return p;
    };
    const abs = fxWrite('a.ts', 'const q = 1;');
    await until(async () => {
      await svc.collect(abs);
      return svc.snapshot().servers.some((s) => s.state === 'ready');
    }, 8000);
    await until(() => {
      try {
        readFileSync(pidfile, 'utf8');
        return true;
      } catch {
        return false;
      }
    }, 4000);
    const pid = Number(readFileSync(pidfile, 'utf8'));
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.ok(isAlive(pid));
    svc.stop();
    assert.ok(await until(() => !isAlive(pid), 4000), 'server process exited after stop()');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(pidfile, { force: true });
  }
});

test('service (lsp): a dying server is restarted at most RESTART_CAP times, then disabled + one notice', async () => {
  const fx = makeFixture('lsp', ['--die-after-init']);
  try {
    const svc = fx.service();
    const notices: string[] = [];
    svc.onNotice((m) => notices.push(m));
    const abs = fx.write('a.ts', 'const d = 1;');
    // Drive: each collect after a death triggers a restart until the cap latches 'disabled'.
    const done = await until(async () => {
      await svc.collect(abs);
      const s = svc.snapshot().servers[0]!;
      return s.state === 'disabled';
    }, 8000);
    assert.ok(done, `server reached disabled (state=${JSON.stringify(svc.snapshot().servers)})`);
    const s = svc.snapshot().servers[0]!;
    assert.equal(s.starts, 2);
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /typescript/);
    // Disabled sticks — and collect stays a quiet null forever.
    assert.equal(await svc.collect(abs), null);
    assert.equal(svc.snapshot().servers[0]!.state, 'disabled');
    assert.equal(notices.length, 1); // still exactly one notice
  } finally {
    fx.cleanup();
  }
});

// ── tsserver-flavor service (native protocol adapter) ───────────────────────────

test('service (tsserver): local node_modules detection → native protocol → error mapped, suggestions dropped', async () => {
  const fx = makeFixture('tsserver');
  try {
    // no servers override: detection must find the fake install — behind the global trust
    // opt-in, since node_modules/typescript/lib/tsserver.js is repo-controlled content.
    const svc = fx.service({ trustNodeModules: true });
    const snap0 = svc.snapshot();
    assert.equal(snap0.servers[0]!.flavor, 'tsserver');
    const abs = fx.write('t.ts', 'const a: number = 1; BOOM');
    assert.equal(await svc.collect(abs), null); // cold start honesty on this flavor too
    assert.ok(await waitReady(fx, svc), 'tsserver became ready');
    const diags = await svc.collect(abs);
    assert.ok(diags && diags.length === 1, `got ${JSON.stringify(diags)}`);
    assert.equal(diags[0]!.severity, 'error');
    assert.equal(diags[0]!.line, 2); // tsserver offsets are 1-based already
    assert.equal(diags[0]!.col, 7);
    assert.equal(diags[0]!.code, '1234');
    assert.equal(diags[0]!.source, 'ts');
    // suggestionDiag was emitted by the fake and must NOT appear anywhere.
    assert.ok(!diags.some((d) => d.message.includes('sugg')));
    const clean = await svc.collect(fx.write('ok.ts', 'const fine = 1;'));
    assert.deepEqual(clean, []);
    svc.stop();
  } finally {
    fx.cleanup();
  }
});

test('service (tsserver): an UNTRUSTED repo-local typescript is never a spawn target — one teaching notice', async () => {
  const fx = makeFixture('tsserver'); // creates a real node_modules/typescript/lib/tsserver.js
  try {
    const notices: string[] = [];
    // detect.which forced empty → machine-independent: local install present, PATH empty.
    const svc = createLspService({ projectDir: fx.root, config: { timeoutMs: 500 }, detect: { which: () => null } });
    svc.onNotice((m) => notices.push(m));
    const snap = svc.snapshot();
    assert.equal(snap.servers.length, 0, 'untrusted local install yields NO servers');

    const abs = fx.write('t.ts', 'const a: number = 1; BOOM');
    assert.equal(await svc.collect(abs), null); // nothing to collect with — never spawns
    assert.equal(svc.serverIdFor(abs), null);
    assert.equal(notices.length, 1, 'exactly one notice');
    assert.match(notices[0]!, /trustNodeModules/);
    assert.match(notices[0]!, /node_modules/);
    await svc.collect(abs); // resolves are cached — the notice must not repeat
    assert.equal(notices.length, 1);
    svc.stop();
  } finally {
    fx.cleanup();
  }
});

// ── lspNoteFor — the loop hook's gate chain, end to end against the fake server ──

function noteCall(fx: Fixture, svc: LspService, opts: Partial<Parameters<typeof lspNoteFor>[0]> = {}) {
  return lspNoteFor({
    tool: 'write_file',
    ok: true,
    input: { path: 'a.ts' },
    workspaceRoot: fx.root,
    service: svc,
    ...opts,
  });
}

test('lspNoteFor: full chain — write with a type error yields the [lsp: typescript] note', async () => {
  const fx = makeFixture('lsp');
  try {
    const svc = fx.service();
    fx.write('a.ts', 'const x: number = 1; BOOM');
    assert.equal(await noteCall(fx, svc), null); // cold start: first write's note skipped
    assert.ok(await waitReady(fx, svc));
    const note = await noteCall(fx, svc);
    assert.ok(note);
    assert.match(note, /\[lsp: typescript\] 1 error, 0 warnings in a\.ts/);
    assert.match(note, /a\.ts:1:1 — this exploded \(error, 1000\)/);
    svc.stop();
  } finally {
    fx.cleanup();
  }
});

test('lspNoteFor: every gate answers null — kill switch, disabled, !ok, dry-run, wrong tool, unknown ext', async () => {
  const fx = makeFixture('lsp');
  try {
    const svc = fx.service();
    fx.write('a.ts', 'BOOM');
    assert.ok(await waitReady(fx, svc));
    const base = { tool: 'write_file' as const, ok: true, input: { path: 'a.ts' }, workspaceRoot: fx.root, service: svc };
    assert.ok(await lspNoteFor(base), 'sanity: the note flows when ungated');
    assert.equal(await lspNoteFor({ ...base, env: { SHADOW_NO_LSP: '1' } }), null);
    assert.equal(await lspNoteFor({ ...base, lsp: { enabled: false } }), null);
    assert.equal(await lspNoteFor({ ...base, ok: false }), null);
    assert.equal(await lspNoteFor({ ...base, dryRun: true }), null);
    assert.equal(await lspNoteFor({ ...base, tool: 'read_file' }), null);
    assert.equal(await lspNoteFor({ ...base, input: { path: 'notes.md' }, tool: 'write_file' }), null);
    svc.stop();
  } finally {
    fx.cleanup();
  }
});

test('lspNoteFor: apply_patch paths come from result.data.files; files outside the workspace never run', async () => {
  const fx = makeFixture('lsp');
  try {
    const svc = fx.service();
    fx.write('a.ts', 'BOOM');
    fx.write('b.ts', 'WARN');
    assert.ok(await waitReady(fx, svc));
    const note = await lspNoteFor({
      tool: 'apply_patch',
      ok: true,
      input: {},
      result: { data: { files: ['a.ts', 'b.ts', '../outside.ts'] } },
      workspaceRoot: fx.root,
      service: svc,
    });
    assert.ok(note);
    assert.match(note, /\[lsp: typescript\] 1 error, 0 warnings in a\.ts/);
    assert.match(note, /\[lsp: typescript\] 0 errors, 1 warning in b\.ts/);
    assert.ok(!note.includes('outside.ts'), 'outside-workspace path never reaches a server');
    svc.stop();
  } finally {
    fx.cleanup();
  }
});

test('lspNoteFor: identical diagnostics dedupe away; a changed file emits again', async () => {
  const fx = makeFixture('lsp');
  try {
    const svc = fx.service();
    fx.write('a.ts', 'BOOM');
    assert.ok(await waitReady(fx, svc));
    assert.ok(await noteCall(fx, svc));
    assert.equal(await noteCall(fx, svc), null); // same file, same signature — suppressed
    fx.write('a.ts', 'WARN');
    const again = await noteCall(fx, svc);
    assert.ok(again && again.includes('warning'), 'changed content re-emits');
    svc.stop();
  } finally {
    fx.cleanup();
  }
});

test('lspNoteFor: session budget exhaustion blocks the note and emits exactly ONE finding', async () => {
  const fx = makeFixture('lsp');
  try {
    const svc = fx.service({ notes: { maxSessionChars: 40 } }); // note is >40 chars
    fx.write('a.ts', 'BOOM');
    assert.ok(await waitReady(fx, svc));
    const bus = new EventBus();
    const findings: string[] = [];
    bus.on((e) => {
      if (e.type === 'finding') findings.push(e.title);
    });
    assert.equal(await noteCall(fx, svc, { bus }), null); // blocked by the session cap
    assert.ok(svc.noteBudget().exhausted(), 'refusal latched exhaustion');
    assert.equal(findings.length, 1);
    assert.match(findings[0]!, /LSP diagnostics notes paused/);
    assert.equal(await noteCall(fx, svc, { bus }), null);
    assert.equal(findings.length, 1); // still exactly one finding
    svc.stop();
  } finally {
    fx.cleanup();
  }
});

// ── module cache ────────────────────────────────────────────────────────────────

test('getLspService: cached per workspace root; stopLspServices clears the cache', async () => {
  const a = mkdtempSync(join(tmpdir(), 'shadow-lsp-'));
  const b = mkdtempSync(join(tmpdir(), 'shadow-lsp-'));
  try {
    const s1 = getLspService(a);
    assert.equal(getLspService(a), s1, 'same root → same service (servers outlive loops)');
    const s2 = getLspService(b);
    assert.notEqual(s2, s1);
    stopLspServices();
    assert.notEqual(getLspService(a), s1, 'cache cleared after stopLspServices');
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
    stopLspServices();
  }
});
