import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, utimesSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectMemory } from '../src/state/memory.js';
import { makeMemoryTool } from '../src/tools/memory.js';
import type { ToolContext } from '../src/tools/types.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'memdur-'));
}
function memPath(root: string): string {
  return join(root, '.shadow', 'memory.json');
}
function put(root: string, text: string): void {
  mkdirSync(join(root, '.shadow'), { recursive: true });
  writeFileSync(memPath(root), text);
}
function corruptFiles(root: string): string[] {
  const dir = join(root, '.shadow');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith('memory.json.corrupt-'));
}
function mode(path: string): number {
  return statSync(path).mode & 0o777;
}
function ctx(): ToolContext {
  return { workspaceRoot: '/tmp', additionalRoots: [], signal: new AbortController().signal, log: () => {}, dryRun: false };
}

// ── quarantine-on-corrupt ────────────────────────────────────────────────────

test('corrupt memory.json is quarantined (bytes preserved) + warning, and the next write succeeds', () => {
  const root = tmp();
  try {
    const bad = '{"version":2,"entries":{ THIS IS NOT JSON';
    put(root, bad);
    const mem = ProjectMemory.load(root);
    const q = corruptFiles(root);
    assert.equal(q.length, 1, 'exactly one quarantine file');
    assert.equal(readFileSync(join(root, '.shadow', q[0]!), 'utf8'), bad, 'original corrupt bytes preserved verbatim');
    assert.ok(!existsSync(memPath(root)), 'corrupt original removed so the next load is clean');
    const notice = mem.takeNotice();
    assert.ok(notice && /corrupt/i.test(notice), 'a corruption warning is surfaced');
    assert.equal(mem.takeNotice(), undefined, 'notice is one-shot');
    // The store started empty and the next write succeeds.
    mem.set('build', 'npm run build');
    assert.equal(ProjectMemory.load(root).get('build'), 'npm run build');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a MISSING memory.json is NOT quarantined (ENOENT is not corruption)', () => {
  const root = tmp();
  try {
    const mem = ProjectMemory.load(root);
    assert.equal(corruptFiles(root).length, 0, 'no quarantine for a missing file');
    assert.equal(mem.takeNotice(), undefined, 'no warning for a missing file');
    mem.set('a', '1');
    assert.equal(ProjectMemory.load(root).get('a'), '1');
    assert.equal(corruptFiles(root).length, 0, 'still no quarantine after a normal write');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quarantine never overwrites an existing quarantine file — a collision suffix is used', () => {
  const root = tmp();
  try {
    // Freeze the clock so both quarantines compute the SAME base ISO timestamp.
    const fixed = new Date('2026-11-12T00:00:00.000Z');
    const RealDate = Date;
    // @ts-expect-error — test-only clock freeze
    globalThis.Date = class extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) super(fixed.getTime());
        else super(args[0] as string | number);
      }
      static override now() { return fixed.getTime(); }
    };
    try {
      put(root, 'FIRST CORRUPT');
      ProjectMemory.load(root);
      const first = corruptFiles(root);
      assert.equal(first.length, 1);
      const firstBytes = readFileSync(join(root, '.shadow', first[0]!), 'utf8');
      // A second corrupt file in the same millisecond must not clobber the first.
      put(root, 'SECOND CORRUPT');
      ProjectMemory.load(root);
      const all = corruptFiles(root);
      assert.equal(all.length, 2, 'a second quarantine file with a collision suffix');
      assert.ok(all.some((f) => f !== first[0]), 'the new file has a different name');
      assert.equal(readFileSync(join(root, '.shadow', first[0]!), 'utf8'), firstBytes, 'first quarantine untouched');
      assert.ok(all.some((f) => readFileSync(join(root, '.shadow', f), 'utf8') === 'SECOND CORRUPT'), 'second bytes preserved');
    } finally {
      globalThis.Date = RealDate;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a file corrupted externally before a write is quarantined, not silently overwritten', () => {
  const root = tmp();
  try {
    const mem = ProjectMemory.load(root);
    mem.set('a', '1'); // good file on disk
    // External damage between operations (a non-atomic editor / disk corruption).
    writeFileSync(memPath(root), 'EXTERNALLY DAMAGED {');
    mem.set('b', '2'); // refresh() sees the corrupt disk → quarantine before writing
    const q = corruptFiles(root);
    assert.equal(q.length, 1, 'the externally damaged bytes are quarantined');
    assert.equal(readFileSync(join(root, '.shadow', q[0]!), 'utf8'), 'EXTERNALLY DAMAGED {');
    const fresh = ProjectMemory.load(root);
    assert.equal(fresh.get('b'), '2', 'the new write still lands');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('corruption between load and the persist-time re-read is quarantined and the write still lands', () => {
  const root = tmp();
  try {
    const mem = ProjectMemory.load(root);
    mem.set('a', '1'); // good file on disk
    // Simulate external damage INSIDE persist(): backupPrevious() runs under the lock
    // immediately before the fresh re-read, so damaging the file right after the real
    // backup lands the corruption in exactly the refresh→persist window this branch
    // guards (corrupting before set() would only exercise the load-time quarantine).
    const damaged = 'DAMAGED MID-PERSIST {';
    const internals = mem as unknown as { backupPrevious: () => void };
    const realBackup = internals.backupPrevious.bind(mem);
    internals.backupPrevious = () => {
      realBackup();
      writeFileSync(memPath(root), damaged);
    };
    try {
      mem.set('b', '2');
    } finally {
      internals.backupPrevious = realBackup; // restore even if set() throws
    }
    const q = corruptFiles(root);
    assert.equal(q.length, 1, 'the mid-persist damaged bytes are quarantined');
    assert.equal(readFileSync(join(root, '.shadow', q[0]!), 'utf8'), damaged, 'damaged bytes preserved verbatim');
    assert.ok(readFileSync(`${memPath(root)}.bak`, 'utf8').includes('"a"'), '.bak still holds the last good file (backup ran before the damage)');
    const fresh = ProjectMemory.load(root);
    assert.equal(fresh.get('b'), '2', 'the write lands after quarantine');
    assert.equal(fresh.get('a'), undefined, 'fresh disk is the shared truth — only pending changes replay onto the post-quarantine store');
    const notice = mem.takeNotice();
    assert.ok(notice && /became corrupt before this write/i.test(notice), 'persist-time quarantine notice surfaced');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── .bak ─────────────────────────────────────────────────────────────────────

test('.bak is created and updated on persist with the previous good bytes', () => {
  const root = tmp();
  try {
    const mem = ProjectMemory.load(root);
    mem.set('a', '1');
    assert.ok(!existsSync(`${memPath(root)}.bak`), 'no .bak on the very first write (no previous good file)');
    const afterFirst = readFileSync(memPath(root), 'utf8');
    mem.set('b', '2');
    const bak = `${memPath(root)}.bak`;
    assert.ok(existsSync(bak), '.bak created on the second write');
    assert.equal(readFileSync(bak, 'utf8'), afterFirst, '.bak holds the previous good file');
    const afterSecond = readFileSync(memPath(root), 'utf8');
    mem.set('c', '3');
    assert.equal(readFileSync(bak, 'utf8'), afterSecond, '.bak updated to the latest good file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a corrupt file is quarantined, NOT copied to .bak', () => {
  const root = tmp();
  try {
    put(root, 'NOT JSON');
    const mem = ProjectMemory.load(root);
    mem.set('a', '1');
    assert.ok(!existsSync(`${memPath(root)}.bak`), 'corrupt bytes are not a valid restore point');
    assert.equal(corruptFiles(root).length, 1, 'corruption went to quarantine instead');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── redaction ────────────────────────────────────────────────────────────────

test('a secret-shaped value is redacted on disk', () => {
  const root = tmp();
  try {
    const mem = ProjectMemory.load(root);
    const secret = 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF';
    mem.set('apikey', `use ${secret} for auth`);
    const onDisk = readFileSync(memPath(root), 'utf8');
    assert.ok(!onDisk.includes(secret), 'the raw secret never lands on disk');
    assert.ok(onDisk.includes('[REDACTED]'), 'a redaction marker is present');
    assert.ok(!mem.get('apikey')!.includes(secret), 'the in-memory value is redacted too');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a secret-shaped source is redacted on disk', () => {
  const root = tmp();
  try {
    const mem = ProjectMemory.load(root);
    const secret = 'ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII';
    mem.set('k', 'benign value', { source: `token=${secret}` });
    const onDisk = readFileSync(memPath(root), 'utf8');
    assert.ok(!onDisk.includes(secret), 'the raw source secret never lands on disk');
    assert.ok(!mem.inspect('k')!.source!.includes(secret), 'stored source is redacted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── permissions ──────────────────────────────────────────────────────────────

test('memory.json, .bak and quarantine are all mode 0600', () => {
  const root = tmp();
  try {
    put(root, 'CORRUPT BYTES');
    const mem = ProjectMemory.load(root);
    mem.set('a', '1'); // creates memory.json
    mem.set('b', '2'); // creates .bak
    assert.equal(mode(memPath(root)), 0o600, 'memory.json is owner-only');
    assert.equal(mode(`${memPath(root)}.bak`), 0o600, '.bak is owner-only');
    const q = corruptFiles(root);
    assert.equal(q.length, 1);
    assert.equal(mode(join(root, '.shadow', q[0]!)), 0o600, 'quarantine is owner-only');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a pre-existing world-readable memory.json is tightened to 0600 on the next write', () => {
  const root = tmp();
  try {
    put(root, JSON.stringify({ version: 2, entries: { a: { value: '1', author: 'generated', scope: 'workspace', createdAt: '', updatedAt: '' } } }));
    // Simulate a legacy 0644 file.
    writeFileSync(memPath(root), readFileSync(memPath(root), 'utf8'), { mode: 0o644 });
    const mem = ProjectMemory.load(root);
    mem.set('b', '2');
    assert.equal(mode(memPath(root)), 0o600, 'perms tightened to owner-only on persist');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an UNREADABLE memory.json (chmod 000) is not overwritten: notice, blocked persist, then self-heal', async (t) => {
  // Root bypasses file permission bits and Windows has no POSIX chmod semantics —
  // the EACCES path cannot be exercised there, so skip instead of failing.
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('chmod 000 does not block reads for root / on Windows');
    return;
  }
  const root = tmp();
  try {
    const mem0 = ProjectMemory.load(root);
    mem0.set('keep', 'original');
    const goodBytes = readFileSync(memPath(root), 'utf8');
    chmodSync(memPath(root), 0o000);
    // While mode is 000 even the owner cannot read the file — prove "no overwrite"
    // via stat: a persist would atomicWrite a temp and rename it over this inode.
    const before = statSync(memPath(root));
    try {
      const mem = ProjectMemory.load(root);
      const notice = mem.takeNotice();
      assert.ok(notice && /could not be read/i.test(notice), 'an unreadable-file warning is surfaced');
      assert.equal(mem.takeNotice(), undefined, 'notice is one-shot');
      mem.set('blocked', 'nope'); // must be refused, not overwrite bytes we could not read
      const after = statSync(memPath(root));
      assert.equal(after.ino, before.ino, 'same inode — no atomic rename replaced the unreadable file');
      assert.equal(after.size, before.size, 'unreadable bytes untouched');
      assert.equal(after.mtimeMs, before.mtimeMs, 'no write happened');
      assert.equal(after.mode & 0o777, 0o000, 'mode untouched (a persist would bring a 0600 temp file)');
      assert.equal(corruptFiles(root).length, 0, 'unreadable is not corruption — nothing quarantined');
      // Blocked persist ⇒ inspect() finds nothing ⇒ the tool result must fall back
      // to the REDACTED input, never echo the raw secret (reviewer adjustment 2).
      const tool = makeMemoryTool(mem);
      const secret = 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF';
      const res = await tool.run({ action: 'remember', key: 'leak', value: `use ${secret} for auth` }, ctx());
      assert.equal(res.ok, true);
      assert.ok(!res.data?.value?.includes(secret), 'blocked persist does not echo the raw secret');
      assert.ok(res.data?.value?.includes('[REDACTED]'), 'fallback value is redacted');
      // Either refusal notice may win: inspect()'s refresh re-loads the still-unreadable
      // disk and its load-time notice legitimately replaces the persist-time one.
      assert.ok(/refusing to overwrite|NOT saved/i.test(res.summary), 'a refused-write warning reaches the model');
      assert.ok(res.meta.findings?.some((f) => f.severity === 'warn'), 'a warn finding is attached');
    } finally {
      chmodSync(memPath(root), 0o600); // restore readability (also lets cleanup proceed)
    }
    assert.equal(readFileSync(memPath(root), 'utf8'), goodBytes, 'original bytes intact — nothing overwrote them');
    mem0.set('after', 'healed'); // same instance: refresh clears persistBlocked once readable
    const fresh = ProjectMemory.load(root);
    assert.equal(fresh.get('keep'), 'original', 'pre-existing fact survived the unreadable window');
    assert.equal(fresh.get('after'), 'healed', 'writes resume after chmod 600 (self-heal)');
    assert.equal(fresh.get('blocked'), undefined, 'the refused change was never saved');
    assert.equal(fresh.takeNotice(), undefined, 'no warning once the store is readable again');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── concurrent-writer merge ──────────────────────────────────────────────────

test('two ProjectMemory instances writing interleaved lose no keys', () => {
  const root = tmp();
  try {
    const a = ProjectMemory.load(root);
    const b = ProjectMemory.load(root);
    a.set('fromA', 'A');
    b.set('fromB', 'B');
    a.set('fromA2', 'A2');
    b.set('fromB2', 'B2');
    const fresh = ProjectMemory.load(root);
    assert.equal(fresh.get('fromA'), 'A');
    assert.equal(fresh.get('fromB'), 'B');
    assert.equal(fresh.get('fromA2'), 'A2');
    assert.equal(fresh.get('fromB2'), 'B2');
    assert.equal(Object.keys(fresh.all()).length, 4, 'all four keys survive');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a concurrent delete is honored and does not resurrect the key', () => {
  const root = tmp();
  try {
    const a = ProjectMemory.load(root);
    const b = ProjectMemory.load(root);
    a.set('shared', 'v');
    a.set('onlyA', 'x');
    b.delete('shared');
    const fresh = ProjectMemory.load(root);
    assert.equal(fresh.get('shared'), undefined, 'delete honored');
    assert.equal(fresh.get('onlyA'), 'x', 'unrelated key survives');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── lockfile ─────────────────────────────────────────────────────────────────

test('a stale lock (>5s) is stolen and the write proceeds', () => {
  const root = tmp();
  try {
    const mem = ProjectMemory.load(root);
    const lock = `${memPath(root)}.lock`;
    mkdirSync(join(root, '.shadow'), { recursive: true });
    writeFileSync(lock, '999999 2020-01-01T00:00:00.000Z\n');
    const old = new Date(Date.now() - 10_000);
    utimesSync(lock, old, old);
    mem.set('a', '1'); // must not hang on the stale lock
    assert.equal(ProjectMemory.load(root).get('a'), '1');
    assert.ok(!existsSync(lock), 'lock released after the write');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a fresh lock is respected then released; the write still lands (best-effort)', () => {
  const root = tmp();
  try {
    const mem = ProjectMemory.load(root);
    const lock = `${memPath(root)}.lock`;
    mkdirSync(join(root, '.shadow'), { recursive: true });
    writeFileSync(lock, `${process.pid} ${new Date().toISOString()}\n`);
    // A live lock with no holder: we wait out the budget then proceed unlocked (best-effort).
    mem.set('a', '1');
    assert.equal(ProjectMemory.load(root).get('a'), '1', 'write lands even when the lock never frees');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── legacy + tool notice ─────────────────────────────────────────────────────

test('legacy v1 string-map still loads', () => {
  const root = tmp();
  try {
    put(root, JSON.stringify({ build: 'npm run build', test: 'node --test' }));
    const mem = ProjectMemory.load(root);
    assert.equal(mem.get('build'), 'npm run build');
    assert.equal(mem.get('test'), 'node --test');
    assert.equal(mem.inspect('build')?.author, 'legacy');
    assert.equal(corruptFiles(root).length, 0, 'a valid legacy file is not quarantined');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the memory tool surfaces a quarantine warning in summary + a warn finding', async () => {
  const root = tmp();
  try {
    put(root, 'BROKEN JSON');
    const mem = ProjectMemory.load(root);
    const tool = makeMemoryTool(mem);
    const res = await tool.run({ action: 'remember', key: 'build', value: 'npm run build' }, ctx());
    assert.equal(res.ok, true);
    assert.match(res.summary, /corrupt/i, 'warning appears in the model-facing summary');
    assert.ok(res.meta.findings?.some((f) => f.severity === 'warn' && /corrupt/i.test(f.body)), 'a warn finding is attached');
    // One-shot: a subsequent call does not repeat the warning.
    const res2 = await tool.run({ action: 'list' }, ctx());
    assert.ok(!/corrupt/i.test(res2.summary), 'notice is not repeated');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the memory tool reports the STORED (redacted) value, not the raw secret input', async () => {
  const root = tmp();
  try {
    const mem = ProjectMemory.load(root);
    const tool = makeMemoryTool(mem);
    const secret = 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF';
    const res = await tool.run({ action: 'remember', key: 'k', value: secret }, ctx());
    assert.equal(res.ok, true);
    assert.ok(!res.data?.value?.includes(secret), 'tool result does not echo the raw secret');
    assert.ok(res.data?.value?.includes('[REDACTED]'), 'tool result shows the redacted value');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a refused ghost key never echoes the raw secret in the tool fallback', async () => {
  const root = tmp();
  try {
    const mem = ProjectMemory.load(root);
    const tool = makeMemoryTool(mem);
    const secret = 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF';
    // A key of only control characters sanitizes to '' — set() refuses it (no ghost
    // key), so inspect() finds nothing and the result must fall back to REDACTED input.
    const res = await tool.run({ action: 'remember', key: '\u0001\u0002', value: `use ${secret} for auth` }, ctx());
    assert.equal(res.ok, true);
    assert.ok(!res.data?.value?.includes(secret), 'raw secret not echoed for a refused key');
    assert.ok(res.data?.value?.includes('[REDACTED]'), 'fallback value is redacted');
    assert.equal(Object.keys(mem.all()).length, 0, 'nothing was stored');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── adj1 (integration review): the quarantine notice is STICKY until an explicit op ──────────

test('adj1: peekNotice survives renders and read-only ops; a mutating op consumes it once', async () => {
  const root = tmp();
  try {
    mkdirSync(join(root, '.shadow'), { recursive: true });
    writeFileSync(join(root, '.shadow', 'memory.json'), '{corrupt', { mode: 0o600 });
    const mem = ProjectMemory.load(root);
    assert.match(mem.peekNotice() ?? '', /preserved the original/i);
    // The per-turn render path (asIndex → refresh) must NOT consume it:
    mem.asIndex(); mem.asIndex();
    assert.match(mem.peekNotice() ?? '', /preserved the original/i, 'notice survives repeated renders');
    const tool = makeMemoryTool(mem);
    const listed = await tool.run({ action: 'list' }, ctx());
    assert.match(listed.summary, /preserved the original/i, 'read-only list surfaces the notice');
    assert.match(mem.peekNotice() ?? '', /preserved the original/i, 'read-only list does NOT consume it');
    const wrote = await tool.run({ action: 'remember', key: 'k', value: 'v' }, ctx());
    assert.match(wrote.summary, /preserved the original/i, 'the mutating op surfaces it');
    assert.equal(mem.peekNotice(), undefined, 'the mutating op consumed it exactly once');
    const again = await tool.run({ action: 'list' }, ctx());
    assert.ok(!/preserved the original/i.test(again.summary), 'no repeat after consumption');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('adj1: the notice stays sticky across instances until taken; quarantine happens exactly once', () => {
  const root = tmp();
  try {
    mkdirSync(join(root, '.shadow'), { recursive: true });
    const file = join(root, '.shadow', 'memory.json');
    writeFileSync(file, '{corrupt', { mode: 0o600 });
    const a = ProjectMemory.load(root);
    assert.match(a.peekNotice() ?? '', /preserved the original/i);
    // A second instance refreshing BEFORE any consume still surfaces the warning (the corrupt
    // bytes were preserved + unlinked by the first load, so the notice rides the live store).
    a.asIndex();
    assert.match(a.peekNotice() ?? '', /preserved the original/i);
    a.takeNotice();
    assert.equal(a.peekNotice(), undefined);
    // After consumption a clean reload is silent — and re-quarantine never repeats:
    const b = ProjectMemory.load(root);
    assert.equal(b.peekNotice(), undefined);
    assert.ok(existsSync(file) === false || readFileSync(file, 'utf8') !== '{corrupt',
      'the corrupt original is not left in place to storm re-quarantines');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});