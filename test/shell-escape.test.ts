import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rejectUnsafeShellInput, runShellEscape, SHELL_ESCAPE_COMMAND } from '../src/tui/shellEscape.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { AgentLoop, type LoopDeps } from '../src/agent/loop.js';
import { Budget } from '../src/agent/budget.js';
import { Context } from '../src/agent/context.js';
import { EventBus } from '../src/agent/events.js';
import { AutoApproveGate } from '../src/agent/approval.js';
import { makeRunShell } from '../src/tools/runShell.js';

function makeWorkspace(): string {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, 'shell-escape-'));
}

test('only an explicit /! prefix is a shell escape', () => {
  assert.equal(SHELL_ESCAPE_COMMAND, '/!');
  assert.deepEqual(rejectUnsafeShellInput('echo hi'), { ok: false });
  assert.deepEqual(rejectUnsafeShellInput('/echo hi'), { ok: false });
  // No-space form matches bash !-style muscle memory: /!ls runs `ls` — the typed ! prefix
  // IS the explicit operator intent.
  assert.deepEqual(rejectUnsafeShellInput('/!ls'), { ok: true, command: 'ls' });
  assert.deepEqual(rejectUnsafeShellInput('/! echo hi'), { ok: true, command: 'echo hi' });
});

test('unsafe inputs are rejected before any state changes', () => {
  assert.equal(rejectUnsafeShellInput('/!').ok, false);
  assert.match(rejectUnsafeShellInput('/!').reason!, /Usage/);
  assert.equal(rejectUnsafeShellInput('/!   ').ok, false);
  assert.equal(rejectUnsafeShellInput('/! [Pasted text #1 +10 lines]').ok, false);
  assert.match(rejectUnsafeShellInput('/! [Pasted text #1 +10 lines]').reason!, /Pasted/);
  assert.equal(rejectUnsafeShellInput('/! echo one\necho two').ok, false);
  assert.match(rejectUnsafeShellInput('/! echo one\necho two').reason!, /Multiline/);
});

test('runShellEscape refuses busy state without touching the pipeline', async () => {
  const calls: string[] = [];
  await runShellEscape({
    busy: () => true,
    errorLine: (t) => calls.push(`error:${t}`),
    outcomeLine: (t, ok) => calls.push(`outcome:${t}:${ok}`),
    clearComposer: () => calls.push('cleared'),
    armAbort: () => { calls.push('armed'); },
    acquireLock: () => { calls.push('lock'); return Promise.resolve(() => {}); },
    runNativeTool: () => { calls.push('exec'); return Promise.resolve({ ok: true, summary: '' }); },
    newBudget: () => ({}),
  }, '/! echo hi');
  assert.equal(calls.filter((c) => c === 'exec').length, 0);
  assert.equal(calls.filter((c) => c === 'lock').length, 0);
  assert.equal(calls.filter((c) => c === 'cleared').length, 0);
  assert.ok(calls.some((c) => c.startsWith('error:Finish the current operation')));
});

test('runShellEscape refuses unsafe input without clearing the composer', async () => {
  const calls: string[] = [];
  await runShellEscape({
    busy: () => false,
    errorLine: (t) => calls.push(`error:${t}`),
    outcomeLine: (t, ok) => calls.push(`outcome:${t}:${ok}`),
    clearComposer: () => calls.push('cleared'),
    armAbort: () => { calls.push('armed'); },
    acquireLock: () => { calls.push('lock'); return Promise.resolve(() => {}); },
    runNativeTool: () => { calls.push('exec'); return Promise.resolve({ ok: true, summary: '' }); },
    newBudget: () => ({}),
  }, '/! echo one\necho two');
  assert.deepEqual(calls, ['error:Multiline input cannot launch a shell. Type the command on one line.']);
});

test('runShellEscape dispatches exactly once and releases the lock', async () => {
  const calls: string[] = [];
  let released = false;
  await runShellEscape({
    busy: () => false,
    errorLine: (t) => calls.push(`error:${t}`),
    outcomeLine: (t, ok) => calls.push(`outcome:${t}:${ok}`),
    clearComposer: () => calls.push('cleared'),
    armAbort: () => { calls.push('armed'); },
    acquireLock: () => { calls.push('lock'); return Promise.resolve(() => { released = true; }); },
    runNativeTool: (_name, input) => {
      calls.push(`exec:${(input as { command: string }).command}`);
      assert.equal(_name, 'run_shell');
      return Promise.resolve({ ok: true, summary: 'ok' });
    },
    newBudget: () => ({}),
  }, '/!  echo once');
  assert.equal(released, true);
  assert.deepEqual(calls, ['cleared', 'armed', 'lock', 'exec:echo once', 'outcome:shell ok: ok:true']);
});

test('operator shell commands go through the REAL pipeline: injected commands are denied, typed commands run', async () => {
  const workspace = makeWorkspace();
  try {
    const registry = new ToolRegistry();
    const bus = new EventBus();
    // The point is POLICY classification, not sandbox confinement: sandbox off keeps the
    // test platform-independent while the real denylist still runs.
    const shell = makeRunShell({
      sandbox: 'off',
      denylist: (cmd) => (/\$\(|`|%[A-Za-z0-9_]+%/.test(cmd) ? 'command_injection_detected' : null),
    });
    registry.register(shell);
    const loopDeps: LoopDeps = {
      provider: { async *send() { yield { type: 'done', stopReason: 'end_turn' } as never; } } as unknown as LoopDeps['provider'],
      registry,
      gate: new AutoApproveGate(),
      bus,
      budget: new Budget({ maxIterations: 0 }, 'mock', { mock: { input: 1, output: 1 } }, Date.now()),
      context: new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 }),
      signal: new AbortController().signal,
      model: 'mock',
      system: 'test',
      maxOutputTokens: 1024,
      workspaceRoot: workspace,
      dryRun: false,
      maxToolResultChars: 16_384,
      contextBudget: 1_000_000,
    };
    const loop = new AgentLoop(loopDeps, 'full');
    // Command injection (`$(...)` substitution) must be classified and denied by the real
    // policy pipeline — proving the shell escape has no bypass around it.
    const injected = await loop.runToolCall({ id: 'native_1', name: 'run_shell', input: { command: 'echo $(pwned)' } });
    assert.equal(injected.ok, false);
    assert.match(injected.summary, /blocked|denied/i);
    // A typed benign command passes the same pipeline and really executes.
    const safe = await loop.runToolCall({ id: 'native_2', name: 'run_shell', input: { command: 'echo pipeline-real' } });
    assert.equal(safe.ok, true);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('a cancelled escape settles: the executor must honour the abort signal like the real pipeline', async () => {
  const controller = new AbortController();
  let released = 0;
  let settled = false;
  const pending = new Promise<void>((resolve) => {
    controller.signal.addEventListener('abort', () => { settled = true; resolve(); }, { once: true });
  });
  await runShellEscape({
    busy: () => false,
    errorLine: () => {},
    outcomeLine: () => {},
    clearComposer: () => {},
    armAbort: (c) => { controller.abort(); c.abort(); },
    acquireLock: (signal) => {
      assert.ok(signal.aborted); // acquisition sees what the host sees
      return Promise.resolve(() => { released++; });
    },
    runNativeTool: async () => { await pending; return { ok: false, summary: 'aborted' }; },
    newBudget: () => ({}),
  }, '/! echo hi');
  assert.equal(released, 1);
  assert.ok(settled);
});
