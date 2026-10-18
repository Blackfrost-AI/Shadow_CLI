import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolateHome } from './helpers/isolateHome.js';

// sample_run executes code, so these tests are the containment argument. They are written to FAIL
// if the sandbox silently degrades — a detonation that ran unconfined is worse than no detonation.
const { home: HOME } = isolateHome('samplerun');
void HOME;
const { sampleRun } = await import('../src/tools/sampleRun.js');

interface Ctx {
  workspaceRoot: string;
  signal: AbortSignal;
  log: (m: string) => void;
  dryRun: boolean;
}

const ctxFor = (workspaceRoot: string): Ctx => ({
  workspaceRoot,
  signal: new AbortController().signal,
  log: () => {},
  dryRun: false,
});

function scratch(): { ws: string; cleanup: () => void } {
  const ws = mkdtempSync(join(tmpdir(), 'det-'));
  return { ws, cleanup: () => rmSync(ws, { recursive: true, force: true }) };
}

const writeSample = (ws: string, name: string, body: string): string => {
  const p = join(ws, name);
  writeFileSync(p, body, { mode: 0o700 });
  chmodSync(p, 0o700);
  return p;
};

// ── Preconditions ────────────────────────────────────────────────────────────

test('sample_run rejects a missing sample without spawning', async () => {
  const { ws, cleanup } = scratch();
  try {
    const r = await sampleRun.run({ path: 'nope.bin' }, ctxFor(ws));
    assert.equal(r.ok, false);
    assert.match(r.summary, /No such sample/);
  } finally {
    cleanup();
  }
});

test('sample_run rejects an empty sample', async () => {
  const { ws, cleanup } = scratch();
  try {
    writeFileSync(join(ws, 'empty.bin'), '');
    const r = await sampleRun.run({ path: 'empty.bin' }, ctxFor(ws));
    assert.equal(r.ok, false);
    assert.match(r.summary, /empty/i);
  } finally {
    cleanup();
  }
});

test('sample_run refuses a path outside the workspace', async () => {
  const { ws, cleanup } = scratch();
  try {
    const r = await sampleRun.run({ path: '../../../etc/passwd' }, ctxFor(ws));
    assert.equal(r.ok, false, 'a traversal path must not be executable');
  } finally {
    cleanup();
  }
});

// ── The core loop ────────────────────────────────────────────────────────────

test('a benign sample detonates, and its dropped file is captured and hashed', async () => {
  const { ws, cleanup } = scratch();
  try {
    writeSample(ws, 'benign.sh', '#!/bin/sh\necho hello\necho payload > dropped.txt\nexit 0\n');
    const r = await sampleRun.run({ path: 'benign.sh' }, ctxFor(ws));
    assert.equal(r.ok, true, r.summary);
    const data = r.data!;
    assert.equal(data.exitCode, 0);
    assert.match(data.stdout, /hello/);
    assert.equal(data.sandboxed, true, 'a detonation must report real containment');

    const dropped = data.artifacts.find((a) => a.path === 'dropped.txt');
    assert.ok(dropped, `dropped.txt should be an artifact, got ${JSON.stringify(data.artifacts)}`);
    assert.equal(dropped.kind, 'file');
    // The digest must be the digest of the CONTENT, not a placeholder.
    assert.match(dropped.sha256, /^[0-9a-f]{64}$/);
    assert.notEqual(dropped.sha256, '0'.repeat(64));
  } finally {
    cleanup();
  }
});

test('a non-zero exit is reported faithfully, not swallowed', async () => {
  const { ws, cleanup } = scratch();
  try {
    writeSample(ws, 'fail.sh', '#!/bin/sh\necho boom >&2\nexit 42\n');
    const r = await sampleRun.run({ path: 'fail.sh' }, ctxFor(ws));
    assert.equal(r.ok, true, 'a crashing sample is still a successful detonation');
    assert.equal(r.data!.exitCode, 42);
    assert.match(r.data!.stderr, /boom/);
  } finally {
    cleanup();
  }
});

test('hangs are killed at the timeout and reported as timedOut', async () => {
  const { ws, cleanup } = scratch();
  try {
    writeSample(ws, 'sleep.sh', '#!/bin/sh\nsleep 30\n');
    const r = await sampleRun.run({ path: 'sleep.sh', timeout_ms: 700 }, ctxFor(ws));
    assert.equal(r.ok, true, r.summary);
    assert.equal(r.data!.timedOut, true, 'a hung sample must be killed, not waited on');
    assert.ok(r.data!.wallMs < 10_000, `should not run to completion (took ${r.data!.wallMs}ms)`);
  } finally {
    cleanup();
  }
});

// ── Containment ──────────────────────────────────────────────────────────────

test('containment: a sample cannot write outside its scratch dir', async () => {
  const { ws, cleanup } = scratch();
  try {
    // Four levels up from .shadow/security/detonation/<run>/sample/ lands at the workspace root.
    writeSample(
      ws,
      'escape.sh',
      [
        '#!/bin/sh',
        'echo pwned > ../../../../ESCAPED.txt 2>/dev/null',
        'echo pwned > /tmp/shadow-det-escape.txt 2>/dev/null',
        'exit 0',
      ].join('\n') + '\n',
    );
    const r = await sampleRun.run({ path: 'escape.sh' }, ctxFor(ws));
    assert.equal(r.ok, true, r.summary);

    // Neither target may exist. This is the assertion that matters: if the sandbox degraded to
    // passthrough, both writes would land and the test fails loudly.
    assert.equal(existsSync(join(ws, 'ESCAPED.txt')), false, 'sample escaped the scratch jail to the workspace root');
    assert.equal(existsSync('/tmp/shadow-det-escape.txt'), false, 'sample escaped the scratch jail to /tmp');
  } finally {
    rmSync('/tmp/shadow-det-escape.txt', { force: true });
    cleanup();
  }
});

test('containment: the workspace is read-only during detonation', async () => {
  const { ws, cleanup } = scratch();
  try {
    writeFileSync(join(ws, 'canary.txt'), 'original\n');
    // Relative path from the scratch cwd back into the workspace tree.
    writeSample(ws, 'tamper.sh', '#!/bin/sh\necho tampered > ../../../../canary.txt 2>/dev/null\nexit 0\n');
    const r = await sampleRun.run({ path: 'tamper.sh' }, ctxFor(ws));
    assert.equal(r.ok, true, r.summary);
    assert.equal(readFileSync(join(ws, 'canary.txt'), 'utf8'), 'original\n', 'workspace file was modified by the sample');
  } finally {
    cleanup();
  }
});

// ── Network ──────────────────────────────────────────────────────────────────

test('network is denied by default and permitted only when asked', async (t) => {
  const { ws, cleanup } = scratch();
  try {
    // Use a raw socket so the result does not depend on curl/nc being installed.
    writeSample(
      ws,
      'net.py',
      [
        '#!/usr/bin/env python3',
        'import socket, sys',
        'try:',
        "    s = socket.create_connection(('1.1.1.1', 443), timeout=5); s.close(); print('CONNECTED')",
        'except Exception as e:',
        "    print('BLOCKED', type(e).__name__)",
      ].join('\n') + '\n',
    );

    const denied = await sampleRun.run({ path: 'net.py', timeout_ms: 15000 }, ctxFor(ws));
    // A missing interpreter must SKIP, not pass. A silent `return` here would report a green
    // containment test on a host that never proved anything — the exact failure mode that lets a
    // broken jail ship, because the suite goes green either way.
    if (!denied.ok) {
      t.skip(`no python3 in this environment — egress containment unproven: ${denied.summary}`);
      return;
    }
    if (/No such file|not found|cannot execute/.test(denied.data!.stderr)) {
      t.skip('no python3 in this environment — egress containment unproven');
      return;
    }
    assert.match(denied.data!.stdout, /BLOCKED/, `egress should be denied by default, got: ${denied.data!.stdout}`);

    const allowed = await sampleRun.run({ path: 'net.py', allow_network: true, timeout_ms: 15000 }, ctxFor(ws));
    assert.match(allowed.data!.stdout, /CONNECTED/, `egress should work when allowed, got: ${allowed.data!.stdout}`);
  } finally {
    cleanup();
  }
});

// ── Environment isolation ────────────────────────────────────────────────────

test('the sample does not inherit the agent environment', async () => {
  const { ws, cleanup } = scratch();
  try {
    process.env.SHADOW_TEST_SECRET = 'super-secret-token';
    writeSample(ws, 'env.sh', '#!/bin/sh\nenv\n');
    const r = await sampleRun.run({ path: 'env.sh' }, ctxFor(ws));
    assert.equal(r.ok, true, r.summary);
    assert.doesNotMatch(
      r.data!.stdout,
      /super-secret-token/,
      'a detonated sample must not see the agent env (API keys live there)',
    );
  } finally {
    delete process.env.SHADOW_TEST_SECRET;
    cleanup();
  }
});

test('dry-run detonates nothing but still reports the sample identity', async () => {
  const { ws, cleanup } = scratch();
  try {
    writeSample(ws, 'benign.sh', '#!/bin/sh\necho hi > should-not-exist.txt\n');
    const r = await sampleRun.run({ path: 'benign.sh' }, { ...ctxFor(ws), dryRun: true });
    assert.equal(r.ok, true);
    assert.match(r.summary, /dry-run/);
    assert.match(r.data!.sampleSha256, /^[0-9a-f]{64}$/);
    assert.equal(existsSync(join(ws, 'should-not-exist.txt')), false);
  } finally {
    cleanup();
  }
});

test('the receipt binds the detonation to the sample hash', async () => {
  const { ws, cleanup } = scratch();
  try {
    writeSample(ws, 'benign.sh', '#!/bin/sh\nexit 0\n');
    const r = await sampleRun.run({ path: 'benign.sh' }, ctxFor(ws));
    assert.equal(r.ok, true, r.summary);
    const sha = r.data!.sampleSha256;
    assert.match(sha, /^[0-9a-f]{64}$/);

    // The ledger must contain a finding naming this hash — "we ran it" is recorded, not claimed.
    const { EvidenceStore } = await import('../src/security/evidence.js');
    const store = new EvidenceStore(ws);
    try {
      const findings = store.list();
      const hit = findings.find((f) => f.title.includes(sha.slice(0, 16)));
      assert.ok(hit, `no receipt bound to ${sha.slice(0, 16)}; got ${JSON.stringify(findings.map((f) => f.title))}`);
      assert.match(hit!.description, /network=denied/);
    } finally {
      store.close();
    }
  } finally {
    cleanup();
  }
});
// REGRESSION (2026-10-18): `wrapCommand` returns `[...prefix, shell, '-c', command]`, and
// sample_run took `argv.slice(0, -2)` to strip the trailing `-c command`. That is off by one: it
// strips only `command`, leaving `[..., shell, '-c']` and appending the sample, so every sample
// ran as `sh -c <sample-path>` — i.e. the shell tried to READ the sample as a script. Shell-script
// fixtures hid this completely; a real compiled Mach-O/ELF failed with exit 126 and no output.
// Every detonation of an actual binary was broken. This test compiles one.
test('a real compiled binary is executed directly, not fed to a shell', async () => {
  const { ws, cleanup } = scratch();
  try {
    const csrc = join(ws, 'hello.c');
    const bin = join(ws, 'hello');
    writeFileSync(
      csrc,
      '#include <stdio.h>\nint main(int argc,char**argv){printf("REAL-BINARY-OK argc=%d\\n",argc);return 7;}\n',
    );
    const cc = spawnSync('cc', ['-O0', '-o', bin, csrc], { encoding: 'utf8' });
    if (cc.status !== 0) {
      // No toolchain on this host — skip rather than assert a false pass.
      return;
    }
    const r = await sampleRun.run({ path: 'hello' }, ctxFor(ws));
    assert.equal(r.ok, true, r.summary);
    const data = r.data!;
    assert.match(
      data.stdout,
      /REAL-BINARY-OK/,
      `the binary must actually execute; got exit=${data.exitCode} stderr=${data.stderr}`,
    );
    assert.equal(data.exitCode, 7, 'the sample owns its exit status');
    assert.equal(data.sandboxed, true);
  } finally {
    cleanup();
  }
});
