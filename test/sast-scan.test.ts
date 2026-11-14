// F4 — sast_scan semgrep bridge. A fake `semgrep` shim is injected on PATH (no real
// scanner needed): it records its argv/env and emits canned SARIF. Tests pin the
// privacy contract (metrics off, registry opt-in), honest missing-binary failure,
// SARIF artifact + counts, and the evidence-store import round-trip.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sastScan, __resetSemgrepProbeForTests } from '../src/tools/sastScan.js';
import { EvidenceStore } from '../src/security/evidence.js';

function ctxFor(ws: string) {
  return { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false };
}
function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'shadow-f4-'));
}

const CANNED_SARIF = {
  version: '2.1.0',
  $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
  runs: [
    {
      tool: { driver: { name: 'semgrep', version: '1.0.0-fake' } },
      results: [
        {
          ruleId: 'fake.sql-injection',
          level: 'error',
          message: { text: 'Possible SQL injection' },
          locations: [{ physicalLocation: { artifactLocation: { uri: 'src/db.ts' }, region: { startLine: 10 } } }],
        },
        {
          ruleId: 'fake.hardcoded-secret',
          level: 'warning',
          message: { text: 'Hardcoded secret' },
          locations: [{ physicalLocation: { artifactLocation: { uri: 'src/config.ts' }, region: { startLine: 3 } } }],
        },
        {
          ruleId: 'fake.info',
          level: 'note',
          message: { text: 'Informational' },
          locations: [{ physicalLocation: { artifactLocation: { uri: 'src/x.ts' }, region: { startLine: 1 } } }],
        },
      ],
    },
  ],
};

/**
 * Install a fake semgrep on PATH. It writes its argv + selected env to a capture
 * file, then emits canned SARIF to the path given by --output. Returns the bin dir
 * and capture path. `exitCode` lets a test simulate scanner failure.
 */
function installFakeSemgrep(dir: string, opts: { exitCode?: number; sarif?: unknown } = {}): { binDir: string; capture: string } {
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const capture = join(dir, 'semgrep-capture.json');
  const sarifJson = JSON.stringify(opts.sarif ?? CANNED_SARIF).replace(/'/g, "'\\''");
  const exitCode = opts.exitCode ?? 1; // semgrep exits 1 when findings exist
  // Node-based shim so it runs on any platform with node on PATH.
  const shim = `#!/usr/bin/env node
const fs = require('fs');
const argv = process.argv.slice(2);
const capture = ${JSON.stringify(capture)};
fs.writeFileSync(capture, JSON.stringify({
  argv,
  metrics: process.env.SEMGREP_SEND_METRICS,
  versionCheck: process.env.SEMGREP_ENABLE_VERSION_CHECK,
}));
if (argv.includes('--version')) { console.log('1.0.0-fake'); process.exit(0); }
const outIdx = argv.indexOf('--output');
if (outIdx >= 0 && argv[outIdx + 1]) {
  fs.writeFileSync(argv[outIdx + 1], ${JSON.stringify(sarifJson)});
}
process.exit(${exitCode});
`;
  const shimPath = join(binDir, 'semgrep');
  writeFileSync(shimPath, shim);
  chmodSync(shimPath, 0o755);
  return { binDir, capture };
}

function withPath(binDir: string, fn: () => Promise<void>): Promise<void> {
  const prev = process.env.PATH;
  process.env.PATH = `${binDir}:${prev ?? ''}`;
  __resetSemgrepProbeForTests();
  return fn().finally(() => {
    process.env.PATH = prev;
    __resetSemgrepProbeForTests();
  });
}

test('sast_scan: check reports availability + version from the shim', async () => {
  const ws = workspace();
  const { binDir } = installFakeSemgrep(ws);
  try {
    await withPath(binDir, async () => {
      const res = await sastScan.run({ action: 'check' }, ctxFor(ws));
      assert.equal(res.ok, true);
      assert.equal(res.data!.semgrep.available, true);
      assert.equal(res.data!.semgrep.version, '1.0.0-fake');
    });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('sast_scan: scan forces metrics off, writes SARIF, counts by level', async () => {
  const ws = workspace();
  const { binDir, capture } = installFakeSemgrep(ws);
  writeFileSync(join(ws, 'rules.yaml'), 'rules: []\n');
  try {
    await withPath(binDir, async () => {
      const res = await sastScan.run({ action: 'scan', config: 'rules.yaml' }, ctxFor(ws));
      assert.equal(res.ok, true);
      const data = res.data!;
      assert.equal(data.metricsOff, true);
      assert.equal(data.registryUsed, false);
      assert.deepEqual(data.counts, { error: 1, warning: 1, note: 1, total: 3 });
      // SARIF artifact exists and is valid.
      const sarifAbs = join(ws, data.sarifPath!);
      assert.ok(existsSync(sarifAbs));
      const parsed = JSON.parse(readFileSync(sarifAbs, 'utf8'));
      assert.equal(parsed.runs[0].results.length, 3);
      // The shim captured argv + env: metrics forced off.
      const cap = JSON.parse(readFileSync(capture, 'utf8'));
      assert.equal(cap.metrics, 'off');
      assert.equal(cap.versionCheck, '0');
      assert.ok(cap.argv.includes('--metrics=off'));
      assert.ok(cap.argv.includes('--sarif'));
      assert.ok(cap.argv.includes('--disable-version-check'));
    });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('sast_scan: registry config refused without allowRegistry; allowed with it', async () => {
  const ws = workspace();
  const { binDir } = installFakeSemgrep(ws);
  try {
    await withPath(binDir, async () => {
      const denied = await sastScan.run({ action: 'scan', config: 'p/security-audit' }, ctxFor(ws));
      assert.equal(denied.ok, false);
      assert.equal(denied.error!.code, 'registry_denied');
      // With explicit opt-in the registry id is passed through (shim ignores it).
      const allowed = await sastScan.run({ action: 'scan', config: 'p/security-audit', allowRegistry: true }, ctxFor(ws));
      assert.equal(allowed.ok, true);
      assert.equal(allowed.data!.registryUsed, true);
    });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('sast_scan: missing config and missing local rules fail honestly', async () => {
  const ws = workspace();
  const { binDir } = installFakeSemgrep(ws);
  try {
    await withPath(binDir, async () => {
      const noConfig = await sastScan.run({ action: 'scan' }, ctxFor(ws));
      assert.equal(noConfig.ok, false);
      assert.equal(noConfig.error!.code, 'config_required');
      const missing = await sastScan.run({ action: 'scan', config: 'nope.yaml' }, ctxFor(ws));
      assert.equal(missing.ok, false);
      assert.equal(missing.error!.code, 'rules_missing');
    });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('sast_scan: importFindings round-trips SARIF into the evidence store', async () => {
  const ws = workspace();
  const { binDir } = installFakeSemgrep(ws);
  writeFileSync(join(ws, 'rules.yaml'), 'rules: []\n');
  try {
    await withPath(binDir, async () => {
      const res = await sastScan.run({ action: 'scan', config: 'rules.yaml', importFindings: true }, ctxFor(ws));
      assert.equal(res.ok, true);
      assert.ok(res.data!.imported);
      assert.equal(res.data!.imported!.imported, 3);
      assert.equal(res.data!.imported!.ids.length, 3);
      // Verify the store actually holds the findings.
      const store = new EvidenceStore(ws);
      try {
        const listed = store.list();
        assert.equal(listed.length, 3);
        assert.ok(listed.some((f) => f.rule === 'fake.sql-injection'));
      } finally {
        store.close();
      }
    });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('sast_scan: scanner failure (exit >1) surfaces honestly', async () => {
  const ws = workspace();
  const { binDir } = installFakeSemgrep(ws, { exitCode: 2 });
  writeFileSync(join(ws, 'rules.yaml'), 'rules: []\n');
  try {
    await withPath(binDir, async () => {
      const res = await sastScan.run({ action: 'scan', config: 'rules.yaml' }, ctxFor(ws));
      assert.equal(res.ok, false);
      assert.equal(res.error!.code, 'scan_failed');
    });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('sast_scan: jail escape on out-of-workspace target refused', async () => {
  const ws = workspace();
  const { binDir } = installFakeSemgrep(ws);
  writeFileSync(join(ws, 'rules.yaml'), 'rules: []\n');
  try {
    await withPath(binDir, async () => {
      const res = await sastScan.run({ action: 'scan', config: 'rules.yaml', target: '../../etc' }, ctxFor(ws));
      assert.equal(res.ok, false);
      assert.equal(res.error!.code, 'jail_escape');
    });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('sast_scan: risk tier is exec — a spawned scanner must be gated like run_shell/sample_run', async () => {
  // sast_scan spawns an external subprocess. It must carry the 'exec' tier so auto-edit
  // requires confirmation before launch; 'write' would auto-approve the spawn
  // (permissions.ts: auto-edit gates exec|network, auto-approves write).
  assert.equal(sastScan.risk, 'exec');
  const { needsApproval } = await import('../src/safety/permissions.js');
  assert.equal(needsApproval('exec', 'auto-edit'), true);
  assert.equal(needsApproval('exec', 'auto-read'), true);
  assert.equal(needsApproval('exec', 'manual'), true);
  assert.equal(needsApproval('exec', 'full'), false);
});