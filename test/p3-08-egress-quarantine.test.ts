import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  quarantineVerdict,
  hostMatchesEntry,
  setEgressPolicy,
  resetEgressPolicyForTests,
  EGRESS_DERIVED_ALLOW,
  shadowFetch,
  setEgressLogPathForTests,
  flushEgressLogForTests,
  setOfflineMode,
  closeAgentsForTests,
  readEgressLogAggregate,
  egressSummary,
} from '../src/safety/egress.js';
import { wrapMcpArgv, wrapCommand } from '../src/safety/sandbox.js';
import { loadConfig } from '../src/config.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// Isolate the receipt file BEFORE anything records — tests must never touch the real ~/.shadow/egress.log.
const tmp = mkdtempSync(join(tmpdir(), 'shadow-p308-test-'));
setEgressLogPathForTests(join(tmp, 'egress.log'));

const servers: Array<{ close: () => Promise<void>; raw: Server }> = [];
function startLocalServer(): Promise<{ port: number }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    server.listen(0, '127.0.0.1', () => {
      servers.push({ raw: server, close: () => new Promise((r) => server.close(() => r())) });
      resolve({ port: (server.address() as AddressInfo).port });
    });
  });
}

after(async () => {
  resetEgressPolicyForTests();
  setOfflineMode(false);
  await flushEgressLogForTests();
  await closeAgentsForTests();
  for (const s of servers) {
    s.raw.closeAllConnections?.();
    await s.close();
  }
  rmSync(tmp, { recursive: true, force: true });
});

function summaryFor(host: string) {
  return egressSummary().find((r) => r.host === host);
}

// ── hostMatchesEntry — the matching primitive ────────────────────────────────

test('hostMatchesEntry: exact entry matches the apex, case-insensitively', () => {
  assert.equal(hostMatchesEntry('example.com', 'example.com'), true);
  assert.equal(hostMatchesEntry('Example.COM', 'example.com'), true);
  assert.equal(hostMatchesEntry('example.com', 'EXAMPLE.COM'), true);
  assert.equal(hostMatchesEntry('other.com', 'example.com'), false);
});

test('hostMatchesEntry: "*.x.com" matches any subdomain depth but NOT the apex', () => {
  assert.equal(hostMatchesEntry('a.x.com', '*.x.com'), true);
  assert.equal(hostMatchesEntry('a.b.x.com', '*.x.com'), true);
  // The apex itself is NOT a subdomain — a wildcard grant must not silently cover x.com.
  assert.equal(hostMatchesEntry('x.com', '*.x.com'), false);
  // Suffix-trap shapes: the match is on a label boundary, not a string suffix.
  assert.equal(hostMatchesEntry('notx.com', '*.x.com'), false);
  assert.equal(hostMatchesEntry('x.com.evil.com', '*.x.com'), false);
});

test('hostMatchesEntry: normalization — trailing dots and port-bearing entries never silently mis-match', () => {
  // "example.com." is a legal URL.hostname form for the same apex — the model can author it.
  assert.equal(hostMatchesEntry('example.com.', 'example.com'), true);
  assert.equal(hostMatchesEntry('a.x.com.', '*.x.com'), true);
  assert.equal(hostMatchesEntry('example.com', 'example.com.'), true);
  // An entry with a port is host-matched (the receipt host key is port-free).
  assert.equal(hostMatchesEntry('example.com', 'example.com:443'), true);
  assert.equal(hostMatchesEntry('a.x.com', '*.x.com:443'), true);
  // Bare IPv6 stays intact — the port-strip must not eat address colons.
  assert.equal(hostMatchesEntry('::1', '[::1]'), true);
  assert.equal(hostMatchesEntry('::1', '::1'), true);
});

test('hostMatchesEntry: a bare wildcard admits NOTHING (a "*." typo must not become a universal grant)', () => {
  assert.equal(hostMatchesEntry('anything.com.', '*.'), false);
  assert.equal(hostMatchesEntry('anything.com', '*.'), false);
  assert.equal(hostMatchesEntry('anything.com', '*'), false);
});

// ── quarantineVerdict — pure decision, no I/O ────────────────────────────────

test('quarantineVerdict: non-tool purposes are NEVER quarantined (provider/mcp/dispatch traffic is operator-addressed)', () => {
  setEgressPolicy({ mode: 'enforce', allow: [] });
  try {
    for (const purpose of ['provider', 'provider-count', 'mcp', 'oauth', 'vision', 'local-probe', 'update-check', 'update-binary', 'plugin-index', 'plugin-clone', 'dispatch']) {
      assert.equal(quarantineVerdict('anything.example', purpose), 'ok', `${purpose} must bypass quarantine`);
    }
  } finally {
    resetEgressPolicyForTests();
  }
});

test('quarantineVerdict: tool purposes miss the allowlist → flag in observe, deny in enforce', () => {
  try {
    setEgressPolicy({ mode: 'observe', allow: [] });
    assert.equal(quarantineVerdict('stranger.example', 'web'), 'flag');
    assert.equal(quarantineVerdict('stranger.example', 'search'), 'flag');
    assert.equal(quarantineVerdict('stranger.example', 'image'), 'flag');
    setEgressPolicy({ mode: 'enforce', allow: [] });
    assert.equal(quarantineVerdict('stranger.example', 'web'), 'deny');
    assert.equal(quarantineVerdict('stranger.example', 'search'), 'deny');
  } finally {
    resetEgressPolicyForTests();
  }
});

test('quarantineVerdict: the derived DuckDuckGo allowlist admits web/search even in enforce with an empty config', () => {
  setEgressPolicy({ mode: 'enforce', allow: [] });
  try {
    assert.deepEqual([...EGRESS_DERIVED_ALLOW], ['duckduckgo.com', '*.duckduckgo.com']);
    assert.equal(quarantineVerdict('duckduckgo.com', 'search'), 'ok');
    assert.equal(quarantineVerdict('html.duckduckgo.com', 'search'), 'ok');
    assert.equal(quarantineVerdict('duckduckgo.com', 'web'), 'ok');
  } finally {
    resetEgressPolicyForTests();
  }
});

test('quarantineVerdict: config allow entries admit hosts; wildcards stay subdomain-only', () => {
  setEgressPolicy({ mode: 'enforce', allow: ['example.com', '*.docs.example.com'] });
  try {
    assert.equal(quarantineVerdict('example.com', 'web'), 'ok');
    assert.equal(quarantineVerdict('a.docs.example.com', 'web'), 'ok');
    assert.equal(quarantineVerdict('docs.example.com', 'web'), 'deny', 'wildcard does not cover the subdomain apex itself');
    assert.equal(quarantineVerdict('sub.example.com', 'web'), 'deny', 'exact entry does not widen to subdomains');
  } finally {
    resetEgressPolicyForTests();
  }
});

test('setEgressPolicy normalizes: unknown/missing mode coerces to observe; allow is copied', () => {
  const allow = ['x.com'];
  setEgressPolicy({ mode: 'bogus' as unknown as 'observe', allow });
  try {
    allow.push('y.com'); // mutating the caller's array must not mutate the policy
    assert.equal(quarantineVerdict('y.com', 'web'), 'flag', 'observe (coerced), y.com never entered the policy');
    assert.equal(quarantineVerdict('x.com', 'web'), 'ok');
  } finally {
    resetEgressPolicyForTests();
  }
});

// ── shadowFetch integration — quarantine fires inside the broker ─────────────

test('quarantine observe: a tool fetch outside the allowlist PROCEEDS but is flagged ⚑ in the receipt', async () => {
  const srv = await startLocalServer();
  const before = summaryFor('127.0.0.1')?.flagged ?? 0;
  setEgressPolicy({ mode: 'observe', allow: [] });
  try {
    // origin:'user' keeps netguard at the metadata-only tier (loopback admitted) so the QUARANTINE
    // step is what we're exercising; the purpose is what selects quarantine ('web' = model-authored URL).
    const res = await shadowFetch(`http://127.0.0.1:${srv.port}/q`, {}, { purpose: 'web', origin: 'user' });
    assert.equal(res.status, 200);
    await res.text();
    const s = summaryFor('127.0.0.1');
    assert.ok(s && s.allowed >= 1, 'the fetch proceeded (observe never blocks)');
    assert.equal(s!.flagged, before + 1, 'one new quarantine flag recorded');

    // The flag also lands on DISK (what `shadow egress` / doctor read).
    await flushEgressLogForTests();
    const rows = await readEgressLogAggregate();
    const row = rows.find((r) => r.host === '127.0.0.1');
    assert.ok(row && row.flagged >= 1, 'disk aggregate carries the quarantine flag');
  } finally {
    resetEgressPolicyForTests();
  }
});

test('quarantine: a host ON the allowlist is not flagged', async () => {
  const srv = await startLocalServer();
  setEgressPolicy({ mode: 'enforce', allow: ['127.0.0.1'] });
  try {
    const before = summaryFor('127.0.0.1')?.flagged ?? 0;
    const res = await shadowFetch(`http://127.0.0.1:${srv.port}/ok`, {}, { purpose: 'web', origin: 'user' });
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(summaryFor('127.0.0.1')!.flagged, before, 'allowlisted host adds no flag — even under enforce');
  } finally {
    resetEgressPolicyForTests();
  }
});

test('quarantine enforce: a tool fetch outside the allowlist is DENIED with a readable, actionable error', async () => {
  setEgressPolicy({ mode: 'enforce', allow: [] });
  try {
    const before = summaryFor('127.0.0.1')?.denied ?? 0;
    await assert.rejects(
      () => shadowFetch('http://127.0.0.1:1/q', {}, { purpose: 'web', origin: 'user' }),
      (err: Error) =>
        /egress quarantine/.test(err.message) &&
        /not on the egress allowlist/.test(err.message) &&
        /egress\.mode='enforce'/.test(err.message) &&
        /egress.*allow/.test(err.message),
      'error names the host, the mode, and how to admit it',
    );
    const s = summaryFor('127.0.0.1');
    assert.ok(s && s.denied >= before + 1, 'the quarantine deny is recorded in the receipt');
  } finally {
    resetEgressPolicyForTests();
  }
});

// ── Config trust — the allowlist is GLOBAL-only ──────────────────────────────

test('project-file "egress" is stripped as untrusted (a repo cannot widen or enforce its own egress)', () => {
  const ws = mkdtempSync(join(tmpdir(), 'p308cfg-'));
  try {
    writeFileSync(
      join(ws, 'shadow.config.json'),
      JSON.stringify({ egress: { mode: 'enforce', allow: ['evil.example', '*.evil.example'] } }),
    );
    const cfg = loadConfig(ws);
    // PROJECT_UNTRUSTED_KEYS drops the key; the schema default takes over.
    assert.equal(cfg.egress.mode, 'observe', 'project enforce mode must not survive');
    assert.deepEqual(cfg.egress.allow, [], 'project allowlist entries must not survive');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('config schema: egress defaults to observe + empty allow; bad mode rejected', () => {
  const ws = mkdtempSync(join(tmpdir(), 'p308cfg2-'));
  try {
    writeFileSync(join(ws, 'shadow.config.json'), JSON.stringify({}));
    const cfg = loadConfig(ws);
    assert.deepEqual(cfg.egress, { mode: 'observe', allow: [] });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── Phase 3: MCP stdio confinement (wrapMcpArgv) ─────────────────────────────

test('wrapMcpArgv: enabled=false passes argv through untouched (no jail)', () => {
  const r = wrapMcpArgv({
    command: 'node',
    args: ['server.js', '--port', '0'],
    workspaceRoot: tmp,
    allowNetwork: false,
    enabled: false,
  });
  assert.deepEqual(r.argv, ['node', 'server.js', '--port', '0']);
  assert.equal(r.sandboxed, false);
  assert.equal(r.note, undefined);
});

test('wrapMcpArgv: confined argv wraps the exact [command, ...args] tail (no shell layer)', () => {
  if (platform() === 'win32') return; // no OS sandbox on Windows — covered by the passthrough note test
  const r = wrapMcpArgv({
    command: 'node',
    args: ['server.js', '--flag'],
    workspaceRoot: tmp,
    allowNetwork: false,
    enabled: true,
  });
  if (!r.sandboxed) return; // host has no sandbox tool — the unconfined-honesty path, tested elsewhere
  assert.deepEqual(r.argv.slice(-3), ['node', 'server.js', '--flag'], 'argv tail is the untouched MCP argv');
  if (platform() === 'darwin') {
    assert.equal(r.argv[0], 'sandbox-exec');
    const profileIdx = r.argv.indexOf('-p');
    assert.ok(profileIdx > 0, 'seatbelt profile is passed via -p');
    const profile = r.argv[profileIdx + 1]!;
    assert.match(profile, /\(deny network\*\)/, 'network OFF by default for a stdio child');
    assert.match(profile, /\(deny file-read\* \(subpath \(param "SD"\)\)\)/, '~/.shadow stays unreadable from the child');
    // AF_UNIX hardening: `(deny network*)` covers INET only — agent sockets under tmp are denied
    // separately. SBPL has no `glob` matcher (profile would fail to compile) — regex is used.
    assert.match(profile, /\(deny file-write\* \(regex "\^\/private\/tmp\/com\\\.apple\\\.launchd/, 'launchd sockets denied');
    assert.match(profile, /\(deny file-write\* \(regex "\^\/private\/tmp\/ssh-/, 'ssh-agent sockets denied');
  } else {
    assert.equal(r.argv[0], 'bwrap');
    assert.ok(r.argv.includes('--unshare-net'), 'bwrap: network namespace off by default');
    assert.ok(r.argv.includes('--unshare-pid'), 'bwrap: pid namespace (no /proc environ read of the agent)');
    // AF_UNIX hardening: the child gets a PRIVATE /tmp (host /tmp carries ssh-agent sockets).
    const tmpIdx = r.argv.indexOf('/tmp');
    assert.ok(tmpIdx > 0 && r.argv[tmpIdx - 1] === '--tmpfs', 'bwrap: private tmpfs /tmp for MCP children');
  }
});

test('run_shell jail is UNCHANGED by the MCP hardening (no socket denies, host /tmp bind intact)', () => {
  if (platform() === 'win32') return;
  const r = wrapCommand({ command: 'true', workspaceRoot: tmp, allowNetwork: false, enabled: true });
  if (!r.sandboxed) return;
  if (platform() === 'darwin') {
    const profile = r.argv[r.argv.indexOf('-p') + 1]!;
    assert.doesNotMatch(profile, /com\.apple\.launchd/, 'run_shell keeps its pre-P3-08 profile shape');
  } else {
    const tmpIdx = r.argv.indexOf('/tmp');
    assert.ok(tmpIdx > 0 && r.argv[tmpIdx - 1] === '--bind', 'run_shell keeps the host /tmp bind');
  }
});

test('wrapMcpArgv: network:true grant removes ONLY the network deny (the rest of the jail holds)', () => {
  if (platform() === 'win32') return;
  const r = wrapMcpArgv({
    command: 'node',
    args: [],
    workspaceRoot: tmp,
    allowNetwork: true,
    enabled: true,
  });
  if (!r.sandboxed) return;
  if (platform() === 'darwin') {
    const profile = r.argv[r.argv.indexOf('-p') + 1]!;
    assert.doesNotMatch(profile, /\(deny network\*\)/, 'network granted → no network deny');
    assert.match(profile, /\(deny file-write\*\)/, 'write jail stays intact when network is granted');
  } else {
    assert.ok(!r.argv.includes('--unshare-net'));
    assert.ok(r.argv.includes('--unshare-pid'));
  }
});

// ── Structural pins — the wiring cannot silently regress ─────────────────────

test('structural: MCP spawn routes through wrapMcpArgv and carries the jail knobs', () => {
  const client = readFileSync(join(repoRoot, 'src/mcp/client.ts'), 'utf8');
  assert.match(client, /import { wrapMcpArgv } from '\.\.\/safety\/sandbox\.js'/, 'client imports the MCP jail wrapper');
  assert.match(client, /const wrapped = wrapMcpArgv\(\{/, 'start() wraps the spawn');
  assert.match(client, /spawn\(wrapped\.argv\[0\]!, wrapped\.argv\.slice\(1\)/, 'the child is spawned from the WRAPPED argv');
  assert.match(client, /network\?: boolean/, 'per-server network grant exists');
  assert.match(client, /sandbox\?: boolean/, 'per-server sandbox opt-out exists');
  assert.match(client, /cfg\.sandbox !== false/, 'sandbox:false is honored as an explicit opt-out');
  assert.match(client, /Boolean\(this\.cfg\.network\)/, 'allowNetwork comes from the server config, default off');
});

test('structural: the Playwright browser preset opts out explicitly (network:true + sandbox:false), never silently', () => {
  const manage = readFileSync(join(repoRoot, 'src/mcp/manage.ts'), 'utf8');
  assert.match(manage, /network: true,\s*sandbox: false/, 'preset stamps both grants');
});

test('mcpServerLines: the confinement row reports the EFFECTIVE jail state, never just the config', async () => {
  const { mcpServerLines } = await import('../src/mcp/manage.js');
  const server = { command: 'node', args: ['s.js'] };
  assert.match(
    mcpServerLines('s', { ...server, sandbox: false }).join('\n'),
    /OFF \(explicit sandbox:false\)/,
    'explicit opt-out says OFF',
  );
  assert.match(
    mcpServerLines('s', server, { requested: true, toolAvailable: true }).join('\n'),
    /OS jail, network off/,
  );
  const offSession = mcpServerLines('s', server, { requested: false, toolAvailable: true }).join('\n');
  assert.match(offSession, /REQUESTED but sandbox OFF this session/);
  assert.match(offSession, /UNCONFINED/, 'an unconfined child must be SAID unconfined');
  const noTool = mcpServerLines('s', server, { requested: true, toolAvailable: false }).join('\n');
  assert.match(noTool, /no OS sandbox tool on this host/);
  assert.match(noTool, /UNCONFINED/);
});

test('structural: /mcp get passes the effective jail state into the display row', () => {
  const slash = readFileSync(join(repoRoot, 'src/tui/slash.ts'), 'utf8');
  assert.match(slash, /mcpServerLines\(name, server, \{/);
  assert.match(slash, /toolAvailable: sandboxToolAvailable\(\)/);
});

test('structural: egress is a project-untrusted config key (global-only quarantine)', () => {
  const config = readFileSync(join(repoRoot, 'src/config.ts'), 'utf8');
  const line = config.split('\n').find((l) => l.startsWith('const PROJECT_UNTRUSTED_KEYS'))!;
  assert.match(line, /'egress'/);
});

test('structural: bootstrap wires cfg.egress into the broker and passes the MCP jail', () => {
  const bootstrap = readFileSync(join(repoRoot, 'src/agent/bootstrap.ts'), 'utf8');
  assert.match(bootstrap, /setEgressPolicy\(cfg\.egress/, 'config egress reaches the broker at startup');
  assert.match(bootstrap, /failurePolicy: cfg\.sandboxFailurePolicy/, 'MCP jail inherits the failure policy');
  const index = readFileSync(join(repoRoot, 'src/index.ts'), 'utf8');
  assert.match(index, /failurePolicy: cfg\.sandboxFailurePolicy/, 'both registration sites pass the policy');
});

test('structural: fail-closed extends to MCP children — an unjailable child is refused, never silently unconfined', () => {
  const client = readFileSync(join(repoRoot, 'src/mcp/client.ts'), 'utf8');
  assert.match(client, /failurePolicy\?: 'auto' \| 'fail-closed' \| 'warn'/, 'McpJail carries the policy');
  assert.match(client, /refusing to start UNCONFINED/, 'the fail-closed refusal exists');
  assert.match(client, /if \(this\.jail\?\.failurePolicy === 'fail-closed'\)/);
});

test('structural: netguard tier forces redirect:manual even when a caller asks for follow', () => {
  const egress = readFileSync(join(repoRoot, 'src/safety/egress.ts'), 'utf8');
  // The chokepoint invariant (every hop re-enters the broker) must not depend on caller convention.
  assert.match(egress, /init\?\.redirect !== 'manual'/);
  assert.doesNotMatch(egress, /ssrf === 'netguard' && !opts\?\.pinnedIps && !init\?\.redirect/, 'the old opt-in-only forcing is gone');
});

test('structural: doctor --privacy carries the runtime egress receipt', () => {
  const privacy = readFileSync(join(repoRoot, 'src/doctor/privacy.ts'), 'utf8');
  assert.match(privacy, /receipt\?: string\[\]/, 'PrivacyReport has the receipt field');
  assert.match(privacy, /Egress receipt/, 'the formatter renders it');
  const index = readFileSync(join(repoRoot, 'src/index.ts'), 'utf8');
  assert.match(index, /readEgressLogAggregate/, 'doctor aggregates the journal from disk');
  assert.match(index, /report\.receipt = /, 'doctor fills the receipt');
});
