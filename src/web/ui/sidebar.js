/**
 * The left sidebar: brand, new-session, projects strip, session list, footer controls.
 * Replaces the old nav rail (rail.js) — navigation is now session-centric (dsh-style): the
 * sidebar IS the session switcher; settings/manage live in a modal, not routes.
 *
 * Data: GET /api/sessions polled on a slow cadence (4s) + a `refresh()` the app calls when the
 * active session's SSE emits status transitions, so the list feels live without a websocket.
 * Only the changed rows are patched — the list rebuild is cheap (≤ 8 sessions + the reserved
 * mirror), and rebuilding wholesale would kill hover state mid-click.
 */

import { el } from './dom.js';
import { getJson, del } from './api.js';
import { eclipse, toast, confirmDialog, tipOn } from './ui.js';
import { themeGlyph, cycleTheme } from './theme.js';
import { timeAgo, oneLine } from './util.js';

const POLL_MS = 4000;

/**
 * @param {Object} ctx
 * @param {() => string} ctx.activeId
 * @param {(id: string) => void} ctx.openSession
 * @param {() => void} ctx.newSession
 * @param {() => void} ctx.openSettings
 * @param {() => void} ctx.toggleSidebar
 */
export function createSidebar(ctx) {
  /** @type {Array<any>} */
  let sessions = [];

  // ---- head ------------------------------------------------------------------
  const btnCollapse = el('button', { class: 'icon-btn', onClick: () => ctx.toggleSidebar() }, ['«']);
  tipOn(btnCollapse, () => 'Toggle sidebar');
  const head = el('div', { class: 'sb-head' }, [
    el('span', { class: 'sb-logo', style: 'color:var(--sw-t-primary);' }, [
      eclipse(16, 'var(--sw-sidebar-fill)'),
      el('span', { class: 'word' }, ['Shadow']),
    ]),
    el('span', { style: 'flex:1;' }, []),
    btnCollapse,
  ]);

  // ---- new session -------------------------------------------------------------
  const btnNew = el(
    'button',
    {
      class: 'sb-new',
      onClick: () => ctx.newSession(),
    },
    [el('span', {}, ['✎']), el('span', { class: 'label' }, ['New session'])],
  );
  tipOn(btnNew, () => 'Start a session in the current project');

  // ---- projects strip ------------------------------------------------------------
  const projHost = el('div', { class: 'sb-projects' }, []);

  async function loadProjects() {
    try {
      const { projects } = await getJson('/api/projects');
      const activePath = ctx.activeProjectPath?.() ?? '';
      projHost.replaceChildren(
        ...(projects ?? []).slice(0, 4).map((p) =>
          el('button', {
            class: 'sb-proj' + (activePath && p.path === activePath ? ' is-active' : ''),
            title: p.path,
            onClick: () => ctx.newSession(p.path),
          }, [
            el('span', {}, ['▸']),
            el('span', { class: 'name' }, [p.label || p.path.split('/').pop() || p.path]),
          ]),
        ),
      );
    } catch {
      /* the strip stays empty; the session list carries the UI */
    }
  }

  // ---- session list ---------------------------------------------------------------
  const listHost = el('div', { class: 'sb-scroll scroll' }, []);

  const statusGlyph = (s) =>
    s.status === 'running' ? '▸' : s.status === 'queued' ? '⋯' : s.status === 'initializing' ? '◌' : s.status === 'error' ? '✕' : '•';

  const renderList = () => {
    const active = ctx.activeId();
    listHost.replaceChildren(
      el('div', { class: 'sb-label' }, ['Sessions']),
      ...sessions.map((s) => {
        const isMirror = s.origin === 'mirror' || s.origin === 'local';
        const busy = s.status === 'running' || s.status === 'queued' || s.status === 'initializing';
        // Named closeBtn — a local `del` here would shadow the api `del` and turn the close
        // call below into awaiting a DOM element (DELETE never sent, no error raised).
        const closeBtn = el(
          'button',
          {
            class: 'icon-btn sm x',
            onClick: async (e) => {
              e.stopPropagation();
              const ok = await confirmDialog({
                title: 'Close session?',
                body: oneLine(`"${s.title}" — its transcript buffer ends here (the durable log on disk stays).`, 140),
                confirmLabel: 'Close',
                danger: true,
              });
              if (!ok) return;
              try {
                await del(`/api/sessions/${s.id}`);
                refresh();
                // Closing the session you are looking at would leave a zombie pane (dead
                // stream, no route change) — fall back to the default route instead.
                if (ctx.activeId() === s.id) location.hash = '#/';
              } catch (err) {
                toast(`close failed: ${err.message}`, { kind: 'error' });
              }
            },
          },
          ['✕'],
        );
        return el(
          'button',
          {
            class: 'sb-item' + (s.id === active ? ' is-active' : ''),
            onClick: () => ctx.openSession(s.id),
          },
          [
            busy
              ? el('span', { class: 'sb-dot' + (s.status === 'error' ? ' err' : ''), style: 'margin-top:8px;' })
              : el('span', { class: 'glyph', style: 'width:16px;text-align:center;color:var(--sw-t-caption);flex:none;' }, [
                  isMirror ? '◆' : '·',
                ]),
            el('span', { class: 'sb-item-main' }, [
              el('div', { class: 'sb-item-title' }, [s.title || 'Untitled']),
              el('div', { class: 'sb-item-meta' }, [
                statusGlyph(s),
                timeAgo(s.createdAt),
                s.canPrompt ? '' : 'read-only',
              ]),
            ]),
            closeBtn,
          ],
        );
      }),
    );
  };

  // ---- footer --------------------------------------------------------------------
  const btnTheme = el('button', { class: 'icon-btn', onClick: onTheme }, [themeGlyph()]);
  tipOn(btnTheme, () => 'Theme: light / dark / auto');
  const btnSettings = el('button', { class: 'icon-btn', onClick: () => ctx.openSettings() }, ['⚙']);
  tipOn(btnSettings, () => 'Settings');

  function onTheme() {
    const next = cycleTheme();
    btnTheme.replaceChildren(el('span', {}, [themeGlyph()]));
    toast(`Theme: ${next}`);
  }

  const foot = el('div', { class: 'sb-foot' }, [btnTheme, btnSettings]);

  const root = el('nav', { class: 'sb' }, [head, btnNew, projHost, listHost, foot]);

  // ---- data ------------------------------------------------------------------------------
  let pollTimer = null;

  async function refresh() {
    try {
      const { sessions: rows } = await getJson('/api/sessions');
      sessions = rows ?? [];
      renderList();
    } catch {
      /* server unreachable — the poll keeps trying */
    }
  }

  const start = () => {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (!document.hidden) refresh();
    }, POLL_MS);
    refresh();
    loadProjects();
  };

  const stop = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };

  start();

  return { root, refresh, loadProjects, stop };
}
