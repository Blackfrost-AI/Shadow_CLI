import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import childProcess, { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grep, __setRipgrepAvailabilityForTests } from '../src/tools/grep.js';
import type { ToolContext } from '../src/tools/types.js';

function ctxFor(ws: string): ToolContext {
  return { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false };
}

before(() => __setRipgrepAvailabilityForTests(false));
after(() => __setRipgrepAvailabilityForTests(null));

test('ripgrep discovery and execution inherit only the allowlisted environment', async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'grep-env-'));
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'review-canary-not-a-real-key';
  const environments: (NodeJS.ProcessEnv | undefined)[] = [];
  const probe = t.mock.method(childProcess, 'spawnSync', (
    _command: string, _args: string[], options: { env?: NodeJS.ProcessEnv },
  ) => {
    environments.push(options.env);
    return { status: 0 };
  });
  const search = t.mock.method(childProcess, 'spawn', (
    _command: string, _args: string[], options: { env?: NodeJS.ProcessEnv },
  ) => {
    environments.push(options.env);
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill() {} });
    queueMicrotask(() => child.emit('close', 1));
    return child;
  });
  syncBuiltinESMExports();
  __setRipgrepAvailabilityForTests(null);
  try {
    const result = await grep.run({ pattern: 'needle' }, ctxFor(ws));
    assert.equal(result.ok, true, result.summary);
    assert.equal(result.data?.engine, 'ripgrep');
    assert.equal(environments.length, 2);
    for (const env of environments) {
      assert.ok(env, 'must not implicitly inherit process.env');
      assert.equal(env.OPENAI_API_KEY, undefined);
      assert.equal(env.PATH, process.env.PATH);
    }
  } finally {
    probe.mock.restore();
    search.mock.restore();
    syncBuiltinESMExports();
    __setRipgrepAvailabilityForTests(false);
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    rmSync(ws, { recursive: true, force: true });
  }
});

test('fallback regex matching resists ambiguous alternatives and nested repeats', () => {
  const ws = mkdtempSync(join(tmpdir(), 'grep-redos-'));
  try {
    writeFileSync(join(ws, 'hostile.txt'), 'a'.repeat(10_000) + '!');
    const url = new URL('../src/tools/grep.ts', import.meta.url).href;
    const script = `
      const { grep, __setRipgrepAvailabilityForTests } = await import(${JSON.stringify(url)});
      __setRipgrepAvailabilityForTests(false);
      const results = [];
      for (const pattern of ['(a|aa)+$', '^(a+)+$', '(a*)*b']) {
        for (const path of ['.', 'hostile.txt']) {
          const result = await grep.run({ pattern, path }, {
            workspaceRoot: ${JSON.stringify(ws)}, signal: new AbortController().signal, log() {}, dryRun: false,
          });
          if (!result.ok) throw new Error(result.summary);
          results.push(result.data.matches.length);
        }
      }
      process.stdout.write(JSON.stringify(results));
    `;
    const result = spawnSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [0, 0, 0, 0, 0, 0]);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('fallback keeps unanchored regex matching and UTF-16 column positions', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'grep-regex-'));
  try {
    writeFileSync(join(ws, 'plain.txt'), '😀 prefix needle42\nno match\nneedle7');
    const result = await grep.run({ pattern: 'needle\\d+$' }, ctxFor(ws));
    assert.equal(result.ok, true, result.summary);
    assert.deepEqual(result.data?.matches.map(({ line, column }) => ({ line, column })), [
      { line: 1, column: 11 }, { line: 3, column: 1 },
    ]);
    for (const pattern of ['(?=needle)', '(a)\\1', 'a'.repeat(5001)]) {
      const invalid = await grep.run({ pattern }, ctxFor(ws));
      assert.equal(invalid.ok, false);
      assert.equal(invalid.error?.code, 'invalid_regex');
    }
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

for (const failure of ['directory', 'root', 'stat'] as const) {
  test(`fallback discloses ${failure} traversal failures as incomplete`, async (t) => {
    const ws = mkdtempSync(join(tmpdir(), 'grep-unreadable-'));
    mkdirSync(join(ws, 'blocked'));
    writeFileSync(join(ws, 'blocked', 'hidden.txt'), 'needle');
    writeFileSync(join(ws, 'vanishing.txt'), 'needle');
    const method = failure === 'stat' ? 'lstatSync' : 'readdirSync';
    const target = failure === 'root' ? ws : join(ws, failure === 'stat' ? 'vanishing.txt' : 'blocked');
    const original = fs[method];
    const mocked = t.mock.method(fs, method, (...args: unknown[]) => {
      if (String(args[0]) === target) throw new Error('fixture: inaccessible path');
      return Reflect.apply(original, fs, args);
    });
    syncBuiltinESMExports();
    try {
      const result = await grep.run({ pattern: 'absent-pattern' }, ctxFor(ws));
      assert.equal(result.ok, true, result.summary);
      assert.equal(result.data?.skipped?.unreadable, 1);
      assert.deepEqual(result.data?.skipped?.sample, [
        failure === 'root' ? './' : failure === 'stat' ? 'vanishing.txt' : 'blocked/',
      ]);
      assert.match(result.summary, /INCOMPLETE/);
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
      rmSync(ws, { recursive: true, force: true });
    }
  });
}

/**
 * A file with a raw NUL byte is classified binary and skipped by the Node
 * fallback. Before this fix the skip was silent, so a pattern that genuinely
 * exists inside such a file produced a bare "No matches" — a false negative
 * indistinguishable from a real absence. These tests pin the qualified negative.
 */
test('a skipped binary-looking file is reported, not folded into "No matches"', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'grepb-'));
  // Contains the pattern AND a NUL, exactly like a source file with a raw NUL in a string literal.
  writeFileSync(join(ws, 'hasnull.ts'), 'const k = `a' + String.fromCharCode(0) + 'b`; // needle\n');
  try {
    const r = await grep.run({ pattern: 'needle' }, ctxFor(ws));
    assert.ok(r.ok, r.summary);
    assert.equal(r.data?.matches.length, 0, 'content is genuinely not searched');
    // The negative must be qualified, not bare.
    assert.ok(r.data?.skipped, 'skipped tally must be present');
    assert.equal(r.data?.skipped.binary, 1, 'the NUL file is counted as skipped');
    assert.ok(
      r.data?.skipped.sample.includes('hasnull.ts'),
      `skipped file should be named: ${JSON.stringify(r.data?.skipped.sample)}`,
    );
    assert.match(r.summary, /INCOMPLETE/, 'summary must not read as proof of absence');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('the ripgrep path searches NUL-bearing source instead of silently skipping it', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'greprg-'));
  writeFileSync(
    join(ws, 'hasnull.ts'),
    Buffer.concat([Buffer.from([0xff, 0]), Buffer.from('needle\n')]),
  );
  __setRipgrepAvailabilityForTests(true);
  try {
    const result = await grep.run({ pattern: 'needle' }, ctxFor(ws));
    assert.ok(result.ok, result.summary);
    if (result.data?.engine === 'ripgrep') {
      assert.equal(result.data.matches.length, 1, 'rg must search through the NUL byte');
      assert.match(result.data.matches[0]!.text, /needle/, 'base64 JSON lines must be decoded');
    } else {
      assert.equal(result.data?.skipped?.binary, 1, 'a host without rg falls back honestly');
      assert.match(result.summary, /INCOMPLETE/);
    }
  } finally {
    __setRipgrepAvailabilityForTests(false);
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a clean negative stays unqualified (no skipped field, no INCOMPLETE)', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'grepc-'));
  writeFileSync(join(ws, 'plain.txt'), 'nothing to see\n');
  try {
    const r = await grep.run({ pattern: 'absent-pattern' }, ctxFor(ws));
    assert.ok(r.ok);
    assert.equal(r.data?.matches.length, 0);
    assert.equal(r.data?.skipped, undefined, 'nothing skipped => no skipped field');
    assert.doesNotMatch(r.summary, /INCOMPLETE/);
    assert.match(r.summary, /^No matches/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('single-file grep on a NUL-bearing file also reports the skip', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'greps-'));
  writeFileSync(join(ws, 'one.ts'), 'needle' + String.fromCharCode(0) + '\n');
  try {
    const r = await grep.run({ pattern: 'needle', path: 'one.ts' }, ctxFor(ws));
    assert.ok(r.ok, r.summary);
    assert.equal(r.data?.matches.length, 0);
    assert.equal(r.data?.skipped?.binary, 1, 'single-file path must tally too');
    assert.match(r.summary, /INCOMPLETE/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a file read successfully still returns its matches alongside the tally', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'grepm-'));
  writeFileSync(join(ws, 'good.txt'), 'needle here\n');
  writeFileSync(join(ws, 'bad.ts'), 'needle' + String.fromCharCode(0) + '\n');
  try {
    const r = await grep.run({ pattern: 'needle' }, ctxFor(ws));
    assert.ok(r.ok);
    assert.equal(r.data?.matches.length, 1, 'the searchable file still matches');
    assert.equal(r.data?.skipped?.binary, 1, 'and the skip is still disclosed');
    assert.match(r.summary, /skipped/, 'partial results carry the caveat too');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
