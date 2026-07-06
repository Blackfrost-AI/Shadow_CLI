import type { CompletionRequest, ContentBlock, Effort, ImageBlock, Message, Provider, ToolCall, ToolUseBlock } from '../provider/provider.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolContext, ToolResult, ToolRisk } from '../tools/types.js';
import { isAutonomyAtLeast, needsApproval, type AutonomyLevel } from '../safety/permissions.js';
import { isBashReadOnly } from '../safety/bashReadOnly.js';
import { classifyToolCall } from '../safety/classifier.js';
import { resolvePermissionRule, type PermissionRule } from '../safety/rules.js';
import type { ShadowConfig } from '../config.js';
import { runHooks, runHookPhase } from '../hooks/runner.js';
import { isFallbackEligible, resolveFallbackModel } from '../provider/fallback.js';
import type { UserQuestion } from './approval.js';
import { askUserInputSchema } from '../tools/askUser.js';
import type { ModelEntry } from '../config.js';
import type { ApprovalGate } from './approval.js';
import type { EventBus, StopReasonExt } from './events.js';
import type { Budget } from './budget.js';
import type { Context } from './context.js';
import { SessionLog, type SessionLog as SessionLogType } from '../state/session.js';
import type { TodoList } from './todo.js';
import type { PlanModeState } from './planMode.js';
import { createReadTracker } from '../tools/readTracker.js';
import { redactString } from '../util/redact.js';
import { sniffToolCalls } from '../provider/textToolCalls.js';
import { normalizeForeignTool } from '../tools/foreignAdapter.js';
import { extractPatchBlock } from '../provider/applyPatch.js';
import { scrubControlTokens } from '../util/scrub.js';
import { DEFAULT_EFFORT, effortDirective } from './effort.js';

export interface LoopDeps {
  provider: Provider;
  registry: ToolRegistry;
  gate: ApprovalGate;
  bus: EventBus;
  budget: Budget;
  context: Context;
  signal: AbortSignal; // Ctrl-C / interrupt
  model: string;
  system: string;
  maxOutputTokens: number;
  /** Reasoning depth for adaptive-thinking models; ignored by providers without it. */
  effort?: Effort;
  /** Anthropic prompt-cache TTL for the stable prefix (default 5m). */
  cacheTtl?: '5m' | '1h';
  /** Anthropic fast mode (premium low-latency); ignored by other providers. */
  fastMode?: boolean;
  workspaceRoot: string;
  /** Extra granted roots (additionalDirectories / --add-dir) file tools + the sandbox may use. */
  additionalRoots?: string[];
  dryRun: boolean;
  maxToolResultChars: number;
  contextBudget: number; // tokens, for the HUD context-% readout
  /** Optional extra gate: returns a reason string if a call must be confirmed regardless of level. */
  forceConfirm?: (call: ToolCall, risk: string) => string | null;
  /**
   * Optional session-scoped todo list. If present, the loop renders its current
   * contents into the system prompt each turn (summarization-proof — the system
   * prompt is re-sent fresh every turn and never enters the message history) so
   * the model always sees its plan pinned in front of it. The `todo_write` tool
   * mutates this list; the loop emits a `todo` event for each write so the TUI
   * can render live progress.
   */
  todoList?: TodoList;
  planMode?: PlanModeState;
  permissionRules?: PermissionRule[];
  autoClassifier?: boolean;
  hooks?: ShadowConfig['hooks']; // full set; only some phases are invoked from the loop today
  models?: ModelEntry[];
  fallbackModel?: string;
  parallelTools?: boolean;
  streamShell?: boolean;
  now?: () => number;
  /** When set, a context snapshot is written after each assistant turn. */
  sessionLog?: SessionLogType;
}

export interface LoopResult {
  stopReason: StopReasonExt;
  finalAnswer: string;
}

/** Bad-tool-call-JSON corrections fed back to the model before giving up (per run). */
const MAX_REPAIR_ATTEMPTS = 3;
/** Nth CONSECUTIVE identical (tool+args) call that gets a loop-guard nudge instead of running. */
const LOOP_GUARD_LIMIT = 3;
/** Synthetic tool_result content for a tool_use orphaned by an interrupt (ESC/Ctrl-C). */
const INTERRUPTED_RESULT = 'Tool execution was interrupted (ESC / Ctrl-C) before this call produced a result.';

export class AgentLoop {
  private autonomy: AutonomyLevel;
  private effort: Effort;
  private readonly now: () => number;
  private repairAttempts = 0; // malformed-JSON tool-arg retries
  private toolUseRetries = 0; // distinct budget: tool_use signaled but no call parsed
  private lastCallSig: string | null = null; // loop guard: signature of the previous tool call
  private consecutiveRepeats = 0; // loop guard: how many times that signature ran back-to-back
  private readonly readTracker = createReadTracker();
  private readonly approvedPlanExitIds = new Set<string>();
  private fallbackUsed = false;
  private turnIndex = 0;
  private readonly sessionToolApprovals = new Set<string>();
  private readonly sessionPrefixApprovals: string[] = [];

  constructor(
    private readonly deps: LoopDeps,
    autonomy: AutonomyLevel,
  ) {
    this.autonomy = autonomy;
    this.effort = deps.effort ?? DEFAULT_EFFORT;
    this.now = deps.now ?? Date.now;
  }

  setAutonomy(level: AutonomyLevel): void {
    this.autonomy = level;
    this.deps.bus.emit({ type: 'autonomy', level });
  }

  /**
   * Hot-swap the reasoning effort mid-session (used by the TUI `/effort` command).
   * Applies on the next provider turn; the directive is re-sent fresh every turn,
   * so a live change takes effect immediately and is summarization-proof.
   */
  setEffort(level: Effort): void {
    this.effort = level;
  }

  /** Hot-swap the active model mid-session (used by the TUI `/model` picker). */
  setProvider(provider: Provider, model: string): void {
    this.deps.provider = provider;
    this.deps.model = model;
  }

  /** Update permission rules mid-session (used by `/permissions` edits). */
  setPermissionRules(rules: PermissionRule[]): void {
    this.deps.permissionRules = rules;
  }

  async run(): Promise<LoopResult> {
    const { provider, bus, budget, context } = this.deps;
    let finalAnswer = '';

    for (;;) {
      if (this.deps.signal.aborted) return this.stop('interrupted', finalAnswer);

      const stop = budget.check(this.now());
      if (stop) return this.stop(stop, finalAnswer);

      bus.emit({ type: 'mode', mode: 'thinking' });
      // Render the live todo list into the system prompt each turn. The system
      // prompt is re-sent fresh every turn and is never part of the summarizable
      // message history, so this is summarization-proof and always current. The
      // block is '' until the model writes its first list, so this is a no-op
      // before the model calls todo_write.
      // Rebuild the system prompt each turn: base profile + the live effort directive
      // (model-agnostic — see agent/effort.ts) + plan/todo blocks. Joined with blank
      // lines so sections never glue together; empties are dropped.
      const sys = [
        this.deps.system,
        effortDirective(this.effort),
        this.deps.planMode?.block() ?? '',
        this.deps.todoList?.block() ?? '',
      ]
        .filter((s) => s && s.trim())
        .join('\n\n');
      const req: CompletionRequest = {
        model: this.deps.model,
        system: sys,
        // Defense-in-depth: an already-corrupt history (e.g. a snapshot taken mid-
        // interrupt by an older build) can end on an assistant tool_use with no
        // matching tool_result — which 400s every request. Heal it before sending.
        messages: this.healDanglingToolUses(context.messages()),
        tools: this.deps.registry.toSchemas(),
        maxOutputTokens: this.deps.maxOutputTokens,
        effort: this.effort,
        cacheTtl: this.deps.cacheTtl,
        fastMode: this.deps.fastMode,
        signal: this.deps.signal, // so ESC cancels the in-flight request immediately
      };

      const turn = await this.runProviderTurnWithFallback(provider, req);
      budget.tick();

      // Recover tool calls a weaker model emitted as TEXT (e.g. <tool_call>{…}</tool_call>,
      // call:NAME{…}, {"tool_calls":[…]}) instead of via the native channel — only when the
      // turn produced no real calls, and only for registered tool names. Scan the CONTENT
      // stream first, then the REASONING stream: some thinking models sometimes emit the
      // <tool_call> XML inside their reasoning and strand the turn. The
      // !badJsonMsg guard is intentionally absent here — a clean TEXT call must still be
      // recovered even when a *separate* native attempt was malformed; `toolCalls.length===0`
      // already prevents double-executing a real native call.
      if (turn.toolCalls.length === 0) {
        const isKnown = (n: string): boolean => this.deps.registry.get(n) !== undefined;
        const toCalls = (calls: { name: string; input: unknown }[]): ToolCall[] =>
          calls.map((c, i) => ({ id: `txt_${this.now()}_${i}`, name: c.name, input: c.input }));
        const fromText = turn.text ? sniffToolCalls(turn.text, isKnown) : null;
        const fromThinking =
          fromText && fromText.calls.length > 0
            ? null
            : turn.thinkingText
              ? sniffToolCalls(turn.thinkingText, isKnown)
              : null;
        if (fromText && fromText.calls.length > 0) {
          turn.toolCalls = toCalls(fromText.calls);
          turn.text = fromText.cleaned;
        } else if (fromThinking && fromThinking.calls.length > 0) {
          // Recovered from the reasoning stream. Map the call exactly as a content
          // recovery would, and strip the recovered span from the SURFACED reasoning
          // only (turn.thinkingText is display-only). The signed history-bearing blocks
          // (turn.thinkingBlocks, with their signatures) are left untouched, so the
          // "thinking blocks lead the turn / signatures preserved" invariant the
          // Anthropic adapter relies on still holds.
          turn.toolCalls = toCalls(fromThinking.calls);
          turn.thinkingText = fromThinking.cleaned;
        } else if (this.deps.registry.get('apply_patch') && turn.text) {
          // A Codex/Grok-class model may print the whole `*** Begin Patch … *** End Patch`
          // envelope as text. Recover it into an apply_patch call — passing the raw patch
          // straight through (NOT via the JSON repair ladder, which would mangle the markers).
          const patch = extractPatchBlock(turn.text);
          if (patch) {
            turn.toolCalls = [{ id: `txt_${this.now()}_patch`, name: 'apply_patch', input: { patch: patch.patch } }];
            turn.text = patch.cleaned;
          }
        }
      }
      // Strip leaked chat-template / control tokens from the committed answer.
      turn.text = scrubControlTokens(turn.text);

      // Commit the assistant turn to history. Thinking blocks lead the turn (the
      // Anthropic adapter requires it) and MUST be preserved with their signatures
      // or the next request 400s when this turn carried tool_use.
      const assistantBlocks: ContentBlock[] = [];
      for (const tb of turn.thinkingBlocks) {
        // Stamp the producing model so a later /model switch drops these (their
        // signatures / encrypted blobs are only valid for the model that issued them).
        if ('redactedData' in tb) {
          assistantBlocks.push({ type: 'redacted_thinking', data: tb.redactedData, model: this.deps.model });
        } else if (tb.signature) {
          assistantBlocks.push({ type: 'thinking', thinking: tb.thinking, signature: tb.signature, model: this.deps.model });
        }
      }
      if (turn.text) assistantBlocks.push({ type: 'text', text: turn.text });
      for (const c of turn.toolCalls) {
        assistantBlocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input, ...(c.signature ? { signature: c.signature } : {}) });
      }
      if (assistantBlocks.length) {
        context.append({ role: 'assistant', content: assistantBlocks });
        if (turn.thinkingText.trim()) {
          bus.emit({ type: 'reasoning_done', text: turn.thinkingText });
        }
        bus.emit({ type: 'assistant_done', text: turn.text });
        // An interrupt (ESC/Ctrl-C) that lands AFTER a tool_use is committed but
        // BEFORE its tool ran leaves the turn unpaired. Synthesize an {ok:false}
        // tool_result for every such tool_use BEFORE snapshotting — both so the
        // snapshot is restorable and so the next request doesn't 400 on a dangling
        // tool_use. Only snapshot once the turn is paired.
        if (this.deps.signal.aborted && turn.toolCalls.length > 0) {
          const synthetic = this.synthesizeMissingResults(turn.toolCalls, []);
          if (synthetic.length) context.append({ role: 'user', content: synthetic });
        }
        if (this.deps.sessionLog) {
          this.deps.sessionLog.recordSnapshot(context, this.turnIndex);
          this.turnIndex += 1;
        }
      }
      if (turn.text) finalAnswer = turn.text;

      // Interrupted mid-turn (ESC / Ctrl-C broke the stream) → report it as such,
      // not as a natural end_turn.
      if (this.deps.signal.aborted) return this.stop('interrupted', finalAnswer);

      // No tools requested. Either the task is done, OR the model TRIED to call a
      // tool but its JSON was unrepairable — in which case feed the error back and
      // let it retry (the load-bearing local-model fix) rather than stop silently.
      if (turn.toolCalls.length === 0) {
        if (turn.badJsonMsg) {
          if (this.repairAttempts < MAX_REPAIR_ATTEMPTS) {
            this.repairAttempts += 1;
            bus.emit({ type: 'retry', attempt: this.repairAttempts, delayMs: 0, reason: 'malformed tool-call JSON' });
            context.append({
              role: 'user',
              content: [
                {
                  type: 'text',
                  text:
                    `Your previous message tried to call a tool, but its arguments were not valid JSON ` +
                    `(${turn.badJsonMsg}). Re-send the tool call with valid JSON arguments and nothing else.`,
                },
              ],
            });
            continue;
          }
          // Out of repair attempts — the model kept emitting unusable tool calls.
          return this.stop('fatal_tool_error', finalAnswer);
        }

        // The model SIGNALED a tool call (finish_reason tool_calls / stop_reason tool_use)
        // but none parsed into a call — don't report a clean stop; nudge it to resend.
        if (turn.stopReason === 'tool_use') {
          if (this.toolUseRetries < MAX_REPAIR_ATTEMPTS) {
            this.toolUseRetries += 1;
            bus.emit({ type: 'retry', attempt: this.toolUseRetries, delayMs: 0, reason: 'tool call signaled but none parsed' });
            context.append({
              role: 'user',
              content: [{ type: 'text', text: 'You indicated a tool call but none was received. Re-send it using the function-calling format.' }],
            });
            continue;
          }
          return this.stop('fatal_tool_error', finalAnswer);
        }

        // A recoverable provider error mid-stream (e.g. an OpenAI 200 error frame) that
        // left the turn empty — surface it instead of a silent end_turn.
        if (turn.providerError && !finalAnswer) {
          bus.emit({ type: 'error', message: redactString(`${turn.providerError.code}: ${turn.providerError.message}`) });
          return this.stop('provider_error', finalAnswer);
        }

        // Hit the output cap before emitting any answer (common on reasoning models that
        // spend the whole budget thinking) — say so rather than returning empty success.
        if (turn.stopReason === 'max_tokens' && !finalAnswer) {
          bus.emit({ type: 'error', message: 'Model hit the output-token cap before producing an answer — raise --max-output-tokens (reasoning models need headroom).' });
          return this.stop('max_tokens', finalAnswer);
        }

        // A paused long turn (server `pause_turn`): the partial assistant turn is
        // committed above — re-request to let the model continue rather than stop.
        // budget.check (iterations/tokens/wall-clock) bounds any runaway pausing.
        if (turn.stopReason === 'pause_turn') continue;
        return this.stop(turn.stopReason ?? 'end_turn', finalAnswer);
      }

      // Execute tool calls (parallel when configured); collect results into one user turn.
      bus.emit({ type: 'mode', mode: 'acting' });
      const resultBlocks: ContentBlock[] = [];
      // Images a tool (view_image) loaded this turn — appended AFTER all tool_result blocks
      // so the user turn stays "tool_results first" (Anthropic's ordering rule), then images.
      const turnImages: ImageBlock[] = [];
      let fatal = false;
      const runCalls = async (calls: ToolCall[]) => {
        const blocks: ContentBlock[] = [];
        for (const call of calls) {
          if (this.deps.signal.aborted) return { blocks, fatal: true };
          const { block, isFatal, images } = await this.executeCall(call);
          blocks.push(block);
          if (images) turnImages.push(...images);
          if (isFatal) return { blocks, fatal: true };
        }
        return { blocks, fatal: false };
      };
      const gateTools = new Set(['enter_plan_mode', 'exit_plan_mode', 'ask_user_question']);
      const parallelOk =
        this.deps.parallelTools !== false &&
        turn.toolCalls.length > 1 &&
        !this.deps.planMode?.active &&
        !turn.toolCalls.some((c) => gateTools.has(c.name)) &&
        // Serialize permission-gated calls so approve-for-session applies before siblings run.
        !turn.toolCalls.some((c) => this.mayNeedPermissionPrompt(c));
      if (parallelOk) {
        const parts = await Promise.all(turn.toolCalls.map((call) => this.executeCall(call)));
        for (const p of parts) {
          resultBlocks.push(p.block);
          if (p.images) turnImages.push(...p.images);
          if (p.isFatal) fatal = true;
        }
      } else {
        const r = await runCalls(turn.toolCalls);
        resultBlocks.push(...r.blocks);
        fatal = r.fatal;
      }
      // An interrupt during serial execution (runCalls early-abort) leaves the not-
      // yet-run tool_use blocks without results. Pair every orphan with a synthetic
      // {ok:false} tool_result before this user turn is committed, or the dangling
      // tool_use 400s every later request and corrupts the snapshot.
      resultBlocks.push(...this.synthesizeMissingResults(turn.toolCalls, resultBlocks));
      // A mixed turn (some calls ran, some had malformed JSON) silently dropped the bad
      // ones — tell the model so it can resend them, alongside the good calls' results.
      if (turn.badCalls.length > 0) {
        resultBlocks.push({
          type: 'text',
          text:
            `Note: ${turn.badCalls.length} tool call(s) in your last message had invalid JSON arguments and were NOT run ` +
            `(${turn.badCalls.join('; ')}). Re-send those calls with valid JSON.`,
        });
      }
      // Images loaded by view_image ride the same user turn, after the tool_result blocks.
      if (turnImages.length > 0) resultBlocks.push(...turnImages);
      context.append({ role: 'user', content: resultBlocks });

      if (fatal) return this.stop('fatal_tool_error', finalAnswer);

      const stop2 = budget.check(this.now());
      if (stop2) return this.stop(stop2, finalAnswer);

      try {
        if (this.deps.hooks?.pre_compact?.length) {
          runHookPhase('pre_compact', this.deps.hooks.pre_compact, { workspaceRoot: this.deps.workspaceRoot });
        }
        const didCompact = await context.maybeSummarize(provider, this.deps.model);
        if (didCompact) {
          // Surface auto-compaction: the TUI shows it live, and the eval harness can
          // confirm the compaction task ACTUALLY summarized (not merely got the sum right).
          this.deps.bus.emit({ type: 'compaction', trigger: 'auto' });
        }
        if (this.deps.hooks?.post_compact?.length) {
          runHookPhase('post_compact', this.deps.hooks.post_compact, { workspaceRoot: this.deps.workspaceRoot });
        }
      } catch {
        // non-fatal
      }
    }
  }

  /** Try the active model; on fallback-eligible failure swap model once and retry. */
  private async runProviderTurnWithFallback(
    provider: Provider,
    req: CompletionRequest,
  ): Promise<{
    text: string;
    toolCalls: ToolCall[];
    thinkingBlocks: Array<{ thinking: string; signature: string } | { redactedData: string }>;
    thinkingText: string;
    stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'pause_turn';
    badJsonMsg?: string;
    badCalls: string[];
    providerError?: { code: string; message: string };
  }> {
    let model = this.deps.model;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const turn = await this.runProviderTurn(provider, { ...req, model });
        const err = turn.providerError;
        if (
          attempt === 0 &&
          err &&
          !turn.text &&
          turn.toolCalls.length === 0 &&
          // An error frame / truncated stream still emits done('end_turn'); allow fallback there
          // too (it only fires when `err` is set + the turn is empty anyway).
          (!turn.stopReason || turn.stopReason === 'end_turn') &&
          !turn.badJsonMsg &&
          isFallbackEligible(err.code, err.message, parseHttpStatus(err.code))
        ) {
          const fb = resolveFallbackModel(model, this.deps.models ?? [], this.deps.fallbackModel);
          if (fb && fb !== model) {
            this.fallbackUsed = true;
            const from = model;
            model = fb;
            this.deps.model = fb;
            this.deps.bus.emit({ type: 'model_fallback', from, to: fb, reason: err.message });
            continue;
          }
        }
        return turn;
      } catch (err) {
        const e = err as Error;
        const code = e.message.split(':')[0]?.trim() ?? 'error';
        const fb = resolveFallbackModel(model, this.deps.models ?? [], this.deps.fallbackModel);
        if (
          attempt === 0 &&
          fb &&
          fb !== model &&
          isFallbackEligible(code, e.message, parseHttpStatus(code))
        ) {
          this.fallbackUsed = true;
          const from = model;
          model = fb;
          this.deps.model = fb;
          this.deps.bus.emit({ type: 'model_fallback', from, to: fb, reason: e.message });
          continue;
        }
        throw err;
      }
    }
    return this.runProviderTurn(provider, { ...req, model });
  }

  /** Consume one provider stream into accumulated text, tool calls, and stop reason. */
  private async runProviderTurn(
    provider: Provider,
    req: CompletionRequest,
  ): Promise<{
    text: string;
    toolCalls: ToolCall[];
    thinkingBlocks: Array<{ thinking: string; signature: string } | { redactedData: string }>;
    thinkingText: string;
    stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'pause_turn';
    badJsonMsg?: string;
    badCalls: string[];
    providerError?: { code: string; message: string };
  }> {
    const t0 = this.now();
    let text = '';
    const toolCalls: ToolCall[] = [];
    const thinkingBlocks: Array<{ thinking: string; signature: string } | { redactedData: string }> = [];
    let thinkingText = '';
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'pause_turn' | undefined;
    let badJsonMsg: string | undefined;
    const badCalls: string[] = [];
    let providerError: { code: string; message: string } | undefined;

    try {
      for await (const ev of provider.send(req)) {
        if (this.deps.signal.aborted) break; // ESC / Ctrl-C — stop consuming the stream now
        switch (ev.type) {
          case 'text':
            text += ev.delta;
            this.deps.bus.emit({ type: 'text', delta: ev.delta });
            break;
          case 'thinking':
            thinkingText += ev.delta;
            this.deps.bus.emit({ type: 'thinking', delta: ev.delta });
            break;
          case 'thinking_block':
            // Stash the signed reasoning block; run() prepends it to the assistant
            // turn so it round-trips back to the API on the next request.
            thinkingBlocks.push({ thinking: ev.thinking, signature: ev.signature });
            break;
          case 'redacted_thinking_block':
            // Encrypted reasoning — keep it in order with signed blocks so the whole
            // reasoning prefix echoes back verbatim (the API 400s otherwise).
            thinkingBlocks.push({ redactedData: ev.data });
            break;
          case 'tool_call':
            toolCalls.push(ev.call);
            break;
          case 'usage': {
            this.deps.budget.recordUsage(ev, this.now());
            // Feed the REAL request size back to the context so summarization + the
            // context-% HUD use exact tokens (incl. system + tools), not the char/4 guess.
            this.deps.context.recordActualTokens(
              ev.inputTokens + (ev.cacheReadTokens ?? 0) + (ev.cacheWriteTokens ?? 0),
            );
            const snap = this.deps.budget.snapshot(this.now());
            const pct =
              this.deps.context.estimateTokens(provider) / Math.max(1, this.deps.contextBudget);
            this.deps.bus.emit({
              type: 'usage',
              inputTokens: snap.inputTokens,
              outputTokens: snap.outputTokens,
              costUSD: snap.costUSD,
              contextPct: Math.min(1, pct),
            });
            break;
          }
          case 'error':
            // Redact: a provider error body can echo the request (incl. the key) and
            // this message is shown on the HUD/stdout, not just the redacted session log.
            this.deps.bus.emit({ type: 'error', message: redactString(`${ev.code}: ${ev.message}`) });
            if (ev.code === 'bad_tool_json') {
              badJsonMsg = ev.message;
              badCalls.push(ev.message); // every malformed call, so a mixed turn can feed them all back
            } else providerError = { code: ev.code, message: ev.message };
            if (!ev.recoverable) throw new Error(`${ev.code}: ${ev.message}`);
            break;
          case 'done':
            stopReason = ev.stopReason;
            break;
          case 'tool_call_partial':
            break; // surfaced to the HUD in M3; ignored here
        }
      }
    } catch (err) {
      // An aborted fetch (ESC mid-stream) throws — that's a clean interrupt, not an
      // error; run() sees signal.aborted next and stops with 'interrupted'.
      if (!this.deps.signal.aborted) throw err;
    } finally {
      this.deps.bus.emit({ type: 'latency', ms: this.now() - t0 });
    }
    return { text, toolCalls, thinkingBlocks, thinkingText, stopReason, badJsonMsg, badCalls, providerError };
  }

  /** Gate, validate, and run one tool call; return its result block. */
  private async executeCall(call: ToolCall): Promise<{ block: ContentBlock; isFatal: boolean; images?: ImageBlock[] }> {
    const { registry, bus } = this.deps;
    const normalized = normalizeForeignTool({ name: call.name, input: call.input });
    call.name = normalized.name;
    call.input = normalized.input;
    const tool = registry.get(call.name);
    if (!tool) {
      const result: ToolResult = {
        ok: false,
        summary: `unknown tool: ${call.name}`,
        error: { code: 'unknown_tool', message: `unknown tool: ${call.name}`, recoverable: true },
        meta: { tool: call.name, durationMs: 0, risk: 'read' },
      };
      this.emitToolEnd(call, result);
      return { block: this.resultBlock(call.id, false, this.serialize(result)), isFatal: false };
    }

    // Canonicalize the call name to the RESOLVED tool (registry.get maps aliases like
    // bash→run_shell). Everything downstream — the catastrophic-command denylist, permission
    // rules, the gate, schema validation, and history — must key on the real tool, not the
    // alias, or a `bash`/`shell` call would slip past the run_shell guards.
    call.name = tool.name;

    // Loop guard: a model stuck calling the same tool with the same args gets a
    // distinct result so it changes course, instead of spinning to the iteration cap.
    // Count only CONSECUTIVE identical calls — any different tool call in between
    // resets the counter, so a legitimate edit→test→edit cycle is never tripped.
    const sig = `${call.name}:${safeJson(call.input) ?? ''}`;
    if (sig === this.lastCallSig) {
      this.consecutiveRepeats += 1;
    } else {
      this.lastCallSig = sig;
      this.consecutiveRepeats = 1;
    }
    if (this.consecutiveRepeats >= LOOP_GUARD_LIMIT) {
      bus.emit({ type: 'tool_denied', call, reason: 'repeated identical call (loop guard)' });
      return {
        block: this.resultBlock(
          call.id,
          false,
          `You have called ${call.name} with these exact arguments ${this.consecutiveRepeats} times in a row ` +
            `with no other action between. Take a different action, or stop if the task is complete.`,
        ),
        isFatal: false,
      };
    }

    const preview = previewOf(call);

    // enter_plan_mode — user must approve before plan mode activates.
    if (call.name === 'enter_plan_mode') {
      const parsed = tool.inputSchema.safeParse(call.input) as
        | { success: true; data: { reason: string } }
        | { success: false; error: { issues: Array<{ path: (string | number)[]; message: string }> } };
      if (!parsed.success) return this.invalidInput(call, tool.risk, formatZodError(call.name, parsed.error));
      if (this.deps.planMode?.active) {
        bus.emit({ type: 'tool_start', call, risk: tool.risk });
        const result: ToolResult = {
          ok: true,
          summary: 'Already in plan mode.',
          data: { mode: 'planning' },
          meta: { tool: call.name, durationMs: 0, risk: tool.risk },
        };
        this.emitToolEnd(call, result);
        return { block: this.resultBlock(call.id, true, this.serialize(result)), isFatal: false };
      }
      const decision = await this.deps.gate.request({
        kind: 'plan_enter',
        call,
        risk: tool.risk,
        reason: parsed.data.reason,
        preview: parsed.data.reason,
      });
      if (decision === 'deny') {
        bus.emit({ type: 'tool_denied', call, reason: 'plan enter denied by user' });
        return {
          block: this.resultBlock(call.id, false, 'Plan mode entry was denied. Continue without planning or revise the request.'),
          isFatal: false,
        };
      }
      this.deps.planMode?.enter();
      bus.emit({ type: 'tool_start', call, risk: tool.risk });
      const result: ToolResult = {
        ok: true,
        summary: `Plan mode active: ${parsed.data.reason}`,
        data: { mode: 'planning' },
        meta: { tool: call.name, durationMs: 0, risk: tool.risk },
      };
      this.emitToolEnd(call, result);
      return { block: this.resultBlock(call.id, true, this.serialize(result)), isFatal: false };
    }

    // ask_user_question — answers collected via the approval gate.
    if (call.name === 'ask_user_question') {
      const parsed = askUserInputSchema.safeParse(call.input);
      if (!parsed.success) return this.invalidInput(call, tool.risk, formatZodError(call.name, parsed.error));
      const decision = await this.deps.gate.request({
        kind: 'user_question',
        call,
        risk: tool.risk,
        reason: 'The model needs your input to continue.',
        preview: parsed.data.questions.map((q) => q.question).join('; '),
        questions: parsed.data.questions as UserQuestion[],
      });
      if (decision === 'deny') {
        bus.emit({ type: 'tool_denied', call, reason: 'user declined to answer' });
        return {
          block: this.resultBlock(call.id, false, 'User declined to answer. Choose another approach without requiring user input.'),
          isFatal: false,
        };
      }
      const answers =
        typeof decision === 'object' && 'answers' in decision
          ? decision.answers
          : parsed.data.questions.map((q) => ({
              question: q.question,
              selected: q.options[0] ? [q.options[0].label] : [],
            }));
      bus.emit({ type: 'tool_start', call, risk: tool.risk });
      const body = JSON.stringify({ answers });
      const result: ToolResult = {
        ok: true,
        summary: 'User answered structured questions.',
        data: { answers },
        meta: { tool: call.name, durationMs: 0, risk: tool.risk },
      };
      this.emitToolEnd(call, result);
      return { block: this.resultBlock(call.id, true, body), isFatal: false };
    }

    const planDecision = await this.checkPlanMode(call, tool.risk);
    if (planDecision) return planDecision;

    // Permission rules — evaluated before coarse autonomy.
    const ruleAction =
      this.deps.permissionRules && this.deps.permissionRules.length > 0
        ? resolvePermissionRule(call, preview, this.deps.permissionRules)
        : null;
    if (ruleAction === 'deny') {
      const reason = `permission rule denied: ${call.name}`;
      bus.emit({ type: 'tool_denied', call, reason });
      return {
        block: this.resultBlock(call.id, false, 'Blocked by a configured permission rule. Choose another approach.'),
        isFatal: false,
      };
    }

    // Optional rule-based classifier stub (gated by autoClassifier config).
    let classifierAllow = false;
    let classifierAsk = false;
    let classifierReason = '';
    if (this.deps.autoClassifier) {
      const verdict = await classifyToolCall({
        call,
        preview,
        risk: tool.risk,
        permissionRules: this.deps.permissionRules,
        provider: this.deps.provider,
        model: this.deps.model,
      });
      if (verdict.verdict === 'hard_deny') {
        bus.emit({ type: 'tool_denied', call, reason: verdict.reason });
        return {
          block: this.resultBlock(call.id, false, `${verdict.reason}. Choose another approach.`),
          isFatal: false,
        };
      }
      if (verdict.verdict === 'allow') classifierAllow = true;
      if (verdict.verdict === 'soft_deny') {
        classifierAsk = true;
        classifierReason = verdict.reason;
      }
    }

    // Permission gate.
    const planExitApproved = this.approvedPlanExitIds.has(call.id);
    const planWriteAllowed = this.deps.planMode?.active === true && call.name === 'plan_write';
    const planReadLikeAllowed = this.deps.planMode?.active === true && isPlanModeReadLikeCall(call);
    const ruleAllow = ruleAction === 'allow';
    const ruleAsk = ruleAction === 'ask';
    // The catastrophic-command denylist (forceConfirm) never bends to a classifier
    // `allow` — a read-only-looking command that smuggles a destructive subshell must
    // still gate. Only an explicit plan-exit approval or a permission-rule `allow`
    // (deliberate, configured overrides) suppress it.
    const forced = planExitApproved || ruleAllow ? null : (this.deps.forceConfirm?.(call, tool.risk) ?? null);

    // Bash read-only auto-allow at auto-read+ — never bypasses denylist / forceConfirm.
    const bashReadOnlyAllow =
      !forced &&
      call.name === 'run_shell' &&
      isAutonomyAtLeast(this.autonomy, 'auto-read') &&
      isBashReadOnly(shellCommandOf(call.input) ?? '');

    const sessionApproved = this.isSessionApproved(call, preview);
    if (
      // A non-null `forced` (catastrophic denylist) ALWAYS gates — no session
      // approval, classifier `allow`, rule `allow`, or bash-read-only fast path
      // may bypass it. The denylist is the one rule that does not bend.
      forced ||
      (!sessionApproved &&
        !planExitApproved &&
        !planWriteAllowed &&
        !planReadLikeAllowed &&
        !ruleAllow &&
        !classifierAllow &&
        !bashReadOnlyAllow &&
        (ruleAsk || classifierAsk || needsApproval(tool.risk, this.autonomy)))
    ) {
      const decision = await this.deps.gate.request({
        kind: 'permission',
        call,
        risk: tool.risk,
        reason:
          forced ??
          (classifierAsk
            ? classifierReason
            : ruleAsk
              ? `permission rule requires confirmation for ${call.name}`
              : `autonomy=${this.autonomy} requires confirmation for ${tool.risk}`),
        preview,
      });
      if (typeof decision === 'object' && 'setAutonomy' in decision) {
        this.setAutonomy(decision.setAutonomy);
      } else if (typeof decision === 'object' && 'approveForSession' in decision) {
        this.sessionToolApprovals.add(call.name);
      } else if (typeof decision === 'object' && 'approveForPrefix' in decision) {
        this.sessionPrefixApprovals.push(decision.approveForPrefix);
      } else if (decision === 'deny') {
        bus.emit({ type: 'tool_denied', call, reason: 'denied by user' });
        return {
          block: this.resultBlock(call.id, false, 'Tool call denied by the user. Choose another approach.'),
          isFatal: false,
        };
      }
    }

    // Validate input.
    const parsed = tool.inputSchema.safeParse(call.input);
    if (!parsed.success) return this.invalidInput(call, tool.risk, formatZodError(call.name, parsed.error));

    const hooks = this.deps.hooks;
    if (hooks?.pre_tool_use?.length) {
      const pre = runHooks('pre_tool_use', hooks.pre_tool_use, {
        tool: call.name,
        input: parsed.data,
        workspaceRoot: this.deps.workspaceRoot,
      });
      if (!pre.ok) {
        bus.emit({ type: 'tool_denied', call, reason: pre.message ?? 'pre_tool_use hook denied' });
        return {
          block: this.resultBlock(call.id, false, pre.message ?? 'pre_tool_use hook denied this call.'),
          isFatal: false,
        };
      }
    }

    bus.emit({ type: 'tool_start', call, risk: tool.risk });
    const sessionLog = this.deps.sessionLog;
    const ctx: ToolContext = {
      workspaceRoot: this.deps.workspaceRoot,
      additionalRoots: this.deps.additionalRoots,
      signal: this.deps.signal,
      log: () => {},
      dryRun: this.deps.dryRun,
      readTracker: this.readTracker,
      streamShell: this.deps.streamShell !== false,
      toolCallId: call.id,
      checkpoint: sessionLog
        ? {
            sessionId: SessionLog.sessionIdFromPath(sessionLog.path),
            turn: this.turnIndex,
          }
        : undefined,
      onShellOutput: (chunk, stream) => {
        bus.emit({ type: 'shell_output', callId: call.id, stream, chunk });
      },
      onShellStart: (info) => {
        bus.emit({ type: 'shell_pid', pid: info.pid, warn: info.warn });
      },
    };

    let result: ToolResult;
    try {
      result = await tool.run(parsed.data, ctx);
    } catch (err) {
      result = {
        ok: false,
        summary: `tool ${call.name} threw: ${(err as Error).message}`,
        error: { code: 'tool_exception', message: (err as Error).message, recoverable: true },
        meta: { tool: call.name, durationMs: 0, risk: tool.risk },
      };
    }

    if (hooks?.post_tool_use?.length) {
      runHooks('post_tool_use', hooks.post_tool_use, {
        tool: call.name,
        input: parsed.data,
        output: this.serialize(result),
        ok: result.ok,
        workspaceRoot: this.deps.workspaceRoot,
      });
    }

    this.emitToolEnd(call, result);

    const isFatal = !result.ok && result.error?.recoverable === false;
    return { block: this.resultBlock(call.id, result.ok, this.serialize(result)), isFatal, images: result.images };
  }

  private invalidInput(call: ToolCall, risk: ToolRisk, msg: string): { block: ContentBlock; isFatal: boolean } {
    const result: ToolResult = {
      ok: false,
      summary: msg,
      error: { code: 'invalid_input', message: msg, recoverable: true },
      meta: { tool: call.name, durationMs: 0, risk },
    };
    this.emitToolEnd(call, result);
    return { block: this.resultBlock(call.id, false, this.serialize(result)), isFatal: false };
  }

  private emitToolEnd(call: ToolCall, result: ToolResult): void {
    this.deps.bus.emit({ type: 'tool_end', call, result });
    this.emitFindings(result);
  }

  private emitFindings(result: ToolResult): void {
    for (const f of result.meta.findings ?? []) {
      this.deps.bus.emit({ type: 'finding', title: f.title, body: f.body, severity: f.severity });
    }
  }

  private async checkPlanMode(call: ToolCall, risk: ToolRisk): Promise<{ block: ContentBlock; isFatal: boolean } | null> {
    const planMode = this.deps.planMode;
    if (!planMode?.active) return null;

    if (call.name === 'plan_write' || isPlanModeReadLikeCall(call)) return null;

    if (call.name === 'exit_plan_mode') {
      const decision = await this.deps.gate.request({
        kind: 'plan_exit',
        call,
        risk: 'write',
        reason: 'approve the current plan and exit plan mode before implementation tools can run',
        preview: previewOf(call),
      });
      if (typeof decision === 'object' && 'setAutonomy' in decision) {
        this.setAutonomy(decision.setAutonomy);
        this.approvedPlanExitIds.add(call.id);
        return null;
      }
      if (decision === 'deny') {
        this.deps.bus.emit({ type: 'tool_denied', call, reason: 'plan mode exit denied by user' });
        return {
          block: this.resultBlock(call.id, false, 'Plan mode exit was denied. Continue exploring or revise the plan.'),
          isFatal: false,
        };
      }
      this.approvedPlanExitIds.add(call.id);
      return null;
    }

    if (risk === 'read') return null;

    const reason = `plan mode blocks ${risk} tool ${call.name}; call plan_write, then exit_plan_mode for approval before implementing`;
    this.deps.bus.emit({ type: 'tool_denied', call, reason });
    return {
      block: this.resultBlock(call.id, false, reason),
      isFatal: false,
    };
  }

  private serialize(result: ToolResult): string {
    let body = result.summary;
    if (result.data !== undefined) {
      const json = safeJson(result.data);
      if (json) body += `\n${json}`;
    }
    const max = this.deps.maxToolResultChars;
    if (body.length > max) {
      const omitted = body.length - max;
      body = `${body.slice(0, max)}\n…(truncated, ${omitted} bytes omitted)`;
    }
    return body;
  }

  private resultBlock(toolCallId: string, ok: boolean, content: string): ContentBlock {
    return { type: 'tool_result', toolCallId, ok, content };
  }

  /**
   * Build a synthetic {ok:false} tool_result for every call in `calls` that isn't
   * already paired in `have`. Used to repair the unpaired tool_use an interrupt
   * (ESC/Ctrl-C) leaves behind — a committed tool_use with no matching tool_result
   * makes every later request 400.
   */
  private synthesizeMissingResults(calls: ToolCall[], have: ContentBlock[]): ContentBlock[] {
    const paired = new Set<string>();
    for (const b of have) if (b.type === 'tool_result') paired.add(b.toolCallId);
    const out: ContentBlock[] = [];
    for (const c of calls) {
      if (!paired.has(c.id)) out.push(this.resultBlock(c.id, false, INTERRUPTED_RESULT));
    }
    return out;
  }

  /**
   * Defense-in-depth: if `messages` ends on an assistant turn carrying tool_use
   * blocks with no following tool_result (a snapshot taken mid-interrupt by an
   * older build, say), return a copy with a synthetic {ok:false} tool_result user
   * turn appended so the request doesn't 400. Returns the input when already clean.
   */
  private healDanglingToolUses(messages: Message[]): Message[] {
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant') return messages;
    const orphans = last.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    if (orphans.length === 0) return messages;
    return [...messages, { role: 'user', content: orphans.map((b) => this.resultBlock(b.id, false, INTERRUPTED_RESULT)) }];
  }

  private isSessionApproved(call: ToolCall, preview: string): boolean {
    if (this.sessionToolApprovals.has(call.name)) return true;
    if (call.name === 'run_shell') {
      const cmd = shellCommandOf(call.input) ?? preview;
      for (const prefix of this.sessionPrefixApprovals) {
        if (cmd.startsWith(prefix)) return true;
      }
    }
    return false;
  }

  /** True when executeCall would reach the permission gate (used to avoid parallel races). */
  private mayNeedPermissionPrompt(call: ToolCall): boolean {
    const normalized = normalizeForeignTool({ name: call.name, input: call.input });
    const tool = this.deps.registry.get(normalized.name);
    if (!tool) return false;
    const canonical = tool.name;
    const preview = previewOf({ ...call, name: canonical, input: normalized.input });
    if (this.isSessionApproved({ ...call, name: canonical }, preview)) return false;
    if (needsApproval(tool.risk, this.autonomy)) return true;
    return false;
  }

  private stop(reason: StopReasonExt, finalAnswer: string): LoopResult {
    this.deps.bus.emit({ type: 'mode', mode: 'idle' });
    this.deps.bus.emit({ type: 'stop', reason, finalAnswer });

    // Hook: stop (fires for main and sub-agents)
    if (this.deps.hooks?.stop?.length) {
      runHookPhase('stop', this.deps.hooks.stop, {
        workspaceRoot: this.deps.workspaceRoot,
        extra: { reason, finalAnswer: finalAnswer?.slice(0, 200) },
      });
    }
    return { stopReason: reason, finalAnswer };
  }
}

function shellCommandOf(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const cmd = (input as { command?: unknown }).command;
  return typeof cmd === 'string' ? cmd : null;
}

function previewOf(call: ToolCall): string {
  const input = call.input as Record<string, unknown> | undefined;
  if (input && typeof input === 'object') {
    if (typeof input.description === 'string' && input.description.trim()) return input.description.trim();
    if (typeof input.command === 'string') return `$ ${input.command}`;
    if (typeof input.path === 'string') return `${call.name} ${input.path}`;
    if (typeof input.url === 'string') return `${call.name} ${input.url}`;
  }
  return `${call.name} ${safeJson(call.input) ?? ''}`;
}

function parseHttpStatus(code: string): number | undefined {
  const m = /^http_(\d+)$/.exec(code);
  return m ? Number(m[1]) : undefined;
}

function formatZodError(tool: string, error: { issues: Array<{ path: (string | number)[]; message: string }> }): string {
  const detail = error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  return `invalid input for ${tool}: ${detail}`;
}

function safeJson(v: unknown): string | null {
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

function isPlanModeReadLikeCall(call: ToolCall): boolean {
  if (call.name !== 'memory') return false;
  const input = call.input as { action?: unknown } | undefined;
  return input?.action === 'recall' || input?.action === 'list';
}
