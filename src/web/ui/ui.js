/**
 * Shared UI primitives: the eclipse mark, toasts, tooltips, popup menus and the confirm
 * dialog. Everything renders through dom.js's `el` (never innerHTML), and every overlay lives
 * at document level so pane scroll/clipping never eats it.
 */

import { el } from './dom.js';

/* ------------------------------------------------------------- brand mark -- */

/**
 * The eclipse mark: an accent disc partly occluded by a second disc the colour of whatever it
 * sits on. `holeFill` must be a CSS color/var resolvable at paint time.
 */
export function eclipse(size, holeFill = 'var(--sw-bg-base)') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('aria-hidden', 'true');
  const disc = (cx, cy, r, fill) => {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', cx);
    c.setAttribute('cy', cy);
    c.setAttribute('r', r);
    c.setAttribute('fill', fill);
    return c;
  };
  svg.append(disc(16, 16, 13, 'currentColor'), disc(24.5, 9.5, 10, holeFill));
  return svg;
}

/* ----------------------------------------------------------------- toasts -- */

let toastHost = null;

/**
 * Toast a message. Auto-dismisses after `ms` (default 3.2s); error toasts linger 6s. The host
 * is created lazily so a page that never toasts pays nothing.
 */
export function toast(text, { kind = 'info', ms } = {}) {
  if (!toastHost) {
    toastHost = el('div', { class: 'toast-wrap' });
    document.body.append(toastHost);
  }
  const t = el('div', { class: kind === 'error' ? 'toast is-error' : 'toast' }, [String(text)]);
  toastHost.append(t);
  const life = ms ?? (kind === 'error' ? 6000 : 3200);
  setTimeout(() => t.remove(), life);
  return t;
}

/* --------------------------------------------------------------- tooltips -- */

let tipEl = null;

/**
 * Show the singleton tooltip near (x, y) in viewport coords. Clamped so long text never runs
 * off-screen. `hideTip()` removes it; pointer-events:none keeps it from stealing hover.
 */
export function showTip(x, y, text) {
  if (!text) return;
  if (!tipEl) {
    tipEl = el('div', { class: 'tip' });
    document.body.append(tipEl);
  }
  tipEl.textContent = text;
  tipEl.style.visibility = 'hidden';
  tipEl.style.left = '0px';
  tipEl.style.top = '0px';
  const r = tipEl.getBoundingClientRect();
  const left = Math.max(6, Math.min(x + 10, window.innerWidth - r.width - 6));
  const top = Math.max(6, Math.min(y + 12, window.innerHeight - r.height - 6));
  tipEl.style.left = `${Math.round(left)}px`;
  tipEl.style.top = `${Math.round(top)}px`;
  tipEl.style.visibility = 'visible';
}

export function hideTip() {
  if (tipEl) tipEl.style.visibility = 'hidden';
}

/** Wire enter/leave tooltip behavior onto a node. */
export function tipOn(node, text) {
  node.addEventListener('pointerenter', (e) => showTip(e.clientX, e.clientY, text()));
  node.addEventListener('pointerleave', hideTip);
  node.addEventListener('pointerdown', hideTip);
}

/* ------------------------------------------------------------------ menus -- */

let openMenu = null;

function closeMenu() {
  if (openMenu) {
    openMenu.remove();
    openMenu = null;
    document.removeEventListener('pointerdown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
  }
}

function onDocDown(e) {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
}

function onKey(e) {
  if (e.key === 'Escape') closeMenu();
}

/**
 * One menu at a time. `items` is a list of:
 *   { label, glyph?, hint?, danger?, selected?, disabled?, onClick }  — a row
 *   'sep'                                                            — a divider
 *   { header: 'Label' }                                              — a section label
 * Opens at viewport (x, y), flipped to keep it on-screen. Returns close().
 */
export function menu(items, { x, y, width } = {}) {
  closeMenu();
  const m = el('div', { class: 'menu' });
  if (width) m.style.minWidth = `${width}px`;
  for (const it of items) {
    if (it === 'sep') {
      m.append(el('div', { class: 'menu-sep' }));
      continue;
    }
    if (it.header) {
      m.append(el('div', { class: 'menu-label' }, [it.header]));
      continue;
    }
    const row = el(
      'button',
      {
        class: 'menu-item' + (it.danger ? ' is-danger' : '') + (it.selected ? ' is-selected' : ''),
        disabled: it.disabled || undefined,
        onClick: () => {
          closeMenu();
          it.onClick?.();
        },
      },
      [
        el('span', { class: 'check' }, ['✓']),
        it.glyph ? el('span', { class: 'glyph' }, [it.glyph]) : null,
        el('span', { class: 'grow' }, [it.label]),
        it.hint ? el('span', { class: 'hint', style: 'color:var(--sw-t-caption);font:var(--sw-f-xxxs);margin-left:auto;' }, [it.hint]) : null,
      ],
    );
    m.append(row);
  }
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.round(Math.max(6, Math.min(x, window.innerWidth - r.width - 6)))}px`;
  m.style.top = `${Math.round(Math.max(6, Math.min(y, window.innerHeight - r.height - 6)))}px`;
  openMenu = m;
  document.addEventListener('pointerdown', onDocDown, true);
  document.addEventListener('keydown', onKey, true);
  return closeMenu;
}

/* --------------------------------------------------------- confirm dialog -- */

/**
 * Modal confirm. Resolves true/false; never throws. Clicking the mask = cancel.
 */
export function confirmDialog({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    let done = (v) => {
      mask.remove();
      resolve(v);
    };
    const cancel = el('button', { class: 'btn btn-ghost', onClick: () => done(false) }, [cancelLabel]);
    const ok = el(
      'button',
      {
        class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'),
        style: danger ? 'border:1px solid var(--sw-border-3);' : '',
        onClick: () => done(true),
      },
      [confirmLabel],
    );
    const modal = el('div', { class: 'modal' }, [
      el('div', { class: 'modal-head' }, [el('span', { class: 't' }, [title])]),
      el('div', { class: 'modal-body', style: 'font:var(--sw-f-s);color:var(--sw-t-secondary);' }, [body]),
      el('div', { class: 'modal-foot' }, [cancel, ok]),
    ]);
    const mask = el('div', {
      class: 'modal-mask',
      onClick: (e) => {
        if (e.target === mask) done(false);
      },
    }, [modal]);
    // Capture phase + stopImmediatePropagation: this dialog is the topmost sheet, so ITS Escape
    // must close it alone — an underlying sheet's own Escape handler (bubble phase, registered
    // earlier) must not also fire. And the listener leaves only via done(), not on any stray
    // keydown ({once:true} used to disarm it on the first non-Escape key).
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      done(false);
    };
    document.addEventListener('keydown', onKey, true);
    done = (v) => {
      document.removeEventListener('keydown', onKey, true);
      mask.remove();
      resolve(v);
    };
    document.body.append(mask);
    ok.focus();
  });
}
