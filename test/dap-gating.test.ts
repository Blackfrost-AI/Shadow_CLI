/**
 * m10 — DAP debugging: session lifecycle, gating, and cleanup (fake adapter).
 *
 * These tests use the in-memory fake adapter from test/fixtures/dap.ts — NO real
 * debugger process is ever spawned and adapter availability is never simulated.
 * The fake speaks REAL DAP framing over in-memory byte streams, so the protocol
 * layer is exercised exactly as it would be on a real pipe.
 *
 * The workspace root is a REAL temp directory with REAL files, because the jail
 * check (insideProject) realpaths against the actual filesystem — a fake root
 * would make every path fail the jail for the wrong reason.
 *
 * Coverage:
 *  A. Gate: single-use digest-bound approvals; operator denial stops everything
 *     before any process exists.
 *  B. Untrusted launch validation: argv arrays only, no shell metas, NUL, jail,
 *     loopback-only attach, env NAMES only.
 *  C. Wire discipline: DAP launch ordering; STOPPED_ONLY commands.
 *  D. Sequence enforcement at session level.
 *  E. Terminated sessions: no command runs after the debuggee dies.
 *  F. Cleanup: every waiter dies with the session; close is idempotent; a
 *     refused launch must not wedge the session open.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAdapter } from './fixtures/dap.js';
import {
  DapSession,
  DapSessionError,
  MAX_LAUNCH_ARGS,
  MAX_ARG_CHARS,
  validateLaunchConfig,
  debuggeeEnv,
} from '../src/agent/dap/session.js';
import { createDapGate, DapGateError, dapLaunchDigest } from '../src/agent/dap/gating.js';

const SPEC: import('../src/agent/dap/adapters.js').DapAdapterSpec = {
  id: 'js-debug',
  language: 'js',
  command: 'node',
  args: ['adapter.js'],
  installRequirement: 'none',
};

/** A REAL temp workspace with REAL files so the jail check is genuine. */
let ROOT = '';
const PROGRAM = () => join(ROOT, 'app.js');

function setupRoot(): void {
  ROOT = mkdtempSync(join(tmpdir(), 'dap-test-'));
  writeFileSync(PROGRAM(), '// debuggee stub\n');
}
function teardownRoot(): void {
  rmSync(ROOT, { recursive: true, force: true });
}

/** A prompt decider the tests control, recording every request it saw. */
function makePrompt(): {
  prompt: (r: { kind: string; description: string; digest: string }) => Promise<boolean>;
  approve: () => void;
  deny: () => void;
} {
  let decision = true;
  return {
    prompt: async () => decision,
    approve: () => { decision = true; },
    deny: () => { decision = false; },
  };
}

const launchCfg = () => ({
  adapterId: 'js-debug',
  mode: 'launch',
  program: PROGRAM(),
  args: [],
  envKeys: [],
});

function makeSession(
  fake: FakeAdapter,
  prompt: ReturnType<typeof makePrompt>['prompt'],
  opts: { handshakeTimeoutMs?: number } = {},
): DapSession {
  return new DapSession({
    workspaceRoot: ROOT,
    adapter: SPEC,
    sessionId: 'sess-1',
    prompt,
    transportFactory: () => fake.transport,
    handshakeTimeoutMs: opts.handshakeTimeoutMs ?? 1_000,
  });
}

/** Script the fake so a full spec-compliant handshake completes and the session runs. */
function scriptHandshake(fake: FakeAdapter): void {
  fake.setScript({
    initialize: { kind: 'resolve', body: { supportTerminateDebuggee: true } },
    launch: { kind: 'drop' }, // answered only after configurationDone (DAP spec)
    configurationDone: { kind: 'resolve' },
    disconnect: { kind: 'resolve' },
  });
  setTimeout(() => fake.emit('initialized'), 5);
  setTimeout(() => fake.respondTo(2), 20); // launch request seq is 2
}

async function launchOk(fake: FakeAdapter): Promise<DapSession> {
  const p = makePrompt();
  const session = makeSession(fake, p.prompt);
  await session.requestLaunchApproval(launchCfg());
  scriptHandshake(fake);
  await session.launch(launchCfg());
  return session;
}

/** Catch the error message a call rejects with. */
async function rejectMsg(p: Promise<unknown> | (() => Promise<unknown>)): Promise<string> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('expected a rejection');
}

// ── A. Gate ─────────────────────────────────────────────────────────────────

test('A1: operator denial stops the launch BEFORE any request exists', async () => {
  setupRoot();
  try {
    const fake = new FakeAdapter();
    const p = makePrompt();
    p.deny();
    const session = makeSession(fake, p.prompt);
    const msg = await rejectMsg(session.requestLaunchApproval(launchCfg()));
    assert.match(msg, /did not approve/);
    assert.equal(fake.receivedCommands.length, 0);
    assert.equal(session.getState(), 'created');
  } finally {
    teardownRoot();
  }
});

test('A2: launch approvals are single-use and digest-bound at the gate', async () => {
  const p = makePrompt();
  const gate = createDapGate('sess-1', p.prompt);
  const config = {
    kind: 'launch' as const,
    adapterId: 'js-debug',
    mode: 'launch' as const,
    program: '/ws/app.js',
    cwd: '/ws',
    args: [],
    envKeys: [],
  };
  const request = await gate.requestLaunchApproval(config);
  assert.equal(request.digest, dapLaunchDigest(config));
  assert.ok(gate.consume('launch', request.digest));
  assert.equal(gate.consume('launch', request.digest), null);
  assert.equal(gate.consume('launch', dapLaunchDigest({ ...config, program: '/ws/other.js' })), null);
  assert.equal(gate.consume('evaluate', request.digest), null);
});

test('A3: evaluate approvals are single-use, per-expression, and frame-bound', async () => {
  const p = makePrompt();
  const gate = createDapGate('sess-1', p.prompt);
  const request = await gate.requestEvaluateApproval('process.exit(1)', 3, 'repl');
  assert.match(request.description, /frame 3/);
  assert.ok(gate.consume('evaluate', request.digest));
  assert.equal(gate.consume('evaluate', request.digest), null);
  const other = await gate.requestEvaluateApproval('process.exit(1)', 4, 'repl');
  assert.ok(gate.consume('evaluate', other.digest));
  assert.equal(gate.consume('evaluate', request.digest), null);
});

test('A4: no approval at all → launch refused with the exact gate refusal', async () => {
  setupRoot();
  try {
    const fake = new FakeAdapter();
    const session = makeSession(fake, makePrompt().prompt);
    const msg = await rejectMsg(() => session.launch(launchCfg()));
    assert.match(msg, /no valid approval binds to this exact configuration/);
    assert.equal(fake.receivedCommands.length, 0);
    assert.equal(session.getState(), 'created');
  } finally {
    teardownRoot();
  }
});

// ── B. Untrusted launch validation ──────────────────────────────────────────

test('B1: non-object configs and wrong modes are refused pre-approval', async () => {
  setupRoot();
  try {
    const fake = new FakeAdapter();
    const session = makeSession(fake, makePrompt().prompt);
    for (const bad of [null, 'string', 42, [], { mode: 'nonsense' }, { mode: 'launch' }]) {
      const msg = await rejectMsg(session.requestLaunchApproval(bad));
      assert.match(msg, /Untrusted launch configuration rejected/);
    }
    assert.equal(fake.receivedCommands.length, 0);
    assert.equal(session.getState(), 'created');
  } finally {
    teardownRoot();
  }
});

test('B2: shell metacharacters in args are rejected outright', async () => {
  setupRoot();
  try {
    const fake = new FakeAdapter();
    const session = makeSession(fake, makePrompt().prompt);
    for (const arg of ['; rm -rf /', '`x`', 'a$(id)b', 'a|b', 'a>b']) {
      const msg = await rejectMsg(session.requestLaunchApproval({ ...launchCfg(), args: [arg] }));
      assert.match(msg, /shell metacharacters/, `arg ${JSON.stringify(arg)}`);
    }
    assert.equal(fake.receivedCommands.length, 0);
  } finally {
    teardownRoot();
  }
});

test('B3: NUL bytes in program or args are rejected', async () => {
  setupRoot();
  try {
    const fake = new FakeAdapter();
    const session = makeSession(fake, makePrompt().prompt);
    assert.match(await rejectMsg(session.requestLaunchApproval({ ...launchCfg(), program: `${join(ROOT, 'a\0b.js')}` })), /NUL/);
    assert.match(await rejectMsg(session.requestLaunchApproval({ ...launchCfg(), args: ['x\0'] })), /NUL/);
    assert.equal(fake.receivedCommands.length, 0);
  } finally {
    teardownRoot();
  }
});

test('B4: argv bounds — too many args and over-long args are refused', async () => {
  setupRoot();
  try {
    const fake = new FakeAdapter();
    const session = makeSession(fake, makePrompt().prompt);
    const msg1 = await rejectMsg(session.requestLaunchApproval({ ...launchCfg(), args: Array(MAX_LAUNCH_ARGS + 1).fill('x') }));
    assert.match(msg1, /cap/);
    const msg2 = await rejectMsg(session.requestLaunchApproval({ ...launchCfg(), args: ['a'.repeat(MAX_ARG_CHARS + 1)] }));
    assert.match(msg2, /exceeds/);
    assert.equal(fake.receivedCommands.length, 0);
  } finally {
    teardownRoot();
  }
});

test('B5: program and cwd must exist and stay inside the workspace jail', async () => {
  setupRoot();
  try {
    const fake = new FakeAdapter();
    const session = makeSession(fake, makePrompt().prompt);
    // Outside the jail but REAL (exists on disk): the temp parent directory.
    const outside = join(tmpdir(), 'outside-target.js');
    writeFileSync(outside, 'x');
    try {
      const cfgOut = { ...launchCfg(), program: outside };
      assert.match(await rejectMsg(session.requestLaunchApproval(cfgOut)), /stay inside the workspace/);
      // Nonexistent inside the root:
      assert.match(
        await rejectMsg(session.requestLaunchApproval({ ...launchCfg(), program: join(ROOT, 'nope.js') })),
        /does not exist/,
      );
      // cwd outside the jail (real dir):
      assert.match(await rejectMsg(session.launch({ ...launchCfg(), cwd: tmpdir() })), /stay inside the workspace/);
    } finally {
      rmSync(outside, { force: true });
    }
    assert.equal(fake.receivedCommands.length, 0);
  } finally {
    teardownRoot();
  }
});

test('B6: attach is loopback-only and never executes anything', async () => {
  setupRoot();
  try {
    const fake = new FakeAdapter();
    const session = makeSession(fake, makePrompt().prompt);
    const attach = { adapterId: 'js-debug', mode: 'attach', port: 9229, envKeys: [] };
    assert.match(await rejectMsg(session.requestLaunchApproval({ ...attach, host: '10.0.0.1' })), /loopback/);
    assert.match(await rejectMsg(session.requestLaunchApproval({ ...attach, program: PROGRAM() })), /must not name a program/);
    for (const port of [0, -1, 65536, 1.5]) {
      assert.match(await rejectMsg(session.requestLaunchApproval({ ...attach, port })), /port/);
    }
    assert.equal(fake.receivedCommands.length, 0);
  } finally {
    teardownRoot();
  }
});

test('B7: env values are never taken from the config — names only', async () => {
  setupRoot();
  try {
    const fake = new FakeAdapter();
    const session = makeSession(fake, makePrompt().prompt);
    assert.match(await rejectMsg(session.requestLaunchApproval({ ...launchCfg(), envKeys: ['0BADC0DE'] })), /Invalid env key/);
    // The debuggee env is PATH + approved names ONLY — the scrubbed base is
    // never spread wholesale, and unlisted secrets never reach the debuggee:
    const base = { PATH: '/usr/bin', HOME: '/home/u', USER: 'u', KEEP_ME: 'v', SECRET: 's' } as NodeJS.ProcessEnv;
    const env = debuggeeEnv(['KEEP_ME'], base);
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.KEEP_ME, 'v');
    assert.equal(env.SECRET, undefined);
    assert.equal(env.HOME, undefined);
    assert.equal(env.USER, undefined);
    const noApprovals = debuggeeEnv([], base);
    assert.deepEqual(noApprovals, { PATH: '/usr/bin' });
    assert.equal(fake.receivedCommands.length, 0);
  } finally {
    teardownRoot();
  }
});

// ── C. Wire discipline ──────────────────────────────────────────────────────

test('C1: DAP ordering — initialize first, launch before configurationDone, running last', async () => {
  setupRoot();
  try {
    const fake = new FakeAdapter();
    const session = await launchOk(fake);
    assert.deepEqual(fake.receivedCommands, ['initialize', 'launch', 'configurationDone']);
    assert.equal(session.getState(), 'running');
    assert.equal(session.summary().state, 'running');
    assert.equal(session.summary().terminated, false);
  } finally {
    teardownRoot();
  }
});

test('C2: STOPPED_ONLY commands refuse while running', async () => {
  setupRoot();
  try {
    const fake = new FakeAdapter();
    const session = await launchOk(fake);
    for (const command of ['stackTrace', 'scopes', 'variables', 'evaluate'] as const) {
      const msg = await rejectMsg(() => session.request(command));
      assert.match(msg, new RegExp(`'${command}' requires a stopped debuggee`));
    }
    assert.equal(session.getState(), 'running');
  } finally {
    teardownRoot();
  }
});

test('C3: evaluate refuses while running (gate never reached)', async () => {
  setupRoot();
  try {
    const fake = new FakeAdapter();
    const session = await launchOk(fake);
    const msg = await rejectMsg(() => session.evaluate('1+1', 1));
    assert.match(msg, /requires a stopped debuggee/);
  } finally {
    teardownRoot();
  }
});
// ── D. Sequence enforcement ─────────────────────────────────────────────────

test('D1: a replayed sequence kills the session and nothing works after', async () => {
  setupRoot();
  try {
    const fake = new FakeAdapter();
    const session = await launchOk(fake);
    fake.emit('stopped', { reason: 'breakpoint' });
    assert.equal(session.getState(), 'stopped');
    // Replay the same sequence → protocol violation → closed:
    fake.emitWithSeq(2, 'stopped', { reason: 'breakpoint' });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(session.getState(), 'closed');
    const msg = await rejectMsg(() => session.request('threads'));
    assert.match(msg, /no transport|closed/);
  } finally {
    teardownRoot();
  }
});

// ── E. Terminated sessions ─────────────────────────────────────────────────

test('E0: a refused configurationDone (or failed initial breakpoint) never wedges the session open with a live adapter', async () => {
  setupRoot();
  try {
    const fake = new FakeAdapter();
    const p = makePrompt();
    const session = makeSession(fake, p.prompt);
    await session.requestLaunchApproval(launchCfg());
    // Handshake proceeds, but the adapter REFUSES configurationDone:
    fake.setScript({
      initialize: { kind: 'resolve', body: { supportTerminateDebuggee: true } },
      launch: { kind: 'drop' },
      configurationDone: { kind: 'refuse', message: 'no debugging for you' },
      disconnect: { kind: 'resolve' },
    });
    setTimeout(() => fake.emit('initialized'), 5);
    const msg = await rejectMsg(() => session.launch(launchCfg()));
    // The session is closed — never wedged in `configuring` with a live child:
    assert.equal(session.getState(), 'closed');
    assert.match(msg, /no debugging for you/);
    // And the fake adapter (stand-in for the adapter child) is dead — close()
    // ran its terminate path against the transport:
    assert.equal(fake.isAlive(), false);
  } finally {
    teardownRoot();
  }
});

test('E1: adapter `terminated` event closes the session and no command works after', async () => {
  setupRoot();
  try {
    const fake = new FakeAdapter();
    const session = await launchOk(fake);
    fake.emit('terminated');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(session.getState(), 'closed');
    assert.equal(session.summary().terminated, true);
    const msg = await rejectMsg(() => session.request('threads'));
    assert.match(msg, /no transport|closed|terminated/);
  } finally {
    teardownRoot();
  }
});

// ── F. Cleanup ──────────────────────────────────────────────────────────────

test('F1: disconnect closes cleanly, is idempotent, and leaves nothing pending', async () => {
  setupRoot();
  try {
    const fake = new FakeAdapter();
    const session = await launchOk(fake);
    await session.disconnect();
    assert.equal(session.getState(), 'closed');
    await session.disconnect();
    assert.equal(session.getState(), 'closed');
    assert.deepEqual(session.pendingCommands(), []);
    const msg = await rejectMsg(() => session.request('threads'));
    assert.match(msg, /no transport|closed/);
  } finally {
    teardownRoot();
  }
});

test('F2: an adapter that never reports readiness is refused within the handshake timeout', async () => {
  setupRoot();
  try {
    const fake = new FakeAdapter();
    const session = makeSession(fake, makePrompt().prompt, { handshakeTimeoutMs: 50 });
    await session.requestLaunchApproval(launchCfg());
    fake.setScript({
      initialize: { kind: 'resolve', body: {} },
      launch: { kind: 'drop' },
      disconnect: { kind: 'resolve' },
    });
    const msg = await rejectMsg(() => session.launch(launchCfg()));
    assert.match(msg, /never reported readiness|cancelled|closed/);
    assert.equal(session.getState(), 'closed');
  } finally {
    teardownRoot();
  }
});

test('F3: a refused launch must not wedge the session open (cleanup, then the refusal)', async () => {
  setupRoot();
  try {
    const fake = new FakeAdapter();
    const session = makeSession(fake, makePrompt().prompt, { handshakeTimeoutMs: 500 });
    await session.requestLaunchApproval(launchCfg());
    fake.setScript({
      initialize: { kind: 'resolve', body: {} },
      launch: { kind: 'refuse', message: 'no such program' },
      configurationDone: { kind: 'resolve' },
      disconnect: { kind: 'resolve' },
    });
    setTimeout(() => fake.emit('initialized'), 5);
    const msg = await rejectMsg(() => session.launch(launchCfg()));
    assert.match(msg, /no such program/);
    assert.equal(session.getState(), 'closed');
    assert.deepEqual(session.pendingCommands(), []);  } finally {
    teardownRoot();
  }
});

test('F4: an unscripted (dropped) initialize cannot hang the session forever', async () => {
  setupRoot();
  try {
    const fake = new FakeAdapter();
    const session = makeSession(fake, makePrompt().prompt, { handshakeTimeoutMs: 50 });
    await session.requestLaunchApproval(launchCfg());
    fake.setScript({ disconnect: { kind: 'resolve' } });
    const msg = await rejectMsg(() => session.launch(launchCfg()));
    assert.match(msg, /never reported readiness|cancelled|closed/);
    assert.equal(session.getState(), 'closed');
  } finally {
    teardownRoot();
  }
});

// ── direct pure-function checks ─────────────────────────────────────────────

test('E2: summary() redacts absolute paths and credentials from adapter stderr', async () => {
  setupRoot();
  try {
    const fake = new FakeAdapter();
    const session = await launchOk(fake);
    // Realistic adapter stderr: stack traces leak absolute home paths.
    fake.emitStderr('Error: Cannot find module \'/Users/craigmac/project/src/main.ts\'\n'
      + 'at Object.<anonymous> (/Users/craigmac/project/node_modules/x.js:3:1)\n');
    const tail = session.summary().stderrTail;
    assert.ok(!tail.includes('/Users/craigmac'), 'absolute home paths must never surface via stderrTail');
    assert.ok(!tail.includes('project/src'), 'directory structure must never surface via stderrTail');
    // The redaction is explicit, not silent truncation:
    assert.ok(tail.includes('Cannot find module'), 'the diagnostic message itself survives redaction');
  } finally {
    teardownRoot();
  }
});

test('B8: validateLaunchConfig jail and normalization (pure function)', () => {
  setupRoot();
  try {
    const inside = validateLaunchConfig(ROOT, launchCfg(), {});
    assert.equal(inside.ok, true);
    const outside = validateLaunchConfig(ROOT, { ...launchCfg(), cwd: tmpdir() }, {});
    assert.equal(outside.ok, false);
    assert.match((outside as { error: string }).error, /stay inside the workspace/);
  } finally {
    teardownRoot();
  }
});

test('DapSessionError and DapGateError are distinct, named error types', () => {
  const a = new DapSessionError('x');
  const b = new DapGateError('y');
  assert.equal(a.name, 'DapSessionError');
  assert.equal(b.name, 'DapGateError');
  assert.ok(a instanceof Error);
  assert.ok(b instanceof Error);
});
