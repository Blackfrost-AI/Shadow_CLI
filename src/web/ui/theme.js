/**
 * Theme state. One source of truth, shared by the pre-paint boot script in shell.html (which
 * reads the SAME key and applies the SAME rule inline so the first paint is never the wrong
 * theme) and by the Settings toggle.
 *
 * Stored value: 'light' | 'dark' | 'auto'. `auto` tracks prefers-color-scheme, including live
 * changes while the page is open. The CSS keys every semantic alias off `body[data-theme]`,
 * so applying a theme is exactly one attribute + one color-scheme style.
 */

const KEY = 'shadow.theme';

function readStored() {
  try {
    return localStorage.getItem(KEY) || 'auto';
  } catch {
    return 'auto';
  }
}

function writeStored(v) {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* private mode — the choice lasts for this page only */
  }
}

export function themeSetting() {
  return readStored();
}

export function isDark() {
  const s = readStored();
  if (s === 'light') return false;
  if (s === 'dark') return true;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Apply the stored theme to the document. Safe to call repeatedly. */
export function applyTheme() {
  const dark = isDark();
  if (dark) document.body.setAttribute('data-theme', 'dark');
  else document.body.removeAttribute('data-theme');
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

export function setTheme(v) {
  writeStored(v);
  applyTheme();
}

/** Cycle light → dark → auto → light. Returns the new setting (callers render the label). */
export function cycleTheme() {
  const order = ['light', 'dark', 'auto'];
  const next = order[(order.indexOf(readStored()) + 1) % 3];
  setTheme(next);
  return next;
}

// Live-track the OS while on 'auto'. One listener for the page's lifetime.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (readStored() === 'auto') applyTheme();
});

/** Sun / moon / auto glyph for the toggle button. */
export function themeGlyph() {
  const s = readStored();
  if (s === 'auto') return '◐';
  return s === 'dark' ? '☾' : '☀';
}
