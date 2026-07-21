import { el } from './dom.js';

/**
 * Shared view building blocks — the design system's small parts, reused across every management
 * surface (Home, Models, Agents, MCP, Workspace, Kit). All colour lives in styles.css tokens;
 * these helpers only pick the right class. Keeping them here (not re-implemented per view) is what
 * makes a token/palette change land everywhere at once, and what keeps the Kit an honest mirror.
 */

/** A session-status dot. Pulses while running unless overridden. `status` is a SessionSummary.status. */
export function statusDot(status, pulse = status === 'running') {
  return el('span', { class: `dot s-${status}${pulse ? ' pulse' : ''}` });
}

/** A semantic-colour dot (ok | err | warn | accent | faint), optionally pulsing. */
export function dotEl(color, pulse = false) {
  return el('span', { class: `dot c-${color}${pulse ? ' pulse' : ''}` });
}

/** A session-status badge — the text is upper-cased by CSS. */
export function statusBadge(status) {
  return el('span', { class: `badge s-${status}` }, [status]);
}

/**
 * The standard view scaffold: a scroll container with a centred inner column. `head` is the
 * already-built head row/block; `body` is the array of content nodes below it.
 */
export function viewShell(head, body) {
  return el('div', { class: 'view' }, [el('div', { class: 'view-inner' }, [head, ...body])]);
}

/**
 * A block head — an <h1> with an optional sub-paragraph beneath it (Home / Agents / Workspace).
 * For the inline "title · sub · [button]" head (Models / MCP) build it inline with `.view-head`.
 */
export function blockHead(title, sub) {
  return el('div', {}, [el('h1', {}, [title]), ...(sub ? [el('p', { class: 'view-sub' }, [sub])] : [])]);
}

/** Turn a thrown fetch error (`/path: 403 {"error":"…"}`) into just the human reason. */
export function reason(e) {
  const s = String(e);
  const m = s.match(/\{"error":"([^"]+)"\}/);
  return m ? m[1] : s.replace(/^Error:\s*/, '').replace(/^.*?:\s*\d+\s*/, '');
}
