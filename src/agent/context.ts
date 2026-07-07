import type { ContentBlock, Message, Provider } from '../provider/provider.js';

export interface ContextOptions {
  contextBudget: number; // token budget that triggers summarization
  triggerRatio: number; // summarize when estimate > contextBudget * ratio (default 0.75)
  keepLastTurns: number; // most-recent turns kept verbatim
}

/**
 * Running message history with a summarization buffer. The original task (and any
 * user-pinned turns) are never summarized away. Summarization never splits a
 * tool_use turn from its matching tool_result turn — both providers reject that.
 */
export class Context {
  private msgs: Message[] = [];
  private pinnedPrefix = 0;
  /** Last REAL request size (input + cache tokens) from the provider's usage event. */
  private lastActualTokens = 0;

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
  }

  messages(): Message[] {
    return this.msgs;
  }

  /** Export restorable state for session snapshots (resume / rewind). */
  exportState(): { messages: Message[]; pinnedPrefix: number; lastActualTokens: number; subAgentTasks?: any[] } {
    return {
      messages: [...this.msgs],
      pinnedPrefix: this.pinnedPrefix,
      lastActualTokens: this.lastActualTokens,
      subAgentTasks: (this as any)._subAgentTasks || [],
    };
  }

  /** Replace history from a snapshot produced by `exportState` / `serializeContext`. */
  loadState(data: { messages: Message[]; pinnedPrefix?: number; lastActualTokens?: number; subAgentTasks?: any[] }): void {
    this.msgs = [...data.messages];
    this.pinnedPrefix = data.pinnedPrefix ?? 0;
    this.lastActualTokens = data.lastActualTokens ?? 0;
    (this as any)._subAgentTasks = data.subAgentTasks || [];
  }

  estimateTokens(provider: Provider): number {
    // Prefer the real last-request size when we have it (accounts for system + tools);
    // the heuristic still wins once history has grown beyond that last measurement.
    return Math.max(provider.estimateTokens(this.msgs), this.lastActualTokens);
  }

  /**
   * Collapse the oldest non-pinned turns into a single summary note when the
   * estimate crosses contextBudget * triggerRatio. Returns true if it summarized.
   */
  async maybeSummarize(provider: Provider, model: string, force = false): Promise<boolean> {
    let tokens = this.estimateTokens(provider);
    if (!force && tokens <= this.opts.contextBudget * this.opts.triggerRatio) {
      // Opportunistic: if the provider can give a real count (Anthropic count_tokens),
      // use it when we're in the "maybe" zone to avoid premature or late compaction.
      if (provider.countTokens && tokens > this.opts.contextBudget * 0.6) {
        try {
          const real = await provider.countTokens({ model, messages: this.msgs });
          if (real > 0) {
            this.lastActualTokens = real; // cache for next estimates
            tokens = real;
          }
        } catch {
          /* ignore, keep heuristic */
        }
      }
      if (tokens <= this.opts.contextBudget * this.opts.triggerRatio) return false;
    }

    let end = this.msgs.length - this.opts.keepLastTurns;
    if (end <= this.pinnedPrefix) return false;

    // Don't begin the kept region on an orphaned tool_result: its matching
    // tool_use lives in the preceding turn, which would be collapsed into the
    // summary, and both providers reject a tool_result with no matching tool_use.
    // Tool results are stored as `tool_result` blocks inside role:'user' turns
    // (not a 'tool' role), so detect them by content, not by role, and advance
    // past any such turn until the kept region starts on a clean boundary.
    while (
      end < this.msgs.length &&
      this.msgs[end]!.content.some((b) => b.type === 'tool_result')
    ) {
      end += 1;
    }
    if (end <= this.pinnedPrefix) return false;

    const toSummarize = this.msgs.slice(this.pinnedPrefix, end);
    const transcript = toSummarize
      .map((m) => `${m.role}: ${m.content.map(blockText).join(' ')}`)
      .join('\n');

    let summary = '';
    try {
      for await (const ev of provider.send({
        model,
        // Structured summary — not a terse blob. The agent reads this to RESUME with zero loss, so
        // it must carry the task, the current work, and the concrete next step (not just "what
        // happened"). The TASK section is load-bearing: it's what stops the model treating the
        // compaction as a fresh session and greeting the user.
        system:
          'You are compacting an IN-PROGRESS agent session so it can continue with a smaller ' +
          'context window. Write a structured summary the agent will read to resume its work with ' +
          'ZERO loss of task or momentum. Use exactly these sections, terse but complete:\n' +
          '1. TASK — the user\'s original request and current goal, stated so it cannot be misread. ' +
          'This is the most important line; never drop or soften it.\n' +
          '2. DECISIONS & FACTS — key findings, constraints, and choices made so far.\n' +
          '3. FILES & COMMANDS — paths created/edited and notable command outcomes.\n' +
          '4. CURRENT WORK — precisely what was underway at the moment of this summary.\n' +
          '5. NEXT STEP — the single concrete next action to take to keep going.\n' +
          'No preamble, no meta-commentary, no sign-off.',
        messages: [{ role: 'user', content: [{ type: 'text', text: transcript }] }],
        tools: [],
        maxOutputTokens: 2048, // room for the structured form; a truncated summary is a lost task
      })) {
        if (ev.type === 'text') summary += ev.delta;
      }
    } catch {
      // If summarization fails, leave history intact rather than losing it.
      return false;
    }
    if (!summary.trim()) return false; // empty summary → don't destroy history for nothing

    // The note is a USER turn (a system-style directive), NOT an assistant turn. An assistant note
    // spliced directly before the kept region — which begins on an assistant turn carrying leading
    // SIGNED thinking + tool_use — coalesces with it on Anthropic, pushing the thinking block off the
    // front → 400 "thinking blocks must be first"; it also emitted two back-to-back assistant messages
    // that strict local (GLM/Lumix) chat templates reject. As a user turn it alternates cleanly with the
    // kept assistant turn across every adapter. The directive still prevents the post-compaction
    // "Hey! What can I help you with?" greeting: it tells the model to resume from NEXT STEP.
    const note: Message = {
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            `[System note: earlier turns in this session were compacted to free up context. Below is the ` +
            `preserved state of the in-progress work. Continue the task directly from NEXT STEP — do NOT ` +
            `greet, ask what to help with, or recap; pick up exactly where you left off and keep working.]` +
            `\n\n${summary.trim()}`,
        },
      ],
    };
    this.msgs = [...this.msgs.slice(0, this.pinnedPrefix), note, ...this.msgs.slice(end)];
    // History just shrank; drop the stale (larger) real count so it doesn't re-trigger
    // summarization before the next turn re-measures.
    this.lastActualTokens = 0;
    return true;
  }
}

function blockText(b: ContentBlock): string {
  switch (b.type) {
    case 'text':
      return b.text;
    case 'thinking':
      return ''; // reasoning is ephemeral — excluded from the summarization transcript
    case 'redacted_thinking':
      return ''; // encrypted reasoning — no readable text
    case 'image':
      return '[image]'; // multimodal input — note its presence for the summarization transcript
    case 'tool_use':
      return `[call ${b.name} ${JSON.stringify(b.input)}]`;
    case 'tool_result':
      return `[result ${b.content}]`;
  }
}
