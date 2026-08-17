/**
 * The center console column: header (title/sub, Chat|Trajectory tabs, context meter, action
 * buttons) + a body that F4 (chat) and F5 (trajectory) own. This module builds the chrome and
 * hands the body over; it renders no transcript content itself.
 */

import { el } from './dom.js';
import { tipOn } from './ui.js';

/**
 * The context meter: a 14px ring (r=5.5, stroke 3 → circumference ~34.6) with the percentage
 * beside it. Amber ≥80%, red ≥95%.
 */
export function contextMeter(pct) {
  const C = 2 * Math.PI * 5.5;
  const p = Math.max(0, Math.min(100, pct ?? 0));
  const color = p >= 95 ? 'var(--sw-error)' : p >= 80 ? 'var(--sw-warn-label)' : 'var(--sw-t-caption)';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 14 14');
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  bg.setAttribute('cx', '7');
  bg.setAttribute('cy', '7');
  bg.setAttribute('r', '5.5');
  bg.setAttribute('fill', 'none');
  bg.setAttribute('stroke', 'var(--sw-border-2)');
  bg.setAttribute('stroke-width', '3');
  const fg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  fg.setAttribute('cx', '7');
  fg.setAttribute('cy', '7');
  fg.setAttribute('r', '5.5');
  fg.setAttribute('fill', 'none');
  fg.setAttribute('stroke', color);
  fg.setAttribute('stroke-width', '3');
  fg.setAttribute('stroke-linecap', 'round');
  fg.setAttribute('stroke-dasharray', `${(C * p) / 100} ${C}`);
  fg.setAttribute('transform', 'rotate(-90 7 7)');
  svg.append(bg, fg);
  return svg;
}

/**
 * @param {Object} ctx
 * @param {() => 'chat'|'traj'} ctx.mode
 * @param {(m: 'chat'|'traj') => void} ctx.setMode
 * @param {() => void} ctx.openSettings
 * @param {() => boolean} ctx.detailsOpen
 * @param {(open: boolean) => void} ctx.setDetails
 */
export function createConsole(ctx) {
  let current = { title: 'Shadow', sub: '' };

  const tabChat = el('button', { class: 'tab', onClick: () => ctx.setMode('chat') }, ['Chat']);
  const tabTraj = el('button', { class: 'tab', onClick: () => ctx.setMode('traj') }, ['Trajectory']);

  const titleEl = el('div', { class: 'con-title' }, [current.title]);
  const subEl = el('div', { class: 'con-sub' }, [current.sub]);

  // Context meter host — setContext REPLACES this element (tipOn registers a listener per
  // host, so re-tipping one host would stack stale-percentage listeners).
  let ctxHost = el('div', { class: 'ctx' }, []);

  const btnDetails = el(
    'button',
    {
      class: 'icon-btn',
      onClick: () => ctx.setDetails(!ctx.detailsOpen()),
    },
    ['▤'],
  );
  tipOn(btnDetails, () => (ctx.detailsOpen() ? 'Hide inspector' : 'Show inspector'));
  const btnSettings = el('button', { class: 'icon-btn', onClick: () => ctx.openSettings() }, ['⚙']);
  tipOn(btnSettings, () => 'Settings');

  const head = el('div', { class: 'con-head' }, [
    el('div', { style: 'min-width:0;display:flex;flex-direction:column;' }, [titleEl, subEl]),
    el('div', { class: 'con-tabs' }, [tabChat, tabTraj]),
    el('div', { class: 'con-actions' }, [ctxHost, btnDetails, btnSettings]),
  ]);

  // The body hosts EITHER the chat surface or the trajectory surface; both are mounted by the
  // app and toggled with .hidden so switching tabs keeps scroll + SSE state.
  const bodyChat = el('div', { class: 'con-body' }, []);
  const bodyTraj = el('div', { class: 'con-body', style: 'display:none;' }, []);
  const root = el('main', { class: 'con' }, [head, bodyChat, bodyTraj]);

  const syncTabs = (m) => {
    tabChat.classList.toggle('is-active', m === 'chat');
    tabTraj.classList.toggle('is-active', m === 'traj');
    bodyChat.style.display = m === 'chat' ? 'flex' : 'none';
    bodyTraj.style.display = m === 'traj' ? 'flex' : 'none';
  };
  syncTabs(ctx.mode());

  return {
    root,
    /** The chat surface container (transcript + docks + composer mount here). */
    chatHost: bodyChat,
    /** The trajectory surface container. */
    trajHost: bodyTraj,
    setMode: syncTabs,
    /** Header metadata, refreshed by the app on session switch + SSE status changes. */
    setMeta({ title, sub }) {
      if (title !== undefined) titleEl.textContent = title;
      if (sub !== undefined) subEl.textContent = sub;
    },
    /** Context-window fill: { pct, label } — label renders next to the ring. */
    setContext({ pct, label }) {
      const fresh = el('div', { class: 'ctx' }, [
        contextMeter(pct),
        el('span', { class: 'num' }, [label ?? '']),
      ]);
      if (pct >= 95) fresh.classList.add('hot');
      else if (pct >= 80) fresh.classList.add('warn');
      tipOn(fresh, () => `Context window: ${Math.round(pct)}% used`);
      ctxHost.replaceWith(fresh);
      ctxHost = fresh;
    },
  };
}
