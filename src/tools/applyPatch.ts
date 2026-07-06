/**
 * `apply_patch` — the Codex/Grok edit grammar, as a first-class Shadow tool.
 *
 * Codex and Grok models are trained to edit files by emitting a single patch envelope
 * (`*** Begin Patch` … `*** End Patch`) rather than str_replace-style edits. Without a
 * landing spot, such a patch is either rejected as an unknown tool or silently committed
 * as prose with no file written. This tool parses that grammar and applies it
 * ALL-OR-NOTHING: every file op is planned and validated first; if any hunk fails to
 * locate, nothing is written.
 *
 * Grammar (carved from the 0.141.0 Codex / 0.2.59 Grok binaries):
 *   *** Begin Patch
 *   *** Add File: <path>          { +line }
 *   *** Delete File: <path>
 *   *** Update File: <path>       [ *** Move to: <newpath> ] { @@ [ctx] { " "|"+"|"-" line } }
 *   *** End Patch
 */
import { readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Tool, ToolResult } from './types.js';
import { ok, fail } from './types.js';
import { resolveWithin } from '../safety/workspaceJail.js';
import { atomicWrite } from './util.js';
import { diffLines, type DiffLine } from '../util/diff.js';

// ── grammar markers ──────────────────────────────────────────────────────────
const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const ADD = '*** Add File: ';
const DELETE = '*** Delete File: ';
const UPDATE = '*** Update File: ';
const MOVE = '*** Move to: ';
const EOF_MARKER = '*** End of File';

// ── parsed shapes ─────────────────────────────────────────────────────────────
export type HunkLine = { type: 'context' | 'add' | 'remove'; text: string };
export interface Hunk {
  header?: string;
  lines: HunkLine[];
}
export type PatchOp =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo?: string; hunks: Hunk[] };

export type ParseResult = { ok: true; ops: PatchOp[] } | { ok: false; error: string };

const isMarker = (l: string): boolean =>
  l.startsWith(ADD) || l.startsWith(DELETE) || l.startsWith(UPDATE) || l === END || l.startsWith(BEGIN);

/** Parse patch text into file operations. Pure. */
export function parsePatch(text: string): ParseResult {
  const all = text.replace(/\r\n/g, '\n').split('\n');
  // Find the Begin marker; ignore any leading prose/fence.
  let i = all.findIndex((l) => l.trimEnd() === BEGIN || l.startsWith(BEGIN));
  if (i === -1) return { ok: false, error: `patch must start with '${BEGIN}'` };
  i += 1;

  const ops: PatchOp[] = [];
  while (i < all.length) {
    const line = all[i]!;
    if (line.trimEnd() === END || line.startsWith(END)) return { ok: true, ops };
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    if (line.startsWith(ADD)) {
      const path = line.slice(ADD.length).trim();
      i += 1;
      const lines: string[] = [];
      while (i < all.length && !isMarker(all[i]!)) {
        const l = all[i]!;
        lines.push(l.startsWith('+') ? l.slice(1) : l); // lenient: strip + if present
        i += 1;
      }
      ops.push({ kind: 'add', path, lines });
      continue;
    }

    if (line.startsWith(DELETE)) {
      ops.push({ kind: 'delete', path: line.slice(DELETE.length).trim() });
      i += 1;
      continue;
    }

    if (line.startsWith(UPDATE)) {
      const path = line.slice(UPDATE.length).trim();
      i += 1;
      let moveTo: string | undefined;
      if (i < all.length && all[i]!.startsWith(MOVE)) {
        moveTo = all[i]!.slice(MOVE.length).trim();
        i += 1;
      }
      const hunks: Hunk[] = [];
      let cur: Hunk | undefined;
      while (i < all.length && !isMarker(all[i]!)) {
        const l = all[i]!;
        if (l.startsWith('@@')) {
          cur = { header: l.slice(2).trim() || undefined, lines: [] };
          hunks.push(cur);
        } else if (l === EOF_MARKER) {
          // end-of-file hint — no content
        } else {
          if (!cur) {
            cur = { lines: [] };
            hunks.push(cur);
          }
          if (l.startsWith('+')) cur.lines.push({ type: 'add', text: l.slice(1) });
          else if (l.startsWith('-')) cur.lines.push({ type: 'remove', text: l.slice(1) });
          else if (l.startsWith(' ')) cur.lines.push({ type: 'context', text: l.slice(1) });
          else cur.lines.push({ type: 'context', text: l }); // lenient: blank/unprefixed → context
        }
        i += 1;
      }
      if (hunks.length === 0) return { ok: false, error: `Update File "${path}" has no hunks` };
      ops.push({ kind: 'update', path, moveTo, hunks });
      continue;
    }

    return { ok: false, error: `unexpected line in patch: ${JSON.stringify(line.slice(0, 80))}` };
  }
  return { ok: false, error: `patch must end with '${END}'` };
}

// ── hunk application (fuzzy context matching ≈ Codex seek_sequence) ────────────
type EqFn = (a: string, b: string) => boolean;
const EQ: EqFn[] = [
  (a, b) => a === b,
  (a, b) => a.replace(/\s+$/, '') === b.replace(/\s+$/, ''), // trailing-ws tolerant
  (a, b) => a.trim() === b.trim(), // full-trim tolerant
];

function matchAt(hay: string[], needle: string[], at: number, eq: EqFn): boolean {
  for (let k = 0; k < needle.length; k++) if (!eq(hay[at + k]!, needle[k]!)) return false;
  return true;
}

/** Find `needle` as a contiguous run in `hay` at/after `start`, exact then whitespace-fuzzy. -1 if none. */
export function seekSequence(hay: string[], needle: string[], start: number): number {
  if (needle.length === 0) return start;
  for (const eq of EQ) {
    for (let i = Math.max(0, start); i + needle.length <= hay.length; i++) {
      if (matchAt(hay, needle, i, eq)) return i;
    }
  }
  return -1;
}

export type ApplyResult = { ok: true; content: string } | { ok: false; error: string };

/** Apply a file's hunks to its content. Pure — no fs. */
export function applyHunks(content: string, hunks: Hunk[]): ApplyResult {
  // Preserve the file's line-ending style: work in LF internally (so context lines and patch-supplied
  // added lines are compared/stored uniformly), then rejoin with the detected EOL. Without this a CRLF
  // file ends up with CRLF context lines and LF added/edited lines (mixed endings).
  const crlf = /\r\n/.test(content);
  const eol = crlf ? '\r\n' : '\n';
  const endsNl = /\r?\n$/.test(content);
  const norm = content.replace(/\r\n/g, '\n');
  const lines = norm === '' ? [] : (endsNl ? norm.slice(0, -1) : norm).split('\n');
  let cursor = 0;

  for (const hunk of hunks) {
    const oldLines = hunk.lines.filter((l) => l.type !== 'add').map((l) => l.text);

    if (oldLines.length === 0) {
      // Pure insertion: after the header's context line if we can find it, else append.
      const adds = hunk.lines.map((l) => l.text);
      let at = lines.length;
      if (hunk.header) {
        const h = seekSequence(lines, [hunk.header], cursor);
        if (h !== -1) at = h + 1;
      }
      lines.splice(at, 0, ...adds);
      cursor = at + adds.length;
      continue;
    }

    const at = seekSequence(lines, oldLines, cursor);
    if (at === -1) {
      const ctx = oldLines.slice(0, 3).join(' / ');
      return { ok: false, error: `could not locate context to patch (near: ${JSON.stringify(ctx)})` };
    }
    // Rebuild the region: keep ORIGINAL context lines verbatim (preserve their whitespace),
    // drop removed lines, insert added lines. Only the +/- deltas change the file.
    const seg: string[] = [];
    let p = at;
    for (const hl of hunk.lines) {
      if (hl.type === 'context') seg.push(lines[p++]!);
      else if (hl.type === 'remove') p++;
      else seg.push(hl.text);
    }
    lines.splice(at, oldLines.length, ...seg);
    cursor = at + seg.length;
  }

  if (lines.length === 0) return { ok: true, content: '' };
  return { ok: true, content: lines.join(eol) + (endsNl ? eol : '') };
}

// ── the tool ──────────────────────────────────────────────────────────────────
const inputSchema = z.object({
  patch: z
    .string()
    .min(1)
    .describe(
      'A patch in the codex patch format. Envelope: `*** Begin Patch` … `*** End Patch`. Inside, one or ' +
        'more file ops, each starting with a header: `*** Add File: <path>` (every following line is a `+` line ' +
        'with the initial contents), `*** Delete File: <path>` (nothing follows), or `*** Update File: <path>` ' +
        '(optionally then `*** Move to: <newpath>`, then `@@` hunks whose lines start with ` ` context, `+` ' +
        'added, or `-` removed). Paths stay inside the workspace. Applied all-or-nothing.',
    ),
});
type ApplyPatchInput = z.infer<typeof inputSchema>;

export interface ApplyPatchData {
  added: number;
  updated: number;
  deleted: number;
  files: string[];
}

type WriteAction = { kind: 'write'; abs: string; rel: string; before: string; after: string };
type DeleteAction = { kind: 'delete'; abs: string; rel: string };
type Action = WriteAction | DeleteAction;

export const applyPatch: Tool<ApplyPatchInput, ApplyPatchData> = {
  name: 'apply_patch',
  description:
    'Apply a multi-file patch in the codex patch format (`*** Begin Patch` … `*** End Patch`, with ' +
    '`*** Add File:` / `*** Update File:` / `*** Delete File:` sections). The standard edit grammar for ' +
    'Codex/GPT-5 and Grok models. Applied all-or-nothing — if any hunk does not match, nothing is written. ' +
    'For single targeted edits, edit_file is also available.',
  risk: 'write',
  inputSchema,
  async run(input, ctx): Promise<ToolResult<ApplyPatchData>> {
    const start = Date.now();
    const F = (code: string, msg: string) => fail('apply_patch', 'write', Date.now() - start, code, msg);

    const parsed = parsePatch(input.patch);
    if (!parsed.ok) return F('bad_patch', parsed.error);

    const roots = [ctx.workspaceRoot, ...(ctx.additionalRoots ?? [])];
    const resolve = (p: string): string | null => {
      try {
        return resolveWithin(roots, p);
      } catch {
        return null;
      }
    };

    // Plan every op in memory first (all-or-nothing): a single failure writes nothing.
    const actions: Action[] = [];
    // Overlay of planned content per path (null = planned-deleted), so multiple ops on the
    // same file in one patch stack on each other instead of each reading stale disk.
    const pending = new Map<string, string | null>();
    const plannedExists = (p: string): boolean => (pending.has(p) ? pending.get(p) !== null : existsSync(p));
    let added = 0,
      updated = 0,
      deleted = 0;
    for (const op of parsed.ops) {
      const abs = resolve(op.path);
      if (!abs) return F('outside_workspace', `path "${op.path}" is outside the workspace`);

      if (op.kind === 'add') {
        if (plannedExists(abs)) return F('exists', `Add File: "${op.path}" already exists`);
        const content = op.lines.length ? op.lines.join('\n') + '\n' : '';
        actions.push({ kind: 'write', abs, rel: op.path, before: '', after: content });
        pending.set(abs, content);
        added += 1;
      } else if (op.kind === 'delete') {
        if (!plannedExists(abs)) return F('not_found', `Delete File: "${op.path}" does not exist`);
        actions.push({ kind: 'delete', abs, rel: op.path });
        pending.set(abs, null);
        deleted += 1;
      } else {
        // Baseline = latest planned content for this path, else disk.
        let before: string;
        if (pending.has(abs)) {
          const cur = pending.get(abs);
          if (cur == null) return F('not_found', `Update File: "${op.path}" was deleted earlier in this patch`);
          before = cur;
        } else {
          try {
            before = readFileSync(abs, 'utf8');
          } catch (e) {
            return F('not_found', `Update File: "${op.path}" could not be read: ${(e as Error).message}`);
          }
          const guard = ctx.readTracker?.check(abs);
          if (guard && !guard.ok) return F('read_required', guard.reason);
        }
        const applied = applyHunks(before, op.hunks);
        if (!applied.ok) return F('hunk_failed', `Update File "${op.path}": ${applied.error}`);

        if (op.moveTo) {
          const destAbs = resolve(op.moveTo);
          if (!destAbs) return F('outside_workspace', `Move to "${op.moveTo}" is outside the workspace`);
          if (destAbs !== abs && plannedExists(destAbs)) {
            return F('exists', `Move to "${op.moveTo}" — destination already exists (would overwrite)`);
          }
          actions.push({ kind: 'write', abs: destAbs, rel: op.moveTo, before, after: applied.content });
          pending.set(destAbs, applied.content);
          if (destAbs !== abs) {
            actions.push({ kind: 'delete', abs, rel: op.path });
            pending.set(abs, null);
          }
        } else {
          actions.push({ kind: 'write', abs, rel: op.path, before, after: applied.content });
          pending.set(abs, applied.content);
        }
        updated += 1;
      }
    }

    const touched = [...new Set(actions.map((a) => a.rel))];
    if (ctx.dryRun) {
      return ok('apply_patch', 'write', Date.now() - start, `[dry-run] would apply patch: +${added} ~${updated} -${deleted} (${touched.join(', ')}).`, {
        added,
        updated,
        deleted,
        files: touched,
      });
    }

    // Execute. Planning validated everything, so a failure here is unexpected I/O — roll back
    // every change made so far so the patch stays all-or-nothing on disk too.
    const diff: DiffLine[] = [];
    const undo: Array<() => void> = [];
    try {
      for (const a of actions) {
        if (a.kind === 'write') {
          const prior = existsSync(a.abs) ? readFileSync(a.abs, 'utf8') : null;
          mkdirSync(dirname(a.abs), { recursive: true });
          atomicWrite(a.abs, a.after);
          undo.push(() => (prior === null ? unlinkSync(a.abs) : atomicWrite(a.abs, prior)));
          ctx.readTracker?.markRead(a.abs);
          const d = diffLines(a.before, a.after);
          if (d.length) diff.push({ tag: ' ', text: `--- ${a.rel}` }, ...d);
        } else {
          const prior = existsSync(a.abs) ? readFileSync(a.abs, 'utf8') : null;
          try {
            unlinkSync(a.abs);
          } catch {
            /* already gone — the desired end state */
          }
          if (prior !== null) undo.push(() => atomicWrite(a.abs, prior));
        }
      }
    } catch (e) {
      for (const revert of undo.reverse()) {
        try {
          revert();
        } catch {
          /* best-effort rollback */
        }
      }
      return F('write_failed', `patch write failed (rolled back): ${(e as Error).message}`);
    }

    const res = ok('apply_patch', 'write', Date.now() - start, `Applied patch: +${added} added, ~${updated} updated, -${deleted} deleted (${touched.join(', ')}).`, {
      added,
      updated,
      deleted,
      files: touched,
    });
    if (diff.length) res.meta.diff = diff;
    return res;
  },
};
