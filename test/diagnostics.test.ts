import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isolateHome } from './helpers/isolateHome.js';

// Redirect ~/.shadow to a throwaway HOME BEFORE any config module is imported (GLOBAL_DIR is a
// module-level const). One isolated home per test process, so this is safe.
const { home: HOME } = isolateHome('p306');

import {
  runDiagnostics,
  diagnosticsNoteFor,
  diagnosticsInFlight,
  quoteFilePath,
  DIAGNOSTIC_TOOL_NAMES,
} from '../src/agent/diagnostics.js';
// config.js is imported DYNAMICALLY below: ESM hoists static imports above isolateHome(), and the
// globalStore's GLOBAL_DIR is captured from os.homedir() at module load — it must see the isolated
// HOME (same pattern as stream-per-config-knobs). This file's static imports therefore must never
// pull in globalStore transitively (the loop end-to-end test lives in diagnostics-loop.test.ts).
const { loadConfig } = await import('../src/config.js');

/**
 * P3-06 v0 — the diagnostics feedback loop.
 *
 * A `diagnostics` map in the TRUSTED GLOBAL config maps extension → command; after a SUCCESSFUL
 * edit_file/write_file/multi_edit the command runs and its output is folded into the tool result,
 * so the model sees compiler/linter verdicts in-loop and self-corrects. These tests pin:
 *   1. the runner semantics (mapping, folding, clean-runs-silent, truncation, HARD timeout cap,
 *      honest kill labels, daemon-grandchild drain, same-command dedup, key normalization);
 *   2. the trust posture (global-only key — a project file cannot set it; scrubbed env; quoted
 *      {file} substitution so hostile filenames cannot inject shell — PROVEN by a side-effect
 *      marker, not just string inspection; win32 fails closed instead of guessing);
 *   3. the END-TO-END acceptance criterion: the diagnostics verdict reaches the model inside the
 *      tool result on the next provider round.
 */

function ws(): string {
  return mkdtempSync(join(tmpdir(), 'p306-'));
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

// --- runner semantics ---

test('mapped extension runs the command and folds a red verdict into the tool result', async () => {
  const root = ws();
  try {
    const note = await runDiagnostics({
      filePath: join(root, 'probe.ts'),
      workspaceRoot: root,
      diagnostics: { ts: 'printf "probe.ts(1,1): error TS9999: boom\\n"; exit 1' },
    });
    assert.ok(note, 'a red run must produce a note');
    assert.match(note!, /\[diagnostics: `printf .*` → exit 1\]/, 'header carries the command + exit code');
    assert.match(note!, /error TS9999: boom/, 'the command output is folded in');
  } finally {
    cleanup(root);
  }
});

test('a clean AND silent run folds nothing (zero context cost)', async () => {
  const root = ws();
  try {
    const note = await runDiagnostics({
      filePath: join(root, 'probe.ts'),
      workspaceRoot: root,
      diagnostics: { ts: 'true' },
    });
    assert.equal(note, null, 'exit 0 with no output must not consume context');
  } finally {
    cleanup(root);
  }
});

test('a green-but-vocal run still folds its output (exit 0 with warnings)', async () => {
  const root = ws();
  try {
    const note = await runDiagnostics({
      filePath: join(root, 'probe.ts'),
      workspaceRoot: root,
      diagnostics: { ts: 'printf "warning: unused var\\n"' },
    });
    assert.ok(note);
    assert.match(note!, /→ exit 0/);
    assert.match(note!, /warning: unused var/);
  } finally {
    cleanup(root);
  }
});

test('unmapped or missing extension folds nothing', async () => {
  const root = ws();
  try {
    assert.equal(
      await runDiagnostics({ filePath: join(root, 'probe.rs'), workspaceRoot: root, diagnostics: { ts: 'false' } }),
      null,
      'an unmapped extension is a no-op',
    );
    assert.equal(
      await runDiagnostics({ filePath: join(root, 'Makefile'), workspaceRoot: root, diagnostics: { ts: 'false' } }),
      null,
      'no extension at all is a no-op',
    );
  } finally {
    cleanup(root);
  }
});

test('map keys are normalized: case and one leading dot are irrelevant', async () => {
  const root = ws();
  try {
    const dotted = await runDiagnostics({
      filePath: join(root, 'probe.ts'),
      workspaceRoot: root,
      diagnostics: { '.TS': 'printf dotkey' },
    });
    assert.ok(dotted?.includes('dotkey'), '".TS" matches probe.ts');
    const upper = await runDiagnostics({
      filePath: join(root, 'probe.ts'),
      workspaceRoot: root,
      diagnostics: { TS: 'printf upperkey' },
    });
    assert.ok(upper?.includes('upperkey'), '"TS" matches probe.ts');
  } finally {
    cleanup(root);
  }
});

test('{file} is substituted with the workspace-relative path, shell-quoted', async () => {
  const root = ws();
  try {
    const note = await runDiagnostics({
      filePath: join(root, 'src', 'probe.ts'),
      workspaceRoot: root,
      diagnostics: { ts: 'printf %s {file}' },
    });
    assert.ok(note);
    assert.match(note!, /src\/probe\.ts/, '{file} resolves workspace-relative');
  } finally {
    cleanup(root);
  }
});

test('a hostile filename in {file} NEVER executes — proven by side effect, not string inspection', async () => {
  const root = ws();
  const marker = join(root, 'PWNED_MARKER');
  try {
    const hostile = 'a$(touch PWNED_MARKER)b.ts';
    const note = await runDiagnostics({
      filePath: join(root, hostile),
      workspaceRoot: root,
      diagnostics: { ts: 'printf %s {file}' },
    });
    assert.ok(note);
    assert.ok(note!.includes(hostile), 'the folded command shows the filename literally');
    assert.ok(!existsSync(marker), 'the injection payload must not have run — no marker file on disk');
  } finally {
    cleanup(root);
  }
});

test('folded output is capped (head + tail, omission counted)', async () => {
  const root = ws();
  try {
    const note = await runDiagnostics({
      filePath: join(root, 'probe.ts'),
      workspaceRoot: root,
      diagnostics: { ts: "head -c 6000 /dev/zero | tr '\\0' 'a'" },
    });
    assert.ok(note);
    assert.match(note!, /…\(\d+ chars omitted\)…/, 'the omission is counted, not silent');
    const body = note!.split('\n').slice(1).join('\n');
    assert.ok(body.length <= 4_200, 'the folded body stays on budget');
  } finally {
    cleanup(root);
  }
});

// --- the hard cap (adversarial-review hardening) ---

test('a diagnostic that hangs is killed at the timeout and reported', async () => {
  const root = ws();
  const started = Date.now();
  try {
    const note = await runDiagnostics({
      filePath: join(root, 'probe.ts'),
      workspaceRoot: root,
      diagnostics: { ts: 'sleep 5' },
      timeoutMs: 150,
    });
    assert.ok(note);
    assert.match(note!, /timed out after 150ms/, 'the timeout is labeled, never silent');
    assert.ok(Date.now() - started < 4_000, 'the turn is not wedged by a slow linter');
  } finally {
    cleanup(root);
  }
});

test('a SIGTERM-immune diagnostic still dies — the cap escalates to SIGKILL', async () => {
  const root = ws();
  const started = Date.now();
  try {
    const note = await runDiagnostics({
      filePath: join(root, 'probe.ts'),
      workspaceRoot: root,
      diagnostics: { ts: "trap '' TERM; while :; do :; done" },
      timeoutMs: 300,
    });
    assert.ok(note);
    assert.match(note!, /timed out after 300ms/);
    // timeout(300) + SIGTERM→SIGKILL grace(2000) + drain(250) ≈ 2.6s; well clear of "forever".
    assert.ok(Date.now() - started < 5_000, 'even a TERM-ignoring busy loop cannot wedge the turn');
  } finally {
    cleanup(root);
  }
});

test('a fast command with a daemonized grandchild holding stdout resolves promptly', async () => {
  const root = ws();
  const started = Date.now();
  try {
    const note = await runDiagnostics({
      filePath: join(root, 'probe.ts'),
      workspaceRoot: root,
      diagnostics: { ts: 'printf fast; sleep 5 &' },
      timeoutMs: 10_000,
    });
    assert.ok(note);
    assert.match(note!, /fast/, 'captured output before exit is kept');
    assert.doesNotMatch(note!, /timed out/, 'a status-0 exit is never mislabeled as a timeout');
    assert.ok(Date.now() - started < 3_000, 'the grandchild holding the pipe does not stall the verdict');
  } finally {
    cleanup(root);
  }
});

test('an external signal death is reported honestly — never as a timeout', async () => {
  const root = ws();
  try {
    const note = await runDiagnostics({
      filePath: join(root, 'probe.ts'),
      workspaceRoot: root,
      diagnostics: { ts: 'kill -KILL $$' },
      timeoutMs: 10_000,
    });
    assert.ok(note);
    assert.match(note!, /killed \(SIGKILL\)/, 'the signal is named');
    assert.doesNotMatch(note!, /timed out/);
  } finally {
    cleanup(root);
  }
});

test('identical concurrent commands share ONE run (parallel writes, one tsc)', async () => {
  const root = ws();
  try {
    const diagnostics = { ts: 'printf x >> dedup.txt; sleep 0.3' };
    const filePath = join(root, 'a.ts');
    const [r1, r2] = await Promise.all([
      runDiagnostics({ filePath, workspaceRoot: root, diagnostics }),
      runDiagnostics({ filePath, workspaceRoot: root, diagnostics }),
    ]);
    assert.equal(r1, r2, 'both callers see the same verdict');
    assert.equal(readFileSync(join(root, 'dedup.txt'), 'utf8'), 'x', 'the command ran EXACTLY once');
    assert.equal(diagnosticsInFlight(), 0, 'the in-flight map is evicted on settle');
  } finally {
    cleanup(root);
  }
});

// --- the loop-facing gate ---

test('diagnosticsNoteFor only fires for successful, real writes with a path', async () => {
  const root = ws();
  const diagnostics = { ts: 'false' }; // exit 1 → would fold a note if it ran
  try {
    const base = { workspaceRoot: root, diagnostics, input: { path: 'x.ts', content: '' } };
    assert.ok(await diagnosticsNoteFor({ ...base, tool: 'write_file', ok: true, dryRun: false }), 'the happy path runs');
    assert.equal(await diagnosticsNoteFor({ ...base, tool: 'read_file', ok: true, dryRun: false }), null, 'read tools never trigger');
    assert.equal(await diagnosticsNoteFor({ ...base, tool: 'run_shell', ok: true, dryRun: false }), null, 'exec tools never trigger');
    assert.equal(await diagnosticsNoteFor({ ...base, tool: 'write_file', ok: false, dryRun: false }), null, 'a failed write is not re-diagnosed');
    assert.equal(await diagnosticsNoteFor({ ...base, tool: 'write_file', ok: true, dryRun: true }), null, 'a simulated write is not diagnosed');
    assert.equal(
      await diagnosticsNoteFor({ ...base, tool: 'write_file', ok: true, dryRun: false, input: { content: '' } }),
      null,
      'no path in input → nothing to diagnose',
    );
    assert.equal(
      await diagnosticsNoteFor({ ...base, tool: 'write_file', ok: true, dryRun: false, diagnostics: {} }),
      null,
      'an empty map is a no-op',
    );
    assert.equal(
      await diagnosticsNoteFor({ ...base, tool: 'write_file', ok: true, dryRun: false, diagnostics: undefined }),
      null,
      'no map configured is a no-op',
    );
    assert.deepEqual([...DIAGNOSTIC_TOOL_NAMES], ['edit_file', 'write_file', 'multi_edit'], 'the v0 tool set is pinned');
  } finally {
    cleanup(root);
  }
});

// --- platform-aware quoting ({file} is hostile-input territory) ---

test('quoteFilePath: POSIX single-quotes everything, escaping embedded quotes', () => {
  assert.equal(quoteFilePath('probe.ts', 'darwin'), "'probe.ts'");
  assert.equal(quoteFilePath('a$(x)b.ts', 'linux'), "'a$(x)b.ts'", 'command substitution stays literal');
  assert.equal(quoteFilePath("a'b.ts", 'linux'), "'a'\\''b.ts'", "embedded single quotes are escaped");
});

test('quoteFilePath: win32 FAILS CLOSED on cmd.exe-active characters', () => {
  for (const hostile of ['a&b.ts', 'a|b.ts', 'a^b.ts', 'a<b.ts', 'a>b.ts', 'a(b.ts', 'a)b.ts', 'a%b%.ts', 'a!b.ts', 'a;b.ts', 'a=b.ts', "a'b.ts", 'a"b.ts', 'a`b.ts', 'a\nb.ts']) {
    assert.equal(quoteFilePath(hostile, 'win32'), null, `"${hostile}" must be refused, not guessed at`);
  }
  assert.equal(quoteFilePath('probe.ts', 'win32'), 'probe.ts', 'plain names pass through');
  assert.equal(quoteFilePath('my file.ts', 'win32'), '"my file.ts"', 'spaces get double quotes');
});

test('on win32 a hostile filename is SKIPPED with an advisory — never spawned', async () => {
  const root = ws();
  const marker = join(root, 'SHOULD_NOT_EXIST');
  try {
    const note = await runDiagnostics({
      filePath: join(root, 'fix&touch SHOULD_NOT_EXIST&.ts'),
      workspaceRoot: root,
      diagnostics: { ts: 'echo ran' },
      platform: 'win32',
    });
    assert.ok(note);
    assert.match(note!, /skipped/, 'the advisory explains the skip');
    assert.ok(!existsSync(marker), 'nothing was spawned — no side effect on disk');
  } finally {
    cleanup(root);
  }
});

// --- trust posture ---

test('diagnostics run with a scrubbed env — provider keys are never inherited', async () => {
  const root = ws();
  const orig = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-p306-must-not-leak';
  try {
    const note = await runDiagnostics({
      filePath: join(root, 'probe.ts'),
      workspaceRoot: root,
      diagnostics: { ts: 'printenv OPENAI_API_KEY' },
    });
    assert.ok(!note?.includes('sk-p306-must-not-leak'), 'the credential must not reach the diagnostic command');
  } finally {
    if (orig === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = orig;
    cleanup(root);
  }
});

test('a project shadow.config.json CANNOT set diagnostics (global-only key)', () => {
  const root = ws();
  try {
    writeFileSync(
      join(root, 'shadow.config.json'),
      JSON.stringify({ diagnostics: { ts: 'touch PWNED_BY_PROJECT' } }),
    );
    const cfg = loadConfig(root);
    assert.equal(cfg.diagnostics, undefined, 'project-file diagnostics are stripped like hooks');
  } finally {
    cleanup(root);
  }
});

test('the GLOBAL config honors diagnostics (and they survive loadConfig)', () => {
  const root = ws();
  try {
    writeFileSync(
      join(HOME, '.shadow', 'config.json'),
      JSON.stringify({ diagnostics: { ts: 'tsc --noEmit', py: 'ruff check {file}' } }),
    );
    const cfg = loadConfig(root);
    assert.deepEqual(cfg.diagnostics, { ts: 'tsc --noEmit', py: 'ruff check {file}' });
  } finally {
    cleanup(root);
  }
});

test('source pins: scrubbed env + group kill + SIGKILL escalation + closed stdin; folded in loop.ts', () => {
  const diag = readFileSync(new URL('../src/agent/diagnostics.ts', import.meta.url), 'utf8');
  assert.match(diag, /scrubbedEnv\(\)/, 'diagnostics must never inherit the full process env');
  assert.match(diag, /process\.kill\(-child\.pid/, 'the timeout kills the whole process group');
  assert.match(diag, /SIGKILL/, 'the kill escalates — the timeout cap is HARD');
  assert.match(diag, /stdio: \['ignore'/, 'stdin is closed so nothing can wedge the turn');
  const loop = readFileSync(new URL('../src/agent/loop.ts', import.meta.url), 'utf8');
  assert.match(loop, /await diagnosticsNoteFor\(/, 'the loop must fold diagnostics into write-tool results');
  assert.match(loop, /result\.summary \+= diagNote/, 'the note is appended to the model-facing summary');
});

// The end-to-end acceptance test (verdict reaches the model inside the tool result) lives in
// diagnostics-loop.test.ts — its static imports pull in globalStore, which must not load before
// this file's isolateHome() runs.
