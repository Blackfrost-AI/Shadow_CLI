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

    // The note is framed in the assistant's OWN voice as an explicit mid-task continuation, not a
    // detached report. This is what prevents the post-compaction "Hey! What can I help you with?"
    // greeting: the model reads that it is resuming, sees the NEXT STEP, and acts — it does not
    // restart. (The pinned original task still precedes this note; the kept recent turns follow it.)
    const note: Message = {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text:
            `[Earlier turns were compacted to free up context. This is the state of my in-progress ` +
            `work so I can continue without losing anything:]\n\n${summary.trim()}\n\n` +
            `[Resuming the task now from NEXT STEP above. I will not greet, ask what to help with, ` +
            `or recap — I pick up exactly where I left off and keep working.]`,
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
