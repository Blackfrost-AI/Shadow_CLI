// LSP-originated edits, the Shadow way (slice m-5).
//
// A language server is an untrusted suggestion engine with a write interface. This module
// makes that interface PREVIEW-ONLY and JOURNAL-BOUND:
//
//   request*  — raw wire calls; nothing here trusts the answer.
//   normalizeWorkspaceEdit — THE single validation path. Every structural promise the server
//     makes is either proven against the exact bytes on disk or rejected with the operation
//     and target named. After-bytes are computed ONLY from on-disk before-bytes — the
//     server's copy of the text is never trusted for content, only for positions.
//   buildEditOperation — hands the validated plan to the REAL mutation journal, which
//     re-reads targets, refuses drift, binds exact bytes, and refuses replay.
//   diffDiagnostics — post-apply diagnostics diffed against pre-apply, so a rename that
//     breaks a new call site is visible instead of silently shipped.
//
// Explicitly out of scope, by design: resource operations (create/rename/delete), command
// execution, and any edit whose UTF-16 positions cannot be proven against on-disk bytes.
// Those are rejected with specific errors — a server that wants them can say so in text.

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { MAX_FILE_BYTES, type LspDiagnostic } from './protocol.js';

/**
 * Every rejection this module itself makes is an LspEditError — callers can tell LSP
 * refusals apart from harness failures. (Journal-layer refusals — drift, replay, size,
 * symlinks — surface as MutationError from src/tools/mutation.ts; those are the journal's
 * own, and are never remapped here.)
 */
export class LspEditError extends Error {}

// ── wire types ────────────────────────────────────────────────────────────────

export interface TextEditWire {
  range: { start: { line: number; character: number }, end: { line: number; character: number } };
  newText: string;
}

export interface WorkspaceEditWire {
  changes?: Record<string, TextEditWire[]>;
  documentChanges?: Array<{
    textDocument?: { uri: string };
    edits?: TextEditWire[];
    kind?: string;
    uri?: string;
    oldUri?: string;
    options?: unknown;
    /** Servers send command-bearing entries; we reject them, so the type must admit them. */
    command?: unknown;
  }>;
  error?: unknown;
}

/** A validated, byte-exact plan for ONE file. `path` is absolute; the journal gets the relative form. */
export interface ValidatedFileEdit {
  path: string;
  beforeBytes: Buffer;
  afterBytes: Buffer;
  editCount: number;
}

export interface LspPositionWire { line: number; character: number }
export interface LspRangeWire { start: LspPositionWire; end: LspPositionWire }

/**
 * The raw-request seam. The production `ServerConnection` (client.ts) today exposes only
 * `navigate()`; until it grows a `request()` passthrough this interface is what tests inject
 * and what editTool adapts. Declaring it here keeps every requester honest about the fact
 * that it is talking to an untrusted server.
 */
export interface LspEditWire {
  request(method: string, params: unknown): Promise<unknown>;
}

function wireOrThrow(connection: LspEditWire): LspEditWire {
  if (!connection || typeof connection.request !== 'function') {
    throw new LspEditError('This LSP connection does not expose raw requests.');
  }
  return connection;
}

// ── raw requesters (nothing below trusts the answer) ─────────────────────────

export async function requestRename(
  connection: LspEditWire, uri: string, position: LspPositionWire, newName: string,
): Promise<unknown> {
  return wireOrThrow(connection).request('textDocument/rename', {
    textDocument: { uri }, position, newName,
  });
}

export async function requestFormatting(
  connection: LspEditWire, uri: string, options: unknown,
): Promise<unknown> {
  return wireOrThrow(connection).request('textDocument/formatting', {
    textDocument: { uri }, options: options ?? {},
  });
}

export async function requestRangeFormatting(
  connection: LspEditWire, uri: string, range: LspRangeWire, options: unknown,
): Promise<unknown> {
  return wireOrThrow(connection).request('textDocument/rangeFormatting', {
    textDocument: { uri }, range, options: options ?? {},
  });
}

/** A code action worth keeping: it carries an `edit` payload and NO command. */
export interface EditsOnlyCodeAction {
  title?: string;
  kind?: string;
  edit: WorkspaceEditWire;
}

export async function requestCodeActions(
  connection: LspEditWire, uri: string, range: LspRangeWire,
): Promise<EditsOnlyCodeAction[]> {
  const raw = await wireOrThrow(connection).request('textDocument/codeAction', {
    textDocument: { uri }, range, context: { diagnostics: [] },
  });
  if (!Array.isArray(raw)) return [];
  const kept: EditsOnlyCodeAction[] = [];
  for (const action of raw) {
    if (!action || typeof action !== 'object') continue;
    const a = action as { title?: unknown; kind?: unknown; edit?: unknown; command?: unknown };
    // A command-bearing action is a request to EXECUTE something — never ours to run.
    if (a.command !== undefined) continue;
    if (a.edit === null || typeof a.edit !== 'object') continue;
    kept.push({
      ...(typeof a.title === 'string' ? { title: a.title } : {}),
      ...(typeof a.kind === 'string' ? { kind: a.kind } : {}),
      edit: a.edit as WorkspaceEditWire,
    });
  }
  return kept;
}

// ── merge (one operation, one approval) ─────────────────────────────
export function mergeWorkspaceEdits(list: Array<WorkspaceEditWire | null | undefined>): WorkspaceEditWire {
  const documentChanges: NonNullable<WorkspaceEditWire['documentChanges']> = [];
  for (const raw of list) {
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== 'object') throw new LspEditError('Workspace edit must be an object.');
    if (raw.error !== undefined) {
      throw new LspEditError(`The language server reported an error instead of an edit: ${JSON.stringify(raw.error)}`);
    }
    if (Array.isArray(raw.documentChanges)) documentChanges.push(...raw.documentChanges);
    if (raw.changes !== undefined) {
      if (typeof raw.changes !== 'object') throw new LspEditError('Malformed changes map in workspace edit.');
      for (const [uri, edits] of Object.entries(raw.changes)) {
        documentChanges.push({ textDocument: { uri }, edits: edits as TextEditWire[] });
      }
    }
  }
  return { documentChanges };
}

// ── pre-request hashing ──────────────────────────────────────────────────────

/** SHA-256 of the exact bytes — the staleness token compared after the server answers. */
export function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The hash map that MUST be taken BEFORE any edit request is sent: it is what makes a late
 * server answer provably stale when the file moved underneath it. Fails closed naming
 * the file — a target that cannot be read cannot be proven unchanged, so it is refused.
 */
export function preRequestFileHashes(
  readFile: (absPath: string) => Buffer, absPaths: string[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const absPath of absPaths) {
    let bytes: Buffer;
    try {
      bytes = readFile(absPath);
    } catch (error) {
      throw new LspEditError(`Cannot hash the edit target ${absPath}: ${(error as Error).message}`);
    }
    if (!Buffer.isBuffer(bytes)) throw new LspEditError(`Cannot hash the edit target ${absPath}`);
    out.set(absPath, sha256Of(bytes));
  }
  return out;
}

/** Absolute paths named by a wire payload — the pre-hash candidate set. Unparseable URIs are skipped; normalizeWorkspaceEdit gives those their precise rejection later. */
export function targetsOfWire(raw: WorkspaceEditWire | null | undefined): string[] {
  const out = new Set<string>();
  const add = (uri: string): void => {
    try { out.add(fileURLToPath(uri)); } catch { /* non-local — normalize rejects it by name */ }
  };
  if (!raw || typeof raw !== 'object') return [...out];
  if (Array.isArray(raw.documentChanges)) {
    for (const entry of raw.documentChanges) {
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.textDocument?.uri === 'string') add(entry.textDocument.uri);
      if (typeof entry.uri === 'string') add(entry.uri);
      if (typeof entry.oldUri === 'string') add(entry.oldUri);
    }
  }
  if (raw.changes && typeof raw.changes === 'object' && !Array.isArray(raw.changes)) {
    for (const uri of Object.keys(raw.changes)) {
      if (typeof uri === 'string') add(uri);
    }
  }
  return [...out];
}

// ── line index and UTF-16 → byte-offset decoding ─────────────────────────────

/** Line start offsets and content-end offsets (terminators \r\n, \n, and lone \r excluded). */
interface LineIndex { starts: number[]; ends: number[] }

function computeLineIndex(bytes: Buffer): LineIndex {
  const starts: number[] = [0];
  const ends: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x0a) {
      ends.push(i > 0 && bytes[i - 1] === 0x0d ? i - 1 : i);
      starts.push(i + 1);
    } else if (b === 0x0d && bytes[i + 1] !== 0x0a) {
      ends.push(i);
      starts.push(i + 1);
    }
  }
  ends.push(bytes.length);
  return { starts, ends };
}

/**
 * Decode one UTF-16 `character` offset within a line into an absolute byte offset.
 *
 * LSP positions count UTF-16 CODE UNITS, not code points and not bytes: '🚀' is TWO units
 * (a surrogate pair) and FOUR bytes. The walk below is the only arithmetic in this module
 * that touches encoding, and it fails closed on the two ways it can lie: an offset past
 * the end of the line, and an offset that lands INSIDE a surrogate pair.
 */
function utf16ToByteOffset(lineText: string, character: number, lineStart: number, path: string, line: number): number {
  if (!Number.isInteger(character) || character < 0) {
    throw new LspEditError(`Invalid character offset ${character} at ${path}:${line + 1}`);
  }
  let acc16 = 0;
  let accBytes = 0;
  for (const codePoint of lineText) {
    const units = codePoint.length; // 1, or 2 for a surrogate pair
    if (acc16 + units > character) {
      if (acc16 === character) return lineStart + accBytes;
      throw new LspEditError(
        `Edit position splits a surrogate pair: character ${character} at ${path}:${line + 1}`,
      );
    }
    acc16 += units;
    accBytes += Buffer.byteLength(codePoint, 'utf8');
  }
  if (character === acc16) return lineStart + accBytes; // includes end-of-line and empty-line positions
  throw new LspEditError(`Edit position is past the end of ${path}:${line + 1} (character ${character} > ${acc16})`);
}

interface DecodedSpan { startByte: number; endByte: number; insert: Buffer }

function decodeSpan(edit: TextEditWire, path: string, index: LineIndex, bytes: Buffer): DecodedSpan {
  if (!edit || typeof edit !== 'object') {
    throw new LspEditError(`Malformed edit entry for ${path}: edits must be objects.`);
  }
  const { range, newText } = edit;
  if (!range || typeof range !== 'object') throw new LspEditError(`Edit without a range for ${path}`);
  const { start, end } = range;
  for (const p of [start, end]) {
    if (!p || typeof p.line !== 'number' || typeof p.character !== 'number'
      || !Number.isInteger(p.line) || !Number.isInteger(p.character) || p.line < 0 || p.character < 0) {
      throw new LspEditError(`Edit with an invalid position for ${path}`);
    }
  }
  if (typeof newText !== 'string') throw new LspEditError(`Edit with non-string newText for ${path}`);
  assertNoLoneSurrogate(newText, path);
  if (start.line >= index.starts.length) {
    throw new LspEditError(`Edit position is past the end of the file: line ${start.line + 1} in ${path}`);
  }
  if (end.line >= index.starts.length) {
    throw new LspEditError(`Edit range ends past the end of the file: line ${end.line + 1} in ${path}`);
  }
  const lineOf = (pos: LspPositionWire): number => {
    const from = index.starts[pos.line]!;
    const to = index.ends[pos.line]!;
    const text = from >= to ? '' : bytes.subarray(from, to).toString('utf8');
    return utf16ToByteOffset(text, pos.character, from, path, pos.line);
  };
  const startByte = lineOf(start);
  const endByte = lineOf(end);
  if (endByte < startByte) {
    throw new LspEditError(`Edit range is reversed for ${path} (line ${start.line + 1} → line ${end.line + 1})`);
  }
  return { startByte, endByte, insert: Buffer.from(newText, 'utf8') };
}

/** A server string can carry an unpaired surrogate; those bytes cannot round-trip, so refuse before splicing. */
function assertNoLoneSurrogate(text: string, path: string): void {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new LspEditError(`newText contains an unpaired surrogate for ${path}: it cannot be written as UTF-8`);
      }
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new LspEditError(`newText contains an unpaired surrogate for ${path}: it cannot be written as UTF-8`);
    }
  }
}

// ── THE single validation path ───────────────────────────────────────────────

function absPathOfUri(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    throw new LspEditError(`LSP edit targets a non-local document: ${uri}`);
  }
}

function describeTarget(entry: NonNullable<WorkspaceEditWire['documentChanges']>[number]): string {
  return entry.textDocument?.uri ?? entry.uri ?? '(no document)';
}

/**
 * Validate a raw workspace edit into a byte-exact, per-file plan — or throw with the
 * operation and target named. Order matters and is cheapest-first:
 *   structural rejects (resource ops, commands, empty lists) → staleness (pre-request hash)
 *   → UTF-8 representability → position decoding → overlap → splice.
 */
export function normalizeWorkspaceEdit(
  raw: WorkspaceEditWire | null | undefined,
  readFileSync: (absPath: string) => Buffer,
  preRequestHashes: Map<string, string>,
): ValidatedFileEdit[] {
  if (raw === null || raw === undefined) return []; // a server that declines proposes nothing
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LspEditError('Workspace edit must be an object.');
  }
  if (raw.error !== undefined) {
    throw new LspEditError(`The language server reported an error instead of an edit: ${JSON.stringify(raw.error)}`);
  }

  const perFile = new Map<string, TextEditWire[]>();
  const collect = (uri: string, edits: TextEditWire[]): void => {
    const absPath = absPathOfUri(uri);
    const existing = perFile.get(absPath);
    if (existing) existing.push(...edits);
    else perFile.set(absPath, [...edits]);
  };

  if (raw.documentChanges !== undefined) {
    if (!Array.isArray(raw.documentChanges)) {
      throw new LspEditError('Malformed documentChanges in workspace edit.');
    }
    for (const entry of raw.documentChanges) {
      if (!entry || typeof entry !== 'object') {
        throw new LspEditError('Malformed documentChanges entry in workspace edit.');
      }
      const target = describeTarget(entry);
      if (entry.kind === 'create' || entry.kind === 'rename' || entry.kind === 'delete') {
        const detail = entry.kind === 'rename' ? `${entry.oldUri ?? '?'} → ${entry.uri ?? '?'}` : target;
        throw new LspEditError(
          `Refusing ${entry.kind} of ${detail}: only in-place text edits are supported, never resource operations.`,
        );
      }
      if (entry.kind !== undefined) {
        throw new LspEditError(`Refusing unsupported documentChanges kind "${entry.kind}" for ${target}.`);
      }
      if (entry.command !== undefined) {
        throw new LspEditError(`Refusing command-bearing change for ${target}: commands are never executed.`);
      }
      if (typeof target !== 'string' || target === '' || target === '(no document)') {
        throw new LspEditError('Edit entry without a document uri.');
      }
      if (!Array.isArray(entry.edits) || entry.edits.length === 0) {
        throw new LspEditError(`Refusing an empty edit list for ${target}.`);
      }
      collect(target, entry.edits);
    }
  }

  if (raw.changes !== undefined) {
    if (typeof raw.changes !== 'object' || Array.isArray(raw.changes)) {
      throw new LspEditError('Malformed changes map in workspace edit.');
    }
    for (const [uri, edits] of Object.entries(raw.changes)) {
      if (!Array.isArray(edits) || edits.length === 0) {
        throw new LspEditError(`Refusing an empty edit list for ${uri}.`);
      }
      collect(uri, edits);
    }
  }

  const out: ValidatedFileEdit[] = [];
  for (const [absPath, edits] of perFile) {
    // Untracked targets are refused BEFORE any disk read: a target with no pre-request
    // hash was never part of a validated request, and reading it would be a side effect
    // of an untrusted answer.
    const expectedHash = preRequestHashes.get(absPath);
    if (expectedHash === undefined) {
      throw new LspEditError(`No pre-request hash was recorded for ${absPath}: refusing to validate untracked bytes.`);
    }
    let beforeBytes: Buffer;
    try {
      beforeBytes = readFileSync(absPath);
    } catch (error) {
      throw new LspEditError(`Cannot read the edit target ${absPath}: ${(error as Error).message}`);
    }
    if (!Buffer.isBuffer(beforeBytes)) {
      throw new LspEditError(`Could not read the target bytes: ${absPath}`);
    }
    if (beforeBytes.length > MAX_FILE_BYTES) {
      throw new LspEditError(`Refusing an edit to a file above the size cap: ${absPath}`);
    }

    // Staleness: the answer must still describe the file we asked about.
    if (sha256Of(beforeBytes) !== expectedHash) {
      throw new LspEditError(
        `Stale edit: ${absPath} changed on disk since the request was sent — the plan no longer describes this file.`,
      );
    }

    // Representability: the journal binds bytes through a UTF-8 text view, so a file whose
    // bytes do not round-trip can never be honestly previewed or restored. Refuse it.
    if (!Buffer.from(beforeBytes.toString('utf8'), 'utf8').equals(beforeBytes)) {
      throw new LspEditError(`Refusing an edit to non-UTF-8 bytes: ${absPath}`);
    }

    const index = computeLineIndex(beforeBytes);
    const spans = edits.map((edit) => decodeSpan(edit, absPath, index, beforeBytes));
    spans.sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte);
    for (let i = 1; i < spans.length; i++) {
      if (spans[i].startByte < spans[i - 1].endByte) {
        throw new LspEditError(`Overlapping edits in ${absPath}: edit ${i} starts inside edit ${i - 1}.`);
      }
    }

    const parts: Buffer[] = [];
    let cursor = 0;
    for (const span of spans) {
      parts.push(beforeBytes.subarray(cursor, span.startByte), span.insert);
      cursor = span.endByte;
    }
    parts.push(beforeBytes.subarray(cursor));
    const afterBytes = Buffer.concat(parts);
    if (!Buffer.from(afterBytes.toString('utf8'), 'utf8').equals(afterBytes)) {
      throw new LspEditError(`The spliced result for ${absPath} is not representable as UTF-8.`);
    }
    if (afterBytes.equals(beforeBytes)) continue; // a no-op file is dropped, never prepared
    out.push({ path: absPath, beforeBytes, afterBytes, editCount: edits.length });
  }
  return out;
}

// ── journal binding ──────────────────────────────────────────────────────────

/** The journal's prepared operation plus the relative paths it was bound under. */
export interface EditOperationPlan {
  record: {
    version: 2;
    id: string;
    state: string;
    approvalDigest: string;
    createdAt: string;
    files: Array<{ path: string; beforeB64: string | null; afterB64: string }>;
  };
  /** Workspace-relative paths, in journal order — what the preview and edit counts are keyed by. */
  files: Array<{ path: string; editCount: number }>;
}

/**
 * Hand a validated plan to the REAL mutation journal. The journal takes workspace-RELATIVE
 * paths (it re-resolves and revalidates every one), so the absolute validated paths are
 * converted here — and an escape from the workspace or an aliasing duplicate is refused
 * before the journal ever sees it, so its own errors remain the last line of defense
 * rather than the first.
 */
export function buildEditOperation(
  workspaceRoot: string,
  journal: {
    prepare(files: Array<{ path: string; before: string | null; after: string }>): unknown;
  },
  edits: ValidatedFileEdit[],
): EditOperationPlan {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new LspEditError('No validated edits to prepare.');
  }
  const root = realpathSync(resolve(workspaceRoot)); // canonical, like the journal's own root
  const relPaths = edits.map((edit) => {
    // Canonicalize BOTH sides: on macOS a temp workspace under /var/folders arrives here
    // via a symlinked path, and relative() across a symlink boundary yields an escape that
    // is pure aliasing, not a real one. The journal realpaths its root and every target too.
    const real = realpathSync(resolve(edit.path));
    const rel = relative(root, real);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new LspEditError(`Refusing an edit outside the workspace: ${edit.path}`);
    }
    return rel;
  });
  if (new Set(relPaths).size !== relPaths.length) {
    throw new LspEditError('Refusing aliased duplicate targets: two edits resolve to the same file.');
  }
  const stored = edits.map((edit, i) => ({
    path: relPaths[i],
    // Text views that provably round-trip (normalizeWorkspaceEdit checked) — the journal
    // re-reads, refuses drift, and binds the RAW bytes base64 for both preview and rollback.
    before: edit.beforeBytes.toString('utf8'),
    after: edit.afterBytes.toString('utf8'),
  }));
  const record = journal.prepare(stored) as EditOperationPlan['record'];
  const files = edits.map((edit, i) => ({ path: relPaths[i], editCount: edit.editCount }));
  return { record, files };
}

// ── post-apply diagnostics diff ──────────────────────────────────────────────

/**
 * Only NEW or CHANGED diagnostics, by the full identity tuple (path, severity, code,
 * range, message). A diagnostic that merely persists is not news; a diagnostic that
 * appeared or changed because of the edit is exactly what the operator must see.
 */
export function diffDiagnostics(before: LspDiagnostic[], after: LspDiagnostic[]): LspDiagnostic[] {
  const keyOf = (d: LspDiagnostic): string =>
    JSON.stringify([d.uri, d.line, d.col, d.severity, d.code ?? '', d.message]);
  const beforeKeys = new Set(before.map(keyOf));
  return after.filter((d) => !beforeKeys.has(keyOf(d)));
}
