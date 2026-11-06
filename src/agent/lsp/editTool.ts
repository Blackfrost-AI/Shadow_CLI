// m-5 tool surface for LSP edits: PREVIEW, then APPROVE, then the REAL journal apply.
//
// Mirrors the discipline of the file tools: nothing here writes. `propose` is read-only —
// it asks the server, validates against on-disk bytes, prepares the journal operation (a
// durable, byte-bound record), and renders the exact preview the operator must approve.
// `apply` is the ONLY write path: it routes the operator's decision through the same
// ApprovalGate seam every other write uses (approval.ts), and only `journal.apply` —
// which re-reads targets, refuses drift, and refuses replay — ever touches disk.
//
// Loop wiring status (TODO, deliberately not done here): the production ServerConnection
// (client.ts) exposes no raw `request()` yet, and the loop has no `lsp_edit_apply` tool
// definition. Wiring both, plus the tool-schema exposure and loop fold-in, exceeds the
// ~30-line budget this slice was given — see the mission report.

import { nextApprovalId, settleWithAbort, type ApprovalGate } from '../approval.js';
import { diffLines } from '../../util/diff.js';
import { createMutationJournal, type MutationJournalOptions, type MutationRecord } from '../../tools/mutation.js';
import { readFileSync as fsReadFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
import {
  LspEditError,
  buildEditOperation,
  diffDiagnostics,
  mergeWorkspaceEdits,
  normalizeWorkspaceEdit,
  preRequestFileHashes,
  requestCodeActions,
  requestFormatting,
  requestRangeFormatting,
  requestRename,
  targetsOfWire,
  type LspEditWire,
  type LspPositionWire,
  type LspRangeWire,
  type TextEditWire,
  type ValidatedFileEdit,
  type WorkspaceEditWire,
} from './editActions.js';
import type { LspDiagnostic } from './protocol.js';

export {
  requestRename, requestFormatting, requestRangeFormatting, requestCodeActions,
  normalizeWorkspaceEdit, buildEditOperation, diffDiagnostics, mergeWorkspaceEdits,
  preRequestFileHashes, targetsOfWire, LspEditError,
  type TextEditWire, type WorkspaceEditWire, type ValidatedFileEdit, type LspEditWire,
} from './editActions.js';

/** What the operator is shown and asked to approve. Read-only — no bytes move. */
export interface LspEditProposal {
  operationId: string;
  approvalDigest: string;
  /** Workspace-relative path → number of validated edits. */
  editCounts: Record<string, number>;
  /** Per-file unified-style preview (--- path, then +/- lines), capped like every other preview. */
  preview: string;
  /** Workspace-relative paths, in journal order. */
  files: string[];
}

export type LspEditKind = 'rename' | 'formatting' | 'rangeFormatting' | 'codeAction';

export interface LspEditRequest {
  kind: LspEditKind;
  uri: string;
  workspaceRoot: string;
  /** rename */
  position?: LspPositionWire;
  newName?: string;
  /** rangeFormatting / codeAction */
  range?: LspRangeWire;
  /** formatting / rangeFormatting */
  options?: unknown;
  /** Test seam for the on-disk reader. Defaults to the real fs. */
  readFileSync?: (absPath: string) => Buffer;
  /** Test seam for the journal (failure injection). */
  journalOptions?: MutationJournalOptions;
}

const PREVIEW_MAX_LINES = 400;

/**
 * Read-only: ask the server, validate against on-disk bytes, and prepare the journal
 * operation — then render the preview. Returns null when the server proposes nothing
 * (a declined rename is not an error).
 *
 * Two-pass, and the second request is the point: a rename's answer names files the caller
 * never knew about, and the staleness contract requires their hashes to have been taken
 * BEFORE the request that is validated. So pass 1 is discovery (learn the target set),
 * the targets are hashed, and pass 2's answer is validated against those hashes. If pass 2
 * names a file pass 1 did not, validation fails closed on the missing hash — no third pass,
 * no loop; the operator re-proposes.
 */
export function propose(
  connection: LspEditWire,
  request: LspEditRequest,
): Promise<LspEditProposal | null> {
  return proposeRaw(connection, request, []);
}

/**
 * propose() with extra wire payloads already collected (e.g. several edits-only code
 * actions chosen by the operator from a menu). Everything still goes through the SAME
 * validation path, as ONE operation and ONE approval.
 */
export async function proposeRaw(
  connection: LspEditWire,
  request: LspEditRequest,
  extraWire: Array<WorkspaceEditWire | null | undefined>,
): Promise<LspEditProposal | null> {
  const readFileSync = request.readFileSync
    ?? ((absPath: string): Buffer => fsReadFileSync(absPath));
  const absPath = uriToPath(request.uri);

  const dispatch = async (): Promise<WorkspaceEditWire | null> => {
    if (request.kind === 'rename') {
      if (!request.position || typeof request.newName !== 'string') {
        throw new LspEditError('A rename requires a position and a new name.');
      }
      return await requestRename(connection, request.uri, request.position, request.newName) as WorkspaceEditWire | null;
    }
    if (request.kind === 'formatting') {
      return singleFileOf(await requestFormatting(connection, request.uri, request.options), request.uri);
    }
    if (request.kind === 'rangeFormatting') {
      if (!request.range) throw new LspEditError('Range formatting requires a range.');
      return singleFileOf(await requestRangeFormatting(connection, request.uri, request.range, request.options), request.uri);
    }
    if (!request.range) throw new LspEditError('A code action request requires a range.');
    return mergeWorkspaceEdits(
      (await requestCodeActions(connection, request.uri, request.range)).map((a) => a.edit),
    );
  };

  const first = await dispatch();
  const targets = new Set<string>([absPath]);
  for (const wire of [first, ...extraWire]) {
    for (const target of targetsOfWire(wire)) targets.add(target);
  }
  // Hash only targets that actually exist inside this workspace. A resource operation
  // naming a file that does not exist (a `create` proposal) must keep its precise
  // "Refusing create of …" rejection from normalizeWorkspaceEdit — a generic "cannot
  // hash" would bury it.
  const realRoot = realpathSync(resolve(request.workspaceRoot));
  const hashable = [...targets].filter((t) => {
    try {
      const real = realpathSync(t);
      return real === realRoot || real.startsWith(`${realRoot}${sep}`);
    } catch {
      return false;
    }
  });
  const preRequestHashes = preRequestFileHashes(readFileSync, hashable);

  const second = await dispatch();
  const merged = mergeWorkspaceEdits([second, ...extraWire]);
  const validated = normalizeWorkspaceEdit(merged, readFileSync, preRequestHashes);
  if (validated.length === 0) return null;

  const journal = createMutationJournal(request.workspaceRoot, request.journalOptions ?? {});
  const plan = buildEditOperation(request.workspaceRoot, journal, validated);
  return {
    operationId: plan.record.id,
    approvalDigest: plan.record.approvalDigest,
    editCounts: Object.fromEntries(plan.files.map((f) => [f.path, f.editCount])),
    files: plan.files.map((f) => f.path),
    preview: renderPreview(plan.files.map((f) => f.path), validated),
  };
}

function singleFileOf(raw: unknown, uri: string): WorkspaceEditWire | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) {
    throw new LspEditError(`Formatting returned a non-edit payload for ${uri}`);
  }
  return { documentChanges: [{ textDocument: { uri }, edits: raw as TextEditWire[] }] };
}

function uriToPath(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    throw new LspEditError(`LSP edit targets a non-local document: ${uri}`);
  }
}

/** Render the preview for a prepared plan. Overload forms: validated edits (propose
 * time) and a journal record (apply time) — the SAME rendering both times, so the apply-time
 * binding compares like with like. */
function renderPreview(relPaths: string[], validated: ValidatedFileEdit[]): string;
function renderPreview(record: MutationRecord): string;
function renderPreview(relPathsOrRecord: string[] | MutationRecord, validated?: ValidatedFileEdit[]): string {
  // Zip by index, never by path resolution: `relPaths` are journal-relative and resolving
  const chunks: string[] = [];
  if (Array.isArray(relPathsOrRecord)) {
    // Zip by index, never by path resolution: `relPaths` are journal-relative and resolving
    // them against anything but their own workspace root would be a path-lookup bug.
    relPathsOrRecord.forEach((rel, i) => {
      const edit = validated?.[i];
      if (!edit) return;
      pushFilePreview(chunks, rel, edit.beforeBytes.toString('utf8'), edit.afterBytes.toString('utf8'));
    });
  } else {
    for (const file of relPathsOrRecord.files) {
      const before = file.beforeB64 === null ? '' : Buffer.from(file.beforeB64, 'base64').toString('utf8');
      const after = Buffer.from(file.afterB64, 'base64').toString('utf8');
      pushFilePreview(chunks, file.path, before, after);
    }
  }
  return chunks.join('\n');
}

function pushFilePreview(chunks: string[], rel: string, before: string, after: string): void {
  const lines = diffLines(before, after, { context: 3, maxLines: PREVIEW_MAX_LINES });
  if (lines.length === 0) return;
  chunks.push(`--- ${rel}`, ...lines.map((l) => `${l.tag}${l.text}`));
}

export interface LspEditApplyOptions {
  workspaceRoot: string;
  operationId: string;
  approvalDigest: string;
  /** What the operator is shown in the approval dialog (the proposal's preview). */
  preview: string;
  files: string[];
  gate: ApprovalGate;
  signal?: AbortSignal;
  /** Test seam for the journal (failure injection). */
  journalOptions?: MutationJournalOptions;
}

export type LspEditApplyResult =
  | { ok: true; applied: true; files: string[] }
  | { ok: false; applied: false; reason: string; denied?: true };

/**
 * The ONLY write path: route the operator's decision through the same approval seam every
 * other write uses, then let the REAL journal apply — it re-reads targets, refuses drift,
 * and refuses replay. A denial (or an interrupt) writes nothing.
 */
export async function apply(opts: LspEditApplyOptions): Promise<LspEditApplyResult> {
  // Bind the shown preview to the record BEFORE asking the operator: the caller supplies
  // id, digest, and preview as one tuple, and a mismatch here means the operator would be
  // shown one thing while another operation applies. Re-render from the record's stored
  // bytes — the same bytes the journal is about to enforce — and refuse anything else.
  const journal = createMutationJournal(opts.workspaceRoot, opts.journalOptions ?? {});
  let record: MutationRecord | null = null;
  try {
    record = journal.get(opts.operationId);
  } catch {
    return { ok: false, applied: false, reason: `No journal operation with id ${opts.operationId}.` };
  }
  if (!record) {
    return { ok: false, applied: false, reason: `No journal operation with id ${opts.operationId}.` };
  }
  if (record.approvalDigest !== opts.approvalDigest) {
    return { ok: false, applied: false, reason: 'The approval digest does not match the prepared operation.' };
  }
  const recordFiles = record.files.map((f) => f.path);
  if (JSON.stringify(recordFiles) !== JSON.stringify(opts.files)) {
    return { ok: false, applied: false, reason: 'The file list does not match the prepared operation.' };
  }
  if (renderPreview(record) !== opts.preview) {
    return { ok: false, applied: false, reason: 'The preview does not match the prepared operation — refusing to apply a different change than shown.' };
  }

  const requestId = nextApprovalId();
  const decision = await settleWithAbort(opts.gate.request({
    id: requestId,
    kind: 'permission' as const,
    call: {
      id: requestId,
      name: 'lsp_edit_apply',
      input: { operationId: opts.operationId, files: opts.files },
    },
    risk: 'write' as const,
    reason: 'Apply the previewed language-server edits through the mutation journal.',
    preview: opts.preview,
    signal: opts.signal,
  }), opts.signal);
  if (decision !== 'approve') {
    // Deliberately literal: session/prefix grants (approveForSession/approveForPrefix
    // objects) are treated as DENIALS here — an LSP edit must be re-previewed and
    // re-approved each time, never auto-applied under a standing grant. The eventual loop
    // wiring must reconcile this with the loop's grant model rather than weaken it.
    return { ok: false, applied: false, denied: true, reason: 'The operator did not approve the edit.' };
  }
  try {
    journal.approve(opts.operationId, opts.approvalDigest);
    journal.apply(opts.operationId, opts.approvalDigest);
  } catch (error) {
    // Journal refusals (drift, replay, lock contention, symlink targets) fail closed here as
    // a structured refusal — the surface never crashes on the journal saying no.
    return { ok: false, applied: false, reason: `The mutation journal refused the apply: ${(error as Error).message}` };
  }
  return { ok: true, applied: true, files: recordFiles };
}

/**
 * Post-apply diagnostics diff: only NEW or CHANGED diagnostics, by the full identity tuple.
 * The loop's existing collect() supplies the before/after batches.
 */
export function postApplyDiagnostics(before: LspDiagnostic[], after: LspDiagnostic[]): LspDiagnostic[] {
  return diffDiagnostics(before, after);
}

