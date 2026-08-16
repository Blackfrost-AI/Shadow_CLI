import type { ContentBlock, Message, Provider } from '../provider/provider.js';
import { envelopeSafeSlice } from '../safety/envelope.js';

export interface ContextOptions {
  contextBudget: number; // token budget that triggers summarization
  triggerRatio: number; // summarize when estimate > contextBudget * ratio (default 0.9)
  keepLastTurns: number; // most-recent messages kept verbatim
  /**
   * P1B-02 microcompaction (F08-01): clear STALE compactable tool_result bodies in place before
   * the summarizer round-trip. Default ON — the cheapest context win for a long self-hosted
   * session. Consumed via the private toggle below (kept OUT of `opts` so policy() stays stable).
   */
  microcompact?: boolean;
  /**
   * Fraction of contextBudget at which microcompaction fires. Clamped below triggerRatio at use
   * so cheap in-place clearing always runs BEFORE summarization. Default 0.7.
   */
  microcompactRatio?: number;
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
  /**
   * F06-12 estimation cache. `provider.estimateTokens` re-stringifies every tool input
   * (JSON.stringify on every tool_use block) on EACH call, and a single turn calls it several
   * times over (microcompact gate → maybeSummarize → loop HUD). The result is a pure function
   * of `msgs` and the estimator, so it is computed once per mutation and reused. EVERY site
   * that mutates `msgs` — or a message inside it — must set `estimateDirty = true`. The
   * output stays EXACTLY `max(heuristic(msgs), lastActualTokens)`: this is call elimination,
   * not a new formula. The provider object is part of the cache key because adapters may
   * override the char/4 default estimator.
   */
  private estimateCached = 0;
  private estimateDirty = true;
  private estimateProvider: Provider | null = null;
  /**
   * F04-11 visibility without warn-spam: set on the first degraded compaction of an episode so
   * the loop warns ONCE, not once per turn while the summarizer stays broken. Cleared by a
   * successful compaction, reset(), and setPolicy() (a new model/budget is a new episode).
   */
  private degradedReported = false;
  /**
   * P1B-02 microcompaction toggle + gate. Held as private fields rather than in `opts` so that
   * policy()/setPolicy keep their original three-key contract (a live test pins the exact shape),
   * while the feature stays configurable through ContextOptions and setPolicy.
   */
  private microcompactOn: boolean;
  private microcompactRatio: number;

  private opts: { contextBudget: number; triggerRatio: number; keepLastTurns: number };

  constructor(opts: ContextOptions) {
    this.opts = {
      contextBudget: opts.contextBudget,
      triggerRatio: opts.triggerRatio,
      keepLastTurns: opts.keepLastTurns,
    };
    this.microcompactOn = opts.microcompact !== false; // default ON
    this.microcompactRatio = normalizeMicrocompactRatio(opts.microcompactRatio);
  }

  /**
   * Move the compaction threshold for a LIVE session (D1).
   *
   * `contextBudget` was copied into readonly opts at construction with no setter, while
   * `/model` mutated `cfg.contextBudget` — which reached the HUD but never `maybeSummarize`.
   * Switching a 200k session onto a 32k local serve therefore showed a red context bar that
   * never triggered a compaction: every turn overflowed, ate a wasted round trip and printed an
   * error, and only recovered because `looksLikeTokenOverflow` force-compacts after the fact.
   * The clamp's own comment already admitted it was "cosmetic".
   *
   * Re-arms the hysteresis: a budget that just SHRANK must be allowed to trigger immediately
   * rather than waiting for the old, larger re-arm point.
   */
  setPolicy(next: Partial<ContextOptions>, resetActualTokens = false): void {
    const contextBudget =
      Number.isFinite(next.contextBudget) && (next.contextBudget ?? 0) > 0
        ? next.contextBudget!
        : this.opts.contextBudget;
    const triggerRatio =
      Number.isFinite(next.triggerRatio) && (next.triggerRatio ?? 0) > 0 && (next.triggerRatio ?? 0) <= 1
        ? next.triggerRatio!
        : this.opts.triggerRatio;
    const keepLastTurns =
      Number.isInteger(next.keepLastTurns) && (next.keepLastTurns ?? 0) > 0
        ? next.keepLastTurns!
        : this.opts.keepLastTurns;
    const shrank = contextBudget < this.opts.contextBudget;
    this.opts = { contextBudget, triggerRatio, keepLastTurns };
    if (typeof next.microcompact === 'boolean') this.microcompactOn = next.microcompact;
    if (
      Number.isFinite(next.microcompactRatio) &&
      (next.microcompactRatio ?? 0) > 0 &&
      (next.microcompactRatio ?? 0) <= 1
    ) {
      this.microcompactRatio = next.microcompactRatio!;
    }
    // Usage from the previous provider/model is not a valid request-size floor for the new one.
    if (resetActualTokens) this.lastActualTokens = 0;
    if (shrank || resetActualTokens) this.rearmAtTokens = 0;
    this.degradedReported = false; // a new model/budget is a new degradation episode
  }

  setBudget(contextBudget: number): void {
    this.setPolicy({ contextBudget });
  }

  /** The live compaction budget (test seam + HUD parity). */
  budget(): number {
    return this.opts.contextBudget;
  }

  policy(): ContextOptions {
    return { ...this.opts };
  }

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
    this.estimateDirty = true; // F06-12
  }

  append(msg: Message): void {
    this.msgs.push(msg);
    this.estimateDirty = true; // F06-12
  }

  /** Drop all history (used by the `/clear` command); the next pinTask re-seeds it. */
  reset(): void {
    this.msgs = [];
    this.pinnedPrefix = 0;
    this.lastActualTokens = 0;
    this.rearmAtTokens = 0;
    this.degradedReported = false;
    this.estimateDirty = true; // F06-12
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
    this.estimateDirty = true; // F06-12: history replaced wholesale
  }

  estimateTokens(provider: Provider): number {
    // Prefer the real last-request size when we have it (accounts for system + tools);
    // the heuristic still wins once history has grown beyond that last measurement.
    // F06-12: the heuristic pass re-runs only after a mutation (see the cache fields) — an
    // unchanged history reuses the last computed pass instead of re-stringifying every tool
    // input. `truncateLocally`'s stop line deliberately bypasses this cache and calls the
    // provider directly: it measures the message-only heuristic, the one quantity
    // tombstoning can move.
    if (this.estimateDirty || this.estimateProvider !== provider) {
      this.estimateCached = provider.estimateTokens(this.msgs);
      this.estimateDirty = false;
      this.estimateProvider = provider;
    }
    return Math.max(this.estimateCached, this.lastActualTokens);
  }

  /**
   * P1B-02 microcompaction (F08-01): the cheapest context win for a long session — clear the
   * BODIES of stale, cheaply-reproducible tool_result blocks IN PLACE, keeping each block, its
   * `toolCallId`, its `ok` flag and its POSITION untouched. The loop's positional tool_use↔
   * tool_result HEALER pairs on toolCallId + position and never inspects `content`, so clearing
   * the text can never break pairing.
   *
   * Runs at a turn boundary BEFORE the summarizer round-trip (gated at a LOWER fraction of the
   * budget, so it reclaims for free first); summarization stays the fallback when clearing bodies
   * is not enough. Returns true if it cleared at least one body.
   *
   * Only results OLDER than the most-recent MICROCOMPACT_KEEP_RECENT messages are touched, and only
   * for tools whose output is bulky and reproducible on demand (read_file/grep/glob/run_shell/
   * web_fetch/web_search). State-bearing results (todo_write/agent/ask_user_question/memory) are
   * never cleared — the model still needs them verbatim. Idempotent: an already-reclaimed body
   * (either sentinel) is left alone — including the F04-11 degradation tombstone, which is
   * forensic evidence that a summarizer failed — so re-running each turn only touches
   * newly-stale results.
   */
  microcompact(provider: Provider): boolean {
    if (!this.microcompactOn) return false;
    const gate = this.opts.contextBudget * Math.min(this.microcompactRatio, this.opts.triggerRatio);
    if (this.estimateTokens(provider) <= gate) return false;

    const cutoff = this.msgs.length - MICROCOMPACT_KEEP_RECENT;
    if (cutoff <= this.pinnedPrefix) return false;

    // A tool_result carries only a toolCallId; the originating tool NAME lives on the matching
    // tool_use block in an earlier assistant turn. Map id → name so we clear only reproducible
    // read-only output.
    const toolNameById = new Map<string, string>();
    for (const m of this.msgs) {
      for (const b of m.content) if (b.type === 'tool_use') toolNameById.set(b.id, b.name);
    }

    let cleared = false;
    for (let i = this.pinnedPrefix; i < cutoff; i++) {
      const m = this.msgs[i]!;
      if (!m.content.some((b) => b.type === 'tool_result')) continue;
      let changed = false;
      const content = m.content.map((b) => {
        if (b.type !== 'tool_result') return b;
        // Idempotent — and never overwrite the degradation tombstone with the generic marker.
        if (b.content === MICROCOMPACT_SENTINEL || b.content === TRUNCATED_RESULT_SENTINEL) return b;
        const name = toolNameById.get(b.toolCallId);
        if (!name || !MICROCOMPACTABLE_TOOLS.has(name)) return b;
        changed = true;
        // Clear ONLY the body; type/toolCallId/ok/position are preserved for the healer.
        return { ...b, content: MICROCOMPACT_SENTINEL };
      });
      if (changed) {
        this.msgs[i] = { ...m, content };
        cleared = true;
      }
    }
    if (cleared) this.estimateDirty = true; // F06-12: tool_result bodies changed in place
    return cleared;
  }

  /**
   * F08-06 overflow ladder rung 2 — replace EVERY image block in history with a small text
   * placeholder. Images cost ~1k tokens each (flat in the estimator, often far more on the wire)
   * and sit in the KEPT tail where summarization never touches them, so a vision-heavy session
   * can stay over the window even after compaction. Losing the image is better than dying on a
   * 400; the placeholder keeps turn structure (and tool_use↔tool_result pairing — images never
   * carry tool ids) intact. Returns the number of image blocks removed (0 = nothing to strip).
   */
  stripImageBlocks(): number {
    let removed = 0;
    for (let i = 0; i < this.msgs.length; i++) {
      const m = this.msgs[i]!;
      if (!m.content.some((b) => b.type === 'image')) continue;
      this.msgs[i] = {
        ...m,
        content: m.content.map((b) =>
          b.type === 'image' ? ({ type: 'text', text: IMAGE_STRIPPED_SENTINEL } as ContentBlock) : b,
        ),
      };
      removed += m.content.filter((b) => b.type === 'image').length;
    }
    if (removed > 0) {
      this.lastActualTokens = 0; // the wire size just changed materially
      this.estimateDirty = true; // F06-12
    }
    return removed;
  }

  /**
   * F08-06 overflow ladder rung 2 — aggressive LOCAL reclamation for a session that is still over
   * the window after a forced compaction. Two lossy-but-survivable cuts, neither requiring a
   * summarizer round trip:
   *  1. every tool_result body is capped HARD (envelope-safe) — much tighter than the normal
   *     kept-tail cap — because at this rung survival beats fidelity;
   *  2. thinking/redacted_thinking blocks are dropped from every assistant turn EXCEPT the last
   *     one (the only turn whose thinking state can matter for continuation).
   * A message whose content would become empty gets a text placeholder instead — providers reject
   * empty assistant turns. Returns true when anything was reclaimed.
   */
  shrinkForOverflow(): boolean {
    let lastAssistant = -1;
    for (let i = this.msgs.length - 1; i >= 0; i--) {
      if (this.msgs[i]!.role === 'assistant') {
        lastAssistant = i;
        break;
      }
    }
    let changed = false;
    for (let i = 0; i < this.msgs.length; i++) {
      const m = this.msgs[i]!;
      let content: ContentBlock[] = m.content.map((b) => {
        if (b.type !== 'tool_result') return b;
        if (b.content.length <= OVERFLOW_TOOL_RESULT_CAP) return b;
        changed = true;
        return {
          ...b,
          content: `${envelopeSafeSlice(b.content, OVERFLOW_TOOL_RESULT_CAP)}\n…[truncated for overflow recovery]`,
        };
      });
      if (i !== lastAssistant && content.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking')) {
        content = content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
        if (content.length === 0) content = [{ type: 'text', text: '[earlier reasoning dropped for overflow recovery]' }];
        changed = true;
      }
      if (changed && content !== m.content) this.msgs[i] = { ...m, content };
    }
    if (changed) {
      this.lastActualTokens = 0;
      this.estimateDirty = true; // F06-12
    }
    return changed;
  }

  /**
   * Collapse the oldest non-pinned turns into a progress note when the estimate crosses
   * contextBudget * triggerRatio.
   *
   * Returns (F04-11 — failure must be distinguishable from a no-op):
   *  - 'summarized' — the summarizer produced a handoff and history was replaced.
   *  - 'truncated'  — the summarizer FAILED (or produced nothing); context was reclaimed
   *                   locally by dropping the oldest tool_result bodies. Degraded, but visible.
   *  - 'failed'     — over budget and nothing could be reclaimed: the summarizer failed with
   *                   nothing droppable left, or history is too short to compact at all.
   *  - false        — nothing to do (under the trigger).
   */
  async maybeSummarize(
    provider: Provider,
    model: string,
    force = false,
    /** ESC must be able to stop a compaction — it is a full provider round trip (D3). */
    signal?: AbortSignal,
    /** The live system prompt + tool schemas, so the count matches the REAL request (D4). */
    countCtx?: {
      system?: string;
      tools?: unknown[];
      /** Goal/todo/plan state that lives outside message history but must shape the handoff. */
      continuity?: string;
      /** Sampling temperature for a self-hosted summarizer request. */
      temperature?: number;
      /** Invoked only once compaction is definitely going to call the summarizer. */
      beforeCompact?: () => void;
      /**
       * F08-06 overflow ladder rung 2: keep HALF the usual tail (floor 2). Used on the second
       * overflow recovery, when a normal compaction already ran and the request is still too long.
       */
      aggressiveKeep?: boolean;
    },
  ): Promise<CompactResult> {
    if (signal?.aborted) return false;
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
            // Pass system + tools (D4): the adapter has always supported them, and omitting them
            // undercounts by exactly the fixed overhead every real request carries.
            const real = await provider.countTokens({
              model,
              messages: this.msgs,
              system: countCtx?.system,
              tools: countCtx?.tools as never,
              signal,
            });
            // NEVER let a count RATCHET THE RECORDED SIZE DOWN. lastActualTokens is the
            // high-water mark of the true size — and a previous reading may have included
            // system+tools+cache that this call omits. Assigning unconditionally could lower it
            // and push the estimate back under the trigger, so a session that genuinely needed
            // compaction quietly stopped compacting.
            if (real > 0) {
              if (real > this.lastActualTokens) this.lastActualTokens = real;
              tokens = Math.max(tokens, real);
            }
          } catch {
            /* ignore, keep heuristic */
          }
        }
        if (tokens <= trigger) return false;
      }
    }

    // Small windows: keep a shorter tail so one compact actually frees space.
    let keep =
      this.opts.contextBudget <= 40_000
        ? Math.min(this.opts.keepLastTurns, 6)
        : this.opts.keepLastTurns;
    if (countCtx?.aggressiveKeep) keep = Math.max(2, Math.floor(keep / 2));
    let end = this.msgs.length - keep;
    // Over budget but history too short to compact: a genuinely stuck state. Under the new
    // contract that must be a VISIBLE failure, not a no-op indistinguishable from health.
    if (end <= this.pinnedPrefix) return tokens > trigger ? 'failed' : false;

    // Don't begin the kept region on an orphaned tool_result: its matching tool_use lives
    // in the preceding turn. Tool results are `tool_result` blocks inside role:'user' turns.
    while (
      end < this.msgs.length &&
      this.msgs[end]!.content.some((b) => b.type === 'tool_result')
    ) {
      end += 1;
    }
    if (end <= this.pinnedPrefix) return tokens > trigger ? 'failed' : false;

    // F06-08: preserved provider reasoning (Qwen/Kimi wire state) is a CONTINUATION contract,
    // not history — the replay path keeps only the newest qualifying turn anyway (toOpenAIMessages),
    // so every older retained copy is dead weight that the token estimator counts char-for-char.
    // Strip it here, during the kept-tail trim, so compaction actually reclaims it and a long
    // session cannot accumulate one full reasoning budget per past turn.
    //
    // Retention is PER DISTINCT MODEL, not newest-global: replay matches on the ACTIVE model
    // (toOpenAIMessages replays only reasoning stamped by it), so a Qwen→Kimi→Qwen switch-back
    // must keep the newest Qwen turn — stripping it because Kimi's is newer would permanently
    // lose the Qwen continuation thread.
    {
      const keptModels = new Set<string>();
      let strippedReasoning = false;
      for (let i = this.msgs.length - 1; i >= 0; i--) {
        const m = this.msgs[i]!;
        if (m.role !== 'assistant' || !m.providerReasoning?.text) continue;
        const model = m.providerReasoning.model;
        if (keptModels.has(model)) {
          delete m.providerReasoning; // in-place mutation of a KEPT message
          strippedReasoning = true;
        } else keptModels.add(model);
      }
      // F06-12: the estimator counts preserved reasoning char-for-char, so a strip moves the
      // heuristic even though the message ARRAY was untouched.
      if (strippedReasoning) this.estimateDirty = true;
    }

    const toSummarize = this.msgs.slice(this.pinnedPrefix, end);
    const pinnedSlice = this.msgs.slice(0, this.pinnedPrefix);

    // Always fold the pinned objective into the summarizer prompt so a weak local model
    // cannot invent a new task — and so the progress note is about THIS work.
    const objectiveLines = harvestInstructions(pinnedSlice);
    const middleLines = harvestInstructions(toSummarize);
    const allInstructions = mergeInstructions(objectiveLines, middleLines);

    const oldTranscript = toSummarize
      .map((m) => `${m.role}: ${m.content.map(blockText).join(' ')}`)
      .join('\n');
    // CURRENT WORK lives overwhelmingly in the tail we keep. The old implementation hid this
    // from the summarizer while demanding CURRENT WORK/NEXT STEP, forcing it to invent a stale
    // continuation from the oldest slice. Show the tail with an explicit "retained" label.
    const recentTranscript = this.msgs
      .slice(end)
      .map((m) => `${m.role}: ${m.content.map(blockText).join(' ')}`)
      .join('\n');

    const objectiveBlock =
      allInstructions.length > 0
        ? `SESSION OBJECTIVE (must preserve verbatim in TASK):\n${allInstructions.map((l) => `• ${l}`).join('\n')}\n\n`
        : '';
    const continuityBlock = countCtx?.continuity?.trim()
      ? `LIVE SESSION STATE (authoritative; preserve it):\n${countCtx.continuity.trim()}\n\n`
      : '';

    let summary = '';
    try {
      countCtx?.beforeCompact?.();
      for await (const ev of provider.send({
        signal, // D3: compaction is a full round trip; without this ESC left the composer locked
                // for 30-60s on a slow local model AFTER "interrupted" had already printed.
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
          '4. CURRENT WORK — derive this from the RECENT RETAINED TAIL, not the older slice.\n' +
          '5. NEXT STEP — the single concrete next action. Do not list "start over" or "re-read the prompt".\n' +
          'The recent tail remains verbatim after this note. If old and recent state conflict, recent wins.\n' +
          'No preamble, no meta-commentary, no sign-off.',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  `${objectiveBlock}${continuityBlock}` +
                  `OLDER HISTORY TO REPLACE:\n${oldTranscript}\n\n` +
                  `RECENT RETAINED TAIL (authoritative current state; this remains verbatim):\n${recentTranscript}`,
              },
            ],
          },
        ],
        tools: [],
        maxOutputTokens: 2048,
        temperature: countCtx?.temperature,
      })) {
        if (ev.type === 'text') summary += ev.delta;
      }
    } catch {
      // F04-11: the summarizer round trip failed. An abort is a user action, not a failure —
      // leave history untouched. Anything else degrades to local truncation instead of silently
      // handing the over-budget session back to a server 400.
      if (signal?.aborted) return false;
      return this.truncateLocally(provider, end, trigger);
    }
    // A provider can yield a partial summary before its fetch notices the abort. Never replace
    // valid history with that truncated handoff: steering and Esc both promise context remains
    // usable for the next turn.
    if (signal?.aborted) return false;
    // An EMPTY summary is a failure too (a model that emitted nothing reclaimed nothing).
    if (!summary.trim()) return this.truncateLocally(provider, end, trigger);

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
            `still the goal. Progress so far and the next action are below. The verbatim recent tail follows ` +
            `this note and wins if it conflicts with the digest. Continue directly from NEXT STEP — ` +
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
    this.estimateDirty = true; // F06-12: history replaced

    // Rearm hysteresis only when compact clearly freed room under the trigger.
    // If still near/over the trigger, rearmAt=0 so the next over-threshold check fires again
    // (with a shorter keep on small budgets) instead of sailing into a server 400.
    // F06-12: route through the cached estimator — identical value (lastActualTokens was just
    // zeroed, so max() collapses to the heuristic) and it seeds the cache for the next reads.
    const after = this.estimateTokens(provider);
    const gap = Math.max(2_000, Math.floor(this.opts.contextBudget * 0.1));
    this.rearmAtTokens = after < trigger * 0.9 ? after + gap : 0;
    this.degradedReported = false; // a healthy compaction ends the degradation episode

    return 'summarized';
  }

  /**
   * F04-11 visibility without warn-spam: returns true exactly once per degradation episode.
   * A persistently failing summarizer re-fires compaction every turn (each attempt can succeed
   * once new reclaimable results arrive, so retrying is right) — but the WARNING must not
   * repeat with it. The loop calls this before emitting the finding/session-log record.
   */
  consumeDegradedReport(): boolean {
    if (this.degradedReported) return false;
    this.degradedReported = true;
    return true;
  }

  /**
   * F04-11 degraded path — the summarizer failed but the session is over budget. Reclaim space
   * locally instead of returning the session to a server 400: tombstone tool_result BODIES in
   * the summarization window, OLDEST FIRST, until the estimate is back under the trigger (or the
   * window is exhausted). Same shape microcompaction and trimKeptMessage prove safe: body only —
   * type / toolCallId / ok / position untouched, so tool_use↔tool_result pairing and the healer
   * are unaffected. Already-reclaimed bodies (either sentinel) are skipped.
   *
   * Two passes: FIRST the bulky reproducible outputs (the MICROCOMPACTABLE_TOOLS class), THEN —
   * only if still over — state-bearing results (agent/todo_write/ask_user_question/memory).
   * Dropping those is real information loss (a sub-agent's only answer may live there), so they
   * are spared whenever reproducible output can still pay the bill; but once nothing else is
   * left, tombstoning them beats handing the session to a server 400 with nothing reclaimed.
   *
   * The stop line measures the message-only heuristic — the one quantity tombstoning can move.
   * An overage driven purely by system/tools overhead cannot be fixed locally and honestly
   * reports 'failed' instead of tombstoning a body for nothing (the overflow backstop still
   * gets its retry shot).
   *
   * Returns 'truncated' when at least one body was reclaimed, 'failed' when there was nothing
   * left to drop (the caller surfaces both — compaction failure is visible, never silent).
   */
  private truncateLocally(provider: Provider, end: number, trigger: number): CompactResult {
    // A tool_result carries only a toolCallId; the originating tool NAME lives on the matching
    // tool_use block in an earlier assistant turn. Map id → name so pass 1 can spare
    // state-bearing results.
    const toolNameById = new Map<string, string>();
    for (const m of this.msgs) {
      for (const b of m.content) if (b.type === 'tool_use') toolNameById.set(b.id, b.name);
    }
    const droppable = (b: ContentBlock, allowStateBearing: boolean): boolean => {
      if (b.type !== 'tool_result') return false;
      if (b.content === TRUNCATED_RESULT_SENTINEL || b.content === MICROCOMPACT_SENTINEL) return false;
      if (allowStateBearing) return true;
      const name = toolNameById.get(b.toolCallId);
      return !!name && MICROCOMPACTABLE_TOOLS.has(name);
    };
    const underStopLine = (): boolean => provider.estimateTokens(this.msgs) <= trigger * 0.9;

    let droppedMessages = 0;
    for (const allowStateBearing of [false, true]) {
      for (let i = this.pinnedPrefix; i < end && !underStopLine(); i++) {
        const m = this.msgs[i]!;
        if (!m.content.some((b) => droppable(b, allowStateBearing))) continue;
        this.msgs[i] = {
          ...m,
          content: m.content.map((b) => (droppable(b, allowStateBearing) ? { ...b, content: TRUNCATED_RESULT_SENTINEL } : b)),
        };
        droppedMessages += 1;
      }
      if (underStopLine()) break;
    }
    if (droppedMessages === 0) return 'failed';
    this.lastActualTokens = 0;
    this.estimateDirty = true; // F06-12: tombstoned bodies moved the heuristic
    // Same value as the direct call (lastActualTokens was just zeroed), but seeds the cache.
    const after = this.estimateTokens(provider);
    const gap = Math.max(2_000, Math.floor(this.opts.contextBudget * 0.1));
    this.rearmAtTokens = after < trigger * 0.9 ? after + gap : 0;
    return 'truncated';
  }
}

// Stable markers for instruction carry-forward across repeated compactions.
const INSTR_HEADER =
  '── TASK & INSTRUCTIONS (verbatim — the source of truth; follow these, the summary below is only a progress digest) ──';
const SUMMARY_HEADER = '── PROGRESS SUMMARY ──';
/** Cap tool_result bodies kept after compact so the kept tail does not re-fill the window. */
const KEPT_TOOL_RESULT_CAP = 2_500;
/** F08-06: much tighter cap applied across history on the overflow ladder's local rung. */
const OVERFLOW_TOOL_RESULT_CAP = 500;

/** F08-06: placeholder left where an image block was stripped during overflow recovery. */
export const IMAGE_STRIPPED_SENTINEL = '[image removed to free context]';

/** P1B-02: replacement body for a stale tool_result whose output was reclaimed in place. */
const MICROCOMPACT_SENTINEL = '[Old tool result content cleared]';
/** F04-11: replacement body when the summarizer FAILED and context was reclaimed locally. */
export const TRUNCATED_RESULT_SENTINEL = '[Tool result dropped — summarizer unavailable; context reclaimed locally]';

/** Outcome of a compaction attempt (F04-11: failure must be distinguishable from no-op). */
export type CompactResult = 'summarized' | 'truncated' | 'failed' | false;
/**
 * Tools whose results are bulky and cheaply reproducible, so microcompaction may clear their
 * stale bodies. Deliberately excludes state-bearing tools (todo_write/agent/ask_user_question/
 * memory) whose output the model still needs verbatim.
 */
const MICROCOMPACTABLE_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'grep',
  'glob',
  'run_shell',
  'web_fetch',
  'web_search',
]);
/**
 * Messages kept verbatim at the tail before microcompaction touches anything (≈ the last 4 tool
 * rounds; a round = assistant tool_use + user tool_result = 2 messages, see config.ts). The model
 * is actively reasoning over this window; older read-only output is reconstructable on demand.
 */
const MICROCOMPACT_KEEP_RECENT = 8;
/** Default microcompaction gate as a fraction of contextBudget (below summarizeTriggerRatio). */
const MICROCOMPACT_DEFAULT_RATIO = 0.7;

/** Validate a microcompaction ratio (0,1]; fall back to the default when absent/out of range. */
function normalizeMicrocompactRatio(v: number | undefined): number {
  return Number.isFinite(v) && (v ?? 0) > 0 && (v ?? 0) <= 1 ? v! : MICROCOMPACT_DEFAULT_RATIO;
}

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
    // User instructions are the source of truth. Never silently truncate them and then depend on
    // a stochastic summary to recreate the missing half.
    if (seen.has(t)) return;
    seen.add(t);
    out.push(t);
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

/** Merge two instruction lists (objective first), losslessly deduped. */
function mergeInstructions(primary: string[], secondary: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const it of [...primary, ...secondary]) {
    if (seen.has(it)) continue;
    seen.add(it);
    out.push(it);
  }
  return out;
}

/** Shrink tool_result payloads in a kept message so post-compact history stays lean.
 *  P3-05: the cut must be ENVELOPE-SAFE — severing a payload from its END marker would leave an
 *  open envelope in the context, exactly the gap a forged bare END inside it needs to read as
 *  "outside". envelopeSafeSlice keeps a prefix whose envelopes still close, and drops an envelope
 *  wholesale when its END would not fit. */
function trimKeptMessage(m: Message): Message {
  let changed = false;
  const content = m.content.map((b) => {
    if (b.type !== 'tool_result') return b;
    if (b.content.length <= KEPT_TOOL_RESULT_CAP) return b;
    changed = true;
    return {
      ...b,
      content: `${envelopeSafeSlice(b.content, KEPT_TOOL_RESULT_CAP)}\n…[truncated after compact]`,
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
