import { homeView, modelsView, agentsView, sessionsView, mcpView, usageView, approvalsView, cronView, chatView, kitView } from './views.js';
import { mountRail, updateActive, initTheme } from './rail.js';

/**
 * Hash-based client router. Chosen over History API because:
 *  - no server route config to keep in sync (every path still serves the shell),
 *  - back/forward works for free,
 *  - the URL fragment is never sent to the server, so it can't leak into logs.
 *
 * The shell is `.rail` (the data-driven left rail, see rail.js) + `.main` (the content area a
 * view mounts into). A `#/s/<id>` hash opens the session console for that session.
 */
const ROUTES = {
  '#/': { view: chatView },
  '#/home': { view: homeView },
  '#/models': { view: modelsView },
  '#/agents': { view: agentsView },
  '#/sessions': { view: sessionsView },
  '#/mcp': { view: mcpView },
  '#/usage': { view: usageView },
  '#/approvals': { view: approvalsView },
  '#/cron': { view: cronView },
  '#/kit': { view: kitView },
};

/** Build the shell: the left rail + the content area. Called once at boot. */
export function renderShell(host) {
  const rail = document.createElement('nav');
  rail.className = 'rail';
  const main = document.createElement('main');
  main.className = 'main';
  host.replaceChildren(rail, main);
  mountRail(rail);
  return { rail, main };
}

let currentCleanup = null;

export function currentRoute() {
  const h = window.location.hash || '#/';
  return ROUTES[h] ? h : '#/';
}

export function navigate() {
  const rawHash = window.location.hash || '#/';
  // A session route `#/s/<id>` opens the chat view for that specific session; everything else is a
  // fixed nav route. This is what makes session switching a plain hash change (fresh chatView mount
  // → fresh store → no transcript splice).
  const sessionMatch = rawHash.match(/^#\/s\/([0-9a-zA-Z]+)/);
  const navKey = sessionMatch ? '#/' : ROUTES[rawHash] ? rawHash : '#/';

  // Reflect the current route in the rail's active-state (re-renders from its cache).
  updateActive();

  // Tear down the previous view (closes SSE subscriptions, cancels fetches).
  if (currentCleanup) {
    try {
      currentCleanup();
    } catch {
      // ignore — never block navigation on a cleanup error
    }
    currentCleanup = null;
  }

  const content = document.querySelector('.main');
  if (!content) return;
  content.replaceChildren();
  currentCleanup = sessionMatch ? chatView(content, sessionMatch[1]) : ROUTES[navKey].view(content);
}

/** Wire hashchange + initial render. Called once at boot. */
export function startRouter(host) {
  initTheme();
  renderShell(host);
  window.addEventListener('hashchange', navigate);
  navigate();
}
