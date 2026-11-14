// Regression contract for the 11.7.0 TUI-immersion features:
//   F1 — clicked OSC 8 links open in the browser (http/https only, no shell injection)
//   F2 — proseMaxCols config knob (0 = fill terminal width; default 100)
//   F3 — Snowfall image save+open fallback wiring
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isOpenableUrl } from '../src/util/openLink.js';
import { contentWidth, PROSE_MAX_COLS } from '../src/app/cells.js';
import { openFileInEditor } from '../src/app/commands.js';
import { loadConfig } from '../src/config.js';

// ── F1: URL validation ────────────────────────────────────────────────────────
test('isOpenableUrl accepts only well-formed http/https', () => {
  assert.equal(isOpenableUrl('https://example.com'), true);
  assert.equal(isOpenableUrl('http://example.com/path?q=1#frag'), true);
  assert.equal(isOpenableUrl('https://example.com:8443/a'), true);
  // Refused schemes — must never reach a launcher.
  assert.equal(isOpenableUrl('file:///etc/passwd'), false);
  assert.equal(isOpenableUrl('javascript:alert(1)'), false);
  assert.equal(isOpenableUrl('data:text/html,<script>'), false);
  assert.equal(isOpenableUrl('ftp://example.com'), false);
  assert.equal(isOpenableUrl('ssh://host'), false);
  // Malformed / empty.
  assert.equal(isOpenableUrl('not a url'), false);
  assert.equal(isOpenableUrl(''), false);
  assert.equal(isOpenableUrl('https://'), false);
});

test('isOpenableUrl is not fooled by shell metacharacters in a valid URL', () => {
  // These are valid URLs; the launcher passes them as a single argv element (no shell),
  // so metacharacters are inert. The validator only gates the scheme.
  assert.equal(isOpenableUrl('https://example.com/$(id)'), true);
  assert.equal(isOpenableUrl('https://example.com/`id`'), true);
  assert.equal(isOpenableUrl('https://example.com/;rm -rf'), true);
});

// ── F2: prose width cap ───────────────────────────────────────────────────────
test('contentWidth default cap stays 100 for backward compatibility', () => {
  assert.equal(PROSE_MAX_COLS, 100);
  assert.equal(contentWidth(200, 'assistant'), 100);
  assert.equal(contentWidth(200, 'user'), 100);
  // Narrow terminals are never widened.
  assert.equal(contentWidth(60, 'assistant'), 56); // 60 - 2*PAGE_MARGIN(2)
});

test('contentWidth honors an explicit proseMaxCols', () => {
  assert.equal(contentWidth(200, 'assistant', 120), 120);
  assert.equal(contentWidth(200, 'assistant', 80), 80);
  // Cap never exceeds the available inner width.
  assert.equal(contentWidth(90, 'assistant', 200), 86);
});

test('contentWidth proseMaxCols=0 fills the terminal width (no cap)', () => {
  assert.equal(contentWidth(200, 'assistant', 0), 196);
  assert.equal(contentWidth(300, 'user', 0), 296);
  assert.equal(contentWidth(80, 'assistant', 0), 76);
});

test('contentWidth banner always spans full width regardless of cap', () => {
  assert.equal(contentWidth(200, 'banner'), 196);
  assert.equal(contentWidth(200, 'banner', 0), 196);
  assert.equal(contentWidth(200, 'banner', 50), 196);
});

// ── F2: config knob ───────────────────────────────────────────────────────────
test('config defaults: linkClickOpen=true, proseMaxCols=100', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-immersion-'));
  try {
    const cfg = loadConfig(dir);
    assert.equal(cfg.linkClickOpen, true);
    assert.equal(cfg.proseMaxCols, 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config proseMaxCols accepts 0 (fill) and rejects out-of-range', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-immersion-'));
  try {
    assert.equal(loadConfig(dir, { proseMaxCols: 0 }).proseMaxCols, 0);
    assert.equal(loadConfig(dir, { proseMaxCols: 140 }).proseMaxCols, 140);
    assert.throws(() => loadConfig(dir, { proseMaxCols: -1 }));
    assert.throws(() => loadConfig(dir, { proseMaxCols: 1001 }));
    assert.throws(() => loadConfig(dir, { proseMaxCols: 1.5 }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config linkClickOpen can be disabled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-immersion-'));
  try {
    assert.equal(loadConfig(dir, { linkClickOpen: false }).linkClickOpen, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openFileInEditor reads the busy guard LIVE, not a /repo-invocation snapshot (P1)', () => {
  // A turn can start while the repo picker is open. The guard must consult current state at
  // file-choose time, so the blocking editor spawn never runs mid-turn. We flip the host's
  // busy flag AFTER building the host object and assert the guard honors the new value.
  const lines: string[] = [];
  let busy = false;
  let spawned = false;
  const host = {
    opts: { workspaceRoot: '/nonexistent', cfg: {} } as never,
    terminal: {} as never,
    tui: { stop: () => { spawned = true; }, start: () => {}, setFocus: () => {}, renderNow: () => {} } as never,
    editor: {} as never,
    isBusy: () => busy,
    getPickerHandle: () => null,
    setPickerHandle: () => {},
    pushLine: (p: { text: string }) => { lines.push(p.text); },
    closePicker: () => {},
  };
  busy = true; // turn started after /repo was opened
  openFileInEditor(host, '/nonexistent/file.ts');
  assert.equal(spawned, false, 'must not stop the TUI / spawn an editor while busy');
  assert.ok(lines.some((l) => l.includes('Finish the current operation')), 'busy refusal surfaced');
});