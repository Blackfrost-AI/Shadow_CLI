/**
 * Boot the Shadow web console (dsh-style app shell).
 *
 * Token handling. `shadow web` prints a launch URL carrying the token as a fragment
 * (`#t=…`). A fragment is never transmitted, so the token stays out of request logs and out
 * of anything that records URLs — which is why the shell document itself is served without
 * auth (the server cannot check a credential it never receives).
 *
 * We then stash it in sessionStorage and scrub the address bar. sessionStorage is scoped to
 * the full origin INCLUDING port, so a service on another localhost port cannot read it —
 * which is precisely why this is not a cookie. Cookies ignore port, so a `127.0.0.1` cookie
 * is handed to every other local service the browser visits.
 *
 * Surviving a refresh is the reason to persist at all: once the fragment is scrubbed, F5 has
 * no token in the URL, and without sessionStorage the console would come back dead.
 *
 * App shape: frame.js lays out sidebar | console | details. This module owns WHICH session is
 * active (hash routes `#/` and `#/s/<id>`), creates and tears down per-session surfaces when
 * the route changes, and refreshes the sidebar when the active stream says a status flipped.
 */

import { setToken, getJson, postJson } from './api.js';
import { el, mount } from './dom.js';
import { applyTheme } from './theme.js';
import { createFrame } from './frame.js';
import { createSidebar } from './sidebar.js';
import { createConsole } from './console.js';
import { mountChat } from './chat.js';
import { createTrajectory } from './trajectory.js';
import { createDetails } from './details.js';
import { openSettings } from './settings.js';
import { eclipse, toast } from './ui.js';
import { fmtTok } from './util.js';

const STORAGE_KEY = 'shadow.session.token';
const LAST_SESSION = 'shadow.ui.lastSession';

function readToken() {
  // Fragment first — the form the launch URL uses, and the only one that never hits the wire.
  if (location.hash.startsWith('#t=')) {
    const t = new URLSearchParams(location.hash.slice(1)).get('t');
    if (t) {
      try {
        sessionStorage.setItem(STORAGE_KEY, t);
      } catch {
        // Private mode / storage disabled: the token still works for this page load, it just
        // will not survive a refresh. Better than refusing to start.
      }
      history.replaceState(null, '', location.pathname + location.search);
      return t;
    }
  }
  // Query form, for `curl` and older launch URLs.
  const q = new URLSearchParams(location.search).get('t');
  if (q) {
    try {
      sessionStorage.setItem(STORAGE_KEY, q);
    } catch {
      /* see above */
    }
    return q;
  }
  try {
    return sessionStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function noToken(host) {
  mount(host, [
    el('div', { class: 'tl-hero', style: 'height:100dvh;' }, [
      eclipse(44, 'var(--sw-bg-base)'),
      el('div', { class: 'hello' }, ['No session token']),
      el('div', { class: 'sub' }, [
        'This page was opened without its access token, so it can’t talk to the console. Open the exact link ',
        el('code', {}, ['shadow web']),
        ' printed in your terminal:',
      ]),
      el('div', { class: 'kbd', style: 'margin-top:8px;' }, ['$ shadow web']),
      el('div', { class: 'sub', style: 'color:var(--sw-t-caption);font:var(--sw-f-xs);' }, [
        'The token travels only in the URL fragment — it never reaches the server or leaves this machine.',
      ]),
    ]),
  ]);
}

/** Route session id from the hash: `#/s/<id>` or '' for the default route. */
function routeSessionId() {
  const m = (location.hash || '').match(/^#\/s\/([0-9a-zA-Z]+)/);
  return m ? m[1] : '';
}

function boot() {
  const host = document.getElementById('app');
  if (!host) return;

  applyTheme(); // pre-paint script already applied it; this covers the no-token screen + keeps auto live

  const token = readToken();
  if (!token) {
    noToken(host);
    return;
  }
  setToken(token);

  // ---- shell ------------------------------------------------------------------
  let activeId = routeSessionId();
  let chatHandle = null;
  let sessionRows = [];
  /** Title derived client-side from the first prompt (the server never retitles). syncMeta must
   *  not clobber it with the registry's "New session" placeholder on the next status tick. */
  let optimisticTitle = '';
  /** Chat|Trajectory tab state — the trajectory only re-renders while visible. */
  let mode = 'chat';
  let traj = null;
  let offNotify = null;

  const loadSessions = async () => {
    try {
      const { sessions } = await getJson('/api/sessions');
      sessionRows = sessions ?? [];
    } catch {
      sessionRows = [];
    }
    return sessionRows;
  };

  const findSession = (id) => sessionRows.find((s) => s.id === id);

  const openSettingsSheet = () =>
    openSettings({
      onProjectsChanged: () => {
        sidebar.refresh();
      },
    });

  const consolePane = createConsole({
    mode: () => mode,
    setMode: (m) => {
      mode = m;
      consolePane.setMode(m);
      if (m === 'traj') traj?.refresh();
    },
    openSettings: openSettingsSheet,
    detailsOpen: () => frame.detailsOpen(),
    setDetails: (open) => frame.setDetails(open),
  });

  const sidebar = createSidebar({
    activeId: () => activeId,
    openSession: (id) => {
      if (id !== activeId) location.hash = `#/s/${id}`;
    },
    newSession: (projectRoot) => void newSession(projectRoot),
    openSettings: openSettingsSheet,
    toggleSidebar: () => frame.toggleSidebar(),
    activeProjectPath: () => findSession(activeId)?.displayPath ?? '',
  });

  const detailsPane = el('aside', { class: 'det' }, []);
  const details = createDetails(detailsPane, {
    model: () => chatHandle?.model ?? null,
    session: () => findSession(activeId) ?? null,
  });

  // frame must exist before the console callbacks above first run — create it now, the
  // closures read it lazily.
  const frame = createFrame({
    sidebar: sidebar.root,
    console: consolePane.root,
    details: detailsPane,
  });
  host.replaceChildren(frame.root);

  // ---- session lifecycle ---------------------------------------------------------
  const syncMeta = () => {
    const s = findSession(activeId);
    consolePane.setMeta({
      title: optimisticTitle || s?.title || 'Shadow',
      sub: s ? `${s.displayPath || ''}${s.model ? ' · ' + s.model : ''}` : '',
    });
  };

  const activate = async (id) => {
    if (chatHandle) {
      chatHandle.unmount();
      chatHandle = null;
    }
    if (offNotify) {
      offNotify();
      offNotify = null;
    }
    activeId = id;
    optimisticTitle = ''; // belongs to the previous session
    // A session created moments ago (or by another tab) may not be in the boot-time list yet —
    // without this the header + inspector stay on placeholders until the next full reload.
    if (id && !findSession(id)) await loadSessions();
    if (id) {
      try {
        localStorage.setItem(LAST_SESSION, id);
      } catch {
        /* non-fatal */
      }
    }
    syncMeta();
    sidebar.refresh();
    if (!id) {
      details.refresh();
      return;
    }
    chatHandle = mountChat(consolePane.chatHost, id, {
      onStatus: () => {
        sidebar.refresh();
        syncMeta();
        details.refresh();
      },
      onTitle: (title) => {
        optimisticTitle = title;
        consolePane.setMeta({ title });
        sidebar.refresh();
      },
      onContext: ({ pct, used }) => {
        consolePane.setContext({ pct, label: used != null ? `${fmtTok(used)} ctx` : '' });
      },
    });
    // Point the trajectory + inspector at the live model; the trajectory renders only while
    // its tab is visible, the inspector throttles to one frame.
    traj = createTrajectory(consolePane.trajHost, chatHandle.model);
    offNotify = chatHandle.model.subscribe(() => {
      if (mode === 'traj') traj?.refresh();
      details.refresh();
    });
    details.refresh();
  };

  const newSession = async (projectRoot) => {
    try {
      if (!projectRoot) {
        await loadSessions();
        projectRoot =
          findSession(activeId)?.displayPath ??
          sessionRows.find((s) => s.origin === 'mirror' || s.origin === 'local')?.displayPath ??
          (await getJson('/api/projects')).projects?.[0]?.path;
      }
      if (!projectRoot) {
        toast('no project to open a session in — add one first', { kind: 'error' });
        return;
      }
      const created = await postJson('/api/sessions', { projectRoot });
      sidebar.refresh();
      location.hash = `#/s/${created.id}`;
    } catch (err) {
      toast(`new session failed: ${err.message}`, { kind: 'error' });
    }
  };

  window.addEventListener('hashchange', async () => {
    const id = routeSessionId();
    if (id !== activeId) await activate(id);
  });

  // ---- initial route --------------------------------------------------------------
  (async () => {
    await loadSessions();
    let id = activeId;
    if (!id) {
      try {
        id = localStorage.getItem(LAST_SESSION) ?? '';
      } catch {
        /* no storage */
      }
      if (!id || !findSession(id)) {
        // Preference order: the last browser session → any promptable session → the reserved
        // console (under `shadow --web` that's the live terminal mirror; standalone it is the
        // inert local placeholder — either way the app opens on a real surface, never a void).
        id = sessionRows.find((s) => s.canPrompt)?.id ?? sessionRows[0]?.id ?? 'cli';
      }
      if (id) history.replaceState(null, '', `#/s/${id}`);
    }
    await activate(id);
  })().catch((e) => toast(`boot failed: ${e.message}`, { kind: 'error' }));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
