import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultDenylist } from '../src/safety/denylist.js';
import { isBlockedIp } from '../src/safety/netguard.js';
import { globToRegExp } from '../src/tools/glob.js';
import { redactString, registerSecret } from '../src/util/redact.js';
import { makeMemoryTool } from '../src/tools/memory.js';
import type { ProjectMemory } from '../src/state/memory.js';

// SHADOW-EXEC-02 — rm guard covers home/absolute/glob + long flags, not just bare /
test('denylist flags recursive deletes of home/absolute/glob targets', () => {
  for (const cmd of ['rm -rf ~/', 'rm -rf ~/Documents', 'rm -rf /etc', 'rm -rf /', 'rm --recursive --force ~', 'rm -r $HOME/x', 'rm -rf *']) {
    assert.ok(defaultDenylist(cmd), `should flag: ${cmd}`);
  }
  // relative paths inside the workspace are NOT flagged (only confirmation-worthy ones are)
  for (const cmd of ['rm -rf node_modules', 'rm -rf build/', 'rm file.txt']) {
    assert.equal(defaultDenylist(cmd), null, `should allow: ${cmd}`);
  }
});

// The denylist is a FAT-FINGER catastrophic guard, not an injection detector
// (see denylist.ts header). It must not flag ordinary subshells/backticks/pipes:
// doing so blocks everyday commands, fires even at `full` autonomy, auto-denies
// in headless --task, and is trivially bypassed by removing a space anyway.
test('denylist does not flag ordinary subshells/backticks, but still catches catastrophic substrings', () => {
  for (const cmd of [
    'kill $(pgrep node)',
    'grep TODO $(git ls-files)',
    'echo `date`',
    'curl -s https://api.example.com | jq .',
  ]) {
    assert.equal(defaultDenylist(cmd), null, `should NOT flag benign: ${cmd}`);
  }
  // A catastrophic command stays caught even when wrapped in a subshell, because
  // the denylist scans the whole command string.
  for (const cmd of ['rm -rf ~', 'grep x $(rm -rf ~)', 'mkfs.ext4 /dev/sda']) {
    assert.ok(defaultDenylist(cmd), `should still flag catastrophic: ${cmd}`);
  }
});

// ssrf-ipv6-mapped-bypass — hex/mapped IPv6 forms must resolve to blocked
test('netguard blocks IPv6 loopback/link-local/unique-local and hex IPv4-mapped', () => {
  for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '64:ff9b::7f00:1']) {
    assert.ok(isBlockedIp(ip), `should block: ${ip}`);
  }
  // public addresses still allowed
  assert.equal(isBlockedIp('2606:4700:4700::1111'), false);
  assert.equal(isBlockedIp('::ffff:8.8.8.8'), false);
});

// SASSY-PI-01 — globToRegExp can't ReDoS
test('globToRegExp rejects pathological wildcards and never backtracks catastrophically', () => {
  assert.throws(() => globToRegExp('*'.repeat(40)), /too complex/);
  // many ** groups compile (collapsed) and match a long non-matching string fast
  const re = globToRegExp('a' + '**/'.repeat(10) + 'b.ts');
  const t0 = Date.now();
  re.test('a' + 'x'.repeat(5000)); // no match — would hang if backtracking
  assert.ok(Date.now() - t0 < 100, 'evaluates promptly, no catastrophic backtracking');
});

// SECRET-01 — registered secret values are masked verbatim (covers credentials-store keys)
test('redactString masks registered secrets and connection-string passwords', () => {
  registerSecret('ollama-cred-7f3a91bc');
  assert.match(redactString('Authorization failed for ollama-cred-7f3a91bc on host'), /\[REDACTED\]/);
  assert.doesNotMatch(redactString('Authorization failed for ollama-cred-7f3a91bc'), /ollama-cred-7f3a91bc/);
  assert.match(redactString('postgres://user:hunter2secret@db.host/x'), /user:\[REDACTED\]@/);
});

// SASSY-PI-02 — memory mutations are gated as writes
test('memory tool is risk:write so remember/forget pass the write gate', () => {
  const tool = makeMemoryTool({} as unknown as ProjectMemory);
  assert.equal(tool.risk, 'write');
});
