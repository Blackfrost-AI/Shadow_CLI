/**
 * The app frame: the dsh three-pane layout — sidebar | console | details — as one CSS grid
 * (see `.app-frame` in styles.css). This module owns GEOMETRY and nothing else:
 *
 *   - drag-to-resize on both gutters (pointer events, px-precise, clamped to the dsh bounds)
 *   - the collapse toggle for the sidebar (expanded ↔ 56px icon rail)
 *   - the details pane on/off (auto-off on narrow viewports, restored when wide again)
 *   - persistence of all three in localStorage
 *   - responsive concessions, recomputed on resize:
 *       <1024px  sidebar force-collapses (a user who re-expands it wins until the next cross)
 *       <1280px  details hide (the console keeps its 640px minimum first)
 *
 * The panes themselves are passed in as elements — frame.js never builds content.
 */

import { el } from './dom.js';
import { clamp } from './util.js';

const SB_MIN = 264;
const SB_MAX = 420;
const SB_DEFAULT = 280;
const SB_COLLAPSED = 56;
const DET_MIN = 300;
const DET_MAX = 520;
const DET_DEFAULT = 360;
/** Console minimum; when space runs out the details pane yields before the chat does. */
const CENTER_MIN = 640;
/** Viewport breakpoints (dsh values). */
const AUTO_COLLAPSE = 1024;
const DET_BREAK = 1280;

const LS = {
  sbW: 'shadow.ui.sbW',
  detW: 'shadow.ui.detW',
  sbCollapsed: 'shadow.ui.sbCollapsed',
};

function lsGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

function lsSet(key, v) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* private mode */
  }
}

/**
 * @param {{sidebar: Element, console: Element, details: Element}} panes
 */
export function createFrame(panes) {
  let sbW = clamp(Number(lsGet(LS.sbW, SB_DEFAULT)) || SB_DEFAULT, SB_MIN, SB_MAX);
  let detW = clamp(Number(lsGet(LS.detW, DET_DEFAULT)) || DET_DEFAULT, DET_MIN, DET_MAX);
  let sbCollapsed = lsGet(LS.sbCollapsed, '0') === '1';

  // Concession state (narrow-viewport overrides). `sbPinned` remembers a user who re-expanded
  // the sidebar under 1024px so resize jitter can't fight them; crossing back above the
  // breakpoint clears it.
  let sbPinned = false;
  let detForcedOff = false;

  const gutterSb = el('div', { class: 'gutter gutter-sidebar', 'aria-hidden': 'true' });
  const gutterDet = el('div', { class: 'gutter gutter-details', 'aria-hidden': 'true' });
  const root = el('div', { class: 'app-frame' }, [
    panes.sidebar,
    gutterSb,
    panes.console,
    gutterDet,
    panes.details,
  ]);

  const apply = () => {
    // Set on <body> itself: tokens.css declares these custom properties on body, and an
    // inherited value from <html> would lose to that declaration. Same-origin wins.
    document.body.style.setProperty('--sw-sidebar-w', `${Math.round(sbCollapsed ? SB_COLLAPSED : sbW)}px`);
    document.body.style.setProperty('--sw-details-w', `${Math.round(detW)}px`);
    document.body.dataset.sb = sbCollapsed ? 'collapsed' : 'expanded';
    document.body.dataset.det = detForcedOff ? 'off' : 'on';
  };

  /** Drag wiring shared by both gutters. `horizontal(x)` maps pointer x → the new width. */
  const draggable = (handle, compute) => {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      document.body.classList.add('is-dragging');
      const move = (ev) => compute(ev.clientX);
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        document.body.classList.remove('is-dragging');
        lsSet(LS.sbW, sbW);
        lsSet(LS.detW, detW);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  };

  draggable(gutterSb, (x) => {
    sbW = clamp(x, SB_MIN, SB_MAX);
    // Dragging the sidebar open/closed is an explicit user statement — pin it.
    sbCollapsed = false;
    sbPinned = true;
    apply();
  });

  draggable(gutterDet, (x) => {
    // Dragging the details gutter is also an explicit statement: bring it back.
    detForcedOff = false;
    detW = clamp(window.innerWidth - x, DET_MIN, DET_MAX);
    apply();
  });

  const concessions = () => {
    const vw = window.innerWidth;
    if (vw < AUTO_COLLAPSE) {
      if (!sbPinned) sbCollapsed = true;
    } else {
      sbPinned = false; // wide again: the stored preference resumes
    }
    // Details yield when the console would drop below its minimum.
    const centerAvailable = vw - (sbCollapsed ? SB_COLLAPSED : sbW) - detW;
    detForcedOff = vw < DET_BREAK || centerAvailable < CENTER_MIN;
    apply();
  };

  window.addEventListener('resize', concessions);

  const api = {
    root,
    /** Toggle the icon rail. Dragging the gutter re-expands at full width. */
    toggleSidebar() {
      sbCollapsed = !sbCollapsed;
      sbPinned = sbCollapsed ? false : true; // an explicit expand survives the narrow viewport
      lsSet(LS.sbCollapsed, sbCollapsed ? '1' : '0');
      apply();
      concessions();
    },
    isSidebarCollapsed: () => sbCollapsed,
    /** Show/hide the details pane (the header button). Turning it on clears the override. */
    setDetails(open) {
      detForcedOff = !open;
      apply();
    },
    /** Details visible right now? (forced-off ≠ the user's last intent, so no persistence here) */
    detailsOpen: () => !detForcedOff,
    /** Re-run the narrow-viewport rules — also called after any programmatic pane change. */
    refresh: concessions,
  };

  concessions();
  return api;
}
