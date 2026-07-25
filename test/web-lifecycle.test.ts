import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Sequence E — web console lifecycle. Structural assertions: each one names the exact code shape
 * that was missing, and fails against the pre-fix source.
 */
const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8');

test('E1: the jail is re-resolved from the allowlist on EVERY turn', () => {
  const src = read('../src/web/runTurn.ts');
  assert.match(
    src,
    /session\.jail = resolve\(session\.displayPath\)/,
    'session.jail was written ONCE by the builder, so a revoked project stayed readable and ' +
      'writable by any already-open session at auto-edit',
  );
  const i = src.indexOf('session.jail = resolve(');
  const j = src.indexOf('buildTurnDeps(session)');
  assert.ok(i > 0 && j > i, 'the re-resolve must happen BEFORE deps are assembled from the jail');
});

test('E1: removing a project cascades to the sessions rooted in it', () => {
  const src = read('../src/web/api/projects.ts');
  assert.match(src, /ctx\.registry\.each\(/, 'the remove route must inspect live sessions');
  assert.match(src, /ctx\.registry\.remove\(id\)/, 'and close the ones it revoked');
  assert.match(src, /contains\(root!, normalizeProjectPath\(s\.displayPath\)\)/, 'matching by containment');
  assert.match(src, /s\.origin !== 'web'/, 'never the reserved CLI mirror — it may legitimately sit inside');
  assert.match(src, /sessionsClosed/, 'and it reports what it closed');
});

test('E2: a DELETE route exists and cannot swallow the chat path', () => {
  const src = read('../src/web/api/sessions.ts');
  const m = src.match(/route\('DELETE', (\/\^[^,]+\/),/);
  assert.ok(m, 'registry.remove had ZERO production callers before this');
  const pattern = new RegExp(m![1]!.slice(1, -1));
  assert.ok(pattern.test('/api/sessions/abc123'), 'matches a bare session id');
  assert.ok(!pattern.test('/api/sessions/abc123/chat'), 'must NOT also match /chat');
  assert.ok(!pattern.test('/api/sessions/abc123/interrupt'), 'must NOT also match /interrupt');
});

test('E2: web sessions are capped', () => {
  const src = read('../src/web/registry.ts');
  assert.match(src, /MAX_WEB_SESSIONS/, 'a ceiling exists');
  assert.match(src, /if \(live >= MAX_WEB_SESSIONS\)/, 'and create() enforces it');
  assert.match(src, /existing\.origin === 'web'/, 'counting only browser-created sessions');
});

test('E2: the UI can actually close a session', () => {
  const src = read('../src/web/ui/views/sessions.js');
  assert.match(src, /del\(`\/api\/sessions\/\$\{s\.id\}`\)/, 'the row has a close control');
  assert.match(src, /e\.stopPropagation\(\)/, 'which must not also open the console');
  // The embedded copy is what the compiled binary serves — a stale map ships a UI without it.
  const bundled = read('../src/web/bundledAssets.ts');
  assert.match(bundled, /api\\\/sessions\\\/\$\{s\.id\}|api\/sessions\/\$\{s\.id\}/, 'and it is embedded');
});

test('E3: the abort controller exists before the build, not after', () => {
  const src = read('../src/web/registry.ts');
  const raw = src.slice(src.indexOf('async function drive('), src.indexOf('return {\n    get(id: string)'));
  // Strip comment lines: the explanatory comment QUOTES both statements, so a naive indexOf
  // finds the prose instead of the code.
  const drive = raw
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
  const ctrl = drive.indexOf('s.abort = new AbortController()');
  const build = drive.indexOf('await s.building');
  assert.ok(ctrl > 0 && build > 0, 'both exist');
  assert.ok(ctrl < build, "interrupt() read a null s.abort during 'initializing' — which can take MINUTES");
  assert.match(drive, /if \(s\.abort\.signal\.aborted\)/, 'and an interrupt during the build must not then run the turn');
});

test('E3: every early return out of drive emits a terminal frame', () => {
  const src = read('../src/web/registry.ts');
  assert.match(src, /const emitInterrupted =/, 'a helper exists');
  const drive = src.slice(src.indexOf('async function drive('), src.indexOf('return {\n    get(id: string)'));
  const emits = (drive.match(/emitInterrupted\(s\)/g) ?? []).length;
  assert.ok(emits >= 2, `both early returns must emit (found ${emits}) — the browser clears its ` +
    'optimistic running state ONLY on a stop frame, so a silent return left the textarea disabled');
});
