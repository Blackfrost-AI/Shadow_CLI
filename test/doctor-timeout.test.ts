import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * C5 — `shadow doctor model` blamed the MODEL for its own timeout.
 *
 * `timedOut` was set only inside the catch, but streamWithRetry SWALLOWS aborts and returns
 * cleanly (`if (a.signal?.aborted) return`) — so nothing threw, the catch never ran, and all five
 * `timedOut ?` branches downstream were dead code. Every probe against a slow local .gguf came
 * back "did not emit a valid write_file call", which is the single most misleading output this
 * command can produce for a local-first audience: the model looks broken when it was just slow.
 */
test('runTurn marks timedOut from the SIGNAL, not only from a thrown abort', () => {
  const src = readFileSync(new URL('../src/doctor/modelCheck.ts', import.meta.url), 'utf8');
  // The fix is a post-loop signal check that runs whether or not anything threw.
  const finallyIdx = src.indexOf('clearTimeout(timer);');
  const returnIdx = src.indexOf('return out;', finallyIdx);
  assert.ok(finallyIdx > 0 && returnIdx > finallyIdx, 'expected the finally block then `return out`');
  const between = src.slice(finallyIdx, returnIdx);
  assert.match(
    between,
    /if \(ac\.signal\.aborted\) out\.timedOut = true;/,
    'a signal check must run AFTER the try/finally — the catch alone never fires, because ' +
      'streamWithRetry returns cleanly on abort instead of throwing',
  );
});

test('the timedOut branches it feeds are reachable', () => {
  const src = readFileSync(new URL('../src/doctor/modelCheck.ts', import.meta.url), 'utf8');
  const branches = src.match(/timedOut\s*\?/g) ?? [];
  assert.ok(branches.length >= 3, `expected the timed-out detail branches to exist, found ${branches.length}`);
  assert.match(src, /timed out after \$\{Math\.round\(timeout \/ 1000\)\}s/, 'they report the timeout, not a model fault');
});
