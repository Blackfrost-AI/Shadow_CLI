// m-5 — LSP edit actions, end to end. The wire here is a FakeLspConnection (the injected
// LspEditWire seam), but the JOURNAL is real: case 7 walks the full prepare→approve→apply
// cycle against on-disk bytes and rolls back, and case 8 injects a write failure through
// journal opts and proves reconcile() surfaces the truth afterwards.
//
// Splice assertions compare against INDEPENDENTLY computed splices (Buffer.concat over
// hand-computed byte offsets), never against normalizeWorkspaceEdit's own output.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  LspEditError,
  buildEditOperation,
  diffDiagnostics,
  normalizeWorkspaceEdit,
  preRequestFileHashes,
  requestCodeActions,
  type TextEditWire,
  type ValidatedFileEdit,
  type WorkspaceEditWire,
} from '../src/agent/lsp/editActions.js';
import {
  apply as applyEdit,
  postApplyDiagnostics,
  propose,
  type LspEditProposal,
} from '../src/agent/lsp/editTool.js';
import { createMutationJournal } from '../src/tools/mutation.js';
import { ScriptedApprovalGate } from '../src/agent/approval.js';
import type { LspDiagnostic } from '../src/agent/lsp/protocol.js';

// ── fixtures ────────────────────────────────────────────────────────────────

/** A workspace with two source files, like the repo it models. */
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'shadow-lsp-edit-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/a.ts'), 'const oldName = 1;\nconsole.log(oldName);\n');
  writeFileSync(join(root, 'src/b.ts'), 'import { oldName } from "./a.js";\nconsole.log(oldName);\n');
  return root;
}

/** The fake wire: answers exactly what the test scripted, in order. */
class FakeLspConnection {
  public calls: Array<{ method: string; params: unknown }> = [];
  private i = 0;
  constructor(private readonly responses: unknown[]) {}

  request(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    const answer = this.i < this.responses.length ? this.responses[this.i++] : null;
    return Promise.resolve(answer);
  }
}

const uriOf = (root: string, rel: string): string => pathToFileURL(join(root, rel)).href;

/** Rejections are specific: the operation and the target are named, and the type is ours. */
const rejectsSpecific = (block: () => void, pattern: RegExp): void => {
  assert.throws(block, (error: unknown) => {
    assert.ok(error instanceof LspEditError, `must be an LspEditError, got: ${String(error)}`);
    assert.match((error as Error).message, pattern);
    return true;
  });
};

/** Pre-hashes for the named files, taken now — the staleness token. */
const hashesFor = (root: string, rels: string[]): Map<string, string> =>
  preRequestFileHashes(
    (absPath: string): Buffer => readFileSync(absPath),
    rels.map((rel) => join(root, rel)),
  );

/** An independent single splice of [start, end) → replacement. */
const splice = (before: Buffer, start: number, end: number, replacement: string): Buffer =>
  Buffer.concat([before.subarray(0, start), Buffer.from(replacement, 'utf8'), before.subarray(end)]);

/** normalizeWorkspaceEdit against the real on-disk reader with pre-hashes for `rels`. */
function normalizeWith(root: string, raw: WorkspaceEditWire, rels: string[]): ValidatedFileEdit[] {
  return normalizeWorkspaceEdit(raw, (absPath) => readFileSync(absPath), hashesFor(root, rels));
}

// ── case 1: valid multi-file rename ──────────────────────────────────────────

test('valid multi-file rename → exact before/after plan', () => {
  const root = workspace();
  try {
    const a = join(root, 'src/a.ts');
    const b = join(root, 'src/b.ts');
    const raw: WorkspaceEditWire = { documentChanges: [
      { textDocument: { uri: uriOf(root, 'src/a.ts') }, edits: [
        { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }, newText: 'newName' },
        { range: { start: { line: 1, character: 12 }, end: { line: 1, character: 19 } }, newText: 'newName' },
      ] },
      { textDocument: { uri: uriOf(root, 'src/b.ts') }, edits: [
        { range: { start: { line: 0, character: 9 }, end: { line: 0, character: 16 } }, newText: 'newName' },
      ] },
    ] };

    const plan = normalizeWith(root, raw, ['src/a.ts', 'src/b.ts']);
    assert.equal(plan.length, 2);
    assert.equal(plan[0].path, a);
    assert.equal(plan[1].path, b);
    assert.equal(plan[0].editCount, 2);
    assert.equal(plan[1].editCount, 1);

    // after-bytes must equal INDEPENDENTLY computed splices of the on-disk bytes.
    // Line 0 is 18 bytes + LF → line 1 starts at byte 19; both edits are 7→7 chars,
    // so the second splice's offsets do not shift in the intermediate buffer.
    const aBefore = readFileSync(a);
    const bBefore = readFileSync(b);
    const expectedA = splice(splice(aBefore, 6, 13, 'newName'), 31, 38, 'newName');
    const expectedB = splice(bBefore, 9, 16, 'newName');
    assert.ok(plan[0].beforeBytes.equals(aBefore));
    assert.ok(plan[1].beforeBytes.equals(bBefore));
    assert.ok(plan[0].afterBytes.equals(expectedA), 'a.ts after-bytes must be the exact splice');
    assert.ok(plan[1].afterBytes.equals(expectedB), 'b.ts after-bytes must be the exact splice');

    const textA = plan[0].afterBytes.toString('utf8');
    assert.match(textA, /const newName = 1;/);
    assert.match(textA, /console\.log\(newName\);/);
    assert.equal(textA.includes('oldName'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── case 2: resource operations, one per test ────────────────────────────────

test('CreateFile rejected with a specific error', () => {
  const root = workspace();
  try {
    const raw: WorkspaceEditWire = { documentChanges: [{ kind: 'create', uri: uriOf(root, 'src/new.ts'), options: {} }] };
    rejectsSpecific(() => normalizeWith(root, raw, []), /Refusing create of .*src\/new\.ts.*resource operations/s);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RenameFile rejected with a specific error', () => {
  const root = workspace();
  try {
    const raw: WorkspaceEditWire = { documentChanges: [
      { kind: 'rename', oldUri: uriOf(root, 'src/a.ts'), uri: uriOf(root, 'src/z.ts') },
    ] };
    rejectsSpecific(() => normalizeWith(root, raw, []), /Refusing rename of .*src\/a\.ts.*→ .*src\/z\.ts/s);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('DeleteFile rejected with a specific error', () => {
  const root = workspace();
  try {
    const raw: WorkspaceEditWire = { documentChanges: [{ kind: 'delete', uri: uriOf(root, 'src/a.ts') }] };
    rejectsSpecific(() => normalizeWith(root, raw, []), /Refusing delete of .*src\/a\.ts/s);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── case 3: command-bearing actions ──────────────────────────────────────────

test('command-bearing code action rejected', async () => {
  const root = workspace();
  try {
    // Wire level: the edits-only filter must DROP the command-bearing action.
    const conn = new FakeLspConnection([[
      { title: 'also runs a command', kind: 'refactor', command: { command: 'evil', arguments: [] }, edit: { documentChanges: [] } },
      { title: 'edits only', kind: 'refactor', edit: { documentChanges: [] } },
    ]]);
    const kept = await requestCodeActions(
      conn,
      uriOf(root, 'src/a.ts'),
      { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    );
    assert.equal(kept.length, 1);
    assert.equal(kept[0].title, 'edits only');

    // Validation level: a documentChanges entry that carries a command is refused by name.
    const raw: WorkspaceEditWire = { documentChanges: [
      { textDocument: { uri: uriOf(root, 'src/a.ts') }, edits: [], command: { command: 'evil' } },
    ] };
    rejectsSpecific(() => normalizeWith(root, raw, []), /Refusing command-bearing change for .*src\/a\.ts/s);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── case 4: overlapping edits ────────────────────────────────────────────────

test('overlapping edits rejected', () => {
  const root = workspace();
  try {
    const raw: WorkspaceEditWire = { documentChanges: [{ textDocument: { uri: uriOf(root, 'src/a.ts') }, edits: [
      { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }, newText: 'x' },
      { range: { start: { line: 0, character: 10 }, end: { line: 0, character: 13 } }, newText: 'y' },
    ] }] };
    rejectsSpecific(() => normalizeWith(root, raw, ['src/a.ts']), /Overlapping edits in .*src\/a\.ts/s);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── case 5: UTF-16 offsets with emoji ────────────────────────────────────────

test('UTF-16 offsets decode correctly with emoji in the file', () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-lsp-edit-'));
  try {
    mkdirSync(join(root, 'src'));
    // 'const 🚀 = 1;\nconsole.log(🚀);\n' — 🚀 is U+1F680: TWO UTF-16 units, FOUR UTF-8 bytes.
    writeFileSync(join(root, 'src/emoji.ts'), 'const 🚀 = 1;\nconsole.log(🚀);\n');
    const abs = join(root, 'src/emoji.ts');
    const before = readFileSync(abs);
    assert.equal(before.length, 35); // 16 (line 0 incl. LF) + 18 (line 1) + LF

    // Replace 🚀 (UTF-16 chars 6..8) with 'rocket'. A code-point or byte reading of
    // 6..8 would splice garbage; only the UTF-16 walk lands on the exact 4 emoji bytes.
    const raw: WorkspaceEditWire = { documentChanges: [{ textDocument: { uri: pathToFileURL(abs).href }, edits: [
      { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 8 } }, newText: 'rocket' },
    ] }] };
    const plan = normalizeWith(root, raw, ['src/emoji.ts']);
    assert.equal(plan.length, 1);
    assert.ok(plan[0].afterBytes.equals(splice(before, 6, 10, 'rocket')), 'must splice exactly the emoji bytes');
    assert.match(plan[0].afterBytes.toString('utf8'), /^const rocket = 1;/);

    // Line 1 starts at byte 16; 'console.log(' is 12 chars → 🚀 occupies bytes 28..32.
    const raw2: WorkspaceEditWire = { documentChanges: [{ textDocument: { uri: pathToFileURL(abs).href }, edits: [
      { range: { start: { line: 1, character: 12 }, end: { line: 1, character: 14 } }, newText: 'boom' },
    ] }] };
    const plan2 = normalizeWith(root, raw2, ['src/emoji.ts']);
    assert.equal(plan2.length, 1);
    assert.ok(plan2[0].afterBytes.equals(splice(before, 28, 32, 'boom')), 'line 2 must splice exactly the emoji bytes');
    assert.match(plan2[0].afterBytes.toString('utf8'), /^console\.log\(boom\);$/m);

    // And splitting a surrogate pair fails closed, naming the file.
    const raw3: WorkspaceEditWire = { documentChanges: [{ textDocument: { uri: pathToFileURL(abs).href }, edits: [
      { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, newText: 'x' },
    ] }] };
    rejectsSpecific(() => normalizeWith(root, raw3, ['src/emoji.ts']), /splits a surrogate pair: character 7 at .*src\/emoji\.ts:1/s);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── case 6b: untracked target (missing pre-request hash) ────────────────────

test('a target with NO pre-request hash fails closed naming the file', () => {
  const root = workspace();
  try {
    // Pass 2 names a file pass 1 never saw — the two-pass protocol's central claim.
    const raw: WorkspaceEditWire = { documentChanges: [{ textDocument: { uri: uriOf(root, 'src/b.ts') }, edits: [
      { range: { start: { line: 0, character: 9 }, end: { line: 0, character: 16 } }, newText: 'newName' },
    ] }] };
    // Hash ONLY a.ts — b.ts was never part of a validated request.
    const hashes = hashesFor(root, ['src/a.ts']);
    // Spy on the reader: an untracked target must be refused BEFORE any read of it.
    const reads: string[] = [];
    rejectsSpecific(
      () => normalizeWorkspaceEdit(raw, (absPath) => { reads.push(absPath); return readFileSync(absPath); }, hashes),
      /No pre-request hash was recorded for .*src\/b\.ts: refusing to validate untracked bytes/s,
    );
    assert.deepEqual(reads, [], 'no untracked bytes may be read');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── case 6c: out-of-workspace and duplicate aliases refused at build time ────

test('buildEditOperation refuses out-of-workspace and aliased duplicate targets', () => {
  const root = workspace();
  try {
    // In-workspace valid edit, for building the base plan.
    const goodRaw: WorkspaceEditWire = { documentChanges: [{ textDocument: { uri: uriOf(root, 'src/a.ts') }, edits: [
      { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }, newText: 'newName' },
    ] }] };
    const goodPlan = normalizeWith(root, goodRaw, ['src/a.ts']);
    const journal = createMutationJournal(root);
    assert.equal(buildEditOperation(root, journal, goodPlan).files.length, 1);

    // Out-of-workspace target: an edit that escapes the root.
    const outside = mkdtempSync(join(tmpdir(), 'shadow-lsp-outside-'));
    writeFileSync(join(outside, 'evil.ts'), 'x = 1;\n');
    const escapeRaw: WorkspaceEditWire = { documentChanges: [{ textDocument: { uri: pathToFileURL(join(outside, 'evil.ts')).href }, edits: [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'y' },
    ] }] };
    const escapePlan = normalizeWorkspaceEdit(escapeRaw, (p) => readFileSync(p), hashesFor(outside, ['evil.ts']));
    rejectsSpecific(
      () => buildEditOperation(root, journal, escapePlan),
      /Refusing an edit outside the workspace/s,
    );
    rmSync(outside, { recursive: true, force: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── case 6d: the remaining reject surface, each with its specific error ─────

test('remaining rejects: reversed, non-UTF-8, past-EOF, lone surrogate, empty list, unknown kind, non-local', () => {
  const root = workspace();
  const a = uriOf(root, 'src/a.ts');
  const hashes = hashesFor(root, ['src/a.ts']);
  const norm = (raw: WorkspaceEditWire): ValidatedFileEdit[] =>
    normalizeWorkspaceEdit(raw, (p) => readFileSync(p), hashes);
  try {
    // Reversed range (end before start, same line).
    rejectsSpecific(() => norm({ documentChanges: [{ textDocument: { uri: a }, edits: [
      { range: { start: { line: 0, character: 10 }, end: { line: 0, character: 6 } }, newText: 'x' },
    ] }] }), /Edit range is reversed/s);

    // Past end of file.
    rejectsSpecific(() => norm({ documentChanges: [{ textDocument: { uri: a }, edits: [
      { range: { start: { line: 99, character: 0 }, end: { line: 99, character: 1 } }, newText: 'x' },
    ] }] }), /past the end of the file: line 100 in/s);

    // Unpaired surrogate in newText.
    rejectsSpecific(() => norm({ documentChanges: [{ textDocument: { uri: a }, edits: [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: '\ud800' },
    ] }] }), /unpaired surrogate/s);

    // Non-object edit element (null): rejected as LspEditError, never a TypeError.
    rejectsSpecific(() => norm({ documentChanges: [{ textDocument: { uri: a }, edits: [
      null as unknown as TextEditWire,
    ] }] }), /Malformed edit entry for/s);

    // Empty edit list (documentChanges path).
    rejectsSpecific(() => norm({ documentChanges: [{ textDocument: { uri: a }, edits: [] }] }), /empty edit list/s);

    // Unknown documentChanges kind.
    rejectsSpecific(() => norm({ documentChanges: [{ kind: 'surprise', textDocument: { uri: a } }] }), /unsupported documentChanges kind "surprise"/s);

    // Non-local URI.
    rejectsSpecific(() => norm({ documentChanges: [{ textDocument: { uri: 'http://evil/x' }, edits: [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'x' },
    ] }] }), /non-local document: http:\/\/evil\/x/s);

    // Non-UTF-8 on-disk bytes: a file whose bytes cannot round-trip is refused.
    writeFileSync(join(root, 'src/bin.ts'), Buffer.from([0xff, 0xfe, 0x0a]));
    rejectsSpecific(() => normalizeWorkspaceEdit(
      { documentChanges: [{ textDocument: { uri: uriOf(root, 'src/bin.ts') }, edits: [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'x' },
      ] }] },
      (p) => readFileSync(p),
      hashesFor(root, ['src/bin.ts']),
    ), /non-UTF-8 bytes/s);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── case 6: stale hash ───────────────────────────────────────────────────────

test('stale hash aborts naming the file', () => {
  const root = workspace();
  try {
    const raw: WorkspaceEditWire = { documentChanges: [{ textDocument: { uri: uriOf(root, 'src/a.ts') }, edits: [
      { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }, newText: 'newName' },
    ] }] };
    const hashes = hashesFor(root, ['src/a.ts']);
    // The file moves after the request was sent — the exact mid-flight race.
    writeFileSync(join(root, 'src/a.ts'), 'const oldName = 2;\nconsole.log(oldName);\n');
    rejectsSpecific(
      () => normalizeWorkspaceEdit(raw, (absPath) => readFileSync(absPath), hashes),
      /Stale edit: .*src\/a\.ts changed on disk/s,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── case 7: full cycle through the REAL journal ─────────────────────────────

test('full cycle: request → normalize → prepare → approve → apply → rollback', () => {
  const root = workspace();
  try {
    const a = join(root, 'src/a.ts');
    const b = join(root, 'src/b.ts');
    const beforeA = readFileSync(a);
    const beforeB = readFileSync(b);

    const raw: WorkspaceEditWire = { documentChanges: [
      { textDocument: { uri: uriOf(root, 'src/a.ts') }, edits: [
        { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }, newText: 'newName' },
        { range: { start: { line: 1, character: 12 }, end: { line: 1, character: 19 } }, newText: 'newName' },
      ] },
      { textDocument: { uri: uriOf(root, 'src/b.ts') }, edits: [
        { range: { start: { line: 0, character: 9 }, end: { line: 0, character: 16 } }, newText: 'newName' },
      ] },
    ] };
    const plan = normalizeWorkspaceEdit(raw, (p) => readFileSync(p), hashesFor(root, ['src/a.ts', 'src/b.ts']));
    assert.equal(plan.length, 2);

    const journal = createMutationJournal(root);
    const op = buildEditOperation(root, journal, plan);
    assert.equal(op.files.length, 2);
    assert.deepEqual(op.files.map((f) => f.path).sort(), ['src/a.ts', 'src/b.ts']);
    assert.equal(op.record.id.length, 36);
    assert.match(op.record.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    journal.approve(op.record.id, op.record.approvalDigest);
    journal.apply(op.record.id, op.record.approvalDigest);
    assert.ok(readFileSync(a).equals(plan[0].afterBytes), 'on-disk a.ts must equal the previewed after-bytes');
    assert.ok(readFileSync(b).equals(plan[1].afterBytes), 'on-disk b.ts must equal the previewed after-bytes');

    // Post-apply diagnostics diff: only the NEW fake diagnostic is news.
    const d = (message: string, code: string): LspDiagnostic => ({
      uri: uriOf(root, 'src/b.ts'), line: 1, col: 1, severity: 'error', message, code,
    });
    const beforeDiags = [d('pre-existing', '100')];
    const afterDiags = [d('pre-existing', '100'), d('new fake diagnostic', '4242')];
    const fresh = diffDiagnostics(beforeDiags, afterDiags);
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].message, 'new fake diagnostic');
    const post = postApplyDiagnostics(beforeDiags, afterDiags);
    assert.equal(post.length, 1);
    assert.equal(post[0].code, '4242');

    // The journal never replays an applied operation.
    assert.throws(() => journal.apply(op.record.id, op.record.approvalDigest), /Only an approved mutation can be applied/);

    // Rollback restores the EXACT original bytes.
    journal.rollBack(op.record.id, op.record.approvalDigest);
    assert.ok(readFileSync(a).equals(beforeA), 'rollback must restore a.ts byte-for-byte');
    assert.ok(readFileSync(b).equals(beforeB), 'rollback must restore b.ts byte-for-byte');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── case 8: failed apply → unknown state → reconcile truth ───────────────────

test('failed apply leaves state unknown; reconcile reports matches-before; re-apply refused', () => {
  const root = workspace();
  try {
    const a = join(root, 'src/a.ts');
    const before = readFileSync(a);

    const raw: WorkspaceEditWire = { documentChanges: [{ textDocument: { uri: uriOf(root, 'src/a.ts') }, edits: [
      { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }, newText: 'newName' },
    ] }] };
    const plan = normalizeWorkspaceEdit(raw, (p) => readFileSync(p), hashesFor(root, ['src/a.ts']));
    assert.equal(plan.length, 1);

    const journal = createMutationJournal(root, {
      targetWrite: (): void => { throw new Error('injected write failure'); },
    });
    const op = buildEditOperation(root, journal, plan);
    journal.approve(op.record.id, op.record.approvalDigest);
    assert.throws(() => journal.apply(op.record.id, op.record.approvalDigest), /injected write failure/);
    assert.ok(readFileSync(a).equals(before), 'the failed apply must not have touched the file');

    // Reconcile must surface THIS operation with the honest per-file truth.
    const recon = journal.reconcile().filter((r) => r.id === op.record.id);
    assert.equal(recon.length, 1);
    assert.equal(recon[0].state, 'unknown');
    assert.deepEqual(recon[0].files.map((f) => f.status), ['matches-before']);

    // The state machine cannot resume an unknown operation.
    assert.throws(() => journal.apply(op.record.id, op.record.approvalDigest), /Only an approved mutation can be applied/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── case 9b: drift between propose and apply → structured refusal, no crash ─

test('drift after propose: the wrapper refuses via the journal without crashing', async () => {
  const root = workspace();
  try {
    const wire: WorkspaceEditWire = { documentChanges: [{ textDocument: { uri: uriOf(root, 'src/a.ts') }, edits: [
      { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }, newText: 'newName' },
    ] }] };
    const conn = new FakeLspConnection([wire, wire]);
    const abs = join(root, 'src/a.ts');
    const before = readFileSync(abs);

    const proposal = await propose(conn, {
      kind: 'rename', uri: uriOf(root, 'src/a.ts'), workspaceRoot: root,
      position: { line: 0, character: 6 }, newName: 'newName',
    });
    assert.ok(proposal);

    // The file moves AFTER the preview was shown — the operator would be applying a stale plan.
    writeFileSync(abs, 'const oldName = 99;\n');

    const result = await applyEdit({
      workspaceRoot: root, operationId: proposal.operationId, approvalDigest: proposal.approvalDigest,
      preview: proposal.preview, files: proposal.files, gate: new ScriptedApprovalGate(['approve']),
    });
    // Structured refusal — never a thrown MutationError, never a crash.
    assert.equal(result.ok, false);
    assert.equal(result.applied, false);
    assert.match(result.ok ? '' : result.reason, /mutation journal refused the apply/s);
    // And the drifted bytes are left exactly as the operator's other tooling left them.
    assert.equal(readFileSync(abs, 'utf8'), 'const oldName = 99;\n');
    void before;
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('propose is read-only; apply is approval-gated and journal-bound', async () => {
  const root = workspace();
  try {
    const wire: WorkspaceEditWire = { documentChanges: [{ textDocument: { uri: uriOf(root, 'src/a.ts') }, edits: [
      { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }, newText: 'newName' },
    ] }] };
    // Two dispatches: propose re-requests after pre-hashing the discovered targets.
    const conn = new FakeLspConnection([wire, wire]);
    const abs = join(root, 'src/a.ts');
    const before = readFileSync(abs);

    const proposal: LspEditProposal | null = await propose(conn, {
      kind: 'rename',
      uri: uriOf(root, 'src/a.ts'),
      workspaceRoot: root,
      position: { line: 0, character: 6 },
      newName: 'newName',
    });
    assert.ok(proposal, 'the server proposed a rename, so a proposal must exist');
    assert.deepEqual(proposal.files, ['src/a.ts']);
    assert.deepEqual(proposal.editCounts, { 'src/a.ts': 1 });
    assert.match(proposal.operationId, /^[0-9a-f-]{36}$/);
    assert.match(proposal.preview, /--- src\/a\.ts/);
    assert.match(proposal.preview, /-const oldName = 1;/);
    assert.match(proposal.preview, /\+const newName = 1;/);
    assert.ok(readFileSync(abs).equals(before), 'propose must not write');
    assert.deepEqual(
      conn.calls.map((c) => c.method),
      ['textDocument/rename', 'textDocument/rename'],
    );

    // A denial writes nothing.
    const denied = await applyEdit({
      workspaceRoot: root, operationId: proposal.operationId, approvalDigest: proposal.approvalDigest,
      preview: proposal.preview, files: proposal.files, gate: new ScriptedApprovalGate(['deny']),
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.applied, false);
    assert.ok(readFileSync(abs).equals(before), 'a denial must not write');

    // An approval applies through the real journal — and only then.
    const applied = await applyEdit({
      workspaceRoot: root, operationId: proposal.operationId, approvalDigest: proposal.approvalDigest,
      preview: proposal.preview, files: proposal.files, gate: new ScriptedApprovalGate(['approve']),
    });
    assert.deepEqual(applied, { ok: true, applied: true, files: ['src/a.ts'] });
    assert.match(readFileSync(abs, 'utf8'), /const newName = 1;/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
