import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveWithin } from '../src/safety/workspaceJail.js';
import { readFile } from '../src/tools/readFile.js';
import { viewImage } from '../src/tools/viewImage.js';
import { writeFile } from '../src/tools/writeFile.js';
import { editFile } from '../src/tools/editFile.js';
import type { ToolContext } from '../src/tools/types.js';

function tmp(): string {
  return mkdtempSync(join(resolve(tmpdir()), 'shadow-tools-'));
}

function ctxFor(root: string, dryRun = false): ToolContext {
  return {
    workspaceRoot: root,
    signal: new AbortController().signal,
    log: () => {},
    dryRun,
  };
}

// ── workspaceJail ───────────────────────────────────────────────────────────

test('workspaceJail rejects ".." traversal and absolute-outside paths', () => {
  const root = tmp();
  try {
    assert.throws(() => resolveWithin(root, '../escape.txt'), /outside the workspace/);
    assert.throws(() => resolveWithin(root, '/etc/passwd'), /outside the workspace/);
    assert.throws(() => resolveWithin(root, ''), /non-empty/);
    // A normal inside path (not yet created) is allowed and contained.
    const p = resolveWithin(root, 'sub/new.txt');
    // resolveWithin checks containment against the realpath'd root but returns the
    // path re-anchored to the caller's ORIGINAL spelling, so assert against that
    // (realpathSync(root) breaks on macOS where /var → /private/var).
    assert.ok(p.startsWith(resolve(root)), 'contained path stays under the root');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('workspaceJail defeats a symlink that points outside the root', () => {
  const root = tmp();
  const outside = tmp();
  try {
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET');
    symlinkSync(realpathSync(outside), join(root, 'link')); // root/link -> outside dir (absolute target)

    // Following the symlink to read a file outside must be rejected...
    assert.throws(() => resolveWithin(root, 'link/secret.txt'), /outside the workspace/);
    // ...and the symlink itself (which resolves outside) must be rejected.
    assert.throws(() => resolveWithin(root, 'link'), /outside the workspace/);
    // A brand-new file *through* the escaping symlink must also be rejected
    // (covers the writeFile-to-not-yet-existing case).
    assert.throws(() => resolveWithin(root, 'link/brand-new.txt'), /outside the workspace/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ── writeFile ───────────────────────────────────────────────────────────────

test('writeFile is atomic (creates parent dirs) and idempotent', async () => {
  const root = tmp();
  try {
    const ctx = ctxFor(root);

    const r1 = await writeFile.run({ path: 'a/b/c.txt', content: 'hello' }, ctx);
    assert.equal(r1.ok, true);
    assert.equal(r1.data?.changed, true);
    assert.ok(existsSync(join(root, 'a/b/c.txt')), 'nested parent dirs were created');
    assert.equal(readFileSync(join(root, 'a/b/c.txt'), 'utf8'), 'hello');

    // Second identical write → no-op, changed:false.
    const r2 = await writeFile.run({ path: 'a/b/c.txt', content: 'hello' }, ctx);
    assert.equal(r2.ok, true);
    assert.equal(r2.data?.changed, false, 'identical content reports changed:false');

    // Different content → changed:true.
    const r3 = await writeFile.run({ path: 'a/b/c.txt', content: 'goodbye' }, ctx);
    assert.equal(r3.data?.changed, true);
    assert.equal(readFileSync(join(root, 'a/b/c.txt'), 'utf8'), 'goodbye');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writeFile honors dryRun (writes nothing)', async () => {
  const root = tmp();
  try {
    const ctx = ctxFor(root, true);
    const r = await writeFile.run({ path: 'x.txt', content: 'data' }, ctx);
    assert.equal(r.ok, true);
    assert.equal(r.data?.changed, true);
    assert.ok(!existsSync(join(root, 'x.txt')), 'dry-run must not create the file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── editFile ────────────────────────────────────────────────────────────────

test('editFile refuses an ambiguous (>1 match) edit without replace_all', async () => {
  const root = tmp();
  try {
    writeFileSync(join(root, 'f.txt'), 'foo\nfoo\n');
    const ctx = ctxFor(root);
    const r = await editFile.run({ path: 'f.txt', old_string: 'foo', new_string: 'bar' }, ctx);
    assert.equal(r.ok, false);
    assert.equal(r.error?.recoverable, true, 'ambiguity is a recoverable failure');
    assert.match(r.error?.message ?? '', /matches 2 times/);
    // File untouched.
    assert.equal(readFileSync(join(root, 'f.txt'), 'utf8'), 'foo\nfoo\n');

    // replace_all resolves it.
    const r2 = await editFile.run(
      { path: 'f.txt', old_string: 'foo', new_string: 'bar', replace_all: true },
      ctx,
    );
    assert.equal(r2.ok, true);
    assert.equal(r2.data?.replacements, 2);
    assert.equal(readFileSync(join(root, 'f.txt'), 'utf8'), 'bar\nbar\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('editFile happy path replaces a unique occurrence', async () => {
  const root = tmp();
  try {
    writeFileSync(join(root, 'g.txt'), 'hello world');
    const ctx = ctxFor(root);
    const r = await editFile.run({ path: 'g.txt', old_string: 'world', new_string: 'there' }, ctx);
    assert.equal(r.ok, true);
    assert.equal(r.data?.replacements, 1);
    assert.equal(readFileSync(join(root, 'g.txt'), 'utf8'), 'hello there');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('editFile returns a recoverable not_found when old_string is absent', async () => {
  const root = tmp();
  try {
    // Use a string dissimilar enough that the fuzzy-repair ladder cannot match
    // it — otherwise a near-miss is (correctly) repaired rather than rejected.
    writeFileSync(join(root, 'h.txt'), 'alpha beta gamma\n');
    const ctx = ctxFor(root);
    const r = await editFile.run({ path: 'h.txt', old_string: 'qqqq wwww eeee rrrr', new_string: 'x' }, ctx);
    assert.equal(r.ok, false);
    assert.equal(r.error?.recoverable, true);
    assert.match(r.error?.code ?? '', /not_found/);
    assert.equal(readFileSync(join(root, 'h.txt'), 'utf8'), 'alpha beta gamma\n', 'file untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── readFile ────────────────────────────────────────────────────────────────

test('readFile offset/limit returns the right 1-based line range', async () => {
  const root = tmp();
  try {
    writeFileSync(join(root, 'lines.txt'), 'line1\nline2\nline3\nline4\nline5');
    const ctx = ctxFor(root);
    const r = await readFile.run({ path: 'lines.txt', offset: 2, limit: 2 }, ctx);
    assert.equal(r.ok, true);
    assert.equal(r.data?.startLine, 2);
    assert.equal(r.data?.endLine, 3);
    assert.equal(r.data?.totalLines, 5);
    assert.equal(r.data?.content, 'line2\nline3');

    // No offset/limit → whole file.
    const all = await readFile.run({ path: 'lines.txt' }, ctx);
    assert.equal(all.data?.startLine, 1);
    assert.equal(all.data?.endLine, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readFile refuses a binary file', async () => {
  const root = tmp();
  try {
    writeFileSync(join(root, 'bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    const ctx = ctxFor(root);
    const r = await readFile.run({ path: 'bin' }, ctx);
    assert.equal(r.ok, false);
    assert.match(r.error?.code ?? '', /binary/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readFile rejects a path outside the workspace', async () => {
  const root = tmp();
  try {
    const r = await readFile.run({ path: '/etc/passwd' }, ctxFor(root));
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, 'outside_workspace');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── view_image ──────────────────────────────────────────────────────────────

// 1×1 transparent PNG — a real, decodable image.
const PIXEL_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('view_image loads a png as an ImageBlock (base64) and does not bloat text content', async () => {
  const root = tmp();
  try {
    writeFileSync(join(root, 'pixel.png'), Buffer.from(PIXEL_PNG_B64, 'base64'));
    const r = await viewImage.run({ path: 'pixel.png' }, ctxFor(root));
    assert.equal(r.ok, true);
    assert.match(r.summary, /image\/png/);
    assert.equal(r.images?.length, 1);
    assert.equal(r.images?.[0]!.type, 'image');
    assert.equal(r.images?.[0]!.mediaType, 'image/png');
    assert.equal(r.images?.[0]!.data, PIXEL_PNG_B64, 'carries the file base64 verbatim');
    // The base64 must NOT leak into the model-facing summary/data (context-bloat guard).
    assert.ok(!r.summary.includes(PIXEL_PNG_B64));
    assert.equal((r.data as { mediaType: string }).mediaType, 'image/png');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('view_image rejects a non-image extension and a path outside the workspace', async () => {
  const root = tmp();
  try {
    writeFileSync(join(root, 'notes.txt'), 'hello');
    const bad = await viewImage.run({ path: 'notes.txt' }, ctxFor(root));
    assert.equal(bad.ok, false);
    assert.equal(bad.error?.code, 'unsupported_image');

    const escape = await viewImage.run({ path: '../escape.png' }, ctxFor(root));
    assert.equal(escape.ok, false);
    assert.equal(escape.error?.code, 'outside_workspace');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
