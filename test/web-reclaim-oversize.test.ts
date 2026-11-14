/**
 * 11.6.0 RECLAIM — web tool oversize coverage: the FULL readable text spills pre-clamp and the
 * locator rides the TRUSTED provenance line (outside the envelope).
 *
 * The success-path transport (egress broker + SSRF guard) is exercised by the web suites; here we
 * prove the spill boundary the tools call (webFetch.ts / webSearch.ts share spillReclaimedBody)
 * preserves every pre-clamp byte, and that a fetch failure never promises a locator.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { webFetch } from '../src/tools/webFetch.js';
import { spillReclaimedBody } from '../src/agent/toolSpill.js';
import { fitPayload } from '../src/safety/envelope.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'shadow-webreclaim-'));
}

test('web oversize: spill file holds the FULL pre-clamp readable text; locator is workspace-relative', () => {
  const ws = tmp();
  try {
    // Simulate a readable page far beyond the tool result budget (the exact condition webFetch /
    // webSearch test before calling spillReclaimedBody).
    const readable = Array.from({ length: 400 }, (_, i) => `line ${i}: ${'page-content-'.repeat(20)}`).join('\n');
    const budget = 500;
    assert.ok(readable.length > budget);
    const locator = spillReclaimedBody({
      workspaceRoot: ws,
      sessionId: 'websess',
      toolName: 'web_fetch',
      toolCallId: 'call-1',
      body: readable,
    });
    assert.ok(locator, 'oversize readable text spills');
    assert.ok(locator!.startsWith('.shadow/sessions/websess/spill/web_fetch-call-1'), 'session-scoped web_fetch spill');
    assert.equal(readFileSync(join(ws, locator!), 'utf8'), readable, 'FULL pre-clamp text preserved — not the clamped preview');
    // The in-context payload is still clamped (clamp-before-envelope invariant unchanged).
    const payload = fitPayload(readable, budget);
    assert.ok(payload.length < readable.length);
    assert.ok(readable.endsWith(payload.slice(-40)) || payload.length <= budget, 'payload is a bounded slice');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('web oversize: repeated fetch of identical content reuses the spill; changed content never overwrites', () => {
  const ws = tmp();
  try {
    const opts = { workspaceRoot: ws, sessionId: 'websess', toolName: 'web_search', toolCallId: 'call-2' };
    const a = spillReclaimedBody({ ...opts, body: 'results v1' });
    const b = spillReclaimedBody({ ...opts, body: 'results v1' });
    const c = spillReclaimedBody({ ...opts, body: 'results v2 — different page' });
    assert.equal(b, a, 'identical re-fetch reuses the file (idempotent)');
    assert.ok(c && c !== a, 'changed results get a new file');
    assert.equal(readFileSync(join(ws, a!), 'utf8'), 'results v1');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('web_fetch failure path: recoverable error, no spill promised (unresolvable host)', async () => {
  const ws = tmp();
  try {
    const ctx = {
      signal: new AbortController().signal,
      dryRun: false,
      workspaceRoot: ws,
      additionalRoots: [] as string[],
      sessionId: 'websess',
      maxToolResultChars: 500,
      toolCallId: 'call-3',
    } as never;
    const r = await webFetch.run({ url: 'http://nonexistent-zzz-shadow-reclaim.invalid/' }, ctx);
    assert.equal(r.ok, false);
    assert.notEqual(r.error?.recoverable, false, 'dead URL stays recoverable');
    assert.ok(!r.summary.includes('saved to'), 'a failed fetch never promises a locator');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});