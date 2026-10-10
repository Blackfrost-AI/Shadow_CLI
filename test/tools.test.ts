import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveWithin } from '../src/safety/workspaceJail.js';
import { readFile } from '../src/tools/readFile.js';
import { viewImage } from '../src/tools/viewImage.js';
import { writeFile } from '../src/tools/writeFile.js';
import { editFile } from '../src/tools/editFile.js';
import type { ToolContext } from '../src/tools/types.js';
import { discoverProjectInstructions, projectInstructionsBlock } from '../src/system/projectInstructions.js';
import { createReadTracker } from '../src/tools/readTracker.js';

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

test('readFile marks a completed bounded range and makes further same-file reading optional', async () => {
  const root = tmp();
  try {
    const lines = Array.from({ length: 12 }, (_, i) => `line-${i + 1}-${'x'.repeat(24)}`);
    writeFileSync(join(root, 'bounded.txt'), lines.join('\n'));
    const cap = 900;
    const result = await readFile.run(
      { path: 'bounded.txt', offset: 3, limit: 2 },
      { ...ctxFor(root), maxToolResultChars: cap },
    );

    assert.equal(result.ok, true);
    assert.equal(result.data?.truncated, undefined);
    assert.equal(result.data?.endLine, 4);
    assert.equal(result.data?.nextOffset, 5);
    assert.deepEqual(result.data?.continuation, { path: 'bounded.txt', offset: 5 });
    assert.match(result.summary, /Requested range complete\./);
    assert.match(
      result.summary,
      /Optional only if more lines are needed: continue the SAME file with read_file \{"path":"bounded\.txt","offset":5\}\./,
    );
    assert.doesNotMatch(result.summary, /Next page/);

    const serialized = `${result.summary}\n${JSON.stringify(result.data)}`;
    assert.ok(serialized.length <= cap, `read_file serialized ${serialized.length} chars into a ${cap}-char cap`);
    assert.doesNotThrow(() => JSON.parse(serialized.slice(serialized.indexOf('\n') + 1)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readFile preserves the remaining line limit when a bounded read is budget-truncated', async () => {
  const root = tmp();
  try {
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i + 1}-${'x'.repeat(96)}`);
    writeFileSync(join(root, 'bounded-page.txt'), lines.join('\n'));
    const offset = 4;
    const limit = 8;
    const result = await readFile.run(
      { path: 'bounded-page.txt', offset, limit },
      { ...ctxFor(root), maxToolResultChars: 900 },
    );

    assert.equal(result.ok, true);
    assert.equal(result.data?.truncated, true);
    const linesRead = (result.data?.endLine ?? offset - 1) - offset + 1;
    assert.ok(linesRead > 0 && linesRead < limit);
    assert.deepEqual(result.data?.continuation, {
      path: 'bounded-page.txt',
      offset: offset + linesRead,
      limit: limit - linesRead,
    });
    assert.match(result.summary, new RegExp(`"limit":${limit - linesRead}`));

    const continuation = result.data?.continuation;
    assert.ok(continuation);
    const next = await readFile.run(continuation, ctxFor(root));
    assert.equal(next.ok, true);
    assert.equal(next.data?.endLine, offset + limit - 1);
    assert.doesNotMatch(next.data?.content ?? '', /line-12-/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readFile reports an honest next page before the tool-result character clamp', async () => {
  const root = tmp();
  try {
    mkdirSync(join(root, '.git'));
    const lines = Array.from({ length: 30 }, (_, i) => `line-${i + 1}-${'x'.repeat(48)}`);
    writeFileSync(join(root, 'large.txt'), lines.join('\n'));
    const ctx = { ...ctxFor(root), maxToolResultChars: 900 };
    const result = await readFile.run({ path: 'large.txt' }, ctx);
    assert.equal(result.ok, true);
    assert.equal(result.data?.truncated, true);
    assert.ok((result.data?.endLine ?? 30) < 30);
    assert.equal(result.data?.nextOffset, (result.data?.endLine ?? 0) + 1);
    assert.deepEqual(result.data?.continuation, {
      path: 'large.txt',
      offset: (result.data?.endLine ?? 0) + 1,
    });
    assert.match(result.summary, /Next page of the SAME file:/);
    assert.match(
      result.summary,
      new RegExp(`SAME file: read_file .*"path":"large\\.txt".*"offset":${result.data?.nextOffset}`),
    );
    const serialized = `${result.summary}\n${JSON.stringify(result.data)}`;
    assert.ok(serialized.length <= 900, `read_file serialized ${serialized.length} chars into a 900-char cap`);
    assert.doesNotThrow(() => JSON.parse(serialized.slice(serialized.indexOf('\n') + 1)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readFile does not unlock edits or advertise progress when no complete line fits', async () => {
  const root = tmp();
  try {
    const path = join(root, 'oversized-line.txt');
    writeFileSync(path, 'x'.repeat(8_000));
    const readTracker = createReadTracker();
    const result = await readFile.run(
      { path: 'oversized-line.txt' },
      { ...ctxFor(root), maxToolResultChars: 500, readTracker },
    );

    assert.equal(result.ok, true);
    assert.equal(result.data?.content, '');
    assert.equal(result.data?.endLine, 0);
    assert.equal(result.data?.truncated, true);
    assert.equal(result.data?.nextOffset, undefined);
    assert.equal(result.data?.continuation, undefined);
    assert.match(result.summary, /exceeds the tool-result budget\. Use grep to narrow/);
    assert.equal(readTracker.hasSeen(path), false, 'a zero-content page must not satisfy read-before-edit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readFile suppresses only unchanged project instructions actually present in the system prompt', async () => {
  const root = tmp();
  try {
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'AGENTS.md'), 'root instructions already in system');
    writeFileSync(join(root, 'root.txt'), 'root data');
    writeFileSync(join(root, 'nested', 'AGENTS.md'), 'nested instructions');
    writeFileSync(join(root, 'nested', 'data.txt'), 'nested data');
    const startupSystem = projectInstructionsBlock(discoverProjectInstructions(root));
    const ctx = { ...ctxFor(root), systemPrompt: startupSystem };

    const rootRead = await readFile.run({ path: 'root.txt' }, ctx);
    assert.equal(rootRead.ok, true);
    assert.equal(rootRead.data?.instructions, undefined);

    const nestedRead = await readFile.run({ path: 'nested/data.txt' }, ctx);
    assert.deepEqual(nestedRead.data?.instructions?.sources.map((source) => source.body), ['nested instructions']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readFile surfaces root instructions excluded by --system and root instructions changed after startup', async () => {
  const root = tmp();
  try {
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, 'AGENTS.md'), 'startup root instructions');
    writeFileSync(join(root, 'data.txt'), 'data');

    const customSystemRead = await readFile.run(
      { path: 'data.txt' },
      { ...ctxFor(root), systemPrompt: 'CUSTOM --system PROMPT' },
    );
    assert.deepEqual(
      customSystemRead.data?.instructions?.sources.map((source) => source.body),
      ['startup root instructions'],
      '--system did not inject the project block, so read_file must still surface it',
    );

    const startupSystem = projectInstructionsBlock(discoverProjectInstructions(root));
    writeFileSync(join(root, 'AGENTS.md'), 'updated root instructions');
    const changedRead = await readFile.run(
      { path: 'data.txt' },
      { ...ctxFor(root), systemPrompt: startupSystem },
    );
    assert.deepEqual(
      changedRead.data?.instructions?.sources.map((source) => source.body),
      ['updated root instructions'],
      'path equality alone must not hide instructions changed after the startup snapshot',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readFile trims or omits oversized instruction metadata while preserving valid capped JSON', async () => {
  const root = tmp();
  try {
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'AGENTS.md'), 'I'.repeat(6_000));
    writeFileSync(
      join(root, 'nested', 'large.txt'),
      Array.from({ length: 30 }, (_, i) => `line-${i + 1}-${'x'.repeat(72)}`).join('\n'),
    );
    const cap = 1_000;
    const result = await readFile.run(
      { path: 'nested/large.txt' },
      { ...ctxFor(root), maxToolResultChars: cap, systemPrompt: 'no project block here' },
    );

    assert.equal(result.ok, true);
    assert.ok((result.data?.endLine ?? 0) > 0, 'instruction metadata must not crowd out every file line');
    assert.equal(result.data?.nextOffset, (result.data?.endLine ?? 0) + 1);
    assert.deepEqual(result.data?.continuation, {
      path: 'nested/large.txt',
      offset: (result.data?.endLine ?? 0) + 1,
    });
    assert.ok(
      (result.data?.instructions?.sources.some((source) => source.truncated) ?? false) ||
        (result.data?.instructionSourcesOmitted ?? 0) > 0,
      'any instruction loss is represented explicitly',
    );
    const serialized = `${result.summary}\n${JSON.stringify(result.data)}`;
    assert.ok(serialized.length <= cap, `read_file serialized ${serialized.length} chars into a ${cap}-char cap`);
    assert.doesNotThrow(() => JSON.parse(serialized.slice(serialized.indexOf('\n') + 1)));
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
