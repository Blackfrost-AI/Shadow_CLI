import { isAbsolute, join, relative, resolve } from 'node:path';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { atomicWrite } from '../tools/util.js';
import { listCheckpointsForTurn, listCheckpointTurns, restoreCheckpoint } from './checkpoints.js';
import { hydrateContext, type ContextSnapshotData, type HydrateOptions } from './snapshot.js';
import { SessionLog } from './session.js';
import type { Context } from '../agent/context.js';
import type { Message } from '../provider/provider.js';

export interface RewindResult {
  /** Absent for a `scope: 'code'` rewind — the conversation was deliberately left untouched. */
  context?: Context;
  restoredFiles: string[];
  /** Files created after the target turn and removed by the rewind. */
  deletedFiles: string[];
  /**
   * Files whose OLDEST backup was missing, so a NEWER backup won instead — they land in a state
   * later than the rewind target. Empty when every chain was complete.
   */
  partialFiles: string[];
  turn: number;
}

/** One rewindable snapshot turn for the /rewind picker (F08-07). */
export interface RewindableTurn {
  /** Snapshot turn index, in the same unit rewindToTurn consumes. */
  turn: number;
  /** The user prompt that produced this turn — for composer prefill after rewinding. */
  prompt: string;
  /** First line of the prompt, truncated — for the picker menu row. */
  label: string;
}

interface SnapshotRecord {
  turn?: number;
  ts?: string;
  data: ContextSnapshotData;
}

function loadSnapshots(sessionPath: string): SnapshotRecord[] {
  // P2-13: deltas reconstructed to full form in one forward pass (see loadSnapshotRecords).
  const out: SnapshotRecord[] = [];
  for (const { record: e } of SessionLog.loadSnapshotRecords(sessionPath)) {
    out.push({
      turn: typeof e.turn === 'number' ? e.turn : out.length,
      ts: typeof e.ts === 'string' ? e.ts : undefined,
      data: e.data as ContextSnapshotData,
    });
  }
  return out;
}

/**
 * Rewind conversation and/or workspace files to the snapshot at `turnIndex`.
 * Turn 0 is the first completed assistant turn; higher indices are later turns.
 *
 * F08-07 scope flags (default: both):
 *  - `scope: 'chat'` — rewind ONLY the conversation; workspace files stay as they are
 *    (use when the files are fine and only the discussion went sideways).
 *  - `scope: 'code'` — rewind ONLY the workspace files; the conversation stays intact
 *    (result.context is then absent).
 */
export function rewindToTurn(
  sessionPath: string,
  turnIndex: number,
  workspaceRoot: string,
  opts: HydrateOptions & { scope?: 'code' | 'chat' },
): RewindResult {
  if (turnIndex < 0) throw new Error('turnIndex must be >= 0');
  if (!Number.isInteger(turnIndex)) throw new Error('turnIndex must be an integer');
  const snaps = loadSnapshots(sessionPath);
  if (!snaps.length) throw new Error(`No snapshots in session: ${sessionPath}`);

  // EXACT turn match, latest append wins. After an interactive /resume the log can hold a second
  // turn-0 snapshot (the resumed lineage); after a rewind-durability snapshot it can hold a second
  // copy of a rewound turn — the newest append is the state the user sees, so it must win. Falling
  // back to "nearest turn at or below" keeps legacy between-turns arguments working. (The old
  // first-larger-`break` scan resolved the ORIGINAL lineage on a non-monotonic log — wrong turn.)
  let pick: SnapshotRecord | undefined;
  for (const s of snaps) {
    if ((s.turn ?? 0) === turnIndex) pick = s; // keep scanning → the last appended match wins
  }
  if (!pick) {
    let best: number | undefined;
    for (const s of snaps) {
      const t = s.turn ?? 0;
      if (t <= turnIndex && (best === undefined || t >= best)) {
        best = t;
        pick = s;
      }
    }
  }
  if (!pick) pick = snaps[0]!; // target before the first snapshot → the oldest recorded state

  // HYDRATE FIRST: it is the only step that validates the snapshot payload, and it is pure. A torn
  // or hand-edited log line used to roll workspace files back and THEN throw here, leaving the
  // conversation and the working tree silently disagreeing (rewind.ts's own definition of the
  // worst failure mode). Everything below can now assume the rewind will complete.
  const context = opts.scope === 'code' ? undefined : hydrateContext(pick.data, opts);

  const sessionId = SessionLog.sessionIdFromPath(sessionPath);
  const turn = pick.turn ?? 0;
  const restoredFiles: string[] = [];
  const deletedFiles: string[] = [];
  const partialFiles: string[] = [];

  if (opts.scope !== 'chat') {
    // Restore EVERY turn from the target onward, newest first so the OLDEST backup lands last and
    // wins. Restoring only the picked turn left every later turn's edits on disk while reporting
    // "Restored N file(s)" — the conversation went back but the working tree did not, which is a
    // worse state than not rewinding at all because the two now disagree silently.
    const turns = listCheckpointTurns(workspaceRoot, sessionId).filter((t) => t >= turn);
    // The checkpoint index.json is DATA ON DISK (a clone or a sync tool can plant one), not a
    // trusted config: validate every path before it touches the filesystem. dest must stay inside
    // the workspace (a `..` relPath used to escape it — arbitrary write/delete); a backup must
    // actually live in this session's checkpoint tree (an absPath used to be an arbitrary read).
    const wsRoot = resolve(workspaceRoot);
    const cpRoot = join(wsRoot, '.shadow', 'checkpoints', sessionId);
    const inside = (root: string, p: string): string | null => {
      const rel = relative(root, resolve(p));
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : null;
    };
    // The OLDEST checkpoint turn per file — if THAT turn's backup is missing, a newer state wins
    // silently; we report the file as partially restored instead (F08-07 review F6).
    const minTurnByPath = new Map<string, number>();
    const entriesByTurn = turns.map((t) => listCheckpointsForTurn(workspaceRoot, sessionId, t));
    turns.forEach((t, i) => {
      for (const e of entriesByTurn[i]!) {
        const m = minTurnByPath.get(e.relPath);
        if (m === undefined || t < m) minTurnByPath.set(e.relPath, t);
      }
    });
    const seen = new Set<string>();
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i]!;
      for (const entry of entriesByTurn[i]!) {
        const destRel = inside(wsRoot, resolve(wsRoot, entry.relPath));
        if (destRel === null) continue; // relPath escapes the workspace — ignore the entry
        const dest = resolve(wsRoot, entry.relPath);
        if (entry.absent) {
          // The file did not exist before that turn — rewinding past it means removing it again.
          if (existsSync(dest)) {
            try {
              rmSync(dest, { force: true });
              if (!seen.has(entry.relPath)) deletedFiles.push(entry.relPath);
            } catch {
              partialFiles.push(entry.relPath); // e.g. a directory now sits at the path
            }
          }
          seen.add(entry.relPath);
          continue;
        }
        if (!existsSync(entry.absPath)) {
          // Missing at the file's OLDEST turn → whatever newer backup already landed (or the
          // file's current on-disk state, if none did) stays: the chain cannot reach the target.
          if (minTurnByPath.get(entry.relPath) === t) partialFiles.push(entry.relPath);
          continue;
        }
        if (inside(cpRoot, entry.absPath) === null) continue; // absPath outside the checkpoint tree
        atomicWrite(dest, restoreCheckpoint(entry.absPath));
        if (!seen.has(entry.relPath)) restoredFiles.push(entry.relPath);
        seen.add(entry.relPath);
      }
    }
  }

  return { context, restoredFiles, deletedFiles, partialFiles, turn };
}

/**
 * The user prompt that produced a snapshot turn: the NEWEST user message in the snapshot with
 * real text (tool_result-only user turns carry none). Injected suffixes — @-file inlining
 * (`\n\nReferenced files:`) and user_prompt_submit hook context (`\n\nAdditional context (`) —
 * are stripped so a prefill reproduces what the user TYPED, not the enriched request.
 */
function promptOfSnapshot(data: ContextSnapshotData): string {
  // Snapshot payloads come off disk (parsed JSONL) — a torn or hand-edited log can carry
  // non-object rows or non-array content. The /rewind menu must never throw on garbage: skip
  // malformed rows instead.
  const msgs: unknown[] = data && Array.isArray(data.messages) ? data.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || typeof m !== 'object' || (m as Message).role !== 'user') continue;
    if (!Array.isArray((m as Message).content)) continue;
    const text = ((m as Message).content as unknown[])
      .map((b) => {
        if (!b || typeof b !== 'object') return '';
        const tb = b as { type?: unknown; text?: unknown };
        return tb.type === 'text' && typeof tb.text === 'string' ? tb.text : '';
      })
      .join(' ')
      .trim();
    if (!text) continue;
    let cut = text.indexOf('\n\nReferenced files:');
    const hookCut = text.indexOf('\n\nAdditional context (');
    if (hookCut >= 0 && (cut < 0 || hookCut < cut)) cut = hookCut;
    return (cut >= 0 ? text.slice(0, cut) : text).trim();
  }
  return '';
}

interface TurnListCache {
  offset: number;
  /** First bytes of the file when the cache was filled — a same-path REPLACEMENT with an
   * equal-or-larger size is invisible to the offset check alone; a differing head forces a full
   * reparse instead of serving stale turns (or merging a foreign tail onto an old prefix). */
  head: string;
  turns: RewindableTurn[];
  /** P2-13: the LAST snapshot line resolved by the pass (full-form messages + the line's byte
   *  offset). The writer always chains a delta onto the snapshot line immediately before it, so
   *  this one entry is normally all the incremental pass needs to reconstruct newly appended
   *  deltas without re-reading the file. Lost when the entry is evicted — a base miss then
   *  triggers a one-shot full reparse. */
  lastSnap?: { offset: number; messages: Message[] };
  /** A delta base went missing even during a full reparse (corrupt mid-chain line) — further
   *  mismatches skip instead of re-parsing, until the next full re-bases the chain. */
  broken?: boolean;
}
/**
 * Incremental per-path cache: the session log is append-only, so each refresh parses ONLY the
 * bytes appended since the last one. Keeps the turn-end menu refresh O(new snapshots) instead of
 * re-parsing every snapshot payload the session has ever written.
 */
const turnListCache = new Map<string, TurnListCache>();
/** Bounded: each entry retains every turn's full prompt; a long TUI cycles through many logs. */
const TURN_CACHE_MAX = 32;

/** One snapshot-bearing JSONL line, parsed — the subset of the record shape the turn list needs. */
type SnapshotLine = {
  kind?: string;
  turn?: number;
  format?: string;
  baseOffset?: number;
  data?: ContextSnapshotData & { appended?: Message[] };
};

/**
 * F08-07: the rewindable turns of a session, NEWEST FIRST, each carrying the prompt that
 * produced it. Feeds the /rewind picker menu (labels) and the post-rewind composer prefill
 * (full prompts). A missing/empty log yields [] — the menu then says "nothing to rewind to".
 */
export function listRewindableTurns(sessionPath: string): RewindableTurn[] {
  let buf: Buffer;
  try {
    buf = readFileSync(sessionPath);
  } catch {
    return [];
  }
  const head = buf.toString('utf8', 0, Math.min(buf.length, 128));
  // Never consume a trailing partial line — the writer may still be appending it.
  const safeLen = buf.length > 0 && buf[buf.length - 1] === 0x0a ? buf.length : buf.lastIndexOf(0x0a) + 1;
  const cached = turnListCache.get(sessionPath);
  const warm = cached && cached.head === head && cached.offset <= safeLen;
  // shrank/rotated OR replaced (different head) → reparse from the start

  /** Parse snapshot lines in buf[from, to), resolving deltas against `bases` (offset → resolved
   *  messages of every earlier snapshot, same semantics as SessionLog.loadSnapshotRecords — a
   *  delta may point at ANY earlier snapshot line, though the writer normally chains onto the
   *  immediately previous one). `reparse` is true on the from-0 pass: a base miss there marks
   *  the chain broken instead of triggering another reparse. */
  const parseRange = (
    from: number,
    to: number,
    state: { turns: RewindableTurn[]; bases: Map<number, Message[]>; broken: boolean },
    reparse: boolean,
  ): { missedBase: boolean } => {
    let missedBase = false;
    let start = from;
    for (let i = from; i <= to; i++) {
      if (i < to && buf[i] !== 0x0a) continue;
      const lineOffset = start;
      const seg = buf.subarray(start, i);
      start = i + 1;
      if (!seg.length) continue;
      let e: SnapshotLine;
      try {
        e = JSON.parse(seg.toString('utf8')) as SnapshotLine;
      } catch {
        continue; // a corrupt/partial line is skipped, never fatal to the menu
      }
      if (e.kind !== 'context_snapshot' || !e.data) continue;
      let messages: Message[] | undefined;
      if (e.format === 'delta') {
        const appended = Array.isArray(e.data.appended) ? e.data.appended : undefined;
        const baseMsgs = typeof e.baseOffset === 'number' ? state.bases.get(e.baseOffset) : undefined;
        if (appended && baseMsgs) {
          messages = [...baseMsgs, ...appended];
        } else if (appended) {
          if (!reparse && !state.broken) missedBase = true; // one-shot reparse from 0
          else state.broken = true; // truly unresolvable — skipped until the next full re-bases
        }
      } else if (Array.isArray(e.data.messages)) {
        messages = e.data.messages; // full-form (or legacy — no `format` field — which is full)
      }
      if (!messages) continue;
      state.bases.set(lineOffset, messages);
      state.broken = false; // a resolved snapshot heals whatever came before it
      const prompt = promptOfSnapshot({ ...e.data, messages });
      const firstLine = (prompt.split(/\r?\n/, 1)[0] ?? '').trim();
      state.turns.push({
        turn: typeof e.turn === 'number' ? e.turn : state.turns.length,
        prompt,
        label: firstLine.length > 72 ? `${firstLine.slice(0, 72)}…` : firstLine,
      });
    }
    return { missedBase };
  };

  // The warm pass seeds its base map with the ONE cached snapshot; deltas appended by the live
  // writer chain onto it, so that single entry is normally enough. A miss triggers a full
  // reparse with an empty map (a forward pass always meets a base before the deltas on it).
  const warmBases = new Map<number, Message[]>();
  if (warm && cached.lastSnap) warmBases.set(cached.lastSnap.offset, cached.lastSnap.messages);
  const state = {
    turns: warm ? cached.turns : [],
    bases: warmBases,
    broken: warm ? (cached.broken ?? false) : false,
  };
  if (safeLen > (warm ? cached.offset : 0)) {
    const { missedBase } = parseRange(warm ? cached.offset : 0, safeLen, state, false);
    if (missedBase) {
      state.turns = [];
      state.bases = new Map();
      state.broken = false;
      parseRange(0, safeLen, state, true);
    }
  }
  // Map iterates in insertion order — the last entry is the last resolved snapshot line.
  let lastSnap: { offset: number; messages: Message[] } | undefined;
  for (const [offset, messages] of state.bases) lastSnap = { offset, messages };
  if (!turnListCache.has(sessionPath) && turnListCache.size >= TURN_CACHE_MAX) {
    const oldest = turnListCache.keys().next().value;
    if (oldest !== undefined) turnListCache.delete(oldest); // Map iterates in insertion order
  }
  turnListCache.set(sessionPath, {
    offset: safeLen,
    head,
    turns: state.turns,
    lastSnap,
    broken: state.broken,
  });
  // Snapshots append oldest-first; the menu wants newest-first.
  return [...state.turns].reverse();
}