/**
 * The chat surface for one session: transcript + docks + composer, driven by the session
 * model (sessionModel.js) over SSE (live) and /api/transcript (hydration).
 *
 * Lifecycle: app.js calls mountChat(host, id, ctx) on route change and unmount() on the next
 * switch; unmount closes the SSE stream and drops every listener. State lives in the model,
 * never the DOM — navigating away and back is non-destructive (a fresh hydrate refills).
 */

import { el } from './dom.js';
import { getJson, postJson } from './api.js';
import { subscribe, ConnState } from './sse.js';
import { createSessionModel } from './sessionModel.js';
import { createTranscript } from './render.js';
import { createDocks } from './docks.js';
import { toast, menu } from './ui.js';
import { titleFromPrompt } from './util.js';
import { readDraft, saveDraft } from './drafts.js';

const AUTONOMY = [
  { level: 'manual', label: 'Manual', hint: 'ask before anything' },
  { level: 'auto-read', label: 'Auto read', hint: 'reads are free' },
  { level: 'auto-edit', label: 'Auto edit', hint: 'edits are free' },
  { level: 'full', label: 'Full', hint: 'most actions automatic; protected actions still ask' },
];

const HERO_CHIPS = ['Explain this repository', 'Review the last commit', 'Write a test for the main module'];

export function mountChat(host, sessionId, ctx = {}) {
  const model = createSessionModel(sessionId);
  let running = false;
  let canPrompt = false;
  let canInterrupt = false;
  let sessionReady = false;
  let submitting = false;
  let connection = ConnState.CONNECTING;
  let autonomy = 'auto-edit';
  let dead = false;
  let titled = false;

  // ---- layout -------------------------------------------------------------------
  const scroller = el('div', { class: 'tl scroll' }, []);
  const connectionLabel = el('div', { class: 'connection-status', role: 'status', 'aria-live': 'polite' }, ['Connecting to Shadow…']);
  const hero = el(
    'div',
    { class: 'tl-hero' },
    [
      el('div', { class: 'glyph' }, ['◇']),
      el('div', { class: 'hello' }, ['Your project. Your models.']),
      el('div', { class: 'sub' }, ['Start with a question or describe a change. Shadow shows its work as it goes.']),
      el('div', { class: 'chips' }, HERO_CHIPS.map((c) => el('button', { class: 'tag-chip', onClick: () => {
        if (ta.value.trim()) return ta.focus();
        ta.value = c;
        saveDraft(sessionId, c);
        autosize();
        syncComposer();
        ta.focus();
      } }, [c]))),
    ],
  );

  const docksHost = el('div', { style: 'flex:none;display:flex;flex-direction:column;' }, []);
  const ta = el('textarea', {
    class: 'ta',
    rows: '1',
    'aria-label': 'Message Shadow',
    placeholder: 'Send a message… (Enter · Shift+Enter for newline)',
    onkeydown: (ev) => {
      // IME composition: Enter confirms the candidate, not the message.
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229) {
        ev.preventDefault();
        sendCurrent();
      }
    },
    oninput: () => {
      saveDraft(sessionId, ta.value);
      autosize();
      syncComposer();
    },
  });
  ta.value = readDraft(sessionId);
  const sendBtn = el('button', { class: 'btn-send', title: 'Send', onClick: () => sendCurrent() }, ['↑']);
  const autoPill = el('button', { class: 'pill-auto', onClick: openAutonomy }, [
    el('span', { class: 'lv' }),
    el('span', { class: 'lbl' }, ['auto-edit']),
    el('span', { style: 'font-size:9px;color:var(--sw-t-caption);' }, ['▾']),
  ]);
  const composer = el('div', { class: 'composer' }, [
    el('div', { class: 'composer-box' }, [
      ta,
      el('div', { class: 'composer-bar' }, [autoPill, el('span', { style: 'flex:1;' }, []), sendBtn]),
    ]),
  ]);

  const wrap = el(
    'div',
    { style: 'display:flex;flex-direction:column;flex:1;min-height:0;position:relative;' },
    [connectionLabel, scroller, hero, docksHost, composer],
  );
  host.replaceChildren(wrap);

  const transcript = createTranscript(scroller, model);
  wrap.append(transcript.jumpToLatest);
  const docks = createDocks(docksHost, model, {
    decide: (approvalId, decision) => {
      postJson(`/api/sessions/${sessionId}/approvals/${approvalId}`, { decision }).catch((e) =>
        toast(`decision failed: ${e.message}`, { kind: 'error' }),
      );
    },
    answerQuestions: (approvalId, answers) => {
      postJson(`/api/sessions/${sessionId}/approvals/${approvalId}`, { decision: { answers } }).catch((e) =>
        toast(`answer failed: ${e.message}`, { kind: 'error' }),
      );
    },
    unqueue: (i) => model.unqueue(i),
  });

  // ---- composer mechanics ------------------------------------------------------------
  const autosize = () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 336)}px`; // ~14 lines cap
  };

  function syncComposer() {
    const online = connection === ConnState.OPEN;
    const stop = running && !ta.value.trim() && canInterrupt;
    ta.disabled = sessionReady && !canPrompt;
    ta.readOnly = submitting;
    sendBtn.disabled = submitting || !sessionReady || !online || (!stop && (!canPrompt || !ta.value.trim()));
    sendBtn.classList.toggle('is-stop', stop);
    sendBtn.textContent = submitting ? '…' : stop ? '■' : '↑';
    const label = submitting ? 'Sending…' : stop ? 'Stop' : running ? 'Queue message' : 'Send';
    sendBtn.title = label;
    sendBtn.setAttribute('aria-label', label);
    autoPill.disabled = submitting || !sessionReady || !canPrompt || !online;
    if (!sessionReady) ta.placeholder = 'Connecting — you can write your message now…';
    else if (!canPrompt) ta.placeholder = 'Start a new session to send a message';
    else if (!online) ta.placeholder = 'Reconnecting — your draft stays here…';
    else ta.placeholder = running ? 'Queue a message for after this turn…' : 'Send a message… (Enter · Shift+Enter for newline)';
  }

  function setRunning(v) {
    if (running === v) return;
    running = v;
    syncComposer();
    ctx.onStatus?.();
  }

  async function sendCurrent() {
    if (submitting || !sessionReady || connection !== ConnState.OPEN) return;
    const draft = ta.value;
    const text = draft.trim();
    if (!text) {
      if (running && canInterrupt) stopTurn();
      return;
    }
    const accepted = await sendText(text);
    if (accepted && ta.value === draft) {
      ta.value = '';
      if (!dead || readDraft(sessionId) === draft) saveDraft(sessionId, '');
    }
    if (!dead) {
      autosize();
      syncComposer();
    }
  }

  async function sendText(text) {
    if (!canPrompt) {
      toast('this session is a read-only mirror', { kind: 'error' });
      return false;
    }
    if (running) {
      model.enqueue(text);
      render();
      return true;
    }
    submitting = true;
    setRunning(true);
    try {
      await postJson(`/api/sessions/${sessionId}/chat`, { prompt: text });
      if (!titled && !dead) {
        titled = true;
        ctx.onTitle?.(titleFromPrompt(text));
      }
      return true;
    } catch (e) {
      setRunning(false);
      // Keep both a failed queued prompt and any newer composer text. Never retry automatically:
      // a lost HTTP acknowledgement can mean the server accepted the request already.
      const current = dead ? readDraft(sessionId) : ta.value;
      ta.value = current.includes(text) ? current : [text, current].filter(Boolean).join('\n\n');
      saveDraft(sessionId, ta.value);
      model.apply({ type: 'error', message: `Could not confirm sending. Your draft is kept; check the conversation before retrying. ${e.message}` });
      if (!dead) render();
      return false;
    } finally {
      submitting = false;
      if (!dead) syncComposer();
    }
  }

  function stopTurn() {
    postJson(`/api/sessions/${sessionId}/interrupt`).catch((e) => {
      toast(`Could not stop the turn: ${e.message}`, { kind: 'error' });
    });
  }

  function openAutonomy(e) {
    const r = e.currentTarget.getBoundingClientRect();
    menu(
      AUTONOMY.map((a) => ({
        label: a.label,
        hint: a.hint,
        selected: a.level === autonomy,
        onClick: () => {
          postJson(`/api/sessions/${sessionId}/autonomy`, { level: a.level })
            .then(() => {
              if (dead) return;
              autonomy = a.level;
              autoPill.querySelector('.lbl').textContent = a.label;
              autoPill.dataset.lv = a.level;
              model.apply({ type: 'autonomy', level: a.level });
            })
            .catch((err) => toast(`autonomy change failed: ${err.message}`, { kind: 'error' }));
        },
      })),
      { x: r.left, y: r.bottom + 4 },
    );
  }

  // ---- stream + hydrate ------------------------------------------------------------------
  const onEvent = (e) => {
    if (dead) return;
    if (e.type === 'user') setRunning(true);
    // Drain AFTER model.apply(e) lands the stop frame — the queued prompt's user row then
    // follows the finished turn's stats/stopped rows instead of interleaving with them.
    let drained = null;
    if (e.type === 'stop') {
      setRunning(false);
      // Drain the queue: one prompt per completed turn, in order.
      drained = model.dequeue();
    }
    if (e.type === 'usage' && e.contextPct != null) {
      ctx.onContext?.({ pct: e.contextPct, used: e.inputTokens });
    }
    if (e.type === 'autonomy') {
      autonomy = e.level;
      autoPill.dataset.lv = e.level;
      const known = AUTONOMY.find((a) => a.level === e.level);
      autoPill.querySelector('.lbl').textContent = known ? known.label : e.level;
    }
    model.apply(e);
    if (drained && canPrompt) void sendText(drained.text);
    render();
  };

  const render = () => {
    if (dead) return;
    transcript.refresh();
    docks.refresh();
    hero.style.display = model.snapshot().rows.length ? 'none' : 'flex';
  };

  // Transcript-FIRST hydration, then a cursor'd subscribe. The transcript snapshot and the SSE
  // ids come from the same counter, so `?after=<last-id>` makes the two sources a partition:
  // hydrate covers ≤ lastId, the stream covers > lastId — no gap (anything emitted between the
  // fetch and the attach is still in the ring and replays), and no doubles (the old
  // subscribe-then-hydrate order let a live event land before hydrate() reset the model,
  // wiping it, or replay after it and duplicate it). On a transcript fetch failure fall back to
  // a plain subscribe: the stream's own ring replay still fills the view.
  let stream = null;
  const openStream = (after) => {
    if (dead) return;
    let url = `/events?session=${encodeURIComponent(sessionId)}`;
    if (after > 0) url += `&after=${after}`;
    stream = subscribe(
      url,
      onEvent,
      (state, detail) => {
        connection = state;
        connectionLabel.dataset.state = state;
        connectionLabel.textContent = state === ConnState.OPEN
          ? 'Connected to Shadow'
          : state === ConnState.RECONNECTING
            ? 'Reconnecting to Shadow… Your draft is kept.'
            : state === ConnState.DEAD
              ? 'Connection closed. Open the access link from your terminal again; your draft is kept.'
              : 'Connecting to Shadow…';
        syncComposer();
        if (state === ConnState.DEAD) {
          model.apply({ type: 'error', message: `stream lost — ${detail ?? 'closed'}` });
          render();
        }
      },
    );
  };

  getJson(`/api/transcript?session=${encodeURIComponent(sessionId)}`)
    .then((t) => {
      if (dead) return;
      model.hydrate((t.events ?? []).map((f) => f.event));
      // Re-derive the title on reload — the server keeps its "New session" placeholder forever,
      // so without this the header forgets what the first prompt called the session.
      if (!titled) {
        const firstUser = model.snapshot().rows.find((r) => r.kind === 'user');
        if (firstUser) {
          titled = true;
          ctx.onTitle?.(titleFromPrompt(firstUser.text));
        }
      }
      // Post-hydration running inference: a live row or a user row with no stop after it.
      const s = model.snapshot();
      const live = s.rows.some((r) => r.streaming || r.status === 'running');
      const last = s.rows.filter((r) => r.kind === 'user' || r.kind === 'status' || r.kind === 'stats').at(-1);
      setRunning(live || last?.kind === 'user');
      render();
      openStream(t.lastEventId ?? 0);
    })
    .catch((e) => {
      if (!dead) {
        model.apply({ type: 'error', message: `history unavailable: ${e.message}` });
        render();
      }
      openStream(0);
    });

  // Session facts (canPrompt / canInterrupt / model) from the registry list.
  getJson('/api/sessions')
    .then(({ sessions }) => {
      if (dead) return;
      const s = (sessions ?? []).find((x) => x.id === sessionId);
      if (!s) {
        connectionLabel.textContent = 'This session is no longer available. Start a new session from the sidebar.';
        return;
      }
      sessionReady = true;
      canPrompt = s.canPrompt !== false;
      canInterrupt = s.canInterrupt !== false;
      if (!canPrompt) {
        autoPill.style.display = 'none';
        hero.querySelector('.hello').textContent = s.origin === 'local' ? 'Ready when you are.' : 'Your terminal, in view.';
        hero.querySelector('.sub').textContent = s.origin === 'local'
          ? 'Start a session in this project to work with your model. Manage your endpoints in Settings.'
          : 'This view follows your terminal. Start a separate session to work from the browser.';
        hero.querySelector('.chips').replaceChildren(
          el('button', { class: 'btn btn-primary', onClick: () => ctx.onNewSession?.() }, ['Start a session']),
          el('button', { class: 'btn btn-ghost', onClick: () => ctx.onSettings?.() }, ['Settings']),
        );
      }
      autonomy = s.autonomy ?? autonomy;
      autoPill.dataset.lv = autonomy;
      const known = AUTONOMY.find((a) => a.level === autonomy);
      autoPill.querySelector('.lbl').textContent = known ? known.label : autonomy;
      syncComposer();
    })
    .catch((e) => {
      if (!dead) toast(`Could not load this session. Reload to reconnect. ${e.message}`, { kind: 'error' });
    });

  syncComposer();
  autosize();
  render();

  return {
    unmount() {
      saveDraft(sessionId, ta.value);
      dead = true;
      stream?.close();
      transcript.destroy();
      host.replaceChildren();
    },
    /** The session model — the app points the trajectory + inspector at it. */
    get model() {
      return model;
    },
  };
}
