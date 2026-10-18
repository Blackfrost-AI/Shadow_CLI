import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The bug these guard against is not a broken cell — it was a complete, unit-tested cell that no
 * layout ever mounted. Nothing failed, the agent simply had no live view of its own work. So the
 * assertions here are about WIRING, which unit tests of the cells can never cover.
 */

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

test('the sub-agent dock is mounted in the Snowfall layout', () => {
  const src = read('src/app/snowfall.ts');
  assert.match(src, /new SubAgentsCell\(/, 'SubAgentsCell must be constructed by the layout');
  assert.match(src, /component:\s*agents/, 'the dock component must be an item in the VStack');
});

test('the toast channel is mounted in the Snowfall layout', () => {
  const src = read('src/app/snowfall.ts');
  assert.match(src, /new ToastCell\(/, 'ToastCell must be constructed by the layout');
  assert.match(src, /component:\s*toasts/, 'the toast component must be an item in the VStack');
});

test('both live cells sit between the editor and the status row, never above the composer', () => {
  const src = read('src/app/snowfall.ts');
  const editorAt = src.indexOf('component: editor');
  const toastsAt = src.indexOf('component: toasts');
  const agentsAt = src.indexOf('component: agents');
  assert.ok(editorAt > 0 && toastsAt > 0 && agentsAt > 0, 'all three must be present');
  // Pushing the composer around while the user is typing is the failure mode to avoid.
  assert.ok(editorAt < toastsAt, 'toasts must render below the editor');
  assert.ok(toastsAt < agentsAt, 'toasts sit above the dock, nearest the composer');
});

test('the app feeds live state into both cells, so they cannot be mounted but empty', () => {
  const src = read('src/app/app.ts');
  assert.match(src, /s\.toasts\s*=/, 'HudState.toasts must be populated each frame');
  assert.match(src, /this\.toasts\.raise\(/, 'something must actually raise toasts');
  // The registry the dock reads must be mutated on lifecycle events, not just declared.
  assert.match(src, /this\.subAgents\.set\(/, 'sub-agent starts must populate the registry');
  assert.match(src, /this\.subAgents\.delete\(/, 'sub-agent finishes must clear the registry');
});

test('toast expiry runs on its own ticker, so idle-session notices still clear', () => {
  const src = read('src/app/app.ts');
  assert.match(src, /startToastTicker\(\)/, 'a dedicated toast ticker must be started');
  // The main ticker is turn-scoped; background work finishes while the session is idle, which is
  // exactly when the turn-scoped timer is not running.
  const startIdx = src.indexOf('private startToastTicker');
  assert.ok(startIdx > 0, 'startToastTicker must exist');
  assert.match(src.slice(startIdx, startIdx + 700), /setInterval/, 'it must actually schedule a tick');
});

test('watchers are wired from the tool registry through to the Work Center', () => {
  assert.match(read('src/agent/bootstrap.ts'), /new WatcherRegistry\(/, 'bootstrap must create the registry');
  assert.match(read('src/agent/bootstrap.ts'), /watchers,/, 'bootstrap must expose it on the session');
  assert.match(read('src/tools/index.ts'), /makeWatcherTool/, 'the tool must be registered');
  assert.match(read('src/index.ts'), /attachWatchers\(/, 'the Work Center must project watchers');
});

test('Ctrl+N opens the live work overlay and is dispatched before the editor claims it', () => {
  const src = read('src/app/app.ts');
  assert.match(src, /isCtrlN\(data\)/, 'Ctrl+N must be handled app-wide');
  const idx = src.indexOf('isCtrlN(data)');
  assert.match(src.slice(idx, idx + 200), /openWorkOverlay\(\)/, 'Ctrl+N must open the work overlay');
});

test('Ctrl+T opens the snapshot overlay instead of dumping text into the transcript', () => {
  const src = read('src/app/app.ts');
  assert.match(src, /openTaskOverlay\(\)/, 'Ctrl+T must open an overlay');
  // printTasksToTranscript may still exist for non-interactive fallback, but the key must not use it.
  const idx = src.indexOf('isCtrlT(data)');
  const branch = src.slice(idx, idx + 300);
  assert.ok(!/printTasksToTranscript/.test(branch), 'the snapshot must not be printed into the stream');
});
