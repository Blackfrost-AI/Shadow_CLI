/**
 * The session model v2 — the dsh-shaped store behind the chat console.
 *
 * Everything the transcript, docks, stats strip, context meter, details inspector and
 * trajectory read comes from ONE store instance per session, updated by apply()-ing LoopEvents
 * off the SSE stream (and hydrated from GET /api/transcript on mount / after reconnect).
 * The DOM never holds state: navigation and F5 are non-destructive by construction.
 *
 * What this adds over the old transcriptStore:
 *   - TURN records: each user → stop cycle becomes a {turn} with timing (LLM vs tool ms),
 *     first-token TTFT, step count and per-request token/cache accounting — the inputs the
 *     dsh stats strip and trajectory need.
 *   - The approvals inbox: approval_request parks here until approval_resolved; the question
 *     composer reads `questions` straight off the ask.
 *   - Todo, the prompt queue (typed-while-running), and sub-agent bookkeeping.
 *   - A local/confirmed user-row handshake: the composer adds the user's text instantly, the
 *     bus echoes the same text a beat later, and the two collapse into one row.
 */

import { dupKey, repeatStep } from './vendor/repeat.js';

/** Hard bounds. A build's shell output would otherwise grow the page until it dies. */
const MAX_ITEMS = 500;
const MAX_TOOL_OUTPUT = 200_000; // chars retained per tool call
const MAX_ASSISTANT_CHARS = 400_000;

export function createSessionModel(sessionId) {
  const id = sessionId;

  /** @type {Array<any>} flat ordered display rows */
  let rows = [];
  let seq = 0;
  const listeners = new Set();

  // ---- live streaming targets -----------------------------------------------------------
  let liveAssistant = null;
  let liveThinking = null;
  /** callId → tool row, so tool_end / shell_output find their owner. */
  const toolsByCall = new Map();

  // ---- per-turn state ---------------------------------------------------------------------
  let turn = null; // open turn record, or null between turns
  /** @type {Array<any>} */
  let turns = [];

  // Verbatim-repeat detection (turn-scoped, same as the old store).
  let answerRun = [];
  let repeatPos = 0;

  // ---- docks + hud ---------------------------------------------------------------------------
  /** @type {Map<string, any>} approval id → the ask (approval_request payload + receivedAt). */
  const approvals = new Map();
  let todo = [];
  /** Prompts typed while a turn runs; the app drains this on stop. */
  let queue = [];
  let hud = { status: 'idle', mode: null, model: null, autonomy: null, usage: null, latencyMs: null };
  /** Latency seen but not yet paired with a usage (providers that emit it first). */
  let pendingLatency = null;

  // Sub-agent bookkeeping: taskId → { type, description, startedAt, ok, tools: n }.
  const subagents = new Map();

  /** The optimistic user row awaiting its bus echo. */
  let localUser = null;

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
    item.seq = ++seq;
    rows.push(item);
    if (rows.length > MAX_ITEMS) {
      const dropped = rows.length - MAX_ITEMS;
      for (const it of rows.slice(0, dropped)) {
        if (it.kind === 'tool' && it.callId) toolsByCall.delete(it.callId);
      }
      rows = rows.slice(dropped);
      if (!rows.length || rows[0].kind !== 'trimmed') {
        rows.unshift({ seq: ++seq, kind: 'trimmed', text: 'earlier output trimmed' });
      }
    }
    return item;
  }

  function closeLiveAssistant() {
    if (!liveAssistant) return;
    const key = dupKey(liveAssistant.text);
    const r = repeatStep(answerRun, repeatPos, key);
    answerRun = r.run;
    repeatPos = r.pos;
    liveAssistant.streaming = false;
    liveAssistant = null;
  }

  // ---- turn accounting -------------------------------------------------------------------

  /** Get the row for a call id, synthesizing one when only the terminal event arrived
   *  (denials and invalid-input rejections never emit tool_start — see loop.ts). */
  function toolRow(e) {
    const existing = toolsByCall.get(e.call?.id);
    if (existing) return existing;
    if (!e.call?.id && !e.call?.name) return null; // nothing identifiable to show
    const item = push({
      kind: 'tool',
      callId: e.call?.id,
      name: e.call?.name ?? 'tool',
      subagent: e.subagent ?? null,
      args: e.call?.input ?? null,
      risk: e.risk,
      status: 'running',
      summary: '',
      diff: null,
      output: '',
      findings: null,
      error: null,
      durationMs: null,
      ts: Date.now(),
    });
    if (item.callId) toolsByCall.set(item.callId, item);
    return item;
  }

  function openTurn(text) {
    turn = {
      id: ++seq,
      startTs: Date.now(),
      endTs: null,
      stopReason: null,
      steps: 0,
      llmMs: 0, // Σ provider round-trips (latency events)
      toolMs: 0, // Σ tool durations (result.meta.durationMs)
      ttftMs: null, // first token of the FIRST request in the turn
      requests: [], // per-request { latencyMs, ttftMs, in, out, cacheRead, cacheWrite }
      usage: null, // last cumulative snapshot (Budget)
      firstText: text ?? '',
    };
    turns.push(turn);
  }

  function endTurn(reason) {
    closeLiveAssistant();
    if (liveThinking) {
      liveThinking.streaming = false;
      liveThinking = null;
    }
    if (turn) {
      turn.endTs = Date.now();
      turn.stopReason = reason ?? null;
      turn = null;
    }
    // Repeat detection is TURN-scoped. Per-request latency scratch must not leak across turns:
    // a value left over from the PREVIOUS turn pairing with the next turn's first usage would
    // fabricate decode time.
    hud.latencyMs = null;
    pendingLatency = null;
    answerRun = [];
    repeatPos = 0;
  }

  /** Aggregate the turn's per-request records into the dsh stats projection. */
  function turnStats(t) {
    const reqs = t.requests ?? [];
    let cacheRead = 0;
    let cacheWrite = 0;
    let uncached = 0;
    let iterIn = 0;
    let iterOut = 0;
    let decodeMs = 0;
    for (const r of reqs) {
      cacheRead += r.cacheRead ?? 0;
      cacheWrite += r.cacheWrite ?? 0;
      uncached += Math.max(0, (r.in ?? 0) - (r.cacheRead ?? 0) - (r.cacheWrite ?? 0));
      iterIn += r.in ?? 0;
      iterOut += r.out ?? 0;
      // decode ≈ round-trip minus time-to-first-token; clamp so a late usage frame can't go
      // negative. Requests with no measured latency contribute NOTHING — a mock/local provider
      // would otherwise read as 1ms decode and fabricate 1000 tok/s.
      if (r.latencyMs != null) decodeMs += Math.max(1, r.latencyMs - (r.ttftMs ?? 0));
    }
    const total = uncached + cacheRead + cacheWrite;
    return {
      steps: t.steps ?? 0,
      llmMs: t.llmMs ?? 0,
      toolMs: t.toolMs ?? 0,
      ttftMs: t.ttftMs ?? null,
      cacheHitPct: total > 0 ? (100 * cacheRead) / total : null,
      inputTokens: iterIn,
      outputTokens: iterOut,
      tokPerSec: decodeMs > 0 ? (1000 * iterOut) / decodeMs : null,
      costUSD: t.usage?.costUSD ?? 0,
      contextPct: t.usage?.contextPct ?? null,
    };
  }

  /** Session-cumulative projection for the header/context meter. */
  function sessionStats() {
    let inTok = 0;
    let outTok = 0;
    let cost = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let uncached = 0;
    let steps = 0;
    for (const t of turns) {
      for (const r of t.requests ?? []) {
        inTok += r.in ?? 0;
        outTok += r.out ?? 0;
        cacheRead += r.cacheRead ?? 0;
        cacheWrite += r.cacheWrite ?? 0;
        uncached += Math.max(0, (r.in ?? 0) - (r.cacheRead ?? 0) - (r.cacheWrite ?? 0));
      }
      cost += t.usage?.costUSD ?? 0;
      steps += t.steps ?? 0;
    }
    const total = uncached + cacheRead + cacheWrite;
    return {
      turns: turns.length,
      steps,
      inputTokens: inTok,
      outputTokens: outTok,
      costUSD: cost,
      cacheHitPct: total > 0 ? (100 * cacheRead) / total : null,
      contextPct: hud.usage?.contextPct ?? null,
    };
  }

  // ---- the event reducer -------------------------------------------------------------------

  function apply(e) {
    switch (e.type) {
      case 'user': {
        // Collapse the optimistic row the composer added into the confirmed bus echo. The local
        // add already opened the turn record — ADOPT it rather than closing and reopening, or
        // every first prompt counts as two turns live (the phantom pre-echo one is empty).
        if (localUser && !localUser.confirmed && localUser.text === (e.text ?? '')) {
          localUser.confirmed = true;
          localUser = null;
          break;
        }
        endTurn(null);
        localUser = null;
        push({ kind: 'user', text: e.text ?? '', ts: Date.now() });
        openTurn(e.text);
        break;
      }
      case 'text': {
        if (!e.delta) break;
        if (!liveAssistant) liveAssistant = push({ kind: 'assistant', text: '', streaming: true, ts: Date.now() });
        if (liveAssistant.text.length < MAX_ASSISTANT_CHARS) liveAssistant.text += e.delta;
        break;
      }
      case 'thinking': {
        if (!e.delta) break;
        if (!liveThinking) liveThinking = push({ kind: 'think', text: '', streaming: true, ts: Date.now() });
        if (liveThinking.text.length < MAX_ASSISTANT_CHARS) liveThinking.text += e.delta;
        break;
      }
      case 'reasoning_done': {
        if (liveThinking) {
          if (e.text) liveThinking.text = e.text;
          liveThinking.streaming = false;
          liveThinking = null;
        } else if (e.text) {
          push({ kind: 'think', text: e.text, streaming: false, ts: Date.now() });
        }
        break;
      }
      case 'assistant_done': {
        const text = e.text ?? '';
        if (!text) break;
        // loop.ts emits assistant_done per model ITERATION with the full turn text; the streamed
        // item already holds it verbatim → just close. A different text (post-tool commit) lands
        // as its own row after repeat-suppression.
        if (liveAssistant && dupKey(liveAssistant.text) === dupKey(text)) {
          closeLiveAssistant();
          break;
        }
        closeLiveAssistant();
        const r = repeatStep(answerRun, repeatPos, dupKey(text));
        answerRun = r.run;
        repeatPos = r.pos;
        if (!r.suppress) push({ kind: 'assistant', text, streaming: false, ts: Date.now() });
        break;
      }
      case 'tool_start': {
        const item = push({
          kind: 'tool',
          callId: e.call?.id,
          name: e.call?.name ?? 'tool',
          subagent: e.subagent ?? null,
          // The wire's ToolCall field is `input` (provider.ts) — not `args`.
          args: e.call?.input ?? null,
          risk: e.risk,
          status: 'running',
          summary: '',
          diff: null,
          output: '',
          findings: null,
          error: null,
          durationMs: null,
          ts: Date.now(),
        });
        if (item.callId) toolsByCall.set(item.callId, item);
        break;
      }
      case 'tool_end': {
        // Denials and invalid-input rejections are emitted BEFORE any tool_start (every
        // pre-execution gate in loop.ts returns early) — synthesize the row instead of
        // dropping the event, or the transcript shows the model silently moving on.
        const item = toolRow(e);
        if (!item) break;
        item.status = e.result?.ok ? 'ok' : 'error';
        item.summary = e.result?.summary ?? '';
        item.error = e.result?.error ?? null;
        item.durationMs = e.result?.meta?.durationMs ?? null;
        item.diff = e.result?.meta?.diff ?? null;
        item.findings = e.result?.meta?.findings ?? null;
        // Structured payload (read/search results, apply patches…) — the expanded card decides
        // how to present it per tool; run_shell streams its own output via shell_output.
        item.data = e.result?.data ?? null;
        if (turn) {
          turn.steps++;
          if (typeof item.durationMs === 'number') turn.toolMs += item.durationMs;
        }
        break;
      }
      case 'tool_denied': {
        const item = toolRow(e);
        if (!item) break;
        item.status = 'denied';
        item.summary = e.reason ?? 'denied';
        break;
      }
      case 'shell_output': {
        const item = toolsByCall.get(e.callId);
        if (!item) break;
        const chunk = e.chunk ?? '';
        if (item.output.length + chunk.length > MAX_TOOL_OUTPUT) {
          item.truncated = true;
          item.output = (item.output + chunk).slice(-MAX_TOOL_OUTPUT);
        } else {
          item.output += chunk;
        }
        break;
      }
      case 'shell_pid':
        break; // no surface
      case 'error': {
        closeLiveAssistant();
        push({ kind: 'error', text: e.message ?? 'error', ts: Date.now() });
        break;
      }
      case 'stop': {
        const finished = turn;
        endTurn(e.reason);
        // The dsh stats strip lands once per turn — only when there is something to show.
        if (finished && (finished.steps > 0 || (finished.requests?.length ?? 0) > 0)) {
          push({ kind: 'stats', stats: turnStats(finished), ts: Date.now() });
        }
        // Benign completions are the stats strip's business; abnormal stops still say themselves.
        const abnormal =
          e.reason === 'interrupted' ||
          e.reason === 'max_iterations' ||
          e.reason === 'budget' ||
          e.reason === 'fatal_tool_error' ||
          e.reason === 'provider_error' ||
          e.reason === 'length';
        if (abnormal || !finished || (finished.steps === 0 && (finished.requests?.length ?? 0) === 0)) {
          push({ kind: 'status', text: `stopped · ${e.reason ?? ''}`.trim(), tone: 'muted', ts: Date.now() });
        }
        break;
      }
      case 'finding': {
        push({
          kind: 'finding',
          title: e.title ?? '',
          body: e.body ?? '',
          severity: e.severity ?? 'info',
          ts: Date.now(),
        });
        break;
      }
      case 'retry': {
        push({ kind: 'status', text: `retry ${e.attempt} in ${e.delayMs}ms · ${e.reason ?? ''}`.trim(), tone: 'warn', ts: Date.now() });
        break;
      }
      case 'compaction': {
        push({ kind: 'status', text: `context compacted (${e.trigger}${e.degraded ? ' · degraded' : ''})`, tone: 'muted', ts: Date.now() });
        break;
      }
      case 'model_fallback': {
        push({ kind: 'status', text: `model fallback: ${e.from} → ${e.to} · ${e.reason ?? ''}`.trim(), tone: 'warn', ts: Date.now() });
        break;
      }
      case 'task_notification': {
        const sa = subagents.get(e.taskId);
        push({ kind: 'task', text: e.answer ?? '', taskId: e.taskId, from: e.fromSubagent ?? sa?.type ?? null, ts: Date.now() });
        break;
      }
      case 'bg_agent_launched': {
        push({ kind: 'status', text: `background agent launched: ${e.subagentType ?? 'agent'}`, tone: 'muted', ts: Date.now() });
        break;
      }
      case 'stream_gap': {
        push({ kind: 'status', text: `${e.dropped} event(s) dropped — this view fell behind`, tone: 'warn', ts: Date.now() });
        break;
      }
      case 'usage': {
        hud.usage = {
          inputTokens: e.inputTokens,
          outputTokens: e.outputTokens,
          costUSD: e.costUSD,
          contextPct: e.contextPct,
        };
        if (turn) {
          turn.usage = hud.usage;
          // The optional per-request fields carry THIS request's numbers (loop.ts). The legacy
          // four are turn-cumulative — do NOT add them into `requests`.
          turn.requests.push({
            // loop.ts emits `usage` from inside the stream loop and `latency` only in the
            // stream's finally — so latency arrives AFTER its usage. Pair via pendingLatency
            // (latency-then-usage providers) and let the latency case backfill this record
            // when it lands afterward (the real order).
            latencyMs: pendingLatency,
            ttftMs: e.ttftMs ?? null,
            in: e.iterInputTokens ?? null,
            out: e.iterOutputTokens ?? null,
            cacheRead: e.cacheReadTokens ?? 0,
            cacheWrite: e.cacheWriteTokens ?? 0,
          });
          pendingLatency = null;
          if (turn.ttftMs == null && e.ttftMs != null) turn.ttftMs = e.ttftMs;
        }
        break;
      }
      case 'latency': {
        hud.latencyMs = e.ms;
        if (turn) {
          turn.llmMs += e.ms;
          // The wire order is usage→latency, so this measurement belongs to the record the
          // last usage pushed (its slot is null). Providers that emit latency first leave the
          // slot filled and this becomes next usage's pendingLatency — correct in both orders.
          const last = turn.requests[turn.requests.length - 1];
          if (last && last.latencyMs == null) last.latencyMs = e.ms;
          else pendingLatency = e.ms;
        }
        break;
      }
      case 'autonomy':
        hud.autonomy = e.level;
        break;
      case 'mode':
        hud.mode = e.mode;
        break;
      case 'todo': {
        todo = e.items ?? [];
        break;
      }
      case 'plan_mode':
        push({ kind: 'status', text: `plan mode: ${e.plan?.mode ?? ''}`, tone: 'muted', ts: Date.now() });
        break;
      case 'subagent_start': {
        subagents.set(e.taskId, {
          taskId: e.taskId,
          type: e.subagentType ?? 'agent',
          description: e.description ?? '',
          startedAt: Date.now(),
          queued: e.queued === true,
          background: e.background === true,
          ok: null,
          tools: 0,
        });
        push({
          kind: 'subagent',
          taskId: e.taskId,
          type: e.subagentType ?? 'agent',
          description: e.description ?? '',
          queued: e.queued === true,
          background: e.background === true,
          ts: Date.now(),
        });
        break;
      }
      case 'subagent_end': {
        const sa = subagents.get(e.taskId);
        if (sa) sa.ok = e.ok === true;
        push({ kind: 'subagent_end', taskId: e.taskId, type: e.subagentType ?? sa?.type ?? 'agent', ok: e.ok === true, ts: Date.now() });
        break;
      }
      case 'subagent_usage': {
        const sa = subagents.get(e.taskId ?? '');
        if (sa) {
          sa.costUSD = e.costUSD ?? 0;
          sa.inputTokens = e.inputTokens ?? 0;
          sa.outputTokens = e.outputTokens ?? 0;
        }
        break;
      }
      case 'cancel_subagent':
        break; // request-direction only (UI → loop); nothing to render
      case 'approval_request': {
        approvals.set(e.id, { ...e, receivedAt: Date.now() });
        break;
      }
      case 'approval_resolved': {
        // Keep the outcome briefly so the strip can flash "approved" before it unmounts.
        approvals.delete(e.id);
        push({ kind: 'approval_outcome', id: e.id, outcome: e.outcome, ts: Date.now() });
        break;
      }
      case 'debug':
        break; // diagnostic channel; the session log persists it
      default:
        push({ kind: 'status', text: `unhandled event: ${e.type}`, tone: 'muted', ts: Date.now() });
        break;
    }
    notify();
  }

  // ---- local actions -----------------------------------------------------------------------

  /** The composer's optimistic add. Collapses into the bus's `user` echo (see apply). */
  function addUserLocal(text) {
    const row = push({ kind: 'user', text, ts: Date.now(), confirmed: false });
    localUser = row;
    openTurn(text);
    notify();
    return row;
  }

  /** Prompt typed while a turn is running — queued, then drained by the app on stop. */
  function enqueue(text) {
    queue.push({ text, ts: Date.now() });
    notify();
  }

  function dequeue() {
    const next = queue.shift();
    notify();
    return next ?? null;
  }

  function unqueue(i) {
    queue.splice(i, 1);
    notify();
  }

  function setHood(patch) {
    Object.assign(hud, patch);
    notify();
  }

  function hydrate(events) {
    reset();
    for (const e of events) {
      try {
        apply(e);
      } catch {
        /* one bad event must not abort hydration */
      }
    }
    // Deliberately NO endTurn here: when the replay ends mid-turn (a refresh while the turn is
    // still running server-side) the open turn record is the one live events continue filling —
    // closing it would drop every post-refresh usage/tool_end into the void and render a
    // spurious "stopped" row on the real completion. Finished history closes itself: the last
    // frame is a stop, whose handler already ended the turn.
  }

  function reset() {
    rows = [];
    seq = 0;
    answerRun = [];
    repeatPos = 0;
    liveAssistant = null;
    liveThinking = null;
    toolsByCall.clear();
    turn = null;
    turns = [];
    approvals.clear();
    todo = [];
    queue = [];
    subagents.clear();
    localUser = null;
    hud = { status: 'idle', mode: null, model: null, autonomy: null, usage: null, latencyMs: null };
    notify();
  }

  return {
    id,
    apply,
    hydrate,
    reset,
    addUserLocal,
    enqueue,
    dequeue,
    unqueue,
    setHood,
    snapshot() {
      return {
        rows,
        hud,
        approvals: [...approvals.values()],
        todo,
        queue,
        turns,
        subagents: [...subagents.values()],
        session: sessionStats(),
      };
    },
    /** Stats projection for ONE turn (the per-turn footer). */
    statsFor(t) {
      return turnStats(t);
    },
    lastTurn() {
      return turns[turns.length - 1] ?? null;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
