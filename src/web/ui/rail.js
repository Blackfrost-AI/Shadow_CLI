import { el, mount } from './dom.js';
import { getJson, postJson } from './api.js';

/**
 * The left rail: brand · the Terminal mirror · projects-as-folders (data-driven) with their web
 * sessions · the Manage nav · a footer with the theme toggle and the privacy line. Matches the
 * Shadow Console design. Data (projects + sessions) is cached and re-rendered on navigation for
 * active-state; refreshRail() re-fetches after a mutation (new session, add/remove project).
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, children = []) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const c of children) n.append(c);
  return n;
}
/**
 * The eclipse mark: an accent disc partly occluded by a second disc the colour of whatever it
 * sits on. `holeFill` is that background — `--panel` on a card/rail, `--bg` on a bare screen —
 * so the crescent reads cleanly against either. Exported for the Home banner and no-token screen.
 */
export function eclipse(size, holeFill = 'var(--panel)') {
  return svg('svg', { width: size, height: size, viewBox: '0 0 20 20', 'aria-hidden': 'true' }, [
    svg('circle', { cx: 10, cy: 10, r: 8, fill: 'var(--accent)', opacity: '0.9' }),
    svg('circle', { cx: 13, cy: 8, r: 7, fill: holeFill }),
  ]);
}
const logo = (size) => eclipse(size);

// ── theme (auto → light → dark) ──────────────────────────────────────────────────────────
const THEME_KEY = 'shadow.theme';
function themePref() {
  try {
    return localStorage.getItem(THEME_KEY) || 'auto';
  } catch {
    return 'auto';
  }
}
function applyTheme(pref) {
  const root = document.documentElement;
  // Explicit choice sets [data-th] (wins over the media query); 'auto' removes it so the OS
  // preference drives the cascade.
  if (pref === 'light' || pref === 'dark') root.setAttribute('data-th', pref);
  else root.removeAttribute('data-th');
}
/** Called once at boot, before first paint, to avoid a theme flash. */
export function initTheme() {
  applyTheme(themePref());
}
function cycleTheme() {
  const next = { auto: 'light', light: 'dark', dark: 'auto' }[themePref()] || 'auto';
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* private mode — the toggle still applies for this page load */
  }
  applyTheme(next);
  render();
}

// ── nav ──────────────────────────────────────────────────────────────────────────────────
// [routeId, label, glyph, soon]. `sessions` is the Workspace view (labelled "Sessions").
const NAV = [
  ['home', 'Home', '⌂'],
  ['models', 'Models', '◈'],
  ['agents', 'Agents', '⛬'],
  ['sessions', 'Sessions', '▤'],
  ['mcp', 'MCP', '⇄'],
  ['usage', 'Usage', '∑', true],
  ['approvals', 'Approvals', '✓', true],
  ['cron', 'Cron', '◷', true],
];

function shortPath(p) {
  const parts = p.split('/').filter(Boolean);
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p;
}
function statusShort(s) {
  return s === 'running' ? '▶' : s === 'error' ? '!' : '·';
}

// ── active-state resolution from the hash ──────────────────────────────────────────────────
function active() {
  const h = location.hash || '#/';
  const m = h.match(/^#\/s\/([0-9a-zA-Z]+)/);
  if (h === '#/' || (m && m[1] === 'cli')) return { kind: 'mirror' };
  if (m) return { kind: 'session', id: m[1] };
  const route = { '#/home': 'home', '#/models': 'models', '#/agents': 'agents', '#/sessions': 'sessions', '#/mcp': 'mcp', '#/usage': 'usage', '#/approvals': 'approvals', '#/cron': 'cron' };
  return { kind: 'nav', id: route[h] ?? null };
}

// ── data ────────────────────────────────────────────────────────────────────────────────
let railEl = null;
let cache = null; // { projects, sessions }

async function fetchData() {
  const [p, s] = await Promise.all([getJson('/api/projects'), getJson('/api/sessions')]);
  cache = { projects: p.projects ?? [], sessions: s.sessions ?? [] };
}

async function newSession(projectRoot) {
  try {
    const { id } = await postJson('/api/sessions', { projectRoot });
    await refreshRail();
    location.hash = `#/s/${id}`;
  } catch {
    /* an allowlisted project should never 403 here; ignore transient failures */
  }
}

function render() {
  if (!railEl) return;
  const act = active();

  const head = el('div', { class: 'rail-head' }, [
    (() => {
      const w = el('span', { class: 'rail-logo' }, []);
      w.append(logo(20));
      return w;
    })(),
    el('span', { class: 'rail-brand' }, ['shadow']),
    el('span', { class: 'rail-ver' }, ['console']),
  ]);

  const items = [];

  // Web console → Terminal (mirror).
  items.push(el('div', { class: 'rail-sec' }, ['Web console']));
  items.push(
    el('a', { class: 'rail-item' + (act.kind === 'mirror' ? ' active' : ''), href: '#/s/cli' }, [
      el('span', { class: 'dot pulse s-running' }, []),
      el('span', { class: 'rail-mirror-name' }, ['Terminal']),
      el('span', { class: 'rail-tag' }, ['read-only']),
    ]),
  );

  // Projects (folders → web sessions).
  items.push(el('div', { class: 'rail-sec' }, ['Projects']));
  const projects = cache?.projects ?? [];
  const web = (cache?.sessions ?? []).filter((s) => s.origin === 'web');
  if (!projects.length) {
    items.push(el('div', { class: 'rail-empty' }, [cache ? 'no projects yet' : 'loading…']));
  }
  for (const p of projects) {
    items.push(
      el('div', { class: 'rail-proj-head' }, [
        el('span', { class: 'rail-caret' }, ['▾']),
        el('span', { class: 'rail-proj-label' }, [p.label || p.path]),
        el('span', { class: 'rail-proj-path' }, [shortPath(p.path)]),
      ]),
    );
    for (const s of web.filter((x) => x.displayPath === p.path)) {
      items.push(
        el('a', { class: 'rail-item rail-sess' + (act.kind === 'session' && act.id === s.id ? ' active' : ''), href: `#/s/${s.id}` }, [
          el('span', { class: `dot s-${s.status}` + (s.status === 'running' ? ' pulse' : '') }, []),
          el('span', { class: 'rail-sess-title' }, [s.title || s.id.slice(0, 8)]),
          el('span', { class: 'rail-sess-stat' }, [statusShort(s.status)]),
        ]),
      );
    }
    const nb = el('div', { class: 'rail-add indent' }, ['+ new session']);
    nb.onclick = () => newSession(p.path);
    items.push(nb);
  }
  const addp = el('div', { class: 'rail-add' }, ['+ add project']);
  addp.onclick = () => {
    location.hash = '#/sessions';
  };
  items.push(addp);

  // Manage.
  items.push(el('div', { class: 'rail-sec' }, ['Manage']));
  for (const [id, label, glyph, soon] of NAV) {
    items.push(
      el('a', { class: 'rail-item' + (act.kind === 'nav' && act.id === id ? ' active' : ''), href: `#/${id === 'home' ? 'home' : id}` }, [
        el('span', { class: 'rail-glyph' }, [glyph]),
        el('span', {}, [label]),
        ...(soon ? [el('span', { class: 'rail-soon' }, ['SOON'])] : []),
      ]),
    );
  }

  const scroll = el('div', { class: 'rail-scroll' }, items);

  const themeBtn = el('button', { class: 'rail-fbtn' }, [`◐ ${themePref()}`]);
  themeBtn.onclick = cycleTheme;
  const kitBtn = el('button', { class: 'rail-fbtn' }, ['▦ kit']);
  kitBtn.onclick = () => {
    location.hash = '#/kit';
  };
  const foot = el('div', { class: 'rail-foot' }, [
    el('div', { class: 'rail-foot-row' }, [themeBtn, kitBtn]),
    el('div', { class: 'rail-priv' }, ['127.0.0.1 · nothing leaves this machine']),
  ]);

  mount(railEl, [head, scroll, foot]);
}

/** Mount the rail into `el`, render immediately (loading), then fetch + re-render. */
export function mountRail(elm) {
  railEl = elm;
  render();
  void refreshRail();
}

/** Re-fetch projects + sessions and re-render. Call after a mutation. */
export async function refreshRail() {
  try {
    await fetchData();
  } catch {
    /* keep the last good tree on a transient failure */
  }
  render();
}

/** Re-render from cache (cheap) to update active-state on navigation. */
export function updateActive() {
  render();
}
