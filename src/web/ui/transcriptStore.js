import { dupKey, repeatStep } from './vendor/repeat.js';

/**
 * The transcript model, kept OUTSIDE the DOM.
 *
 * router.js replaces `.content`'s children on every hash change, so anything held only as DOM
 * is destroyed when the user clicks Models and comes back. State lives in a store instance and
 * the chat view re-renders from it on mount — that is what makes navigation (and an F5, via the
 * /api/transcript snapshot) non-destructive.
 *
 * `createStore()` returns an INDEPENDENT instance: the sidebar holds one per open session, so two
 * sessions no longer splice into one shared singleton. Items are a flat ordered list; deltas
 * mutate the last item in place rather than appending, so a long answer is one item.
 */

/** Hard bounds. A build's shell output would otherwise grow the page until it dies. */
const MAX_ITEMS = 500;
const MAX_TOOL_OUTPUT = 200_000; // chars retained per tool call
const MAX_ASSISTANT_CHARS = 400_000;

export function createStore() {
  let items = [];
  let seq = 0;
  const listeners = new Set();

  /** Per-turn state for verbatim-repeat detection (see src/util/repeat.ts). */
  let answerRun = [];
  let repeatPos = 0;
  /** The open streaming assistant item, if a turn is mid-answer. */
  let liveAssistant = null;
  let liveThinking = null;
  /** callId → tool item, so tool_end / shell_output can find their row. */
  const toolsByCall = new Map();

  /** Rolling HUD state — last-known values, not a history. */
  let hud = { usage: null, latencyMs: null, autonomy: null, mode: null, model: null };

  function notify() {
    for (const fn of listeners) {
      try {
        fn();
      } catch {
        /* a view error must never break ingestion */
      }
    }
  }

  function push(item) {
    item.id = ++seq;
    items.push(item);
    if (items.length > MAX_ITEMS) {
      const dropped = items.length - MAX_ITEMS;
      for (const it of items.slice(0, dropped)) {
        if (it.kind === 'tool' && it.callId) toolsByCall.delete(it.callId);
      }
      items = items.slice(dropped);
      // Mark the top so the user knows history was trimmed rather than never existing.
      if (!items.length || items[0].kind !== 'trimmed') {
        items.unshift({ id: ++seq, kind: 'trimmed', text: 'earlier output trimmed' });
      }
    }
    return item;
  }

  /** Finalize the open streamed answer, registering it with the repeat detector. */
  function closeLiveAssistant() {
    if (!liveAssistant) return;
    const key = dupKey(liveAssistant.text);
    const r = repeatStep(answerRun, repeatPos, key);
    answerRun = r.run;
    repeatPos = r.pos;
    liveAssistant.streaming = false;
    liveAssistant = null;
  }

  function endTurn() {
    closeLiveAssistant();
    if (liveThinking) {
      liveThinking.streaming = false;
      liveThinking = null;
    }
    // Repeat detection is TURN-scoped: an identical short answer in a later turn is legitimate.
    answerRun = [];
    repeatPos = 0;
  }

  /**
   * Apply one LoopEvent. Every variant in src/agent/events.ts is handled or explicitly ignored;
   * an unknown type becomes a notice rather than vanishing, so a new event type is visible
   * instead of silently dropped.
   */
  function apply(e) {
    switch (e.type) {
      case 'user': {
        // A new user turn ends the previous one: close any open answer and reset the
        // turn-scoped repeat detector, so an identical answer to a later question still shows.
        endTurn();
        push({ kind: 'user', text: e.text ?? '' });
        break;
      }
      case 'text': {
        if (!e.delta) break;
        if (!liveAssistant) liveAssistant = push({ kind: 'assistant', text: '', streaming: true });
        if (liveAssistant.text.length < MAX_ASSISTANT_CHARS) liveAssistant.text += e.delta;
        break;
      }
      case 'thinking': {
        if (!e.delta) break;
        if (!liveThinking) liveThinking = push({ kind: 'thinking', text: '', streaming: true });
        if (liveThinking.text.length < MAX_ASSISTANT_CHARS) liveThinking.text += e.delta;
        break;
      }
      case 'reasoning_done': {
        if (liveThinking) {
          if (e.text) liveThinking.text = e.text;
          liveThinking.streaming = false;
          liveThinking = null;
        } else if (e.text) {
          push({ kind: 'thinking', text: e.text, streaming: false });
        }
        break;
      }
      case 'assistant_done': {
        const text = e.text ?? '';
        if (!text) break;
        // Already streamed verbatim? Keep the streamed item; just close it. loop.ts emits
        // assistant_done once per model ITERATION with the FULL turn text, so a tool-using turn
        // emits it several times.
        if (liveAssistant && dupKey(liveAssistant.text) === dupKey(text)) {
          closeLiveAssistant();
          break;
        }
        closeLiveAssistant();
        const r = repeatStep(answerRun, repeatPos, dupKey(text));
        answerRun = r.run;
        repeatPos = r.pos;
        if (!r.suppress) push({ kind: 'assistant', text, streaming: false });
        break;
      }
      case 'tool_start': {
        const item = push({
          kind: 'tool',
          callId: e.call?.id,
          name: e.call?.name ?? 'tool',
          args: e.call?.args,
          risk: e.risk,
          status: 'running',
          summary: '',
          diff: null,
          output: '',
          truncated: false,
        });
        if (item.callId) toolsByCall.set(item.callId, item);
        break;
      }
      case 'tool_end': {
        const item = toolsByCall.get(e.call?.id) ?? push({ kind: 'tool', name: e.call?.name ?? 'tool', output: '' });
        item.status = e.result?.ok ? 'ok' : 'error';
        item.summary = e.result?.summary ?? '';
        item.error = e.result?.error ?? null;
        item.durationMs = e.result?.meta?.durationMs ?? null;
        // Diffs are computed server-side and ride along on the result — nothing to compute here.
        item.diff = e.result?.meta?.diff ?? null;
        item.findings = e.result?.meta?.findings ?? null;
        break;
      }
      case 'tool_denied': {
        const item = toolsByCall.get(e.call?.id) ?? push({ kind: 'tool', name: e.call?.name ?? 'tool', output: '' });
        item.status = 'denied';
        item.summary = e.reason ?? 'denied';
        break;
      }
      case 'shell_output': {
        const item = toolsByCall.get(e.callId);
        const chunk = e.chunk ?? '';
        if (!item) break;
        if (item.output.length + chunk.length > MAX_TOOL_OUTPUT) {
          item.truncated = true;
          item.output = (item.output + chunk).slice(-MAX_TOOL_OUTPUT);
        } else {
          item.output += chunk;
        }
        break;
      }
      case 'shell_pid': {
        break; // no user-visible surface yet
      }
      case 'error': {
        closeLiveAssistant();
        push({ kind: 'error', text: e.message ?? 'error' });
        break;
      }
      case 'stop': {
        endTurn();
        push({ kind: 'status', text: `stopped · ${e.reason ?? ''}`.trim(), tone: 'muted' });
        break;
      }
      case 'finding': {
        push({ kind: 'finding', title: e.title ?? '', body: e.body ?? '', severity: e.severity ?? 'info' });
        break;
      }
      case 'retry': {
        push({ kind: 'status', text: `retry ${e.attempt} in ${e.delayMs}ms · ${e.reason ?? ''}`.trim(), tone: 'warn' });
        break;
      }
      case 'compaction': {
        push({ kind: 'status', text: `context compacted (${e.trigger})`, tone: 'muted' });
        break;
      }
      case 'model_fallback': {
        push({ kind: 'status', text: `model fallback: ${e.from} → ${e.to} · ${e.reason ?? ''}`.trim(), tone: 'warn' });
        break;
      }
      case 'task_notification': {
        push({ kind: 'status', text: `task ${e.taskId} finished${e.fromSubagent ? ` (${e.fromSubagent})` : ''}`, tone: 'muted' });
        break;
      }
      case 'bg_agent_launched': {
        push({ kind: 'status', text: `background agent launched: ${e.subagentType ?? 'agent'}`, tone: 'muted' });
        break;
      }
      case 'stream_gap': {
        push({ kind: 'status', text: `${e.dropped} event(s) dropped — this view fell behind`, tone: 'warn' });
        break;
      }
      // --- HUD-only, no transcript row -------------------------------------------------
      case 'usage':
        hud.usage = { inputTokens: e.inputTokens, outputTokens: e.outputTokens, costUSD: e.costUSD, contextPct: e.contextPct };
        break;
      case 'latency':
        hud.latencyMs = e.ms;
        break;
      case 'autonomy':
        hud.autonomy = e.level;
        break;
      case 'mode':
        hud.mode = e.mode;
        break;
      // --- deliberately not rendered in the read-only mirror ----------------------------
      case 'todo':
      case 'plan_mode':
        break;
      default:
        push({ kind: 'status', text: `unhandled event: ${e.type}`, tone: 'muted' });
        break;
    }
    notify();
  }

  /** Replace all state from a server snapshot (GET /api/transcript). */
  function hydrate(events) {
    reset();
    for (const e of events) {
      try {
        apply(e);
      } catch {
        /* one bad event must not abort hydration */
      }
    }
  }

  function reset() {
    items = [];
    seq = 0;
    answerRun = [];
    repeatPos = 0;
    liveAssistant = null;
    liveThinking = null;
    toolsByCall.clear();
    hud = { usage: null, latencyMs: null, autonomy: null, mode: null, model: null };
    notify();
  }

  return {
    apply,
    hydrate,
    reset,
    snapshot: () => items,
    hudState: () => hud,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
