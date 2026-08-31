import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import {
  detectFormatter,
  specForKind,
  lookpath,
  clearLookpathCache,
  createFormatter,
  formatAfterWrite,
  defaultExec,
  FORMATTER_KINDS,
  type FormatterExec,
  type FormatterKind,
} from '../src/agent/formatter.js';
import { writeFile } from '../src/tools/writeFile.js';
import { editFile } from '../src/tools/editFile.js';
import { multiEdit } from '../src/tools/multiEdit.js';
import { applyPatch } from '../src/tools/applyPatch.js';
import { createReadTracker } from '../src/tools/readTracker.js';
import type { ToolContext } from '../src/tools/types.js';

// ── helpers ────────────────────────────────────────────────────────────────────

const dirs: string[] = [];

function fixture(files: Record<string, string>): string {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'fmt-')));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  dirs.push(dir);
  return dir;
}

function cleanup(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

function ctxFor(ws: string, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: ws,
    signal: new AbortController().signal,
    log: () => {},
    dryRun: false,
    readTracker: createReadTracker(),
    ...extra,
  };
}

/** Fake formatter that records argv and appends a marker to the target file (last argv). */
function rewritingExec(marker: string, calls: string[][] = []): FormatterExec {
  return async (argv) => {
    calls.push([...argv]);
    appendFileSync(argv[argv.length - 1]!, marker);
    return { exitCode: 0, output: '', timedOut: false };
  };
}

/** Drop an executable shell script into a fresh dir; returns the dir. */
function fakeBin(name: string, body: string): string {
  const dir = fixture({});
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(p, 0o755);
  return dir;
}

/** Run fn with `dir` prepended to PATH; restores PATH + lookpath cache after. */
async function withPath(dir: string, fn: () => Promise<void>): Promise<void> {
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${oldPath ?? ''}`;
  clearLookpathCache();
  try {
    await fn();
  } finally {
    process.env.PATH = oldPath;
    clearLookpathCache();
  }
}

test.after(cleanup);

// ── detection matrix ───────────────────────────────────────────────────────────

test('detectFormatter: biome (dep + biome.json)', () => {
  const dir = fixture({
    'package.json': JSON.stringify({ devDependencies: { '@biomejs/biome': '^1.0.0' } }),
    'biome.json': '{}',
  });
  assert.equal(detectFormatter(dir)?.kind, 'biome');
});

test('detectFormatter: biome dep WITHOUT config falls through (null here)', () => {
  const dir = fixture({
    'package.json': JSON.stringify({ devDependencies: { biome: '^1.0.0' } }),
  });
  assert.equal(detectFormatter(dir), null);
});

test('detectFormatter: prettier via package.json dep', () => {
  const dir = fixture({
    'package.json': JSON.stringify({ devDependencies: { prettier: '^3.0.0', typescript: '^5.0.0' } }),
  });
  assert.equal(detectFormatter(dir)?.kind, 'prettier');
});

test('detectFormatter: prettier via .prettierrc* (no package.json)', () => {
  const dir = fixture({ '.prettierrc.json': '{"semi": true}' });
  assert.equal(detectFormatter(dir)?.kind, 'prettier');
});

test('detectFormatter: prettier via prettier.config.*', () => {
  const dir = fixture({ 'prettier.config.js': 'module.exports = {};' });
  assert.equal(detectFormatter(dir)?.kind, 'prettier');
});

test('detectFormatter: ruff via pyproject.toml [tool.ruff]', () => {
  const dir = fixture({ 'pyproject.toml': '[project]\nname = "x"\n\n[tool.ruff]\nline-length = 100\n' });
  assert.equal(detectFormatter(dir)?.kind, 'ruff');
});

test('detectFormatter: pyproject.toml without [tool.ruff] → null', () => {
  const dir = fixture({ 'pyproject.toml': '[project]\nname = "x"\n" ' });
  assert.equal(detectFormatter(dir), null);
});

test('detectFormatter: ruff via .ruff.toml / ruff.toml', () => {
  assert.equal(detectFormatter(fixture({ '.ruff.toml': 'line-length = 88' }))?.kind, 'ruff');
  assert.equal(detectFormatter(fixture({ 'ruff.toml': 'line-length = 88' }))?.kind, 'ruff');
});

test('detectFormatter: go.mod → gofmt', () => {
  assert.equal(detectFormatter(fixture({ 'go.mod': 'module example.com/x\n' }))?.kind, 'gofmt');
});

test('detectFormatter: Cargo.toml → rustfmt', () => {
  assert.equal(detectFormatter(fixture({ 'Cargo.toml': '[package]\nname = "x"\n' }))?.kind, 'rustfmt');
});

test('detectFormatter: .shfmt → shfmt', () => {
  assert.equal(detectFormatter(fixture({ '.shfmt': '' }))?.kind, 'shfmt');
});

test('detectFormatter: empty project → null', () => {
  assert.equal(detectFormatter(fixture({})), null);
});

test('detectFormatter priority: biome > prettier > ruff > gofmt > rustfmt > shfmt', () => {
  // all markers at once → biome wins
  const all = fixture({
    'package.json': JSON.stringify({ devDependencies: { biome: '1', prettier: '1' } }),
    'biome.json': '{}',
    '.prettierrc': '{}',
    'pyproject.toml': '[tool.ruff]\n',
    'go.mod': 'module x\n',
    'Cargo.toml': '[package]\n',
    '.shfmt': '',
  });
  assert.equal(detectFormatter(all)?.kind, 'biome');
  // prettier beats ruff/gofmt
  const p = fixture({ 'package.json': JSON.stringify({ devDependencies: { prettier: '1' } }), 'go.mod': 'module x\n' });
  assert.equal(detectFormatter(p)?.kind, 'prettier');
  // ruff beats rustfmt
  assert.equal(detectFormatter(fixture({ '.ruff.toml': '', 'Cargo.toml': '[package]\n' }))?.kind, 'ruff');
  // gofmt beats rustfmt
  assert.equal(detectFormatter(fixture({ 'go.mod': 'module x\n', 'Cargo.toml': '[package]\n' }))?.kind, 'gofmt');
  // rustfmt beats shfmt
  assert.equal(detectFormatter(fixture({ 'Cargo.toml': '[package]\n', '.shfmt': '' }))?.kind, 'rustfmt');
});

test('specForKind: commandFor argv per kind', () => {
  const f = '/w/src/a.ts';
  const expected: Record<FormatterKind, string[]> = {
    prettier: ['prettier', '--write', f],
    biome: ['biome', 'format', '--write', f],
    ruff: ['ruff', 'format', f],
    gofmt: ['gofmt', '-w', f],
    rustfmt: ['rustfmt', f],
    shfmt: ['shfmt', '-w', f],
  };
  for (const kind of FORMATTER_KINDS) {
    assert.deepEqual(specForKind(kind).commandFor(f), expected[kind], kind);
  }
});

// ── lookpath ───────────────────────────────────────────────────────────────────

test('lookpath finds an executable, misses a nonexistent one, caches until cleared', () => {
  const dir = fakeBin('fmtprobe', 'echo hi');
  assert.equal(lookpath('fmtprobe', dir), join(dir, 'fmtprobe'));
  assert.equal(lookpath('definitely-not-a-real-binary-xyz', dir), null);

  // Cached miss stays a miss even after the file appears, until cleared.
  const dir2 = fixture({});
  assert.equal(lookpath('latebin', dir2), null);
  const p = join(dir2, 'latebin');
  writeFileSync(p, '#!/bin/sh\necho hi\n', { mode: 0o755 });
  assert.equal(lookpath('latebin', dir2), null, 'cached miss persists');
  clearLookpathCache();
  assert.equal(lookpath('latebin', dir2), p, 'found after cache clear');
});

// ── runner with an injected exec seam ──────────────────────────────────────────

test('createFormatter runs the formatter on a file (injected exec rewrites it)', async () => {
  const ws = fixture({ 'package.json': JSON.stringify({ devDependencies: { prettier: '1' } }) });
  const file = join(ws, 'a.ts');
  writeFileSync(file, 'const a=1\n');
  const calls: string[][] = [];
  const f = createFormatter({ projectDir: ws, exec: rewritingExec('// fmt\n', calls), which: () => '/x/prettier' });
  const out = await f.formatFile(file);
  assert.deepEqual(out, { ran: true });
  assert.equal(readFileSync(file, 'utf8'), 'const a=1\n// fmt\n');
  assert.deepEqual(calls[0], ['prettier', '--write', file]);
});

test('a failing formatter (exit 1) does not throw — one-line note with exit reason', async () => {
  const ws = fixture({ 'package.json': JSON.stringify({ devDependencies: { prettier: '1' } }) });
  const file = join(ws, 'a.ts');
  writeFileSync(file, 'const a=1\n');
  const failing: FormatterExec = async () => ({ exitCode: 1, output: 'boom: bad indent\nsecond line\n', timedOut: false });
  const f = createFormatter({ projectDir: ws, exec: failing, which: () => '/x/prettier' });
  const out = await f.formatFile(file);
  assert.equal(out.ran, true);
  assert.equal(out.note, 'formatter prettier exit 1: boom: bad indent');
  assert.equal(readFileSync(file, 'utf8'), 'const a=1\n', 'file untouched by the failed run');
});

test('skips: disabled / kill-switch / binary missing / outside-workspace / override-off', async () => {
  const ws = fixture({ 'package.json': JSON.stringify({ devDependencies: { prettier: '1' } }) });
  const file = join(ws, 'a.ts');
  writeFileSync(file, 'x\n');
  const never: FormatterExec = async () => {
    throw new Error('exec must not run when skipped');
  };

  const disabled = createFormatter({ projectDir: ws, config: { enabled: false }, exec: never, which: () => '/x' });
  assert.deepEqual(await disabled.formatFile(file), { ran: false, skipped: 'disabled' });

  const killed = createFormatter({ projectDir: ws, env: { SHADOW_NO_FORMAT: '1' }, exec: never, which: () => '/x' });
  assert.deepEqual(await killed.formatFile(file), { ran: false, skipped: 'kill-switch' });

  const noBin = createFormatter({ projectDir: ws, exec: never, which: () => null });
  assert.deepEqual(await noBin.formatFile(file), { ran: false, skipped: 'binary-missing' });

  const outside = fixture({ 'package.json': JSON.stringify({ devDependencies: { prettier: '1' } }) });
  const stray = join(outside, 'stray.ts');
  writeFileSync(stray, 'x\n');
  const f = createFormatter({ projectDir: ws, exec: never, which: () => '/x' });
  assert.deepEqual(await f.formatFile(stray), { ran: false, skipped: 'outside-workspace' });

  const off = createFormatter({
    projectDir: ws,
    config: { overrides: { '.ts': 'off' } },
    exec: never,
    which: () => '/x',
  });
  assert.deepEqual(await off.formatFile(file), { ran: false, skipped: 'override-off' });

  assert.equal(readFileSync(file, 'utf8'), 'x\n', 'file untouched by skips');
});

test('no detected formatter → not-detected skip', async () => {
  const ws = fixture({});
  const file = join(ws, 'a.ts');
  writeFileSync(file, 'x\n');
  const f = createFormatter({ projectDir: ws, exec: rewritingExec('nope'), which: () => '/x' });
  assert.deepEqual(await f.formatFile(file), { ran: false, skipped: 'not-detected' });
});

test('overrides: extension keys are dot/case-insensitive; a kind override beats detection', async () => {
  // Project detects prettier, but .py files are overridden to ruff, .md turned off.
  const ws = fixture({ 'package.json': JSON.stringify({ devDependencies: { prettier: '1' } }) });
  const calls: string[][] = [];
  const f = createFormatter({
    projectDir: ws,
    config: { overrides: { py: 'ruff', '.MD': 'off' } },
    exec: rewritingExec('# fmt\n', calls),
    which: () => '/x/tool',
  });

  const py = join(ws, 'a.py');
  writeFileSync(py, 'a=1\n');
  assert.equal((await f.formatFile(py)).ran, true);
  assert.deepEqual(calls[0], ['ruff', 'format', py], 'override routed to ruff despite prettier detection');

  const md = join(ws, 'README.md');
  writeFileSync(md, '# hi\n');
  assert.deepEqual(await f.formatFile(md), { ran: false, skipped: 'override-off' });

  // specFor reflects the override too
  assert.equal(f.specFor(py)?.kind, 'ruff');
  assert.equal(f.specFor(md), null);
});

// ── runner with the REAL spawn + PATH ──────────────────────────────────────────

test('real exec: fake prettier on PATH formats the file', async () => {
  const binDir = fakeBin('prettier', 'for f; do :; done\nprintf "// fake-prettier\\n" >> "$f"');
  const ws = fixture({ 'package.json': JSON.stringify({ devDependencies: { prettier: '1' } }) });
  const file = join(ws, 'a.ts');
  writeFileSync(file, 'const a=1\n');
  await withPath(binDir, async () => {
    const f = createFormatter({ projectDir: ws });
    assert.deepEqual(await f.formatFile(file), { ran: true });
  });
  assert.equal(readFileSync(file, 'utf8'), 'const a=1\n// fake-prettier\n');
});

test('real exec: failing binary → note, no throw', async () => {
  const binDir = fakeBin('prettier', 'echo "fakefmt: syntax error at line 3" >&2\nexit 1');
  const ws = fixture({ 'package.json': JSON.stringify({ devDependencies: { prettier: '1' } }) });
  const file = join(ws, 'a.ts');
  writeFileSync(file, 'x\n');
  await withPath(binDir, async () => {
    const f = createFormatter({ projectDir: ws });
    const out = await f.formatFile(file);
    assert.equal(out.ran, true);
    assert.equal(out.note, 'formatter prettier exit 1: fakefmt: syntax error at line 3');
  });
});

test('real exec: timeout kills the child and reports a note', async () => {
  const binDir = fakeBin('prettier', 'sleep 5');
  const ws = fixture({ 'package.json': JSON.stringify({ devDependencies: { prettier: '1' } }) });
  const file = join(ws, 'a.ts');
  writeFileSync(file, 'x\n');
  await withPath(binDir, async () => {
    const f = createFormatter({ projectDir: ws, timeoutMs: 300 });
    const started = Date.now();
    const out = await f.formatFile(file);
    assert.ok(Date.now() - started < 4000, 'was killed, not waited out');
    assert.equal(out.ran, true);
    assert.equal(out.note, 'formatter prettier timed out after 300ms');
  });
});

test('real PATH: detected but binary absent → silent binary-missing skip', async () => {
  const emptyDir = fixture({});
  const ws = fixture({ 'package.json': JSON.stringify({ devDependencies: { prettier: '1' } }) });
  const file = join(ws, 'a.ts');
  writeFileSync(file, 'x\n');
  // env.PATH points at an empty dir → lookpath cannot find prettier
  const f = createFormatter({ projectDir: ws, env: { PATH: emptyDir } });
  assert.deepEqual(await f.formatFile(file), { ran: false, skipped: 'binary-missing' });
  assert.equal(readFileSync(file, 'utf8'), 'x\n');
});

// ── formatAfterWrite (the tool-layer seam) ─────────────────────────────────────

test('formatAfterWrite: returns note on formatter failure, null on success, never throws', async () => {
  const ws = fixture({ 'package.json': JSON.stringify({ devDependencies: { prettier: '1' } }) });
  const file = join(ws, 'a.ts');
  writeFileSync(file, 'x\n');
  const which = () => '/fake/bin';

  const okNote = await formatAfterWrite(file, { workspaceRoot: ws, formatterExec: rewritingExec('// f\n'), formatterWhich: which });
  assert.equal(okNote, null);

  const failing: FormatterExec = async () => ({ exitCode: 2, output: 'nope\n', timedOut: false });
  const badNote = await formatAfterWrite(file, { workspaceRoot: ws, formatterExec: failing, formatterWhich: which });
  assert.match(badNote ?? '', /formatter prettier exit 2: nope/);

  const throwing: FormatterExec = async () => {
    throw new Error('kapow');
  };
  assert.equal(await formatAfterWrite(file, { workspaceRoot: ws, formatterExec: throwing, formatterWhich: which }), null);

  // path outside the workspace root → skipped, null
  const outside = fixture({});
  const stray = join(outside, 's.ts');
  writeFileSync(stray, 'x\n');
  assert.equal(await formatAfterWrite(stray, { workspaceRoot: ws, formatterExec: rewritingExec('!'), formatterWhich: which }), null);
  assert.equal(readFileSync(stray, 'utf8'), 'x\n');
});

// ── hook integration through the real tools ────────────────────────────────────

test('write_file: successful write runs the formatter; formatter failure never fails the write', async () => {
  const ws = fixture({ 'package.json': JSON.stringify({ devDependencies: { prettier: '1' } }) });
  const file = join(ws, 'a.ts');
  const which = { formatterWhich: () => '/fake/bin' };

  // formatter rewrites the file → write succeeds, file carries the formatter output
  const r1 = await writeFile.run(
    { path: file, content: 'const a=1\n' },
    ctxFor(ws, { formatterExec: rewritingExec('// fmt\n'), ...which }),
  );
  assert.ok(r1.ok, r1.summary);
  assert.equal(readFileSync(file, 'utf8'), 'const a=1\n// fmt\n');
  assert.ok(!r1.summary.includes('formatter'), 'no note on formatter success');

  // formatter fails → write STILL succeeds, one-line note on the summary
  const failing: FormatterExec = async () => ({ exitCode: 1, output: 'boom: bad indent\n', timedOut: false });
  const r2 = await writeFile.run({ path: file, content: 'const b=2\n' }, ctxFor(ws, { formatterExec: failing, ...which }));
  assert.ok(r2.ok, r2.summary);
  assert.match(r2.summary, /formatter prettier exit 1: boom: bad indent/);
  assert.equal(readFileSync(file, 'utf8'), 'const b=2\n', 'failed formatter leaves the written content as-is');
});

test('write_file: skips when formatters.enabled=false and when SHADOW_NO_FORMAT=1', async () => {
  const ws = fixture({ 'package.json': JSON.stringify({ devDependencies: { prettier: '1' } }) });

  const r1 = await writeFile.run(
    { path: join(ws, 'a.ts'), content: 'x\n' },
    ctxFor(ws, { formatterExec: rewritingExec('NO'), formatters: { enabled: false } }),
  );
  assert.ok(r1.ok);
  assert.equal(readFileSync(join(ws, 'a.ts'), 'utf8'), 'x\n');

  process.env.SHADOW_NO_FORMAT = '1';
  try {
    const r2 = await writeFile.run(
      { path: join(ws, 'b.ts'), content: 'y\n' },
      ctxFor(ws, { formatterExec: rewritingExec('NO') }),
    );
    assert.ok(r2.ok);
    assert.equal(readFileSync(join(ws, 'b.ts'), 'utf8'), 'y\n');
  } finally {
    delete process.env.SHADOW_NO_FORMAT;
  }
});

test('edit_file: formats after the edit, and the next edit does not trip the stale guard', async () => {
  const ws = fixture({ 'package.json': JSON.stringify({ devDependencies: { prettier: '1' } }) });
  const file = join(ws, 'a.ts');
  writeFileSync(file, 'const a = 1\nconst b = 2\n');

  const ctx = ctxFor(ws, { formatterExec: rewritingExec('// fmt\n'), formatterWhich: () => '/fake/bin' });
  ctx.readTracker!.markSeen(file); // simulate a prior read_file (edit guard)
  const r1 = await editFile.run({ path: file, old_string: 'const a = 1', new_string: 'const a = 11' }, ctx);
  assert.ok(r1.ok, r1.summary);
  assert.equal(readFileSync(file, 'utf8'), 'const a = 11\nconst b = 2\n// fmt\n');

  // The formatter rewrote the file after the edit; the readTracker mtime must include that
  // rewrite, so a follow-up edit on the same ctx is NOT refused as changed-on-disk.
  const r2 = await editFile.run({ path: file, old_string: 'const b = 2', new_string: 'const b = 22' }, ctx);
  assert.ok(r2.ok, `second edit must pass the stale guard: ${r2.summary}`);
  assert.ok(readFileSync(file, 'utf8').includes('const b = 22'));
});

test('multi_edit: formats the file once after all edits land', async () => {
  const ws = fixture({ 'package.json': JSON.stringify({ devDependencies: { prettier: '1' } }) });
  const file = join(ws, 'a.ts');
  writeFileSync(file, 'a\nb\n');
  const calls: string[][] = [];
  const ctx = ctxFor(ws, { formatterExec: rewritingExec('// fmt\n', calls), formatterWhich: () => '/fake/bin' });
  ctx.readTracker!.markSeen(file); // simulate a prior read_file (edit guard)
  const r = await multiEdit.run(
    { path: file, edits: [{ old_string: 'a', new_string: 'A' }, { old_string: 'b', new_string: 'B' }] },
    ctx,
  );
  assert.ok(r.ok, r.summary);
  assert.equal(readFileSync(file, 'utf8'), 'A\nB\n// fmt\n');
  assert.equal(calls.length, 1);
});

test('apply_patch: formats every written file, never the deletes; failures ride as notes', async () => {
  const ws = fixture({ 'package.json': JSON.stringify({ devDependencies: { prettier: '1' } }) });
  const patch = [
    '*** Begin Patch',
    '*** Add File: one.ts',
    '+const one = 1',
    '*** Add File: two.ts',
    '+const two = 2',
    '*** End Patch',
  ].join('\n');
  const calls: string[][] = [];
  const which = { formatterWhich: () => '/fake/bin' };
  const r = await applyPatch.run({ patch }, ctxFor(ws, { formatterExec: rewritingExec('// fmt\n', calls), ...which }));
  assert.ok(r.ok, r.summary);
  assert.equal(readFileSync(join(ws, 'one.ts'), 'utf8'), 'const one = 1\n// fmt\n');
  assert.equal(readFileSync(join(ws, 'two.ts'), 'utf8'), 'const two = 2\n// fmt\n');
  assert.equal(calls.length, 2);

  // failing formatter → patch still ok, one note per formatted file
  const failing: FormatterExec = async () => ({ exitCode: 3, output: 'ugh\n', timedOut: false });
  const patch2 = ['*** Begin Patch', '*** Update File: one.ts', '@@', '-const one = 1', '+const one = 11', '*** End Patch'].join('\n');
  const ctx2 = ctxFor(ws, { formatterExec: failing, ...which });
  ctx2.readTracker!.markSeen(join(ws, 'one.ts')); // simulate a prior read_file (F07-11 read-before-patch guard)
  const r0 = await applyPatch.run({ patch: patch2 }, ctx2); // seeds the tracker's mtime (post-format)
  assert.ok(r0.ok, r0.summary);
  const r2 = await applyPatch.run({ patch: ['*** Begin Patch', '*** Update File: one.ts', '@@', '-const one = 11', '+const one = 111', '*** End Patch'].join('\n') }, ctx2);
  assert.ok(r2.ok, r2.summary);
  assert.match(r2.summary, /formatter prettier exit 3: ugh/);
});

// ── config schema ──────────────────────────────────────────────────────────────

// The REAL ~/.shadow on a dev machine may not parse under this tree's schema (it is
// written by whatever build the user runs). Point HOME at an empty dir across the first
// config.js import so loadGlobalConfig() sees no global file; the resolved module (and
// its import-time GLOBAL_DIR) is cached for the remaining calls.
let configMod: Promise<typeof import('../src/config.js')> | null = null;
function loadConfigModuleIsolated(): Promise<typeof import('../src/config.js')> {
  if (!configMod) {
    const oldHome = process.env.HOME;
    process.env.HOME = fixture({});
    configMod = import('../src/config.js').finally(() => {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    });
  }
  return configMod;
}

test('config: formatters block defaults enabled with empty overrides; parses overrides', async () => {
  const { loadConfig } = await loadConfigModuleIsolated();
  const empty = fixture({});
  const cfg = loadConfig(empty);
  assert.equal(cfg.formatters.enabled, true);
  assert.deepEqual(cfg.formatters.overrides, {});

  const withBlock = fixture({
    'shadow.config.json': JSON.stringify({
      formatters: { enabled: false, overrides: { '.md': 'off', ts: 'prettier' } },
    }),
  });
  const cfg2 = loadConfig(withBlock);
  assert.equal(cfg2.formatters.enabled, false);
  assert.deepEqual(cfg2.formatters.overrides, { '.md': 'off', ts: 'prettier' });
});

test('config: an unknown formatter name in overrides is rejected', async () => {
  const { loadConfig } = await loadConfigModuleIsolated();
  const bad = fixture({
    'shadow.config.json': JSON.stringify({ formatters: { overrides: { '.ts': 'eslint' } } }),
  });
  assert.throws(() => loadConfig(bad), /invalid configuration/);
});

test('defaultExec: children run with a scrubbed env — secrets never ride, PATH survives', async () => {
  // An auto-formatter is a PATH-resolved binary spawned with no approval; handing it the full
  // parent env would leak every *_API_KEY Shadow itself holds. Pin the scrubbedEnv invariant.
  const KEY = 'SHADOW_FMT_SECRET_PROBE';
  const prev = process.env[KEY];
  process.env[KEY] = 'leak-me-if-you-see-this';
  try {
    const out = await defaultExec(
      [
        process.execPath,
        '-e',
        'console.log(process.env.' + KEY + ' ?? "absent", process.env.PATH ? "path-ok" : "no-path")',
      ],
      { cwd: tmpdir(), timeoutMs: 15_000 },
    );
    assert.equal(out.exitCode, 0, `exit=${out.exitCode} output=${out.output}`);
    assert.match(out.output, /absent/);
    assert.match(out.output, /path-ok/);
    assert.doesNotMatch(out.output, /leak-me/);
  } finally {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  }
});
