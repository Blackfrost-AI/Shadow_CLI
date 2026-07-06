import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactString } from '../src/util/redact.js';
import { isLocalHost } from '../src/safety/offline.js';
import { isBashReadOnly } from '../src/safety/bashReadOnly.js';
import { supportsAdaptiveThinking } from '../src/provider/anthropic.js';
import { defaultDenylist } from '../src/safety/denylist.js';
import { isBlockedIp } from '../src/safety/netguard.js';
import { BgRegistry } from '../src/tools/bgShell.js';
import { readFile } from '../src/tools/readFile.js';
import { applyHunks } from '../src/tools/applyPatch.js';
import { parseRetryAfter } from '../src/provider/stream.js';

test('applyHunks preserves the file EOL (CRLF stays CRLF; added lines are not LF)', () => {
  const hunk = {
    lines: [
      { type: 'context', text: 'a' },
      { type: 'remove', text: 'b' },
      { type: 'add', text: 'B' },
      { type: 'context', text: 'c' },
    ],
  };
  const crlf = applyHunks('a\r\nb\r\nc\r\n', [hunk as never]);
  assert.ok(crlf.ok);
  assert.equal((crlf as { content: string }).content, 'a\r\nB\r\nc\r\n', 'all lines including the added one are CRLF');
  assert.ok(!/[^\r]\n/.test((crlf as { content: string }).content), 'no bare LF remains in a CRLF file');
  const lf = applyHunks('a\nb\nc\n', [hunk as never]);
  assert.ok(lf.ok);
  assert.equal((lf as { content: string }).content, 'a\nB\nc\n', 'an LF file stays LF');
});

test('parseRetryAfter handles delta-seconds and HTTP-dates', () => {
  assert.equal(parseRetryAfter('5'), 5000);
  assert.equal(parseRetryAfter('0'), 0);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter('not-a-date'), undefined);
  assert.equal(parseRetryAfter('Wed, 01 Jan 2020 00:00:00 GMT'), 0, 'a past date clamps to 0, never negative');
});
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('netguard decodes 6to4 / Teredo IPv6 wrappers hiding loopback/metadata IPv4', () => {
  assert.equal(isBlockedIp('2002:7f00:1::'), true, '6to4 wrapping 127.0.0.1 is blocked');
  assert.equal(isBlockedIp('2002:a9fe:a9fe::'), true, '6to4 wrapping 169.254.169.254 (metadata) is blocked');
  assert.equal(isBlockedIp('2001:0:0:0:0:0:80ff:fffe'), true, 'Teredo wrapping 127.0.0.1 is blocked');
  // a real public IPv6 (Google DNS) must NOT be misread as Teredo (b[2] != 0) and stays allowed
  assert.equal(isBlockedIp('2001:4860:4860::8888'), false, 'real public IPv6 is not falsely blocked');
  assert.equal(isBlockedIp('2606:4700::1111'), false, 'Cloudflare IPv6 allowed');
});

test('BgRegistry evicts the oldest FINISHED background shells past the cap', () => {
  const bg = new BgRegistry();
  const mk = () => {
    const c = new EventEmitter() as unknown as { stdout: EventEmitter; stderr: EventEmitter; pid: number; kill: () => void } & EventEmitter;
    (c as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
    (c as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
    (c as unknown as { pid: number }).pid = 111;
    (c as unknown as { kill: () => void }).kill = () => {};
    return c;
  };
  for (let i = 0; i < 150; i++) {
    const child = mk();
    bg.add('cmd', child as never);
    (child as EventEmitter).emit('close', 0, null); // finish it so it becomes evictable
  }
  assert.equal(bg.get('bash_1'), undefined, 'the oldest finished shell was evicted');
  assert.ok(bg.get('bash_150'), 'the newest shell is retained');
  assert.ok(bg.get('bash_51'), 'the cap keeps the most-recent ~100');
});

test('read_file reports accurate totalLines (no phantom trailing line)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-'));
  try {
    writeFileSync(join(dir, 'trail.txt'), 'a\nb\n'); // trailing newline
    writeFileSync(join(dir, 'notrail.txt'), 'a\nb\nc'); // no trailing newline
    const ctx = { workspaceRoot: dir, additionalRoots: [] } as never;
    const r1 = await readFile.run({ path: 'trail.txt' }, ctx);
    assert.equal(r1.data!.totalLines, 2, '"a\\nb\\n" is 2 lines, not 3');
    const r2 = await readFile.run({ path: 'notrail.txt' }, ctx);
    assert.equal(r2.data!.totalLines, 3, '"a\\nb\\nc" is 3 lines');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('denylist sees through quoted danger targets (rm -rf "/" bypass)', () => {
  // the bypass the audit found — must now be caught
  assert.ok(defaultDenylist('rm -rf "/"'), 'rm -rf "/" is dangerous');
  assert.ok(defaultDenylist("rm -rf '/'"), "rm -rf '/' is dangerous");
  assert.ok(defaultDenylist('rm -rf "/etc"'), 'rm -rf "/etc" is dangerous');
  assert.ok(defaultDenylist('rm -rf /'), 'unquoted still caught');
  // benign relative deletes inside the workspace are NOT flagged
  assert.equal(defaultDenylist('rm -rf build'), null);
  assert.equal(defaultDenylist('rm -rf "my dir"'), null, 'quoted relative path is not a danger target');
});

test('redactString masks GitHub / Slack / Google / GitLab / OpenRouter / Stripe / AWS-STS tokens', () => {
  const cases = [
    'ghp_' + 'a'.repeat(36),
    'github_pat_' + 'A1'.repeat(20),
    'xoxb-' + '1234567890-abcdefghij',
    'AIza' + 'B'.repeat(35),
    'glpat-' + 'x'.repeat(20),
    'sk-or-v1-' + 'c'.repeat(40),
    'sk_live_' + 'd'.repeat(24),
    'ASIA' + 'ABCDEFGHIJKLMNOP',
  ];
  for (const secret of cases) {
    assert.match(redactString(`token=${secret} done`), /\[REDACTED\]/, `should mask ${secret.slice(0, 8)}…`);
    assert.ok(!redactString(`token=${secret}`).includes(secret), `raw ${secret.slice(0, 8)}… must not survive`);
  }
});

test('isLocalHost validates real IPs and rejects look-alike public hostnames', () => {
  // genuinely local
  for (const h of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.10', '172.16.0.1', '172.31.255.1', 'box.local', '::1']) {
    assert.equal(isLocalHost(h), true, `${h} is local`);
  }
  // the attack: a public hostname that merely starts with a private-range prefix
  for (const h of ['127.0.0.1.evil.com', '10.0.0.1.attacker.net', '192.168.1.1.evil.com', '172.16.0.1.evil.com', 'evil.com', '8.8.8.8', 'api.example.com']) {
    assert.equal(isLocalHost(h), false, `${h} must NOT be treated as local`);
  }
});

test('isBashReadOnly rejects output redirection and ref-mutating git branch flags', () => {
  // read-only stays read-only
  assert.equal(isBashReadOnly('git status'), true);
  assert.equal(isBashReadOnly('cat file.txt'), true);
  assert.equal(isBashReadOnly('grep -r foo src'), true);
  assert.equal(isBashReadOnly('git branch'), true, 'listing branches is read-only');
  assert.equal(isBashReadOnly('git branch --list'), true);
  // writes must NOT be auto-allowed
  assert.equal(isBashReadOnly('echo secret > important.txt'), false, 'output redirect overwrites a file');
  assert.equal(isBashReadOnly('cat a >> b'), false, 'append redirect writes a file');
  assert.equal(isBashReadOnly('ls &> out.log'), false, '&> redirect writes a file');
  assert.equal(isBashReadOnly('git branch -D main'), false, 'force-delete a branch');
  assert.equal(isBashReadOnly('git branch -m old new'), false, 'rename a branch');
  assert.equal(isBashReadOnly('git branch -f main HEAD~3'), false, 'force-move a ref');
});

test('supportsAdaptiveThinking: 4.6+ minor versions yes, date-suffixed GA snapshots no', () => {
  assert.equal(supportsAdaptiveThinking('claude-opus-4-8'), true);
  assert.equal(supportsAdaptiveThinking('claude-sonnet-4-6'), true);
  assert.equal(supportsAdaptiveThinking('claude-fable-5'), true);
  // older minors
  assert.equal(supportsAdaptiveThinking('claude-sonnet-4-5'), false);
  assert.equal(supportsAdaptiveThinking('claude-haiku-4-5'), false);
  // date-suffixed GA snapshot ids (Opus/Sonnet 4.0) must NOT be read as gen 20250514
  assert.equal(supportsAdaptiveThinking('claude-opus-4-20250514'), false);
  assert.equal(supportsAdaptiveThinking('claude-sonnet-4-20250514'), false);
});
