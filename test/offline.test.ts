import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/cli/flags.js';
import {
  evaluateOffline,
  isLocalBaseUrl,
  isLocalHost,
  isLocalModelTarget,
  OFFLINE_BANNER,
} from '../src/safety/offline.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/index.js';

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
