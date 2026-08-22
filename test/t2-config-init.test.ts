// T2 Phase 2 — config init + doctor layout panel unit tests.
// The modules under test are PURE (fs on injected/temp paths, store injected) —
// no isolateHome needed; they never touch ~/.shadow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SAFE_SEED,
  CONFIG_TEMPLATE_MD,
  configInit,
  formatConfigInit,
  configIsEmpty,
  globalConfigLooksEmpty,
  fileSizeBytes,
  buildLayoutPanel,
  formatLayoutPanel,
  type ConfigStore,
} from '../src/config/configInit.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'cfg-init-'));
}

/** In-memory fake of the globalStore surface configInit needs. */
function fakeStore(backing: Record<string, unknown>): ConfigStore {
  return {
    loadGlobalConfig: () => ({ ...backing }),
    saveGlobalConfig: (patch) => Object.assign(backing, patch),
  };
}

// ── configInit ───────────────────────────────────────────────────────────────

test('configInit writes template + seeds safe defaults into a fresh dir', () => {
  const dir = tmp();
  const backing = {};
  const res = configInit(dir, join(dir, 'config.json'), fakeStore(backing));
  assert.ok('written' in res.template, 'template written');
  assert.ok('seeded' in res.seed, 'defaults seeded');
  // Template lands on disk with every documented section.
  const t = readFileSync(join(dir, 'config.template.md'), 'utf8');
  assert.match(t, /stream\.idleTimeoutMs/);
  assert.match(t, /SHADOW_IDLE_MS/);
  assert.match(t, /vault\.enc/);
  // Seed carries the stream block + conservative notify/contextBudget.
  assert.deepEqual((backing as Record<string, unknown>).notify, 'auto');
  assert.deepEqual((backing as Record<string, unknown>).contextBudget, 128_000);
  const stream = (backing as Record<string, unknown>).stream as Record<string, unknown>;
  assert.equal(stream.idleTimeoutMs, 300_000);
  assert.equal(stream.firstByteTimeoutMs, 600_000);
  assert.equal(stream.retries, 5);
});

test('configInit NEVER overwrites an existing non-empty config.json', () => {
  const dir = tmp();
  const cfgPath = join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify({ provider: 'anthropic', model: 'x' }));
  const backing = {};
  const res = configInit(dir, cfgPath, fakeStore(backing));
  assert.ok('alreadyPresent' in res.seed);
  assert.equal(readFileSync(cfgPath, 'utf8'), JSON.stringify({ provider: 'anthropic', model: 'x' }));
  assert.equal(Object.keys(backing).length, 0, 'store untouched');
});

test('configInit re-seeds a config.json that is present but whitespace-only', () => {
  const dir = tmp();
  const cfgPath = join(dir, 'config.json');
  writeFileSync(cfgPath, '   \n  ');
  const backing = {};
  const res = configInit(dir, cfgPath, fakeStore(backing));
  assert.ok('seeded' in res.seed, 'whitespace-only counts as empty');
});

test('configInit NEVER overwrites an existing template', () => {
  const dir = tmp();
  const tpl = join(dir, 'config.template.md');
  writeFileSync(tpl, 'CUSTOM TEMPLATE');
  const res = configInit(dir, join(dir, 'config.json'), fakeStore({}));
  assert.ok('alreadyPresent' in res.template);
  assert.equal(readFileSync(tpl, 'utf8'), 'CUSTOM TEMPLATE');
});

test('configInit creates the global dir at 0700 when missing', () => {
  const dir = join(tmp(), 'nested-shadow');
  configInit(dir, join(dir, 'config.json'), fakeStore({}));
  assert.ok(existsSync(dir));
  const mode = statSync(dir).mode & 0o777;
  assert.ok(mode <= 0o700, `dir mode 0${mode.toString(8)} must be ≤ 0700`);
  assert.ok(readdirSync(dir).includes('config.template.md'));
});

test('formatConfigInit reports both artifacts honestly', () => {
  const dir = tmp();
  const res = configInit(dir, join(dir, 'config.json'), fakeStore({}));
  const out = formatConfigInit(res, join(dir, 'config.json'));
  assert.match(out, /wrote .*config\.template\.md/);
  assert.match(out, /seeded safe defaults/);
  assert.match(out, /Layout: settings live in config\.json/);
});

// ── SAFE_SEED / template contract ────────────────────────────────────────────

test('SAFE_SEED is conservative and self-hosted friendly', () => {
  const s = SAFE_SEED.stream as Record<string, unknown>;
  assert.ok(Number(s.idleTimeoutMs) >= 300_000, 'idle budget covers slow self-hosted serves');
  assert.equal(SAFE_SEED.notify, 'auto');
});

test('CONFIG_TEMPLATE_MD documents the resolution order + the env override', () => {
  assert.match(CONFIG_TEMPLATE_MD, /env > per-model entry > stream block/);
  assert.match(CONFIG_TEMPLATE_MD, /shadow config init/);
});

// ── globalConfigLooksEmpty / configIsEmpty ───────────────────────────────────

test('globalConfigLooksEmpty: absent, whitespace, {} → true; content → false', () => {
  const dir = tmp();
  assert.equal(globalConfigLooksEmpty(join(dir, 'missing.json')), true);
  const p = join(dir, 'c.json');
  writeFileSync(p, '');
  assert.equal(globalConfigLooksEmpty(p), true);
  writeFileSync(p, '  \n\t ');
  assert.equal(globalConfigLooksEmpty(p), true);
  writeFileSync(p, '{}');
  assert.equal(globalConfigLooksEmpty(p), true);
  writeFileSync(p, '{"provider":"openai"}');
  assert.equal(globalConfigLooksEmpty(p), false);
  writeFileSync(p, 'not json at all');
  assert.equal(globalConfigLooksEmpty(p), true, 'invalid/unparseable → treated as empty; the hint is harmless and never writes');
});

test('configIsEmpty counts object keys', () => {
  assert.equal(configIsEmpty({}), true);
  assert.equal(configIsEmpty({ provider: 'openai' }), false);
});

// ── doctor layout panel ──────────────────────────────────────────────────────

test('buildLayoutPanel reports present/empty/missing rows against a temp dir', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'config.json'), '{"provider":"openai"}');
  writeFileSync(join(dir, 'credentials.json'), '{}');
  writeFileSync(join(dir, 'vault.enc'), ''); // present but empty
  const rows = buildLayoutPanel(dir);
  const byFile = new Map(rows.map((r) => [r.file, r]));
  assert.equal(byFile.get('config.json')?.status, 'present');
  assert.match(byFile.get('config.json')?.note ?? '', /NO secrets/);
  assert.equal(byFile.get('credentials.json')?.status, 'present');
  assert.match(byFile.get('credentials.json')?.note ?? '', /LEGACY/);
  assert.equal(byFile.get('vault.enc')?.status, 'empty');
  assert.equal(byFile.get('SHADOW.md')?.status, 'missing');
  // The canonical file set is always listed.
  for (const f of ['config.json', 'config.template.md', 'vault.enc', 'credentials.json', 'SHADOW.md', 'keybindings.json', 'egress.log', 'prompts']) {
    assert.ok(byFile.has(f), `row for ${f}`);
  }
});

test('buildLayoutPanel sizes + modes are formatted, and paths stay inside the dir', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'egress.log'), 'x'.repeat(2048));
  const rows = buildLayoutPanel(dir);
  const eg = rows.find((r) => r.file === 'egress.log')!;
  assert.equal(eg.size, '2.0 kB');
  assert.match(eg.mode, /^0[0-7]{3}$/);
  assert.ok(eg.path.startsWith(dir));
});

test('formatLayoutPanel renders header + every row, flag ✓ for present', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'config.json'), '{}');
  const out = formatLayoutPanel(dir, buildLayoutPanel(dir));
  assert.match(out, new RegExp(`${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} layout:`));
  assert.match(out, /config\.json\s+present/);
  assert.match(out, /vault\.enc\s+missing/);
});

test('fileSizeBytes: -1 for missing, real size otherwise', () => {
  const dir = tmp();
  assert.equal(fileSizeBytes(join(dir, 'nope')), -1);
  const p = join(dir, 'f');
  writeFileSync(p, 'abc');
  assert.equal(fileSizeBytes(p), 3);
});

test('a fresh install layout shows the config-init guidance', () => {
  const dir = tmp();
  const rows = buildLayoutPanel(dir);
  const cfg = rows.find((r) => r.file === 'config.json')!;
  assert.equal(cfg.status, 'missing');
  assert.match(cfg.note, /shadow config init/);
});
