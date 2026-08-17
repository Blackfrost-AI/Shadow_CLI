/**
 * The details inspector rail: stacked, collapsible sections of session facts — identity, usage
 * accounting, per-request telemetry, sub-agents. Everything reads the session model + the
 * registry summary the app passes in; the rail holds no state of its own beyond which sections
 * the user opened.
 *
 * Refresh policy: rebuilt on a trailing throttle (metrics tick with every event; the rail does
 * not need to keep up with token deltas) and on session switch.
 */

import { el } from './dom.js';
import { fmtMs, fmtTok, fmtPct } from './util.js';

/** A collapsible section. `open` defaults true unless told otherwise. */
function section(title, kids, { open = true } = {}) {
  const body = el('div', { class: 'det-sec-body' }, kids);
  const node = el('div', { class: 'det-sec' + (open ? ' is-open' : '') }, [
    el(
      'button',
      {
        class: 'det-sec-head',
        onClick: () => node.classList.toggle('is-open'),
      },
      [title, el('span', { class: 'chev' }, ['›'])],
    ),
    body,
  ]);
  return { node, body };
}

const kv = (k, v) => el('div', { class: 'det-kv' }, [el('span', { class: 'k' }, [k]), el('span', { class: 'v' }, [String(v ?? '—')])]);

/* ------------------------------------------------------------ json tree -- */

const jsonRow = (key, node, depth) => {
  const row = el('div', { class: 'j-row' }, []);
  if (key != null) row.append(el('span', { class: 'j-key' }, [`${JSON.stringify(key)}: `]));
  row.append(node);
  void depth;
  return row;
};

/**
 * A collapsible JSON tree node (objects/arrays collapse; scalars are leaves). Deep arrays of
 * scalars render inline to keep the rail readable.
 */
function jsonNode(value, key = null, depth = 0) {
  if (value === null || value === undefined) return jsonRow(key, el('span', { class: 'j-null' }, ['null']));
  if (typeof value === 'string') return jsonRow(key, el('span', { class: 'j-str' }, [JSON.stringify(value)]));
  if (typeof value === 'number') return jsonRow(key, el('span', { class: 'j-num' }, [String(value)]));
  if (typeof value === 'boolean') return jsonRow(key, el('span', { class: 'j-bool' }, [String(value)]));

  const isArr = Array.isArray(value);
  const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value);
  if (!entries.length) {
    return jsonRow(key, el('span', { class: 'j-punct' }, [isArr ? '[ ]' : '{ }']));
  }

  // Shallow scalar-only containers render on ONE line — a flat string map should not take 12.
  if (depth >= 1 && entries.every(([, v]) => v == null || typeof v !== 'object')) {
    const parts = entries.map(([, v]) => (typeof v === 'string' ? JSON.stringify(v) : String(v)));
    return jsonRow(key, el('span', { class: 'j-punct' }, [isArr ? `[ ${parts.join(', ')} ]` : `{ ${parts.join(', ')} }`]));
  }

  const kids = el('div', { class: 'j-kids' }, entries.slice(0, 64).map(([k, v]) => jsonNode(v, k, depth + 1)));
  if (entries.length > 64) {
    kids.append(el('div', { class: 'j-ellipsis' }, [`… ${entries.length - 64} more`]));
  }
  const caret = el('span', { class: 'j-caret' }, ['▸']);
  const branch = el('span', {}, [caret, el('span', { class: 'j-punct' }, [isArr ? `[${entries.length}]` : `{${entries.length}}`])]);
  const row = el('div', { class: 'j-row', style: 'flex-wrap:wrap;' }, []);
  if (key != null) row.append(el('span', { class: 'j-key' }, [`${JSON.stringify(key)}: `]));
  row.append(branch, kids);
  const toggle = (open) => {
    kids.classList.toggle('is-collapsed', !open);
    caret.textContent = open ? '▾' : '▸';
  };
  caret.onclick = () => toggle(kids.classList.contains('is-collapsed'));
  caret.style.cursor = 'pointer';
  return row;
}

/* ---------------------------------------------------------------- rail -- */

/**
 * @param {Element} host the .det aside body
 * @param {Object} ctx
 *   model()  → the ACTIVE session model (or null between mounts)
 *   session() → the registry SessionSummary (or null)
 */
export function createDetails(host, ctx) {
  const body = el('div', { class: 'det-body' }, []);
  host.replaceChildren(
    el('div', { class: 'det-head' }, [el('span', { class: 't' }, ['Inspector'])]),
    body,
  );

  let queued = false;
  const refresh = () => {
    if (queued) return; // trailing coalesce — one rebuild per frame at most
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      render();
    });
  };

  const render = () => {
    const model = ctx.model?.() ?? null;
    const session = ctx.session?.() ?? null;
    const snap = model ? model.snapshot() : null;

    const kids = [];

    // ---- session identity ----
    const idSec = section('Session', [
      kv('id', session?.id ?? '—'),
      kv('origin', session?.origin ?? '—'),
      kv('model', session?.model || snap?.hud?.model || '—'),
      kv('autonomy', session?.autonomy ?? snap?.hud?.autonomy ?? '—'),
      kv('status', session?.status ?? '—'),
    ]);
    kids.push(idSec.node);

    if (snap) {
      // ---- usage accounting ----
      const s = snap.session;
      kids.push(
        section('Usage', [
          kv('turns', s.turns),
          kv('steps', s.steps),
          kv('input', fmtTok(s.inputTokens)),
          kv('output', fmtTok(s.outputTokens)),
          s.cacheHitPct != null ? kv('cache hit', fmtPct(s.cacheHitPct)) : null,
          s.costUSD > 0 ? kv('cost', `$${s.costUSD.toFixed(4)}`) : null,
          snap.hud.usage?.contextPct != null ? kv('context', fmtPct(snap.hud.usage.contextPct)) : null,
        ]).node,
      );

      // ---- per-request telemetry (latest first, capped) ----
      const reqs = [];
      for (const t of snap.turns) for (const r of t.requests ?? []) reqs.push(r);
      const last = reqs.slice(-12).reverse();
      kids.push(
        section(
          `Requests (${reqs.length})`,
          last.length
            ? last.map((r, i) =>
                kv(
                  `#${reqs.length - i}`,
                  [
                    r.latencyMs != null ? fmtMs(r.latencyMs) : '—',
                    r.ttftMs != null ? `ttft ${fmtMs(r.ttftMs)}` : null,
                    r.in != null ? `in ${fmtTok(r.in)}` : null,
                    r.out != null ? `out ${fmtTok(r.out)}` : null,
                    r.cacheRead ? `cache ${fmtTok(r.cacheRead)}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                ),
              )
            : [el('div', { class: 'det-kv' }, [el('span', { class: 'k' }, ['no requests yet'])])],
          { open: false },
        ).node,
      );

      // ---- sub-agents ----
      if (snap.subagents.length) {
        kids.push(
          section(
            `Sub-agents (${snap.subagents.length})`,
            snap.subagents.map((sa) =>
              kv(`${sa.type}${sa.background ? ' · bg' : ''}`, sa.ok == null ? (sa.queued ? 'queued' : 'running') : sa.ok ? 'ok' : 'failed'),
            ),
          ).node,
        );
      }

      // ---- pending approvals ----
      if (snap.approvals.length) {
        kids.push(
          section(
            `Pending asks (${snap.approvals.length})`,
            snap.approvals.map((a) => kv(a.tool, a.kind)),
            { open: false },
          ).node,
        );
      }

      // ---- raw last turn (diagnostics) ----
      const lt = model.lastTurn?.();
      if (lt) {
        const stats = model.statsFor(lt);
        kids.push(
          section(
            'Last turn',
            [el('div', { class: 'json' }, [jsonNode(stats)])],
            { open: false },
          ).node,
        );
      }
    } else {
      kids.push(
        el('div', { class: 'det-sec' }, [
          el('div', { class: 'det-sec-body', style: 'padding:14px 16px;color:var(--sw-t-caption);font:var(--sw-f-xs);' }, [
            'No session mounted.',
          ]),
        ]),
      );
    }

    body.replaceChildren(...kids);
  };

  render();
  return { refresh };
}
