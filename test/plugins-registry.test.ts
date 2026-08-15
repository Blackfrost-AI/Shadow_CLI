// P3-07 — the OPTIONAL plugin index: user-configured, OFF by default, fetched through the egress
// broker (purpose 'plugin-index'), entries are display-only untrusted data, and when a
// pluginIndexKey is configured the detached ECDSA P-256 signature is FAIL-CLOSED. Also pins the
// trust boundary: a project shadow.config.json can never set pluginIndexUrl/pluginIndexKey.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { isolateHome } from './helpers/isolateHome.js';

const { shadowDir } = isolateHome('plugins-registry');
assert.ok(shadowDir.includes('.shadow'), 'isolation sanity');

const { fetchPluginIndex, filterIndex, resolveIndexUrl, verifyIndexSignature } =
  await import('../src/plugins/registry.js');
const { loadConfig } = await import('../src/config.js');
const { readEgressLogAggregate } = await import('../src/safety/egress.js');

// Hostile index body: an ext:: URL entry, a malformed name, and a control-char description must
// all be neutralized before anything reaches a display surface. The bell char is built at runtime
// so this source file carries no literal control bytes.
const bell = String.fromCharCode(7);
const INDEX = JSON.stringify({
  plugins: [
    { name: 'good-pack', description: 'A good pack', url: 'https://example.com/good.git', version: '1.2.3' },
    { name: 'evil-ext', description: 'executes commands', url: 'ext::sh -c pwn' },
    { name: 'bad name!', description: 'malformed name', url: 'https://example.com/x.git' },
    { name: 'ctrl-desc', description: `bell${bell}ring`, url: 'https://example.com/ctrl.git' },
    { name: 'plain', description: 'plain pack', url: 'https://example.com/plain.git' },
  ],
});
const BIG = JSON.stringify({ plugins: [], pad: 'x'.repeat(1_200_000) }); // > 1 MB cap

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PUB_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const SIG = cryptoSign('sha256', Buffer.from(INDEX), privateKey);
const OTHER = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const WRONG_PUB_PEM = OTHER.publicKey.export({ type: 'spki', format: 'pem' }).toString();

let server: Server;
let base = '';

before(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/index.json') return void res.end(INDEX);
    if (url === '/index.json.sig') return void res.end(SIG);
    if (url === '/tamper.json') return void res.end(INDEX + ' ');
    if (url === '/tamper.json.sig') return void res.end(SIG);
    if (url === '/unsigned.json') return void res.end(INDEX);
    if (url === '/big.json') return void res.end(BIG);
    if (url === '/bad.json') return void res.end('{nope');
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((r) => server.close(() => r())));

test('no index configured → readable refusal that states the zero-telemetry default', async () => {
  await assert.rejects(() => fetchPluginIndex({}), /no plugin index/i);
  await assert.rejects(() => fetchPluginIndex({ pluginIndexUrl: '   ' }), /no plugin index/i);
});

test('unsigned index fetch: hostile entries are filtered, control chars sanitized, nothing executed', async () => {
  const idx = await fetchPluginIndex({ pluginIndexUrl: `${base}/index.json` });
  assert.equal(idx.keyConfigured, false);
  assert.equal(idx.signatureVerified, false);
  const names = idx.entries.map((e) => e.name).sort();
  assert.deepEqual(names, ['ctrl-desc', 'good-pack', 'plain'], 'ext:: and malformed-name entries are dropped');
  assert.ok(!idx.entries.some((e) => e.url.startsWith('ext::')), 'no ext:: URL survives coercion');
  const ctrl = idx.entries.find((e) => e.name === 'ctrl-desc');
  assert.ok(ctrl && !ctrl.description.includes(bell), 'bell char stripped from display field');
  assert.equal(ctrl?.description, 'bell ring');
});

test('pluginIndexKey + valid detached signature → signatureVerified true', async () => {
  const idx = await fetchPluginIndex({ pluginIndexUrl: `${base}/index.json`, pluginIndexKey: PUB_PEM });
  assert.equal(idx.keyConfigured, true);
  assert.equal(idx.signatureVerified, true);
});

test('tampered body with a real signature → FAIL CLOSED', async () => {
  await assert.rejects(
    () => fetchPluginIndex({ pluginIndexUrl: `${base}/tamper.json`, pluginIndexKey: PUB_PEM }),
    /SIGNATURE/i,
  );
});

test('signature from the WRONG key → FAIL CLOSED', async () => {
  await assert.rejects(
    () => fetchPluginIndex({ pluginIndexUrl: `${base}/index.json`, pluginIndexKey: WRONG_PUB_PEM }),
    /SIGNATURE/i,
  );
});

test('key configured but .sig missing (404) → FAIL CLOSED, never fall back to unsigned', async () => {
  await assert.rejects(
    () => fetchPluginIndex({ pluginIndexUrl: `${base}/unsigned.json`, pluginIndexKey: PUB_PEM }),
    /fail-closed|signature/i,
  );
});

test('oversized index (> 1 MB) is refused; malformed JSON is refused', async () => {
  await assert.rejects(() => fetchPluginIndex({ pluginIndexUrl: `${base}/big.json` }), /1 MB|cap/i);
  await assert.rejects(() => fetchPluginIndex({ pluginIndexUrl: `${base}/bad.json` }), /JSON/i);
});

test('verifyIndexSignature is a pure predicate: true only for the exact body+key pair', () => {
  assert.equal(verifyIndexSignature(Buffer.from(INDEX), PUB_PEM, SIG), true);
  assert.equal(verifyIndexSignature(Buffer.from(INDEX + 'x'), PUB_PEM, SIG), false);
  assert.equal(verifyIndexSignature(Buffer.from(INDEX), WRONG_PUB_PEM, SIG), false);
  assert.equal(verifyIndexSignature(Buffer.from(INDEX), 'not-a-pem', SIG), false);
});

test('filterIndex + resolveIndexUrl: search is display-only, add-by-name only returns a vetted URL', async () => {
  const cfg = { pluginIndexUrl: `${base}/index.json` };
  const all = (await fetchPluginIndex(cfg)).entries;
  assert.equal(filterIndex(all, 'good').length, 1);
  assert.equal(filterIndex(all, '').length, all.length);
  assert.equal(filterIndex(all, 'zzz-missing').length, 0);

  assert.equal(await resolveIndexUrl('good-pack', cfg), 'https://example.com/good.git');
  assert.equal(await resolveIndexUrl('GOOD-PACK', cfg), 'https://example.com/good.git', 'case-insensitive');
  assert.equal(await resolveIndexUrl('ghost-pack', cfg), null);
  assert.equal(await resolveIndexUrl('evil-ext', cfg), null, 'filtered entries can never resolve');
});

test('the fetch is receipted by the egress broker with purpose plugin-index', async () => {
  const rows = await readEgressLogAggregate();
  const row = rows.find((r) => [...r.purposes].includes('plugin-index'));
  assert.ok(row, 'an egress receipt row with purpose plugin-index must exist');
  assert.ok(row!.allowed > 0);
});

test('PROJECT_UNTRUSTED_KEYS: a project file cannot set pluginIndexUrl/pluginIndexKey', () => {
  const ws = mkdtempSync(join(tmpdir(), 'shadow-plug-ws-'));
  writeFileSync(
    join(ws, 'shadow.config.json'),
    JSON.stringify({
      pluginIndexUrl: 'http://evil.example/index.json',
      pluginIndexKey: 'attacker-pem',
      style: 'proactive',
    }),
  );
  const cfg = loadConfig(ws);
  assert.equal(cfg.pluginIndexUrl, undefined, 'project pluginIndexUrl must be stripped');
  assert.equal((cfg as unknown as Record<string, unknown>).pluginIndexKey, undefined, 'project pluginIndexKey must be stripped');
  assert.equal(cfg.style, 'proactive', 'benign keys still load');
});
