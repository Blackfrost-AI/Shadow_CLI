import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseArgs } from '../src/cli/flags.js';
import {
  evaluateOffline,
  isLocalBaseUrl,
  isLocalHost,
  isLocalModelTarget,
  offlineEgressEnforced,
  OFFLINE_BANNER,
  OFFLINE_UNENFORCED_WARNING,
} from '../src/safety/offline.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/index.js';
import { buildEnvBlock } from '../src/agent/bootstrap.js';

// ── (a) --offline parses as a boolean flag ──────────────────────────────────────
test('parseArgs: --offline parses to flags.offline === true', () => {
  assert.equal(parseArgs(['--offline']).offline, true);
  // Coexists with other flags and order-independent.
  assert.equal(parseArgs(['--task', 'hi', '--offline']).offline, true);
  // Absent by default.
  assert.equal(parseArgs(['--task', 'hi']).offline, undefined);
});

// ── (b) offline + local model → web tools NOT registered ────────────────────────
test('registerBuiltinTools: offline (network:false) omits web_fetch + web_search', () => {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, { network: false });
  assert.equal(registry.get('web_fetch'), undefined, 'web_fetch must be absent offline');
  assert.equal(registry.get('web_search'), undefined, 'web_search must be absent offline');
  // Core local tools are still present.
  assert.ok(registry.get('read_file'), 'read_file should still be registered');
  assert.ok(registry.get('run_shell'), 'run_shell should still be registered');
});

test('registerBuiltinTools: online (default) registers the web tools', () => {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, {});
  assert.ok(registry.get('web_fetch'), 'web_fetch present when online');
  assert.ok(registry.get('web_search'), 'web_search present when online');
});

// ── (c) offline + cloud model → the guard rejects (pure decision fn) ─────────────
test('evaluateOffline: rejects a cloud model with a friendly fix hint', () => {
  const d = evaluateOffline({ label: 'claude', baseUrl: 'https://api.anthropic.com' });
  assert.equal(d.ok, false);
  assert.match(d.error ?? '', /local model/i);
  assert.match(d.error ?? '', /shadow local/); // tells the user exactly how to fix it
});

test('evaluateOffline: rejects a cloud model that has no baseUrl (default API)', () => {
  const d = evaluateOffline({ label: 'anthropic/claude-opus-4-8' });
  assert.equal(d.ok, false);
  assert.match(d.error ?? '', /shadow local/);
});

test('evaluateOffline: accepts a gguf preset', () => {
  assert.deepEqual(evaluateOffline({ label: 'qwen-local', gguf: '/models/qwen.gguf' }), { ok: true });
});

test('evaluateOffline: accepts a local OpenAI-compatible endpoint (Ollama/LM Studio/LAN)', () => {
  assert.equal(evaluateOffline({ label: 'ollama', baseUrl: 'http://localhost:11434/v1' }).ok, true);
  assert.equal(evaluateOffline({ label: 'lan', baseUrl: 'http://127.0.0.1:8002/v1' }).ok, true);
});

// ── (d) the local-host predicate classification ─────────────────────────────────
test('isLocalHost: loopback / mDNS / RFC-1918 are local; public API hosts are not', () => {
  for (const h of ['localhost', '127.0.0.1', '0.0.0.0', '::1', 'box.local', '10.0.0.5', '192.168.1.20', '172.16.0.1', '172.31.255.255']) {
    assert.equal(isLocalHost(h), true, `${h} should be local`);
  }
  for (const h of ['api.anthropic.com', 'api.openai.com', 'example.com', '8.8.8.8', '172.15.0.1', '172.32.0.1', '']) {
    assert.equal(isLocalHost(h), false, `${h} should NOT be local`);
  }
});

test('isLocalBaseUrl: extracts the host from a URL and classifies it', () => {
  assert.equal(isLocalBaseUrl('http://127.0.0.1:8080/v1'), true);
  assert.equal(isLocalBaseUrl('https://192.168.0.10:1234'), true);
  assert.equal(isLocalBaseUrl('https://api.anthropic.com'), false);
  assert.equal(isLocalBaseUrl('https://api.openai.com/v1'), false);
  assert.equal(isLocalBaseUrl(undefined), false);
  assert.equal(isLocalBaseUrl(''), false);
});

test('isLocalModelTarget: gguf OR local baseUrl counts as local', () => {
  assert.equal(isLocalModelTarget({ gguf: '/m.gguf' }), true);
  assert.equal(isLocalModelTarget({ baseUrl: 'http://localhost:11434' }), true);
  assert.equal(isLocalModelTarget({ baseUrl: 'https://api.openai.com' }), false);
  assert.equal(isLocalModelTarget({}), false);
});

test('OFFLINE_BANNER states the no-cloud / no-web guarantee', () => {
  assert.match(OFFLINE_BANNER, /local model/i);
  assert.match(OFFLINE_BANNER, /no web tools/i);
});

// ── (e) F07-04: the system-prompt egress claim must match what the host enforces ─
// The sandbox fails open when bwrap/seatbelt are missing, so "egress is denied" is
// only true with confinement active. `sandboxToolPresent` is the injection seam —
// both states run on any host, no monkey-patching.
test('buildEnvBlock: offline + sandbox tool present → claims egress denied', () => {
  const block = buildEnvBlock('/nonexistent-ws', [], { offline: true, sandboxToolPresent: true });
  assert.match(block, /Offline Shadow Mode: ACTIVE/);
  assert.match(block, /run_shell network egress is denied/);
  assert.doesNotMatch(block, /CANNOT be enforced/);
});

test('buildEnvBlock: offline + NO sandbox tool → names the missing enforcement, never claims denial', () => {
  const block = buildEnvBlock('/nonexistent-ws', [], { offline: true, sandboxToolPresent: false });
  assert.match(block, /Offline Shadow Mode: ACTIVE/);
  assert.match(block, /run_shell egress CANNOT be enforced on this host \(no bwrap\/seatbelt/);
  assert.doesNotMatch(block, /egress is denied/);
});

test('buildEnvBlock: offline + confinement dropped (--yolo) → unenforced claim even with the tool present', () => {
  const block = buildEnvBlock('/nonexistent-ws', [], { offline: true, yolo: true, sandboxToolPresent: true });
  assert.match(block, /CANNOT be enforced/);
  assert.doesNotMatch(block, /egress is denied/);
});

test('offlineEgressEnforced: needs confinement ON and the platform tool present', () => {
  assert.equal(offlineEgressEnforced({}, true), true);
  assert.equal(offlineEgressEnforced({}, false), false);
  assert.equal(offlineEgressEnforced({ yolo: true }, true), false);
  assert.equal(offlineEgressEnforced({ noSandbox: true }, true), false);
  assert.equal(offlineEgressEnforced({ unrestricted: true }, true), false);
});

test('OFFLINE_UNENFORCED_WARNING names the missing enforcement', () => {
  assert.match(OFFLINE_UNENFORCED_WARNING, /cannot be enforced/i);
  assert.match(OFFLINE_UNENFORCED_WARNING, /bwrap\/seatbelt/);
  assert.match(OFFLINE_UNENFORCED_WARNING, /unconfined/);
});

// ── (f) F07-04 wiring: the startup warning actually fires beside the banner ──────
test('bootstrap: offline banner site gates OFFLINE_UNENFORCED_WARNING on the shared predicate', () => {
  const src = readFileSync(new URL('../src/agent/bootstrap.ts', import.meta.url), 'utf8');
  const banner = src.indexOf('write(lc.bold(OFFLINE_BANNER)');
  assert.ok(banner > -1, 'the offline banner write is still in bootstrap');
  const after = src.slice(banner, banner + 600);
  assert.match(after, /offlineEgressEnforced\(/, 'warning gated on the same predicate the env block uses');
  assert.match(after, /OFFLINE_UNENFORCED_WARNING/, 'the warning text is written beside the banner');
});
