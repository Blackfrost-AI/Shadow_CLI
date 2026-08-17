/**
 * The transcript renderer: model rows → DOM, incrementally.
 *
 * Rows are append-only in the store, so mounting is a walk: each row gets a node keyed by its
 * `seq` and is appended in order; LIVE rows (streaming answers, open think blocks, running
 * tools) get an `update(row)` closure that patches text in place — no re-mount, so open
 * disclosures, selections and scroll survive every event. Static rows build once.
 *
 * Markdown / code highlighting / diffs come from the SAME vendor engines as the Ink TUI, so
 * the two renderers cannot drift. Nothing is ever parsed as HTML — every node goes through
 * dom.js's `el()`.
 */

import { el } from './dom.js';
import { parseMarkdown } from './vendor/markdown.js';
import { highlight } from './vendor/highlight.js';
import { fmtMs, fmtTok, fmtPct, baseName } from './util.js';

/* ------------------------------------------------------------- markdown -- */

function renderSpans(spans) {
  const out = [];
  for (const s of spans ?? []) {
    if (s.code) {
      out.push(el('code', {}, [s.text]));
      continue;
    }
    if (s.link && s.url) {
      out.push(el('a', { href: s.url, rel: 'noreferrer noopener', target: '_blank' }, [s.text]));
      continue;
    }
    if (s.linkLabel) {
      out.push(el('span', { style: 'color:var(--sw-t-tertiary);' }, [s.text]));
      continue;
    }
    let node = s.text;
    if (s.bold) node = el('strong', {}, [node]);
    if (s.italic) node = el('em', {}, [node]);
    out.push(node);
  }
  return out;
}

function copyBtn(getText) {
  const btn = el('button', { class: 'icon-btn sm', title: 'Copy' }, ['⧉']);
  btn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(getText());
      btn.classList.add('is-done');
      btn.textContent = '✓';
      setTimeout(() => {
        btn.classList.remove('is-done');
        btn.textContent = '⧉';
      }, 1000);
    } catch {
      /* clipboard denied — a no-op beats a dead button */
    }
  };
  return btn;
}

function renderCode(block) {
  const lines = [];
  for (const span of highlight(block.code, block.lang ?? '')) {
    lines.push(el('span', { class: `hl-${span.role}` }, [span.text]));
  }
  return el('pre', {}, [
    el('div', { class: 'code-head' }, [
      el('span', { class: 'lang' }, [block.lang || 'text']),
      copyBtn(() => block.code),
    ]),
    el('code', {}, lines),
  ]);
}

function renderBlock(b) {
  switch (b.type) {
    case 'heading':
      return el(`h${Math.min(Math.max(b.level ?? 1, 1), 6)}`, {}, renderSpans(b.spans));
    case 'paragraph':
      return el('p', {}, renderSpans(b.spans));
    case 'code':
      return renderCode(b);
    case 'quote':
      return el('blockquote', {}, renderSpans(b.spans));
    case 'rule':
      return el('hr');
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const attrs = {};
      if (b.ordered && b.start !== undefined) attrs.start = String(b.start);
      return el(tag, attrs, (b.items ?? []).map((spans) => el('li', {}, renderSpans(spans))));
    }
    case 'table': {
      const align = (i) => {
        const a = b.align?.[i];
        return a && a !== 'auto' ? a : 'left';
      };
      const head = el('thead', {}, [
        el('tr', {}, (b.header ?? []).map((cell, i) => el('th', { style: `text-align:${align(i)}` }, renderSpans(cell)))),
      ]);
      const body = el('tbody', {}, (b.rows ?? []).map((row) =>
        el('tr', {}, row.map((cell, i) => el('td', { style: `text-align:${align(i)}` }, renderSpans(cell)))),
      ));
      return el('div', { class: 'scroll', style: 'overflow-x:auto;' }, [el('table', {}, [head, body])]);
    }
    default:
      return el('p', {}, [String(b.type ?? '')]);
  }
}

function renderMarkdown(text) {
  try {
    return parseMarkdown(text).map(renderBlock);
  } catch {
    return [el('p', {}, [text])];
  }
}

/* ------------------------------------------------------------ tool rows -- */

/** Best-effort one-line display argument (the dsh SUMMARY_KEYS set). */
export function argOf(args) {
  const a = args || {};
  const v = a.command ?? a.path ?? a.file ?? a.file_path ?? a.pattern ?? a.query ?? a.url ?? a.old_string ?? '';
  return typeof v === 'string' ? v : '';
}

const TOOL_GLYPH = {
  run_shell: '$',
  bash: '$',
  read: '☰',
  view: '☰',
  edit: '✎',
  apply: '✎',
  write: '✎',
  search: '⌕',
  grep: '⌕',
  glob: '⌕',
  agent: '◇',
  fetch: '⇄',
  web_fetch: '⇄',
  web_search: '⌕',
};

function glyphFor(name, sub) {
  if (sub) return '↳';
  return TOOL_GLYPH[name] ?? '⚙';
}

function renderDiffTable(lines) {
  const rows = [];
  let lnA = 0;
  let lnB = 0;
  for (const l of lines) {
    if (l.tag === '-') lnA++;
    else if (l.tag === '+') lnB++;
    else {
      lnA++;
      lnB++;
    }
    const cls = l.tag === '+' ? 'd-add' : l.tag === '-' ? 'd-del' : l.tag === '@' ? 'd-hunk' : '';
    rows.push(
      el('tr', { class: cls }, [
        el('td', { class: 'ln num' }, [l.tag === '+' ? String(lnB) : String(lnA)]),
        el('td', { class: 'sg', style: 'user-select:none;color:inherit;width:1%;' }, [l.tag === ' ' ? ' ' : l.tag]),
        el('td', {}, [l.text]),
      ]),
    );
  }
  return el('table', { class: 'd-table' }, rows);
}

/** The expanded card body — variant by what the result carried. */
function toolCardBody(row) {
  const kids = [];
  const arg = argOf(row.args);
  const pathy = row.args?.path ?? row.args?.file ?? row.args?.file_path ?? '';
  if (pathy) {
    kids.push(el('div', { class: 'card-head' }, [el('span', { class: 'path' }, [String(pathy)])]));
  }
  if (row.status === 'denied') {
    kids.push(el('div', { class: 'card-kv' }, [el('span', { class: 'k' }, ['denied']), el('span', { class: 'v' }, [row.summary || '—'])]));
  }
  if (row.diff?.length) kids.push(renderDiffTable(row.diff));
  if (row.error?.message) {
    kids.push(el('div', { class: 'card-kv' }, [el('span', { class: 'k' }, ['error']), el('span', { class: 'v' }, [row.error.message])]));
  }
  if (row.output) {
    kids.push(el('pre', { class: 'wrap' }, [row.output]));
    if (row.truncated) kids.push(el('div', { style: 'padding:4px 14px;font:var(--sw-f-xxxs);color:var(--sw-t-caption);' }, ['earlier output trimmed']));
  }
  if (row.findings?.length) {
    for (const f of row.findings) {
      kids.push(el('div', { class: 'card-kv' }, [
        el('span', { class: 'k' }, [f.severity ?? 'info']),
        el('span', { class: 'v' }, [`${f.title}: ${f.body}`]),
      ]));
    }
  }
  if (!kids.length && row.summary && row.status !== 'running') {
    const cap = 4000;
    const s = row.summary.length > cap ? `${row.summary.slice(0, cap)}\n…(trimmed in console)` : row.summary;
    kids.push(el('pre', { class: 'wrap' }, [s]));
  }
  if (!kids.length && row.status === 'running' && arg) {
    kids.push(el('div', { class: 'card-kv' }, [el('span', { class: 'k' }, ['arg']), el('span', { class: 'v' }, [arg])]));
  }
  return kids;
}

function buildToolRow(row) {
  const glyph = el('span', { class: 'tool-glyph' }, [glyphFor(row.name, row.subagent)]);
  const name = el('span', { class: 'tool-name' }, [row.subagent ? `${row.name}` : row.name]);
  const sum = el('span', { class: 'tool-sum' }, []);
  const chev = el('span', { class: 'chev' }, ['›']);
  const card = el('div', { class: 'tool-card' }, toolCardBody(row));

  const node = el('div', { class: 'tool' + (row.subagent ? ' is-sub' : '') }, [
    el('button', { class: 'tool-head' }, [glyph, name, sum, chev]),
    card,
  ]);
  node.querySelector('.tool-head').onclick = () => node.classList.toggle('is-open');

  const update = (r) => {
    node.classList.toggle('is-running', r.status === 'running');
    node.classList.toggle('is-error', r.status === 'error');
    node.classList.toggle('is-denied', r.status === 'denied');
    const bits = [];
    if (r.status === 'running') bits.push('running…');
    else if (r.status === 'denied') bits.push('denied');
    else if (r.status === 'error') bits.push('error');
    else bits.push(r.durationMs != null ? fmtMs(r.durationMs) : 'ok');
    if (r.diff?.length) {
      const adds = r.diff.filter((d) => d.tag === '+').length;
      const dels = r.diff.filter((d) => d.tag === '-').length;
      bits.push(`+${adds} −${dels}`);
    }
    const arg = r.summary && r.status !== 'running' ? r.summary : argOf(r.args);
    sum.textContent = [arg ? baseName(String(arg)) || arg : '', bits.join(' · ')].filter(Boolean).join(' · ');
    // Rebuild the card only when the outcome changed (running → done), not per chunk.
    if (node.dataset.done !== String(r.status !== 'running')) {
      node.dataset.done = String(r.status !== 'running');
      card.replaceChildren(...toolCardBody(r));
    }
  };
  update(row);
  return { node, update };
}

/* --------------------------------------------------------- other rows -- */

function buildUserRow(row) {
  const bubble = el('div', { class: 'bubble' }, [row.text]);
  const node = el('div', { class: 'row-user' }, [
    el('div', { style: 'display:flex;flex-direction:column;align-items:flex-end;gap:2px;max-width:100%;' }, [
      bubble,
      el('div', { class: 'msg-actions always', style: 'opacity:0.55;' }, [copyBtn(() => row.text)]),
    ]),
  ]);
  return { node, update: () => {} };
}

function buildAssistantRow(row) {
  const body = el('div', { class: 'md' }, []);
  const actions = el('div', { class: 'msg-actions' }, [copyBtn(() => row.text)]);
  const node = el('div', { class: 'row-md' }, [body, actions]);
  const update = (r) => {
    if (r.streaming) {
      // Plain pre-wrap text while streaming — markdown parses once, on commit.
      if (body.dataset.mode !== 'raw') {
        body.classList.remove('md');
        body.replaceChildren();
        body.dataset.mode = 'raw';
        body.style.whiteSpace = 'pre-wrap';
      }
      const at = body.firstChild;
      if (at && at.nodeType === 3) at.nodeValue = r.text;
      else body.prepend(document.createTextNode(r.text));
    } else if (body.dataset.mode !== 'md') {
      body.dataset.mode = 'md';
      body.classList.add('md');
      body.style.whiteSpace = '';
      body.replaceChildren(...renderMarkdown(r.text));
    }
  };
  update(row);
  return { node, update };
}

function buildThinkRow(row) {
  const label = el('span', { class: 'label' }, []);
  const bodyEl = el('div', { class: 'think-body scroll' }, []);
  const node = el('div', { class: 'think' + (row.streaming ? ' is-latest' : '') }, [
    el('button', { class: 'think-head' }, [el('span', { style: 'flex:none;' }, ['✻']), label, el('span', { class: 'chev' }, ['›'])]),
    bodyEl,
  ]);
  node.querySelector('.think-head').onclick = () => {
    node.classList.toggle('is-open');
    node.dataset.user = '1';
  };
  let doneAt = null;
  const update = (r) => {
    node.classList.toggle('is-latest', Boolean(r.streaming));
    if (!r.streaming && !doneAt) doneAt = Date.now();
    label.textContent = r.streaming ? 'Thinking…' : doneAt ? `Thought for ${fmtMs(doneAt - r.ts)}` : 'Thought';
    // Latest-line follow: an OPEN live block rides its own tail.
    if (r.streaming) {
      bodyEl.textContent = r.text;
      if (node.classList.contains('is-open')) bodyEl.scrollTop = bodyEl.scrollHeight;
    } else if (bodyEl.dataset.mode !== 'final') {
      bodyEl.dataset.mode = 'final';
      bodyEl.textContent = r.text;
    }
  };
  update(row);
  return { node, update };
}

function buildStatsRow(row) {
  const s = row.stats ?? {};
  const seg = (t) => el('span', {}, [t]);
  const sep = el('span', { class: 'sep' }, ['|']);
  const kids = [];
  if (s.steps != null) kids.push(seg(`${s.steps} step${s.steps === 1 ? '' : 's'}`));
  if (s.llmMs || s.toolMs) kids.push(seg(`LLM ${fmtMs(s.llmMs)} · Tool ${fmtMs(s.toolMs)}`));
  if (s.ttftMs != null && (s.tokPerSec != null || s.outputTokens > 0))
    kids.push(seg(`TTFT ${fmtMs(s.ttftMs)}${s.tokPerSec != null ? ` · ${s.tokPerSec.toFixed(1)} tok/s` : ''}`));
  if (s.cacheHitPct != null || s.inputTokens > 0 || s.outputTokens > 0)
    kids.push(
      seg(
        `${s.cacheHitPct != null ? `Cache ${fmtPct(s.cacheHitPct)} · ` : ''}In ${fmtTok(s.inputTokens)} · Out ${fmtTok(s.outputTokens)}`,
      ),
    );
  if (s.costUSD > 0) kids.push(seg(`$${s.costUSD < 0.01 ? s.costUSD.toFixed(4) : s.costUSD.toFixed(2)}`));
  const node = el('div', { class: 'stats' }, kids.flatMap((k, i) => (i ? [sep, k] : [k])));
  return { node, update: () => {} };
}

function buildRow(row) {
  switch (row.kind) {
    case 'user':
      return buildUserRow(row);
    case 'assistant':
      return buildAssistantRow(row);
    case 'think':
      return buildThinkRow(row);
    case 'tool':
      return buildToolRow(row);
    case 'stats':
      return buildStatsRow(row);
    case 'error':
      return {
        node: el('div', { style: 'margin:10px 0;padding:10px 14px;border-radius:12px;background:color-mix(in srgb, var(--sw-error) 8%, transparent);border:1px solid color-mix(in srgb, var(--sw-error) 30%, transparent);color:var(--sw-error);font:var(--sw-f-s);white-space:pre-wrap;overflow-wrap:anywhere;' }, [row.text]),
        update: () => {},
      };
    case 'finding':
      return {
        node: el('div', { style: 'margin:10px 0;padding:10px 14px;border-radius:12px;border:1px solid var(--sw-border-2);background:var(--sw-bg-layer-1);' }, [
          el('div', { style: 'font:var(--sw-f-s-strong);color:var(--sw-t-primary);' }, [row.title]),
          el('div', { style: 'font:var(--sw-f-xs);color:var(--sw-t-tertiary);white-space:pre-wrap;margin-top:2px;' }, [row.body]),
        ]),
        update: () => {},
      };
    case 'task':
      return {
        node: el('div', { class: 'tool' }, [
          el('div', { class: 'tool-head', style: 'cursor:default;' }, [
            el('span', { class: 'tool-glyph' }, ['◆']),
            el('span', { class: 'tool-name' }, [row.from ? `task · ${row.from}` : 'task finished']),
            el('span', { class: 'tool-sum' }, []),
          ]),
          row.text ? el('div', { class: 'tool-card', style: 'display:block;' }, [el('pre', { class: 'wrap' }, [row.text])]) : null,
        ]),
        update: () => {},
      };
    case 'subagent':
      return {
        node: el('div', { style: 'margin:4px 0;font:var(--sw-f-xs);color:var(--sw-t-tertiary);' }, [
          `◇ ${row.queued ? 'queued' : 'started'}${row.background ? ' (background)' : ''} · ${row.type}${row.description ? ` — ${row.description}` : ''}`,
        ]),
        update: () => {},
      };
    case 'subagent_end':
      return {
        node: el('div', { style: 'margin:4px 0;font:var(--sw-f-xs);color:var(--sw-t-tertiary);' }, [
          `◇ ${row.type} ${row.ok ? 'finished' : 'failed'}`,
        ]),
        update: () => {},
      };
    case 'approval_outcome':
      return {
        node: el('div', { style: 'margin:4px 0;font:var(--sw-f-xxs);color:var(--sw-t-caption);' }, [
          `${
            row.outcome === 'approved'
              ? '✓ approved'
              : row.outcome === 'session'
                ? '✓ approved for session'
                : row.outcome === 'answered'
                  ? '✓ answered'
                  : row.outcome === 'cancelled'
                    ? '– cancelled'
                    : '✕ denied'
          }`,
        ]),
        update: () => {},
      };
    case 'trimmed':
      return {
        node: el('div', { style: 'padding:8px 0;font:var(--sw-f-xxxs);color:var(--sw-t-caption);text-align:center;' }, [row.text]),
        update: () => {},
      };
    case 'status':
    default:
      return {
        node: el('div', { style: `margin:4px 0;font:var(--sw-f-xxxs);color:${row.tone === 'warn' ? 'var(--sw-warn-label)' : 'var(--sw-t-caption)'};` }, [row.text]),
        update: () => {},
      };
  }
}

/* --------------------------------------------------- the keyed renderer -- */

/**
 * Mount the transcript into `scroller` (a .tl container) and keep it in sync with the model.
 * Returns { refresh(), destroy() }. Call refresh() on every model notify.
 */
export function createTranscript(scroller, model) {
  const inner = el('div', { class: 'tl-inner' }, []);
  scroller.replaceChildren(inner);

  /** seq → { node, update } — the reconciliation index. */
  const mounted = new Map();

  const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
  let pinned = true;

  const onScroll = () => {
    const was = pinned;
    pinned = atBottom();
    if (was !== pinned) jump.style.visibility = pinned ? 'hidden' : 'visible';
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });

  const jump = el(
    'button',
    {
      class: 'btn-send',
      style:
        'position:absolute;right:32px;bottom:16px;width:34px;height:34px;border-radius:999px;box-shadow:var(--sw-shadow-2);visibility:hidden;background:var(--sw-btn-floating);color:var(--sw-t-secondary);',
      onClick: () => {
        pinned = true;
        scroller.scrollTop = scroller.scrollHeight;
        jump.style.visibility = 'hidden';
      },
    },
    ['↓'],
  );

  const refresh = () => {
    const { rows } = model.snapshot();
    let liveDirty = false;
    for (const row of rows) {
      let m = mounted.get(row.seq);
      if (!m) {
        m = buildRow(row);
        // Append-only ordering. A trim drops front rows; drop their nodes too.
        mounted.set(row.seq, m);
        inner.append(m.node);
        liveDirty = true;
      } else if (row.streaming || row.status === 'running') {
        m.update(row);
        liveDirty = true;
      } else if (m.pendingFinal) {
        m.pendingFinal = false;
        m.update(row);
        liveDirty = true;
      }
      if (row.streaming || row.status === 'running') m.pendingFinal = true;
    }
    // Front-trim: drop nodes whose seq fell off the store window.
    if (mounted.size > rows.length + 8) {
      const live = new Set(rows.map((r) => r.seq));
      for (const [seq, m] of mounted) {
        if (!live.has(seq)) {
          m.node.remove();
          mounted.delete(seq);
        }
      }
    }
    if (liveDirty && pinned) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  };

  return {
    refresh,
    destroy() {
      scroller.removeEventListener('scroll', onScroll);
    },
    jumpToLatest: jump,
  };
}
