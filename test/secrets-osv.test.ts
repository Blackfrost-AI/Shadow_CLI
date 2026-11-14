// F3 — secrets_scan (masked, bounded) + osv_query (brokered POST, offline-aware).
// secrets_scan: planted fake credentials are found and MASKED (raw secret never in
// output); benign repos yield zero; binary/vendor skip + caps hold. osv_query: the
// egress fetch seam is stubbed (no live network); offline mode refuses; the request
// body carries only package identity.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secretsScan } from '../src/tools/secretsScan.js';
import { osvQuery } from '../src/tools/osvQuery.js';
import { setOfflineMode, setEgressResolverForTests } from '../src/safety/egress.js';
import { isolateHome } from './helpers/isolateHome.js';

// Isolate ~/.shadow so egress receipts never touch the real home.
isolateHome('f3-secrets-osv');

function ctxFor(ws: string) {
  return { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false };
}
function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'shadow-f3-'));
}

// A fake AWS access key id (shape match, not a real credential).
const FAKE_AWS = 'AKIA' + 'IOSFODNN7EXAMPLE';
// A fake GitHub classic PAT (ghp_ + 36 chars).
const FAKE_GHP = 'ghp_' + 'a'.repeat(36);
// A fake OpenAI-style key.
const FAKE_OPENAI = 'sk-' + 'B'.repeat(48);

// ── secrets_scan ────────────────────────────────────────────────────────────
test('secrets_scan: finds planted credentials and masks them (no raw secret in output)', async () => {
  const ws = workspace();
  try {
    writeFileSync(join(ws, 'config.ts'), `export const aws = "${FAKE_AWS}";\nexport const gh = "${FAKE_GHP}";\n`);
    writeFileSync(join(ws, 'clean.ts'), 'export const x = 1;\n');
    const res = await secretsScan.run({}, ctxFor(ws));
    assert.equal(res.ok, true);
    const data = res.data!;
    assert.ok(data.totalFindings >= 2, `expected >=2 findings, got ${data.totalFindings}`);
    const rules = data.findings.map((f) => f.rule);
    assert.ok(rules.includes('aws-access-key-id'), `rules: ${rules.join(',')}`);
    assert.ok(rules.includes('github-token'));
    // The raw secrets must NEVER appear anywhere in the serialized result.
    const serialized = JSON.stringify(res);
    assert.ok(!serialized.includes(FAKE_AWS), 'raw AWS key leaked into output');
    assert.ok(!serialized.includes(FAKE_GHP), 'raw GitHub token leaked into output');
    // Every preview is masked.
    for (const f of data.findings) {
      assert.ok(f.preview.includes('…') || f.preview.includes('[REDACTED'), `preview not masked: ${f.preview}`);
    }
    // file:line is present and correct.
    const aws = data.findings.find((f) => f.rule === 'aws-access-key-id')!;
    assert.equal(aws.file, 'config.ts');
    assert.equal(aws.line, 1);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('secrets_scan: benign repo yields zero findings', async () => {
  const ws = workspace();
  try {
    writeFileSync(join(ws, 'a.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
    writeFileSync(join(ws, 'b.md'), '# Notes\nNothing sensitive here.\n');
    const res = await secretsScan.run({}, ctxFor(ws));
    assert.equal(res.ok, true);
    assert.equal(res.data!.totalFindings, 0);
    assert.ok(res.data!.filesScanned >= 2);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('secrets_scan: entropy heuristic flags high-entropy assignments; can be disabled', async () => {
  const ws = workspace();
  try {
    // A high-entropy random-looking value bound to a secret-ish key (no known shape).
    const rand = 'Zx9Qm3Vb7Kp2Wd8Rf4Tg6Yh1Nj5Lc0Es';
    writeFileSync(join(ws, 'env.ts'), `const api_key = "${rand}";\n`);
    const on = await secretsScan.run({ entropy: true }, ctxFor(ws));
    assert.equal(on.ok, true);
    assert.ok(on.data!.findings.some((f) => f.kind === 'entropy'), 'entropy hit expected');
    const off = await secretsScan.run({ entropy: false }, ctxFor(ws));
    assert.equal(off.ok, true);
    assert.ok(!off.data!.findings.some((f) => f.kind === 'entropy'), 'entropy disabled but still hit');
    assert.ok(!JSON.stringify(on).includes(rand), 'raw entropy secret leaked');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('secrets_scan: skips binaries and vendor dirs; respects maxFiles cap', async () => {
  const ws = workspace();
  try {
    mkdirSync(join(ws, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(ws, 'node_modules', 'pkg', 'leak.js'), `const k = "${FAKE_OPENAI}";\n`);
    writeFileSync(join(ws, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    writeFileSync(join(ws, 'real.ts'), `const k = "${FAKE_OPENAI}";\n`);
    const res = await secretsScan.run({}, ctxFor(ws));
    assert.equal(res.ok, true);
    // node_modules is skipped, so only real.ts contributes.
    assert.ok(res.data!.findings.every((f) => f.file === 'real.ts'), `unexpected files: ${res.data!.findings.map((f) => f.file)}`);
    assert.ok(res.data!.filesSkipped >= 1);
    // maxFiles cap.
    const capped = await secretsScan.run({ maxFiles: 1 }, ctxFor(ws));
    assert.equal(capped.ok, true);
    assert.ok(capped.data!.filesScanned <= 1);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('secrets_scan: jail escape on out-of-workspace path is refused', async () => {
  const ws = workspace();
  try {
    const res = await secretsScan.run({ paths: ['../../etc/passwd'] }, ctxFor(ws));
    assert.equal(res.ok, false);
    assert.equal(res.error!.code, 'jail_escape');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── osv_query ───────────────────────────────────────────────────────────────
const OSV_RESPONSE = {
  vulns: [
    {
      id: 'GHSA-xxxx-yyyy-zzzz',
      aliases: ['CVE-2021-99999'],
      summary: 'Prototype pollution in lodash before 4.17.21.',
      severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
      affected: [{ ranges: [{ events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }],
      published: '2021-05-06T00:00:00Z',
      modified: '2021-05-07T00:00:00Z',
    },
  ],
};

test('osv_query: returns parsed advisories; request carries only package identity', async () => {
  let capturedUrl = '';
  let capturedBody = '';
  const prevFetch = globalThis.fetch;
  setEgressResolverForTests(async () => ['203.0.113.12']);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedBody = typeof init?.body === 'string' ? init.body : '';
    return new Response(JSON.stringify(OSV_RESPONSE), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    const res = await osvQuery.run({ ecosystem: 'npm', name: 'lodash', version: '4.17.20' }, ctxFor(workspace()));
    assert.equal(res.ok, true);
    assert.equal(capturedUrl, 'https://api.osv.dev/v1/query');
    const sent = JSON.parse(capturedBody);
    assert.deepEqual(sent, { package: { ecosystem: 'npm', name: 'lodash' }, version: '4.17.20' });
    const data = res.data!;
    assert.equal(data.vulnCount, 1);
    assert.equal(data.vulns[0].id, 'GHSA-xxxx-yyyy-zzzz');
    assert.deepEqual(data.vulns[0].aliases, ['CVE-2021-99999']);
    assert.deepEqual(data.vulns[0].fixed, ['4.17.21']);
    // Summary is enveloped as untrusted data.
    assert.ok(res.summary.includes('UNTRUSTED_CONTENT_BEGIN'));
  } finally {
    globalThis.fetch = prevFetch;
    setEgressResolverForTests(null);
  }
});

test('osv_query: purl form sends purl only', async () => {
  let capturedBody = '';
  const prevFetch = globalThis.fetch;
  setEgressResolverForTests(async () => ['203.0.113.12']);
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = typeof init?.body === 'string' ? init.body : '';
    return new Response(JSON.stringify({ vulns: [] }), { status: 200 });
  }) as typeof fetch;
  try {
    const res = await osvQuery.run({ purl: 'pkg:npm/lodash@4.17.20' }, ctxFor(workspace()));
    assert.equal(res.ok, true);
    assert.deepEqual(JSON.parse(capturedBody), { package: { purl: 'pkg:npm/lodash@4.17.20' } });
    assert.equal(res.data!.vulnCount, 0);
  } finally {
    globalThis.fetch = prevFetch;
    setEgressResolverForTests(null);
  }
});

test('osv_query: offline mode refuses without any network call', async () => {
  let called = false;
  const prevFetch = globalThis.fetch;
  setEgressResolverForTests(async () => ['203.0.113.12']);
  globalThis.fetch = (async () => {
    called = true;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  setOfflineMode(true);
  try {
    const res = await osvQuery.run({ ecosystem: 'npm', name: 'lodash', version: '4.17.20' }, ctxFor(workspace()));
    assert.equal(res.ok, false);
    assert.equal(res.error!.code, 'offline');
    assert.equal(called, false, 'fetch must not be called in offline mode');
  } finally {
    setOfflineMode(false);
    globalThis.fetch = prevFetch;
    setEgressResolverForTests(null);
  }
});

test('osv_query: HTTP error surfaces honestly', async () => {
  const prevFetch = globalThis.fetch;
  setEgressResolverForTests(async () => ['203.0.113.12']);
  globalThis.fetch = (async () => new Response('nope', { status: 503 })) as typeof fetch;
  try {
    const res = await osvQuery.run({ ecosystem: 'npm', name: 'lodash', version: '4.17.20' }, ctxFor(workspace()));
    assert.equal(res.ok, false);
    assert.equal(res.error!.code, 'http_error');
  } finally {
    globalThis.fetch = prevFetch;
    setEgressResolverForTests(null);
  }
});

test('osv_query: schema requires purl or full triple', async () => {
  const parsed = osvQuery.inputSchema.safeParse({ ecosystem: 'npm' });
  assert.equal(parsed.success, false);
  const ok1 = osvQuery.inputSchema.safeParse({ ecosystem: 'npm', name: 'x', version: '1' });
  assert.equal(ok1.success, true);
  const ok2 = osvQuery.inputSchema.safeParse({ purl: 'pkg:npm/x@1' });
  assert.equal(ok2.success, true);
});