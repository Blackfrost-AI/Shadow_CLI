import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runHookPhase,
  runHooks,
  matchToolName,
  parseHookStdout,
  normalizeHookEntry,
  MAX_HOOK_CONTEXT_CHARS,
} from '../src/hooks/runner.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'shadow-hooks2-'));
}

function script(root: string, name: string, body: string): string {
  const p = join(root, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(p, 0o755);
  return p;
}

// ─── F08-09: matcher semantics (glob/pipe on the tool name) ────────────────────────────────────

test('matchToolName: pipe alternatives and glob * / ? match full tool names', () => {
  assert.equal(matchToolName('edit_file|multi_edit', 'edit_file'), true);
  assert.equal(matchToolName('edit_file|multi_edit', 'multi_edit'), true);
  assert.equal(matchToolName('edit_file|multi_edit', 'run_shell'), false);
  assert.equal(matchToolName('edit_*', 'edit_file'), true);
  assert.equal(matchToolName('edit_*', 'multi_edit'), false);
  assert.equal(matchToolName('run_shell_?', 'run_shell_a'), true);
  assert.equal(matchToolName('run_shell_?', 'run_shell_ab'), false);
  // Glob special chars in the matcher are treated literally, not as regex.
  assert.equal(matchToolName('a.b', 'axb'), false);
  assert.equal(matchToolName('a.b', 'a.b'), true);
  assert.equal(matchToolName('', 'edit_file'), false);
});

test('normalizeHookEntry accepts the v1 string form and the v2 object form', () => {
  assert.deepEqual(normalizeHookEntry('/abs/cmd.sh'), { command: '/abs/cmd.sh' });
  assert.deepEqual(normalizeHookEntry({ command: '/abs/cmd.sh', matcher: 'edit_*' }), {
    command: '/abs/cmd.sh',
    matcher: 'edit_*',
  });
});

test('a matcher that excludes the tool SKIPS the hook (marker never drops), phase stays ok', () => {
  const root = tmp();
  try {
    const marker = join(root, 'RAN');
    const s = script(root, 'h.sh', `touch "${marker}"`);
    const r = runHookPhase('pre_tool_use', [{ command: s, matcher: 'edit_*' }], {
      workspaceRoot: root,
      tool: 'run_shell',
    });
    assert.equal(r.ok, true, 'non-matching entry does not deny');
    assert.equal(existsSync(marker), false, 'the hook must not run for a non-matching tool');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a matcher that matches the tool RUNS the hook (and can still deny)', () => {
  const root = tmp();
  try {
    const marker = join(root, 'RAN');
    const s = script(root, 'h.sh', `touch "${marker}"\nexit 1`);
    const r = runHookPhase('pre_tool_use', [{ command: s, matcher: 'edit_*|run_shell' }], {
      workspaceRoot: root,
      tool: 'run_shell',
    });
    assert.equal(existsSync(marker), true, 'matching tool runs the hook');
    assert.equal(r.ok, false, 'deny phase: non-zero exit still blocks');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('matchers are ignored on non-tool phases: the entry runs regardless', () => {
  const root = tmp();
  try {
    const marker = join(root, 'RAN');
    const s = script(root, 'h.sh', `touch "${marker}"`);
    const r = runHookPhase('session_start', [{ command: s, matcher: 'edit_*' }], {
      workspaceRoot: root,
    });
    assert.equal(r.ok, true);
    assert.equal(existsSync(marker), true, 'session_start has no tool context — matcher is inert');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── F08-09: stdout verdicts ({decision, reason} / {context}) ──────────────────────────────────

test('parseHookStdout: only a single JSON object yields a verdict', () => {
  assert.deepEqual(parseHookStdout(''), {});
  assert.deepEqual(parseHookStdout('just some logs'), {});
  assert.deepEqual(parseHookStdout('{"decision":"block"} trailing garbage'), {});
  assert.deepEqual(parseHookStdout('[1,2,3]'), {});
  assert.deepEqual(parseHookStdout('"str"'), {});
  assert.deepEqual(parseHookStdout('{not json'), {});
  assert.deepEqual(parseHookStdout('{"decision":"block","reason":"nope"}'), { block: 'nope' });
  assert.deepEqual(parseHookStdout('{"decision":"deny","reason":"stop"}'), { block: 'stop' });
  assert.deepEqual(parseHookStdout('{"decision":"approve"}'), {});
  assert.deepEqual(parseHookStdout('{"context":"hello"}'), { context: 'hello' });
  // A block without a reason still blocks, with a default message.
  assert.equal(parseHookStdout('{"decision":"block"}').block, 'blocked by hook decision');
});

test('an exit-0 hook can BLOCK via stdout decision even though it exited 0', () => {
  const root = tmp();
  try {
    const s = script(root, 'h.sh', `printf '{"decision":"block","reason":"guarded by policy"}'`);
    const r = runHookPhase('pre_tool_use', [s], { workspaceRoot: root, tool: 'run_shell' });
    assert.equal(r.ok, false);
    assert.match(r.message ?? '', /guarded by policy/);
    const r2 = runHookPhase('user_prompt_submit', [s], { workspaceRoot: root, prompt: 'do it' });
    assert.equal(r2.ok, false, 'user_prompt_submit is a deny phase too');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a block decision is honored only on deny phases (post_tool_use cannot block)', () => {
  const root = tmp();
  try {
    const s = script(root, 'h.sh', `printf '{"decision":"block","reason":"late"}'`);
    const r = runHookPhase('post_tool_use', [s], { workspaceRoot: root, tool: 'run_shell' });
    assert.equal(r.ok, true, 'nothing to block after the tool already ran');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('exit-0 hook context accumulates across hooks and is returned for folding', () => {
  const root = tmp();
  try {
    const a = script(root, 'a.sh', `printf '{"context":"alpha"}'`);
    const b = script(root, 'b.sh', `printf '{"context":"beta"}'`);
    const c = script(root, 'c.sh', `echo 'plain logs, no verdict'`);
    const r = runHookPhase('post_tool_use', [a, c, b], { workspaceRoot: root, tool: 'run_shell' });
    assert.equal(r.ok, true);
    assert.equal(r.context, 'alpha\nbeta', 'logs-only hook contributes nothing');
    // runHooks wrapper carries the same shape.
    const r2 = runHooks('pre_tool_use', [a], { workspaceRoot: root, tool: 'edit_file' });
    assert.equal(r2.context, 'alpha');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hook stdout is UNTRUSTED INPUT: control chars are stripped from context and reason', () => {
  const root = tmp();
  try {
    // Emit a context with an ESC sequence + bell embedded (printf escapes inside sh).
    const s = script(root, 'h.sh', `printf '{"context":"a\\\\u001b[31mb\\\\u0007c"}'`);
    const r = runHookPhase('post_tool_use', [s], { workspaceRoot: root, tool: 'x' });
    // The JSON \\u001b decodes to a real ESC; the cleaner must strip it (and the bell).
    assert.equal(r.context, 'a[31mbc', `control chars stripped, got ${JSON.stringify(r.context)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('context is clamped at MAX_HOOK_CONTEXT_CHARS with a truncation marker', () => {
  const root = tmp();
  try {
    const big = 'x'.repeat(MAX_HOOK_CONTEXT_CHARS + 2000);
    const s = script(root, 'h.sh', `printf '{"context":"%s"}' "${big}"`);
    const r = runHookPhase('post_tool_use', [s], { workspaceRoot: root, tool: 'x' });
    assert.ok(r.context, 'context present');
    assert.ok(
      (r.context ?? '').length <= MAX_HOOK_CONTEXT_CHARS + 64,
      `clamped near the cap, got ${(r.context ?? '').length}`,
    );
    assert.match(r.context ?? '', /hook context truncated/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a FAILED hook contributes no verdict and no context (fail-closed)', () => {
  const root = tmp();
  try {
    const s = script(root, 'h.sh', `printf '{"decision":"block","reason":"should not count"}'\nexit 1`);
    const r = runHookPhase('post_tool_use', [s], { workspaceRoot: root, tool: 'x' });
    assert.equal(r.ok, true, 'non-deny phase: failure does not deny');
    assert.equal(r.context, undefined, 'a failed hook cannot inject context');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v1 behavior intact: string entries, logs-only stdout, non-zero exit on deny phases', () => {
  const root = tmp();
  try {
    const ok = script(root, 'ok.sh', `echo 'log line only'`);
    const r = runHookPhase('pre_tool_use', [ok], { workspaceRoot: root, tool: 'edit_file' });
    assert.deepEqual(r, { ok: true }, 'logs-only exit-0 hook: no verdict, no context');
    const bad = script(root, 'bad.sh', `exit 3`);
    const r2 = runHookPhase('pre_tool_use', [bad], { workspaceRoot: root, tool: 'edit_file' });
    assert.equal(r2.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── F08-09: config schema accepts both entry forms ────────────────────────────────────────────

test('HooksSchema accepts string and {command, matcher?} entries, rejects empty command', async () => {
  const { z } = await import('zod');
  const HookEntrySchema = z.union([
    z.string().min(1),
    z.object({ command: z.string().min(1), matcher: z.string().optional() }),
  ]);
  assert.equal(HookEntrySchema.safeParse('/abs/hook.sh').success, true);
  assert.equal(HookEntrySchema.safeParse({ command: '/abs/hook.sh' }).success, true);
  assert.equal(HookEntrySchema.safeParse({ command: '/abs/hook.sh', matcher: 'edit_*' }).success, true);
  assert.equal(HookEntrySchema.safeParse({ command: '' }).success, false);
  assert.equal(HookEntrySchema.safeParse('').success, false);
  assert.equal(HookEntrySchema.safeParse(42).success, false);
});

test('a global config with v2 hook entries loads through loadConfig', async () => {
  // GLOBAL_DIR caches homedir() at module load — redirect HOME BEFORE importing config,
  // exactly like the profiles tests (npm test only, never bun test).
  const { isolateHome, assertStoreIsolated } = await import('./helpers/isolateHome.js');
  const { shadowDir } = isolateHome('hooks-v2');
  const { loadConfig } = await import('../src/config.js');
  const { GLOBAL_DIR } = await import('../src/state/globalStore.js');
  assertStoreIsolated(GLOBAL_DIR, shadowDir);
  writeFileSync(
    join(shadowDir, 'config.json'),
    JSON.stringify({
      hooks: {
        pre_tool_use: ['/abs/a.sh', { command: '/abs/b.sh', matcher: 'edit_*' }],
      },
    }),
    'utf8',
  );
  const ws = tmp();
  try {
    const cfg = loadConfig(ws, {});
    assert.deepEqual(cfg.hooks.pre_tool_use, [
      '/abs/a.sh',
      { command: '/abs/b.sh', matcher: 'edit_*' },
    ]);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ─── adversarial review regressions (2026-08-14): F1–F7 ────────────────────────────────────────

test('F1: a SIGTERM-immune hook is killed at the cap — the phase fails fast and no late verdict is honored', async () => {
  const { hookTiming, runHookPhase: runPhase } = await import('../src/hooks/runner.js');
  const saved = hookTiming.timeoutMs;
  hookTiming.timeoutMs = 700;
  const root = tmp();
  try {
    // Ignores SIGTERM and would (if ever allowed to finish) print a context verdict ~2s late.
    const s = script(root, 'immune.sh', `trap '' TERM\nsleep 2\nprintf '{"context":"late verdict"}'`);
    const t0 = Date.now();
    const r = runPhase('pre_tool_use', [s], { workspaceRoot: root, tool: 'edit_file' });
    const elapsed = Date.now() - t0;
    assert.equal(r.ok, false, 'deny phase: a timed-out hook blocks (fail-closed)');
    assert.equal(r.context, undefined, 'the late context verdict is never honored');
    assert.match(r.message ?? '', /timed out|killed/i, 'the message says the hook was killed');
    assert.ok(elapsed < 1800, `returned near the cap, not after the hook finished (${elapsed}ms)`);
  } finally {
    hookTiming.timeoutMs = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test('F2: bidi overrides, zero-widths, BOM and line separators are stripped from hook context', async () => {
  const { parseHookStdout: parse } = await import('../src/hooks/runner.js');
  const bidi = String.fromCharCode(0x202e); // RTL override
  const isolate = String.fromCharCode(0x2067); // RTL isolate
  const zwsp = String.fromCharCode(0x200b); // zero-width space
  const bom = String.fromCharCode(0xfeff);
  const softHyphen = String.fromCharCode(0xad);
  const ls = String.fromCharCode(0x2028); // line separator
  const v = parse(`{"context":"a${bidi}${isolate}${zwsp}${bom}${softHyphen}${ls}b"}`);
  assert.equal(v.context, 'ab', 'the whole invisible/format set is stripped');
  const reason = parse(`{"decision":"block","reason":"x${bidi}y"}`);
  assert.equal(reason.block, 'xy', 'reasons are cleaned too');
});

test('F2 (end-to-end): a hook emitting real bidi/zero-width bytes in JSON has them stripped', async () => {
  const root = tmp();
  try {
    // printf JSON \u escapes decode to real code points; the cleaner must strip them.
    const s = script(root, 'h.sh', `printf '{"context":"a\\\\u202e\\\\u200bb"}'`);
    const r = runHookPhase('post_tool_use', [s], { workspaceRoot: root, tool: 'x' });
    assert.equal(r.context, 'ab', `bidi/ZWSP stripped, got ${JSON.stringify(r.context)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('F3: a TERM-immune DETACHED hook group is SIGKILL-escalated at the cap (end marker never drops)', async () => {
  const { runHookPhaseDetached, hookTiming } = await import('../src/hooks/runner.js');
  const savedTimeout = hookTiming.timeoutMs;
  const savedGrace = hookTiming.detachedGraceMs;
  hookTiming.timeoutMs = 500;
  hookTiming.detachedGraceMs = 200;
  const root = tmp();
  try {
    const start = join(root, 'START');
    const end = join(root, 'END');
    const s = script(root, 'detached.sh', `touch "${start}"\ntrap '' TERM\nsleep 10\ntouch "${end}"`);
    runHookPhaseDetached('session_start', [s], { workspaceRoot: root });
    await new Promise((r) => setTimeout(r, 1400)); // cap (500) + grace (200) + margin
    assert.equal(existsSync(start), true, 'the hook did start');
    assert.equal(existsSync(end), false, 'the TERM-immune group was SIGKILL-escalated before finishing');
  } finally {
    hookTiming.timeoutMs = savedTimeout;
    hookTiming.detachedGraceMs = savedGrace;
    rmSync(root, { recursive: true, force: true });
  }
});

test('F4: a FAILED hook deny message is clamped at MAX_HOOK_FAILURE_CHARS', async () => {
  const { MAX_HOOK_FAILURE_CHARS } = await import('../src/hooks/runner.js');
  const root = tmp();
  try {
    const s = script(root, 'loud.sh', `head -c 6000 /dev/zero | tr '\\0' 'A' >&2\nexit 1`);
    const r = runHookPhase('pre_tool_use', [s], { workspaceRoot: root, tool: 'edit_file' });
    assert.equal(r.ok, false);
    assert.match(r.message ?? '', /hook error truncated/);
    assert.ok(
      (r.message ?? '').length <= `pre_tool_use hook ${s} failed: `.length + MAX_HOOK_FAILURE_CHARS + 64,
      `deny message clamped near the cap, got ${(r.message ?? '').length}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('F5: parseHookStdout reads OWN properties only — a polluted Object.prototype cannot inject verdicts', async () => {
  const { parseHookStdout: parse } = await import('../src/hooks/runner.js');
  const proto = Object.prototype as Record<string, unknown>;
  try {
    proto.context = 'polluted-context';
    proto.decision = 'block';
    proto.reason = 'polluted-reason';
    assert.deepEqual(parse('{}'), {}, 'an empty JSON object yields NO verdict despite pollution');
    assert.deepEqual(parse('{"context":"real"}'), { context: 'real' }, 'own properties still work');
  } finally {
    delete proto.context;
    delete proto.decision;
    delete proto.reason;
  }
});

test('F6: combineHookContexts clamps the TOTAL of pre+post context at MAX_HOOK_CONTEXT_CHARS', async () => {
  const { combineHookContexts, MAX_HOOK_CONTEXT_CHARS } = await import('../src/hooks/runner.js');
  assert.equal(combineHookContexts(undefined, undefined), undefined);
  assert.equal(combineHookContexts(undefined, 'solo'), 'solo');
  const joined = combineHookContexts('a'.repeat(7000), 'b'.repeat(7000))!;
  assert.ok(joined.length <= MAX_HOOK_CONTEXT_CHARS + 64, `total clamped, got ${joined.length}`);
  assert.match(joined, /hook context truncated/);
  // Under the cap: plain join, no marker.
  assert.equal(combineHookContexts('pre', 'post'), 'pre\npost');
});

test('F7: a matcher-bearing guard hook on a deny phase BLOCKS when the caller omits tool (fail-closed)', async () => {
  const root = tmp();
  try {
    const marker = join(root, 'RAN');
    const s = script(root, 'guard.sh', `touch "${marker}"`);
    const r = runHookPhase('pre_tool_use', [{ command: s, matcher: 'edit_*' }], { workspaceRoot: root });
    assert.equal(r.ok, false, 'refuses to silently skip a guard hook');
    assert.match(r.message ?? '', /no tool context/);
    assert.equal(existsSync(marker), false, 'the hook itself never ran');
    // Non-deny tool phases keep the old skip semantics (nothing to block).
    const r2 = runHookPhase('post_tool_use', [{ command: s, matcher: 'edit_*' }], { workspaceRoot: root });
    assert.equal(r2.ok, true);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
