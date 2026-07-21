import { el, mount } from '../dom.js';
import { getJson, postJson } from '../api.js';
import { subscribe, ConnState } from '../sse.js';
import { createStore } from '../transcriptStore.js';
import { parseMarkdown } from '../vendor/markdown.js';
import { highlight } from '../vendor/highlight.js';

/**
 * The session console (Shadow Console design). Header (title / path · id + status + connection) ·
 * a HUD strip · a transcript of the agent turn (user turns, reasoning, the full tool-card
 * vocabulary — diffs, streaming shell, findings — and streaming markdown answers) · a composer
 * (read-only for the terminal mirror; live with context chips for a browser session).
 *
 * Markdown/highlight/diff all come from the SAME engine as the Ink TUI (vendor/), so the two
 * renderers can't drift. Nothing is parsed as HTML — every node goes through el().
 */

// ── markdown → DOM ──────────────────────────────────────────────────────────────────────
function renderSpans(spans) {
  const out = [];
  for (const s of spans ?? []) {
    if (s.code) {
      out.push(el('code', { class: 'md-code' }, [s.text]));
      continue;
    }
    if (s.link && s.url) {
      out.push(el('a', { href: s.url, rel: 'noreferrer noopener', target: '_blank' }, [s.text]));
      continue;
    }
    if (s.linkLabel) {
      out.push(el('span', { class: 'md-linklabel' }, [s.text]));
      continue;
    }
    let node = s.text;
    if (s.bold) node = el('strong', {}, [node]);
    if (s.italic) node = el('em', {}, [node]);
    out.push(node);
  }
  return out;
}

function renderCode(block) {
  const lines = [];
  for (const span of highlight(block.code, block.lang ?? '')) {
    lines.push(el('span', { class: `hl-${span.role}` }, [span.text]));
  }
  return el('div', { class: 'md-codeblock' }, [
    el('div', { class: 'md-codelang' }, [block.lang || 'text']),
    el('pre', {}, [el('code', {}, lines)]),
  ]);
}

function renderBlock(b) {
  switch (b.type) {
    case 'heading':
      return el(`h${Math.min(Math.max(b.level ?? 1, 1), 6)}`, { class: 'md-h' }, renderSpans(b.spans));
    case 'paragraph':
      return el('p', { class: 'md-p' }, renderSpans(b.spans));
    case 'code':
      return renderCode(b);
    case 'quote':
      return el('blockquote', { class: 'md-quote' }, renderSpans(b.spans));
    case 'rule':
      return el('hr', { class: 'md-rule' });
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const attrs = { class: 'md-list' };
      if (b.ordered && b.start !== undefined) attrs.start = String(b.start);
      return el(tag, attrs, (b.items ?? []).map((spans) => el('li', {}, renderSpans(spans))));
    }
    case 'table': {
      const head = el('thead', {}, [
        el('tr', {}, (b.header ?? []).map((cell, i) => el('th', { style: `text-align:${alignOf(b.align, i)}` }, renderSpans(cell)))),
      ]);
      const body = el('tbody', {}, (b.rows ?? []).map((row) =>
        el('tr', {}, row.map((cell, i) => el('td', { style: `text-align:${alignOf(b.align, i)}` }, renderSpans(cell)))),
      ));
      return el('div', { class: 'scrollpane' }, [el('table', { class: 'md-table' }, [head, body])]);
    }
    default:
      return el('p', { class: 'md-p' }, [String(b.type ?? '')]);
  }
}

function alignOf(align, i) {
  const a = align?.[i];
  return a && a !== 'auto' ? a : 'left';
}

function renderMarkdown(text) {
  try {
    return parseMarkdown(text).map(renderBlock);
  } catch {
    return [el('p', { class: 'md-p' }, [text])];
  }
}

// ── tool cards ──────────────────────────────────────────────────────────────────────────
const RISK_KEY = { network: 'net' };
function riskClass(r) {
  return `badge risk-${RISK_KEY[r] ?? r}`;
}
function fmtMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}
/** Best-effort display argument for a tool call (the command / path / pattern). */
function argOf(item) {
  const a = item.args || {};
  const v = a.command ?? a.path ?? a.file ?? a.file_path ?? a.pattern ?? a.query ?? a.url ?? '';
  return typeof v === 'string' ? v : '';
}

function toolStatusEl(item) {
  if (item.status === 'running') {
    return el('span', { class: 'tool-r running' }, [el('span', { class: 'spinner' }, []), 'running…']);
  }
  if (item.status === 'denied') return el('span', { class: 'tool-r denied' }, ['denied']);
  if (item.status === 'error') return el('span', { class: 'tool-r error' }, ['error']);
  return el('span', { class: 'tool-r ok' }, [`ok${item.durationMs != null ? ` · ${fmtMs(item.durationMs)}` : ''}`]);
}

function toolHead(item) {
  const bits = [];
  if (item.risk) bits.push(el('span', { class: riskClass(item.risk) }, [item.risk]));
  bits.push(el('span', { class: 'tool-name' }, [item.name]));
  const arg = argOf(item);
  if (arg) bits.push(el('span', { class: 'tool-arg' }, [arg]));
  bits.push(toolStatusEl(item));
  if (item.diff?.length) {
    const adds = item.diff.filter((d) => d.tag === '+').length;
    const dels = item.diff.filter((d) => d.tag === '-').length;
    bits.push(el('span', { class: 'tool-diffcount' }, [el('span', { class: 'add' }, [`+${adds}`]), el('span', { class: 'del' }, [`−${dels}`])]));
  }
  return bits;
}

function renderDiff(lines) {
  return el('div', { class: 'diff' }, lines.map((l) => {
    const cls = l.tag === '+' ? 'add' : l.tag === '-' ? 'del' : 'ctx';
    return el('div', { class: `diff-row ${cls}` }, [
      el('span', { class: 'g' }, [l.tag === ' ' ? ' ' : l.tag]),
      el('span', { class: 'c' }, [l.text]),
    ]);
  }));
}

function toolBody(item) {
  const kids = [];
  if (item.status === 'denied') kids.push(el('div', { class: 'tool-denied-reason' }, [`reason: ${item.summary || 'denied'}`]));
  if (item.diff?.length) kids.push(renderDiff(item.diff));
  if (item.error?.message) kids.push(el('div', { class: 'tool-line' }, [item.error.message]));
  if (item.output) {
    kids.push(el('pre', { class: 'tool-pre' }, [item.output]));
    if (item.truncated) kids.push(el('div', { class: 'tool-trim' }, ['earlier output trimmed']));
  } else if (item.summary && item.status === 'ok' && !item.diff?.length) {
    kids.push(el('div', { class: 'tool-line' }, [item.summary]));
  }
  for (const f of item.findings ?? []) {
    kids.push(el('div', { class: 'tool-finding' }, [el('span', { class: `badge sev-${f.severity ?? 'info'}` }, [f.severity ?? 'info']), `${f.title}: ${f.body}`]));
  }
  return kids;
}

function renderTool(item) {
  // Open (always-visible) for anything not-yet-succeeded, running, or bearing a diff — the diff
  // is the interesting part. A plain successful call collapses to a one-liner.
  const open = item.status !== 'ok' || item.status === 'running' || (item.diff?.length ?? 0) > 0;
  const body = toolBody(item);
  if (open) {
    return el('div', { class: 'tool-card open' }, [el('div', { class: 'tool-card-head' }, toolHead(item)), ...body]);
  }
  return el('details', { class: 'tool-card' }, [el('summary', {}, toolHead(item)), ...body]);
}

// ── transcript items ────────────────────────────────────────────────────────────────────
function renderItem(item) {
  switch (item.kind) {
    case 'user':
      return el('div', { class: 'turn-user' }, [
        el('span', { class: 'turn-caret' }, ['❯']),
        el('div', { class: 'turn-user-text' }, [item.text]),
      ]);
    case 'assistant': {
      const body = el('div', { class: 'answer-body' }, renderMarkdown(item.text));
      if (item.streaming) body.append(el('span', { class: 'answer-caret' }, []));
      return el('div', { class: 'answer' }, [body]);
    }
    case 'thinking':
      return el('details', { class: 'reasoning' }, [
        el('summary', {}, ['▸ Reasoning']),
        el('div', { class: 'reasoning-body' }, renderMarkdown(item.text)),
      ]);
    case 'tool':
      return renderTool(item);
    case 'error':
      return el('div', { class: 'error-row' }, [item.text]);
    case 'finding':
      return el('div', { class: `finding-card sev-${item.severity ?? 'info'}` }, [
        el('div', { style: 'min-width:0' }, [
          el('div', { class: 'finding-title' }, [el('span', { class: `badge sev-${item.severity ?? 'info'}` }, [item.severity ?? 'info']), item.title]),
          el('div', { class: 'finding-body' }, [item.body]),
        ]),
      ]);
    case 'status':
    case 'trimmed':
      if (/^stopped/.test(item.text)) return el('div', { class: 'status-end' }, [`— ${item.text} —`]);
      return el('div', { class: 'status-div' + (item.tone === 'warn' ? ' warn' : '') }, [
        el('span', { class: 'rule' }, []),
        item.text,
        el('span', { class: 'rule' }, []),
      ]);
    default:
      return el('div', { class: 'status-div' }, [el('span', { class: 'rule' }, []), String(item.kind), el('span', { class: 'rule' }, [])]);
  }
}

// ── the view ────────────────────────────────────────────────────────────────────────────
function basename(p) {
  const parts = String(p).split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}
function shortPath(p) {
  const parts = String(p).split('/').filter(Boolean);
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p;
}

export function chatView(host, sessionId = 'cli') {
  const store = createStore();
  const q = `?session=${encodeURIComponent(sessionId)}`;
  const isMirror = sessionId === 'cli';
  let meta = null; // session summary once fetched

  // ── header ──
  const titleEl = el('div', { class: 'console-title' }, [isMirror ? 'Terminal (mirror)' : `Session ${sessionId.slice(0, 8)}`]);
  const subEl = el('div', { class: 'console-sub' }, []);
  const statusBadge = el('span', { class: 'badge s-idle' }, ['idle']);
  const connDot = el('span', { class: 'dot c-warn' }, []);
  const connTxt = el('span', { class: 'conn-txt c-connecting' }, ['connecting']);
  const head = el('div', { class: 'console-head' }, [
    el('div', { class: 'console-titles' }, [titleEl, subEl]),
    el('div', { class: 'console-head-right' }, [statusBadge, el('span', { class: 'conn-pill' }, [connDot, connTxt])]),
  ]);

  const hudEl = el('div', { class: 'hud' }, []);
  const transcript = el('div', { class: 'transcript' }, [el('div', { class: 'transcript-inner' }, [])]);
  const inner = transcript.firstChild;

  // ── composer ──
  let setRunning = () => {};
  let refreshChips = () => {};
  let composer;
  if (isMirror) {
    composer = el('div', { class: 'composer' }, [
      el('div', { class: 'composer-inner' }, [
        el('div', { class: 'composer-mirror' }, [
          el('span', { class: 'ic' }, ['⌀']),
          el('span', {}, ['Read-only — this mirrors the live terminal. Answer prompts and approvals in the terminal window.']),
          el('span', { class: 'composer-mirror-tag' }, ['canPrompt: false']),
        ]),
      ]),
    ]);
  } else {
    const input = el('textarea', { class: 'composer-ta', rows: '2', placeholder: 'Message the agent…  Enter to send · Shift+Enter for newline' });
    const err = el('span', { class: 'composer-err' }, ['']);
    const hint = el('span', { class: 'composer-hint' }, [
      el('b', {}, ['@']), ' files · ', el('b', {}, ['/']), ' commands · ', el('b', {}, ['$']), ' skills · ', el('b', {}, ['#']), ' conversations',
    ]);
    const sendBtn = el('button', { class: 'btn-send', type: 'button' }, ['Send ⏎']);
    const stopBtn = el('button', { class: 'btn-interrupt', type: 'button' }, [el('span', { class: 'dot c-err', style: 'border-radius:1px;width:8px;height:8px' }, []), 'Interrupt']);
    stopBtn.style.display = 'none';
    const box = el('div', { class: 'composer-box' }, [input, el('div', { class: 'composer-row' }, [hint, err, sendBtn, stopBtn])]);

    setRunning = (running) => {
      sendBtn.style.display = running ? 'none' : '';
      stopBtn.style.display = running ? '' : 'none';
      input.disabled = running;
      box.classList.toggle('running', !!running);
    };

    const chips = el('div', { class: 'chips' }, []);
    refreshChips = () => {
      const kids = [el('span', { class: 'chip' }, ['▤ ' + (meta ? basename(meta.displayPath) : 'project')])];
      if (meta?.model) kids.push(el('span', { class: 'chip' }, ['◈ ' + meta.model, el('span', { class: 'car' }, [' ▾'])]));
      if (meta?.autonomy) kids.push(el('span', { class: 'chip accent' }, ['access: ' + meta.autonomy, el('span', { style: 'opacity:.6' }, [' ▾'])]));
      mount(chips, kids);
    };
    refreshChips();

    const send = async () => {
      const prompt = input.value.trim();
      if (!prompt || input.disabled) return;
      err.textContent = '';
      input.value = '';
      setRunning(true);
      try {
        await postJson(`/api/sessions/${sessionId}/chat`, { prompt });
      } catch (e) {
        const m = String(e).match(/\{"error":"([^"]+)"\}/);
        err.textContent = m ? m[1] : String(e).replace(/^Error:\s*/, '');
        input.value = prompt;
        setRunning(false);
      }
    };
    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void send();
      }
    });
    stopBtn.addEventListener('click', () => {
      void postJson(`/api/sessions/${sessionId}/interrupt`).catch(() => {});
    });

    composer = el('div', { class: 'composer' }, [el('div', { class: 'composer-inner' }, [chips, box])]);
  }

  mount(host, [el('div', { class: 'console' }, [head, hudEl, transcript, composer])]);

  // Stick to bottom unless the user scrolled up.
  let stick = true;
  transcript.addEventListener('scroll', () => {
    stick = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
  });

  const nodes = new Map();

  const renderHud = () => {
    const h = store.hudState();
    const cells = [];
    const cell = (kids, cls) => el('span', { class: 'hud-cell' + (cls ? ' ' + cls : '') }, kids);
    cells.push(cell([el('span', { class: 'dot' + (h.mode && h.mode !== 'idle' ? ' c-accent pulse' : ' c-faint') }, []), el('span', { class: 'v' }, [h.mode || 'idle'])]));
    if (h.usage) {
      const pct = h.usage.contextPct;
      cells.push(cell(['ctx ', el('span', { class: 'v' }, [pct > 0 && pct < 0.1 ? '<0.1%' : `${pct.toFixed(1)}%`])]));
      cells.push(cell([el('span', { class: 'v' }, [h.usage.costUSD < 0.01 ? '<$0.01' : `$${h.usage.costUSD.toFixed(2)}`])]));
      cells.push(cell([el('span', { class: 'v' }, [`${h.usage.inputTokens}→${h.usage.outputTokens}`]), ' tok']));
    }
    if (h.latencyMs != null) cells.push(cell([el('span', { class: 'v' }, [`${h.latencyMs}ms`])]));
    const access = h.autonomy || meta?.autonomy;
    if (access) cells.push(cell(['access ', el('span', { class: 'v' }, [access])], 'access'));
    const model = meta?.model;
    if (model) cells.push(el('span', { class: 'hud-model' }, ['model ', el('span', { class: 'v' }, [model])]));
    mount(hudEl, cells);
  };

  const render = () => {
    const items = store.snapshot();
    const seen = new Set();
    let prev = null;
    for (const item of items) {
      seen.add(item.id);
      const node = nodes.get(item.id);
      const fresh = renderItem(item);
      if (node) node.replaceWith(fresh);
      else if (prev) prev.after(fresh);
      else inner.prepend(fresh);
      nodes.set(item.id, fresh);
      prev = fresh;
    }
    for (const [id, node] of nodes) {
      if (!seen.has(id)) {
        node.remove();
        nodes.delete(id);
      }
    }
    renderHud();
    if (stick) transcript.scrollTop = transcript.scrollHeight;
  };

  const setConn = (state) => {
    const map = {
      [ConnState.OPEN]: ['live', 'c-ok', 'c-open', false],
      [ConnState.RECONNECTING]: ['reconnecting…', 'c-warn', 'c-reconnecting', true],
      [ConnState.DEAD]: ['disconnected', 'c-err', 'c-dead', false],
    };
    const [label, dotC, txtC, pulse] = map[state] ?? ['connecting', 'c-warn', 'c-connecting', false];
    connDot.className = 'dot ' + dotC + (pulse ? ' pulse' : '');
    connTxt.className = 'conn-txt ' + txtC;
    connTxt.textContent = label;
  };

  const unsubStore = store.subscribe(render);

  // Session summary → header, status badge, HUD access/model, composer chips + running-state.
  void getJson('/api/sessions')
    .then((r) => {
      meta = (r.sessions ?? []).find((s) => s.id === sessionId) || null;
      if (meta) {
        titleEl.textContent = meta.title || (isMirror ? 'Terminal (mirror)' : `Session ${sessionId.slice(0, 8)}`);
        mount(subEl, [
          el('span', {}, [shortPath(meta.displayPath)]),
          el('span', { class: 'sep' }, ['·']),
          el('span', {}, [meta.id === 'cli' ? 'cli' : meta.id.slice(0, 8)]),
        ]);
        statusBadge.className = `badge s-${meta.status}`;
        statusBadge.textContent = meta.status;
        if (!isMirror) setRunning(['running', 'queued', 'initializing'].includes(meta.status));
        refreshChips();
        renderHud();
      }
    })
    .catch(() => {});

  let stream = null;
  void getJson(`/api/transcript${q}`)
    .then((snap) => store.hydrate((snap.events ?? []).map((r) => r.event)))
    .catch(() => {})
    .finally(() => {
      render();
      stream = subscribe(
        `/events${q}`,
        (e) => {
          store.apply(e);
          if (e.type === 'stop') {
            setRunning(false);
            if (statusBadge) {
              statusBadge.className = 'badge s-idle';
              statusBadge.textContent = 'idle';
            }
          } else if (e.type === 'user' || (e.type === 'mode' && e.mode !== 'idle')) {
            setRunning(true);
            statusBadge.className = 'badge s-running';
            statusBadge.textContent = 'running';
          }
        },
        setConn,
      );
    });

  return () => {
    unsubStore();
    if (stream) stream.close();
    nodes.clear();
  };
}
