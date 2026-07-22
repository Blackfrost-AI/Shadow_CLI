import type { ContentBlock, Message, Provider } from '../provider/provider.js';

export interface ContextOptions {
  contextBudget: number; // token budget that triggers summarization
  triggerRatio: number; // summarize when estimate > contextBudget * ratio (default 0.9)
  keepLastTurns: number; // most-recent messages kept verbatim
}

/**
 * Running message history with a summarization buffer. The session objective is never
 * summarized away. Summarization never splits a tool_use turn from its matching
 * tool_result turn — both providers reject that.
 *
 * Two hard-won failure modes this class guards against:
 *  1. **Thrashing** — compact fires every few tool rounds because a small local budget
 *     re-triggers immediately after a weak shrink. Fixed with post-compact hysteresis.
 *  2. **Restart from first prompt** — the pinned first user message still looks like a
 *     fresh request after compact, so the model re-plans from scratch. Fixed by reframing
 *     the pin as an in-progress SESSION OBJECTIVE and putting CURRENT WORK in a progress note.
 */
export class Context {
  private msgs: Message[] = [];
  private pinnedPrefix = 0;
  /** Last REAL request size (input + cache tokens) from the provider's usage event. */
  private lastActualTokens = 0;
  /**
   * After a successful compact, auto-compact is suppressed until the estimate grows past
   * this floor. Prevents the "compact → still over trigger → compact again next tool"
   * death spiral on small local windows.
   */
  private rearmAtTokens = 0;

  constructor(private readonly opts: ContextOptions) {}

  /**
   * Record the exact request size the provider just reported (input + cache-read +
   * cache-write tokens). This is the true count against the context window — far more
   * accurate than the char/4 heuristic, and free (the API returns it every turn). It
   * includes the system prompt + tool definitions, which the message-only heuristic misses.
   */
  recordActualTokens(total: number): void {
    if (total > 0) this.lastActualTokens = total;
  }

  /** Seed the conversation with the task; the task is pinned. */
  pinTask(msg: Message): void {
    this.msgs.push(msg);
    this.pinnedPrefix = this.msgs.length;
  }

  append(msg: Message): void {
    this.msgs.push(msg);
  }

  /** Drop all history (used by the `/clear` command); the next pinTask re-seeds it. */
  reset(): void {
    this.msgs = [];
    this.pinnedPrefix = 0;
    this.lastActualTokens = 0;
    this.rearmAtTokens = 0;
  }

  messages(): Message[] {
    return this.msgs;
  }

  /** Export restorable state for session snapshots (resume / rewind). */
  exportState(): {
    messages: Message[];
    pinnedPrefix: number;
    lastActualTokens: number;
    rearmAtTokens?: number;
    subAgentTasks?: any[];
  } {
    return {
      messages: [...this.msgs],
      pinnedPrefix: this.pinnedPrefix,
      lastActualTokens: this.lastActualTokens,
      rearmAtTokens: this.rearmAtTokens,
      subAgentTasks: (this as any)._subAgentTasks || [],
    };
  }

  /** Replace history from a snapshot produced by `exportState` / `serializeContext`. */
  loadState(data: {
    messages: Message[];
    pinnedPrefix?: number;
    lastActualTokens?: number;
    rearmAtTokens?: number;
    subAgentTasks?: any[];
  }): void {
    this.msgs = [...data.messages];
    this.pinnedPrefix = data.pinnedPrefix ?? 0;
    this.lastActualTokens = data.lastActualTokens ?? 0;
    this.rearmAtTokens = data.rearmAtTokens ?? 0;
    (this as any)._subAgentTasks = data.subAgentTasks || [];
  }

  estimateTokens(provider: Provider): number {
    // Prefer the real last-request size when we have it (accounts for system + tools);
    // the heuristic still wins once history has grown beyond that last measurement.
    return Math.max(provider.estimateTokens(this.msgs), this.lastActualTokens);
  }

  /**
   * Collapse the oldest non-pinned turns into a progress note when the estimate crosses
   * contextBudget * triggerRatio. Returns true if it summarized.
   */
  async maybeSummarize(provider: Provider, model: string, force = false): Promise<boolean> {
    const trigger = this.opts.contextBudget * this.opts.triggerRatio;
    let tokens = this.estimateTokens(provider);

    if (!force) {
      // Hysteresis only applies when we are STILL under the trigger. Once we are over
      // the trigger again, always compact — otherwise a weak compact + high rearm floor
      // lets the request grow until the local server 400s (32k hard limit).
      if (tokens <= trigger) {
        if (this.rearmAtTokens > 0 && tokens < this.rearmAtTokens) return false;
        // Opportunistic real count when we're in the "maybe" zone.
        if (provider.countTokens && tokens > this.opts.contextBudget * 0.6) {
          try {
            const real = await provider.countTokens({ model, messages: this.msgs });
            if (real > 0) {
              this.lastActualTokens = real;
              tokens = real;
            }
          } catch {
            /* ignore, keep heuristic */
          }
        }
        if (tokens <= trigger) return false;
      }
    }

    // Small windows: keep a shorter tail so one compact actually frees space.
    const keep =
      this.opts.contextBudget <= 40_000
        ? Math.min(this.opts.keepLastTurns, 6)
        : this.opts.keepLastTurns;
    let end = this.msgs.length - keep;
    if (end <= this.pinnedPrefix) return false;

    // Don't begin the kept region on an orphaned tool_result: its matching tool_use lives
    // in the preceding turn. Tool results are `tool_result` blocks inside role:'user' turns.
    while (
      end < this.msgs.length &&
      this.msgs[end]!.content.some((b) => b.type === 'tool_result')
    ) {
      end += 1;
    }
    if (end <= this.pinnedPrefix) return false;

    const toSummarize = this.msgs.slice(this.pinnedPrefix, end);
    const pinnedSlice = this.msgs.slice(0, this.pinnedPrefix);

    // Always fold the pinned objective into the summarizer prompt so a weak local model
    // cannot invent a new task — and so the progress note is about THIS work.
    const objectiveLines = harvestInstructions(pinnedSlice);
    const middleLines = harvestInstructions(toSummarize);
    const allInstructions = mergeInstructions(objectiveLines, middleLines);

    const transcript = toSummarize
      .map((m) => `${m.role}: ${m.content.map(blockText).join(' ')}`)
      .join('\n');

    const objectiveBlock =
      allInstructions.length > 0
        ? `SESSION OBJECTIVE (must preserve verbatim in TASK):\n${allInstructions.map((l) => `• ${l}`).join('\n')}\n\n`
        : '';

    let summary = '';
    try {
      for await (const ev of provider.send({
        model,
        system:
          'You are compacting an IN-PROGRESS agent session so it can continue with a smaller ' +
          'context window. The agent must RESUME mid-work — it must NOT restart the original ' +
          'request from scratch, re-greet the user, or re-plan work already done.\n' +
          'Write a structured summary with exactly these sections, terse but complete:\n' +
          '1. TASK — restate the SESSION OBJECTIVE (given below) so it cannot be misread.\n' +
          '2. ALREADY DONE — concrete progress (files changed, decisions made). Critical: this ' +
          'is what stops the model redoing finished work.\n' +
          '3. DECISIONS & FACTS — constraints and choices that still apply.\n' +
          '4. CURRENT WORK — precisely what was underway at the moment of this summary.\n' +
          '5. NEXT STEP — the single concrete next action. Do not list "start over" or "re-read the prompt".\n' +
          'No preamble, no meta-commentary, no sign-off.',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `${objectiveBlock}TRANSCRIPT TO COMPACT:\n${transcript}`,
              },
            ],
          },
        ],
        tools: [],
        maxOutputTokens: 2048,
      })) {
        if (ev.type === 'text') summary += ev.delta;
      }
    } catch {
      return false;
    }
    if (!summary.trim()) return false;

    // Reframe the pin: a raw first user prompt after compact reads as a FRESH request and
    // models restart from it. Replace the pin with an explicit in-progress objective carrier,
    // then a separate progress note (summary + next step). Verbatim instructions ride the pin.
    const objectiveText =
      allInstructions.length > 0
        ? allInstructions.map((l) => `• ${l}`).join('\n')
        : pinnedSlice
            .map((m) => m.content.map(blockText).join(' ').trim())
            .filter(Boolean)
            .join('\n') || '(session objective — see progress note)';

    const objectiveMsg: Message = {
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            `SESSION OBJECTIVE (in progress — do NOT restart from the beginning, do NOT re-greet, ` +
            `do NOT re-plan finished work; continue from the progress note's NEXT STEP):\n` +
            `${objectiveText}`,
        },
      ],
    };

    const progressMsg: Message = {
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            `[System note: earlier turns were compacted to free context. The SESSION OBJECTIVE above is ` +
            `still the goal. Progress so far and the next action are below. Continue directly from NEXT STEP — ` +
            `do NOT greet, ask what to help with, restate the whole plan, or start over.]` +
            `\n\n${SUMMARY_HEADER}\n${summary.trim()}`,
        },
      ],
    };

    // Keep recent messages; trim fat tool_result bodies so a single compact actually frees room
    // (otherwise rearm hysteresis is the only thing preventing thrash).
    const kept = this.msgs.slice(end).map(trimKeptMessage);
    this.msgs = [objectiveMsg, progressMsg, ...kept];
    this.pinnedPrefix = 1; // only the objective carrier is protected
    this.lastActualTokens = 0;

    // Rearm hysteresis only when compact clearly freed room under the trigger.
    // If still near/over the trigger, rearmAt=0 so the next over-threshold check fires again
    // (with a shorter keep on small budgets) instead of sailing into a server 400.
    const after = provider.estimateTokens(this.msgs);
    const gap = Math.max(2_000, Math.floor(this.opts.contextBudget * 0.1));
    this.rearmAtTokens = after < trigger * 0.9 ? after + gap : 0;

    return true;
  }
}

// Stable markers for instruction carry-forward across repeated compactions.
const INSTR_HEADER =
  '── TASK & INSTRUCTIONS (verbatim — the source of truth; follow these, the summary below is only a progress digest) ──';
const SUMMARY_HEADER = '── PROGRESS SUMMARY ──';
const INSTR_MAX_EACH = 1500;
const INSTR_MAX_TOTAL = 8000;
/** Cap tool_result bodies kept after compact so the kept tail does not re-fill the window. */
const KEPT_TOOL_RESULT_CAP = 2_500;

/**
 * Pull human instructions out of turns. Skips tool_result user turns. Prior compaction notes
 * contribute only their instruction block (or the SESSION OBJECTIVE carrier).
 */
function harvestInstructions(turns: Message[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    const t = raw.trim();
    if (!t) return;
    const capped = t.length > INSTR_MAX_EACH ? `${t.slice(0, INSTR_MAX_EACH)} …[truncated]` : t;
    const key = capped.slice(0, 200);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(capped);
  };
  for (const m of turns) {
    if (m.role !== 'user') continue;
    if (m.content.some((b) => b.type === 'tool_result')) continue;
    const text = m.content.map(blockText).join(' ').trim();
    if (!text) continue;

    // New-style objective carrier
    if (text.startsWith('SESSION OBJECTIVE')) {
      const body = text.replace(/^SESSION OBJECTIVE[^\n]*:\n?/i, '');
      for (const line of body.split('\n')) {
        const l = line.replace(/^\s*•\s?/, '').trim();
        if (l) add(l);
      }
      continue;
    }

    const marker = text.indexOf(INSTR_HEADER);
    if (marker !== -1) {
      const after = text.slice(marker + INSTR_HEADER.length);
      const endIdx = after.indexOf(SUMMARY_HEADER);
      const block = endIdx === -1 ? after : after.slice(0, endIdx);
      for (const line of block.split('\n')) {
        const l = line.replace(/^\s*•\s?/, '').trim();
        if (l && !l.startsWith('…[')) add(l);
      }
      continue;
    }
    if (text.startsWith('[System note:')) continue;
    add(text);
  }
  return out;
}

/** Merge two instruction lists (objective first), deduped, budgeted. */
function mergeInstructions(primary: string[], secondary: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const it of [...primary, ...secondary]) {
    const key = it.slice(0, 200);
    if (seen.has(key)) continue;
    if (total + it.length > INSTR_MAX_TOTAL) {
      out.push('…[further instructions elided to save space]');
      break;
    }
    seen.add(key);
    out.push(it);
    total += it.length;
  }
  return out;
}

/** Shrink tool_result payloads in a kept message so post-compact history stays lean. */
function trimKeptMessage(m: Message): Message {
  let changed = false;
  const content = m.content.map((b) => {
    if (b.type !== 'tool_result') return b;
    if (b.content.length <= KEPT_TOOL_RESULT_CAP) return b;
    changed = true;
    return {
      ...b,
      content: `${b.content.slice(0, KEPT_TOOL_RESULT_CAP)}\n…[truncated after compact]`,
    };
  });
  return changed ? { ...m, content } : m;
}

function blockText(b: ContentBlock): string {
  switch (b.type) {
    case 'text':
      return b.text;
    case 'thinking':
      return '';
    case 'redacted_thinking':
      return '';
    case 'image':
      return '[image]';
    case 'tool_use':
      return `[call ${b.name} ${JSON.stringify(b.input)}]`;
    case 'tool_result':
      return `[result ${b.content}]`;
  }
}
