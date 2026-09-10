import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editFile } from '../src/tools/editFile.js';
import { readFile } from '../src/tools/readFile.js';
import { writeFile } from '../src/tools/writeFile.js';
import { createReadTracker } from '../src/tools/readTracker.js';
import type { ToolContext } from '../src/tools/types.js';

function setup(): { ws: string; ctx: ToolContext } {
  const ws = mkdtempSync(join(tmpdir(), 'rbe-'));
  const ctx: ToolContext = {
    workspaceRoot: ws,
    signal: new AbortController().signal,
    log: () => {},
    dryRun: false,
    readTracker: createReadTracker(),
  };
  return { ws, ctx };
}

test('edit without a prior read_file (or write_file) is REFUSED (Claude "read in conversation" parity)', async () => {
  const { ws, ctx } = setup();
  try {
    writeFileSync(join(ws, 'f.txt'), 'alpha bravo\n');
    const r = await editFile.run({ path: 'f.txt', old_string: 'alpha', new_string: 'ALPHA' }, ctx);
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, 'read_required');
    assert.match(r.error?.message ?? '', /read_file tool on this file before editing/);
    // content unchanged
    assert.equal(readFileSync(join(ws, 'f.txt'), 'utf8'), 'alpha bravo\n');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('read then edit succeeds', async () => {
  const { ws, ctx } = setup();
  try {
    writeFileSync(join(ws, 'f.txt'), 'alpha bravo\n');
    await readFile.run({ path: 'f.txt' }, ctx);
    const r = await editFile.run({ path: 'f.txt', old_string: 'alpha', new_string: 'ALPHA' }, ctx);
    assert.equal(r.ok, true, r.summary);
    assert.equal(readFileSync(join(ws, 'f.txt'), 'utf8'), 'ALPHA bravo\n');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('write then edit succeeds (a written file is known)', async () => {
  const { ws, ctx } = setup();
  try {
    await writeFile.run({ path: 'g.txt', content: 'one two\n' }, ctx);
    const r = await editFile.run({ path: 'g.txt', old_string: 'two', new_string: 'three' }, ctx);
    assert.equal(r.ok, true, r.summary);
    assert.equal(readFileSync(join(ws, 'g.txt'), 'utf8'), 'one three\n');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('edit is refused if the file changed on disk since it was read', async () => {
  const { ws, ctx } = setup();
  try {
    const p = join(ws, 'f.txt');
    writeFileSync(p, 'alpha\n');
    await readFile.run({ path: 'f.txt' }, ctx);
    // Simulate an external change: rewrite + bump mtime forward.
    writeFileSync(p, 'beta\n');
    const future = statSync(p).mtimeMs / 1000 + 5;
    utimesSync(p, future, future);
    const r = await editFile.run({ path: 'f.txt', old_string: 'beta', new_string: 'BETA' }, ctx);
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, 'read_required');
    assert.match(r.error?.message ?? '', /changed on disk/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('without a readTracker (e.g. isolated tests) the guard is inert', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'rbe-'));
  try {
    writeFileSync(join(ws, 'f.txt'), 'x\n');
    const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false };
    const r = await editFile.run({ path: 'f.txt', old_string: 'x', new_string: 'y' }, ctx);
    assert.equal(r.ok, true, 'no tracker → no guard');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a read in an EARLIER TURN still authorizes the edit (the tracker is per-SESSION, not per-loop)', async () => {
  // A new AgentLoop is built for every user message (TUI, REPL, and web all do this), and each loop
  // used to create its OWN tracker — so a file read in turn 1 was "unseen" in turn 2, and the edit
  // was refused with "read it in this conversation first" for a read the model HAD performed one
  // message earlier. The same lifetime bug was already fixed for approval grants (SessionApprovals);
  // this pins the read guard to the same rule.
  const ws = mkdtempSync(join(tmpdir(), 'rbe-session-'));
  try {
    writeFileSync(join(ws, 'f.txt'), 'alpha bravo\n');
    // ONE tracker, shared by every turn's loop — the only change the fix makes at the call sites.
    const sessionTracker = createReadTracker();
    const turn = (): ToolContext => ({
      workspaceRoot: ws,
      signal: new AbortController().signal,
      log: () => {},
      dryRun: false,
      readTracker: sessionTracker,
    });

    const readCtx = turn(); // turn 1's loop
    await readFile.run({ path: 'f.txt' }, readCtx);

    const editCtx = turn(); // turn 2's loop — a DIFFERENT ToolContext, same session
    const r = await editFile.run({ path: 'f.txt', old_string: 'alpha', new_string: 'ALPHA' }, editCtx);
    assert.equal(r.ok, true, `cross-turn edit must be allowed: ${r.summary ?? r.error?.message}`);
    assert.equal(readFileSync(join(ws, 'f.txt'), 'utf8'), 'ALPHA bravo\n');

    // …and the stale-file protection survives the turn boundary too (it is the same tracker).
    const p = join(ws, 'f.txt');
    writeFileSync(p, 'beta\n');
    const future = statSync(p).mtimeMs / 1000 + 5;
    utimesSync(p, future, future);
    const stale = await editFile.run({ path: 'f.txt', old_string: 'beta', new_string: 'BETA' }, turn());
    assert.equal(stale.ok, false, 'an external change between turns is still caught');
    assert.match(stale.error?.message ?? '', /changed on disk/);

    // clear() (called on /resume, /fork, /clear) drops the memory: the next edit re-gates.
    sessionTracker.clear();
    const after = await editFile.run({ path: 'f.txt', old_string: 'beta', new_string: 'BETA' }, turn());
    assert.equal(after.ok, false, 'after clear() the read must be re-established');
    assert.equal(after.error?.code, 'read_required');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
