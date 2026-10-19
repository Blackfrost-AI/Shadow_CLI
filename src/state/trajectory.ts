/**
 * Trajectory normalizer — projects Shadow's session JSONL into canonical training trajectories.
 *
 * Session logs are written for *resume*, not for learning: they are delta-encoded, chained to
 * context snapshots, and interleaved with UI-only chatter. This module projects them into the
 * shape a training pipeline actually wants — a list of turns, each with the state the model saw,
 * what it thought, what it did, and what came back.
 *
 * Design rules (each one is load-bearing):
 *
 *  1. **Never drop reasoning.** `reasoning_done` is the most valuable span in the trace and the
 *     easiest thing for a normalization step to accidentally discard.
 *  2. **Pair actions with observations.** `tool_start` alone is not an example; `tool_start` +
 *     its `tool_end` is. Unpaired starts mean a truncated trace, which is flagged, not silently
 *     repaired.
 *  3. **Preserve failures.** A failed call followed by a recovery is a better training example
 *     than a clean run. Normalization never filters to successes.
 *  4. **Stream.** A single real session can be >1 GB, so this reads line-by-line and never holds
 *     the raw file in memory.
 */
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import type { Provenance } from './provenance.js';

/** One tool interaction, paired. */
export interface TrajectoryTurn {
  /** 0-based position in the trajectory. */
  i: number;
  /** Committed reasoning text, when the model produced any. */
  thought?: string;
  /** The tool call, normalized. Absent for a pure text turn. */
  action?: {
    tool: string;
    input: unknown;
    risk?: string;
  };
  /** What came back. `ok: false` is a *successful* recording of a failed action. */
  observation?: {
    ok: boolean;
    summary: string;
    errorCode?: string;
    durationMs?: number;
  };
  /** Tokens/latency for the turn that produced this action, when recorded. */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    latencyMs?: number;
    /** Model that produced THIS turn — the per-turn attribution from Phase 0. */
    model?: string;
  };
  /** Assistant text committed on this turn (the user-visible answer). */
  answer?: string;
}

export interface TrajectoryOutcome {
  /** Terminal stop reason, if the session recorded one. */
  stopReason?: string;
  /** True when the trace ended mid-action (a start with no matching end). */
  truncated: boolean;
  /** Number of turns the model took. */
  turns: number;
  /** Count of tool calls that returned `ok: false`. */
  failedActions: number;
  /** Count of user messages that arrived after an assistant turn — a correction signal. */
  userCorrections: number;
}

export interface Trajectory {
  sessionId: string;
  provenance?: Provenance;
  turns: TrajectoryTurn[];
  outcome: TrajectoryOutcome;
  /** Models observed in usage records, in first-seen order. >1 means a mid-session switch. */
  modelsSeen: string[];
  /** Non-fatal normalization problems (unknown record kinds, parse failures). */
  warnings: string[];
}

/** Records we intentionally ignore — UI-only or redundant for training. */
const IGNORED_TYPES = new Set([
  'text', // streamed deltas; superseded by assistant_done
  'thinking', // streamed deltas; superseded by reasoning_done
  'shell_output', // streamed chunks; superseded by tool_end summary
  'shell_pid',
  'todo',
  'debug',
  'retry',
]);

interface RawRecord {
  kind?: string;
  type?: string;
  ts?: string;
  [k: string]: unknown;
}

/**
 * Normalize one session file into a trajectory.
 *
 * Never throws on malformed input: a corrupt line is recorded as a warning and skipped, because
 * one bad byte should not discard an otherwise usable transcript.
 */
export async function normalizeSessionFile(path: string): Promise<Trajectory> {
  const turns: TrajectoryTurn[] = [];
  const warnings: string[] = [];
  const modelsSeen: string[] = [];
  const provenance: Provenance | undefined = undefined;
  let prov: Provenance | undefined = provenance;
  let stopReason: string | undefined;
  let pendingThought: string | undefined;
  let pendingStart:
    | { turn: TrajectoryTurn; callId: string; tool: string; input: unknown; risk?: string }
    | undefined;
  let failedActions = 0;
  let userCorrections = 0;
  let sawAssistant = false;

  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let rec: RawRecord;
    try {
      rec = JSON.parse(line) as RawRecord;
    } catch {
      if (warnings.length < 20) warnings.push(`unparseable line: ${line.slice(0, 80)}`);
      continue;
    }

    if (rec.kind === 'provenance') {
      prov = rec as unknown as Provenance;
      continue;
    }
    if (rec.kind !== 'event') continue; // snapshots/manifests carry no turn content

    const type = rec.type ?? '';
    if (IGNORED_TYPES.has(type)) continue;

    switch (type) {
      case 'reasoning_done': {
        const text = typeof rec.text === 'string' ? rec.text : '';
        if (text) pendingThought = pendingThought ? `${pendingThought}\n${text}` : text;
        break;
      }

      case 'tool_start': {
        const call = rec.call as { id?: string; name?: string; input?: unknown } | undefined;
        const turn: TrajectoryTurn = {
          i: turns.length,
          action: {
            tool: call?.name ?? 'unknown',
            input: call?.input,
            risk: typeof rec.risk === 'string' ? rec.risk : undefined,
          },
        };
        if (pendingThought) {
          turn.thought = pendingThought;
          pendingThought = undefined;
        }
        turns.push(turn);
        pendingStart = {
          turn,
          callId: call?.id ?? '',
          tool: call?.name ?? 'unknown',
          input: call?.input,
          risk: typeof rec.risk === 'string' ? rec.risk : undefined,
        };
        break;
      }

      case 'tool_end': {
        const result = rec.result as
          | { ok?: boolean; summary?: string; error?: { code?: string }; meta?: { durationMs?: number } }
          | undefined;
        // Pair with the most recent unmatched start. A sub-agent's result can arrive out of
        // order, so fall back to a synthetic turn rather than dropping the observation.
        const target = pendingStart?.turn ?? { i: turns.length } as TrajectoryTurn;
        if (!pendingStart) {
          turns.push(target);
          target.action = {
            tool: (rec.call as { name?: string } | undefined)?.name ?? 'unknown',
            input: (rec.call as { input?: unknown } | undefined)?.input,
          };
        }
        target.observation = {
          ok: result?.ok !== false,
          summary: typeof result?.summary === 'string' ? result.summary : '',
          ...(result?.error?.code ? { errorCode: result.error.code } : {}),
          ...(typeof result?.meta?.durationMs === 'number'
            ? { durationMs: result.meta.durationMs }
            : {}),
        };
        if (result?.ok === false) failedActions++;
        pendingStart = undefined;
        break;
      }

      case 'tool_denied': {
        const turn: TrajectoryTurn = {
          i: turns.length,
          action: {
            tool: (rec.call as { name?: string } | undefined)?.name ?? 'unknown',
            input: (rec.call as { input?: unknown } | undefined)?.input,
          },
          observation: {
            ok: false,
            summary: typeof rec.reason === 'string' ? rec.reason : 'denied',
            errorCode: 'denied',
          },
        };
        if (pendingThought) {
          turn.thought = pendingThought;
          pendingThought = undefined;
        }
        turns.push(turn);
        failedActions++;
        break;
      }

      case 'assistant_done': {
        sawAssistant = true;
        const text = typeof rec.text === 'string' ? rec.text : '';
        // Attach to the turn that just completed; otherwise record a text-only turn so the
        // answer is never lost.
        const last = turns[turns.length - 1];
        if (last && !last.answer) last.answer = text;
        else if (text) turns.push({ i: turns.length, answer: text });
        break;
      }

      case 'user': {
        // A user message after the assistant has spoken is a correction/steer — the single
        // most valuable signal in the trace. Counted, not inlined into turns.
        if (sawAssistant) userCorrections++;
        break;
      }

      case 'usage': {
        const last = turns[turns.length - 1];
        const model = typeof rec.model === 'string' ? rec.model : undefined;
        if (model && !modelsSeen.includes(model)) modelsSeen.push(model);
        if (last) {
          last.usage = {
            ...(typeof rec.inputTokens === 'number' ? { inputTokens: rec.inputTokens } : {}),
            ...(typeof rec.outputTokens === 'number' ? { outputTokens: rec.outputTokens } : {}),
            ...(typeof rec.cacheReadTokens === 'number'
              ? { cacheReadTokens: rec.cacheReadTokens }
              : {}),
            ...(typeof rec.latencyMs === 'number' ? { latencyMs: rec.latencyMs } : {}),
            ...(model ? { model } : {}),
          };
        }
        break;
      }

      case 'stop': {
        stopReason = typeof rec.reason === 'string' ? rec.reason : undefined;
        break;
      }

      default:
        break;
    }
  }

  const truncated = pendingStart !== undefined;

  return {
    // A stable ID, not the absolute path: the path varies by machine, which would make the
    // split assignment (and therefore train/test leakage) machine-dependent.
    sessionId: basename(path).replace(/\.jsonl$/, ''),
    ...(prov ? { provenance: prov } : {}),
    turns,
    outcome: {
      ...(stopReason ? { stopReason } : {}),
      truncated,
      turns: turns.length,
      failedActions,
      userCorrections,
    },
    modelsSeen,
    warnings,
  };
}