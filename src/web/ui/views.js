import { el, mount } from './dom.js';
import { getJson } from './api.js';
import { eclipse } from './rail.js';
import { viewShell, blockHead } from './parts.js';
import { modelsView } from './views/models.js';
import { agentsView } from './views/agents.js';
import { mcpView } from './views/mcp.js';
import { chatView } from './views/chat.js';
import { sessionsView } from './views/sessions.js';
import { kitView } from './views/kit.js';

/**
 * One render function per surface. Each larger surface lives in its own file under views/ and is
 * re-exported here so the router has a single import. This file holds the small views: the Home
 * dashboard, the "coming soon" placeholders (Usage / Approvals / Cron), and the re-exports.
 *
 * Every view receives the mount point and returns an optional cleanup closure (e.g. to cancel a
 * fetch or close an SSE subscription when the user navigates away).
 */

export { modelsView, agentsView, mcpView, chatView, sessionsView, kitView };

/**
 * A "coming soon" surface — a centred glyph, title, body, and a mono note pill. The three future
 * surfaces (Usage / Approvals / Cron) differ only in their copy, so they share this factory.
 */
function placeholderView(glyph, title, body, note) {
  return (host) => {
    mount(host, [
      el('div', { class: 'placeholder' }, [
        el('div', { class: 'placeholder-inner' }, [
          el('div', { class: 'placeholder-glyph' }, [glyph]),
          el('h1', {}, [title]),
          el('p', {}, [body]),
          el('div', { class: 'placeholder-note' }, [note]),
        ]),
      ]),
    ]);
    return () => {};
  };
}

export const usageView = placeholderView(
  '∑',
  'Usage',
  'Cost and token analytics per session, model, and day — everything metered locally, reported to no one.',
  'coming soon · GET /api/usage',
);

export const approvalsView = placeholderView(
  '✓',
  'Approvals',
  'A queue for approving risky tool calls from the browser. Today the browser policy is fail-closed: anything needing approval is denied with a notice, and you answer in the terminal.',
  'coming soon · fail-closed today',
);

export const cronView = placeholderView(
  '◷',
  'Cron',
  'Scheduled agents — recurring tasks that run on your machine, on your clock.',
  'coming soon · POST /api/cron',
);

/** How each autonomy level reads in one line — the note under the Home autonomy card. */
const AUTONOMY_NOTE = {
  manual: 'every tool call needs approval',
  'auto-read': 'reads run free · writes & exec need approval',
  'auto-edit': 'edits run free · exec & network need approval',
  full: 'runs unattended — no approvals',
};

/** The home/dashboard: a snapshot from /api/state as stat cards, plus the privacy banner. */
export function homeView(host) {
  let cancelled = false;
  void (async () => {
    let snap = {};
    try {
      snap = await getJson('/api/state');
    } catch (e) {
      if (!cancelled) mount(host, [viewShell(blockHead('Home'), [el('p', { class: 'error' }, [`Failed to load state: ${String(e)}`])])]);
      return;
    }
    if (cancelled) return;

    const models = Array.isArray(snap.models) ? snap.models : [];
    const agents = Array.isArray(snap.agents) ? snap.agents : [];
    const mcp = snap.mcpServers && typeof snap.mcpServers === 'object' ? Object.keys(snap.mcpServers) : [];
    const activeEntry = models.find((m) => m.label === snap.model);
    const disabled = models.filter((m) => m.disabled).length;
    const builtin = agents.filter((a) => a.builtin).length;
    const custom = agents.length - builtin;

    // A stat card: KEY · value · note. `opts.big` renders a count in the sans face; `opts.accent`
    // tints the value; `opts.err` reddens the note (kept for symmetry with the design).
    const card = (key, value, note, opts = {}) =>
      el('div', { class: 'card' }, [
        el('div', { class: 'card-key' }, [key]),
        el('div', { class: `card-val${opts.big ? ' big' : ''}${opts.accent ? ' accent' : ''}` }, [String(value)]),
        ...(note ? [el('div', { class: `card-note${opts.errNote ? ' err' : ''}` }, [note])] : []),
      ]);

    const cards = el('div', { class: 'cards' }, [
      card('active model', snap.model ?? '—', activeEntry ? `${activeEntry.model} · ${activeEntry.provider}` : (snap.provider ?? '')),
      card('fallback', snap.fallbackModel ?? '—', 'used on provider errors'),
      card('autonomy', snap.autonomy ?? '—', AUTONOMY_NOTE[snap.autonomy] ?? '', { accent: true }),
      card('model presets', models.length, disabled ? `${disabled} disabled` : 'all enabled', { big: true }),
      card('sub-agents', agents.length, `${builtin} builtin · ${custom} custom`, { big: true }),
      card('mcp servers', mcp.length, mcp.length === 1 ? '1 configured' : `${mcp.length} configured`, { big: true }),
    ]);

    const banner = el('div', { class: 'privacy-banner' }, [
      eclipse(28),
      el('div', {}, [
        el('div', { style: 'font-weight:600' }, ['Nothing leaves this machine']),
        el('div', { class: 'card-note', style: 'font-size:12px' }, ['Serving on 127.0.0.1 only. No telemetry, no remote fonts, no CDN. Your models, your data, your box.']),
      ]),
      el('span', { class: 'verified' }, ['✓ verified']),
    ]);

    mount(host, [
      viewShell(blockHead('Home', 'Everything runs on this machine. Loopback-only · zero telemetry · no cloud.'), [cards, banner]),
    ]);
  })();
  return () => {
    cancelled = true;
  };
}
