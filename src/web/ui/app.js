import { setToken } from './api.js';
import { startRouter } from './router.js';
import { initTheme, eclipse } from './rail.js';
import { el, mount } from './dom.js';

/**
 * Boot the Shadow web console.
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
 */

const STORAGE_KEY = 'shadow.session.token';

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
    el('div', { class: 'notoken' }, [
      el('div', { class: 'notoken-inner' }, [
        eclipse(44, 'var(--bg)'),
        el('h1', {}, ['No session token']),
        el('p', {}, [
          'This page was opened without its access token, so it can’t talk to the console. Open the exact link ',
          el('code', {}, ['shadow web']),
          ' printed in your terminal:',
        ]),
        el('div', { class: 'notoken-code' }, [
          '$ shadow web',
          el('br'),
          el('span', { class: 'muted' }, ['console → http://127.0.0.1:4123/#t=…']),
        ]),
        el('p', { class: 'notoken-foot' }, [
          'The token travels only in the URL fragment — it never reaches the server or leaves this machine.',
        ]),
      ]),
    ]),
  ]);
}

function boot() {
  const host = document.getElementById('app');
  if (!host) return;

  initTheme(); // apply the stored/OS theme before first paint (covers the no-token screen too)

  const token = readToken();
  if (!token) {
    noToken(host);
    return;
  }
  setToken(token);
  startRouter(host);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
