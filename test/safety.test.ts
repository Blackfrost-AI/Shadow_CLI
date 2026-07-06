import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDenylist, defaultDenylist } from '../src/safety/denylist.js';
import { isBlockedIp, assertUrlAllowed } from '../src/safety/netguard.js';
import { AgentLoop, type LoopDeps } from '../src/agent/loop.js';
import { Budget } from '../src/agent/budget.js';
import { Context } from '../src/agent/context.js';
import { EventBus, type LoopEvent } from '../src/agent/events.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/index.js';
import { ScriptedApprovalGate } from '../src/agent/approval.js';
import { MockProvider } from '../src/provider/mock.js';
import type { ToolCall } from '../src/provider/provider.js';

test('denylist flags catastrophic commands and allows ordinary ones', () => {
  assert.ok(defaultDenylist('rm -rf /'));
  assert.ok(defaultDenylist('rm -rf ~'));
  assert.ok(defaultDenylist('sudo rm -rf /*'));
  assert.ok(defaultDenylist('mkfs.ext4 /dev/sda1'));
  assert.ok(defaultDenylist('dd if=/dev/zero of=/dev/sda bs=1M'));
  assert.ok(defaultDenylist(':(){ :|:& };:'));
  assert.ok(defaultDenylist('chmod -R 777 /'));

  assert.equal(defaultDenylist('rm -rf ./build'), null);
  assert.equal(defaultDenylist('rm -rf node_modules'), null);
  assert.equal(defaultDenylist('ls -la /etc'), null);
  assert.equal(defaultDenylist('npm test'), null);
});

test('denylist honors configured extra patterns', () => {
  const dl = makeDenylist(['shadow-test-sentinel']);
  assert.ok(dl('echo shadow-test-sentinel'));
  assert.equal(dl('echo hello'), null);
});

test('netguard blocks loopback / private / link-local / metadata IPs', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.5.5', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fe80::1', 'fd00::1']) {
    assert.equal(isBlockedIp(ip), true, `${ip} should be blocked`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.113.10']) {
    assert.equal(isBlockedIp(ip), false, `${ip} should be allowed`);
  }
});

test('netguard rejects bad schemes, localhost, and metadata; allows a public literal IP', async () => {
  await assert.rejects(() => assertUrlAllowed('file:///etc/passwd'), /scheme/);
  await assert.rejects(() => assertUrlAllowed('ftp://example.com/x'), /scheme/);
  await assert.rejects(() => assertUrlAllowed('http://localhost/admin'), /blocked address/);
  await assert.rejects(() => assertUrlAllowed('http://169.254.169.254/latest/meta-data'), /blocked address/);
  const { url, ips } = await assertUrlAllowed('http://1.1.1.1/');
  assert.equal(url.hostname, '1.1.1.1');
  assert.deepEqual(ips, ['1.1.1.1'], 'returns the validated IP(s) for connection pinning');
});

test('a denylisted shell command is confirmed even at `full` autonomy (no silent execution)', async () => {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry);

  const denylist = makeDenylist(['shadow-test-sentinel']);
  const forceConfirm = (call: ToolCall): string | null => {
    if (call.name !== 'run_shell') return null;
    const input = call.input as { command?: unknown } | undefined;
    const command = typeof input?.command === 'string' ? input.command : '';
    const why = denylist(command);
    return why ? `denylisted: ${why}` : null;
  };

  const provider = new MockProvider([
    [
      {
        type: 'tool_call',
        // harmless even if it somehow ran; matches the configured sentinel
        call: { id: 's1', name: 'run_shell', input: { command: 'echo shadow-test-sentinel' } },
      },
      { type: 'done', stopReason: 'tool_use' },
    ],
    [{ type: 'text', delta: 'aborted as requested.' }, { type: 'done', stopReason: 'end_turn' }],
  ]);

  const bus = new EventBus();
  const events: LoopEvent[] = [];
  bus.on((e) => events.push(e));

  const deps: LoopDeps = {
    provider,
    registry,
    gate: new ScriptedApprovalGate(['deny']),
    bus,
    budget: new Budget({ maxIterations: 25 }, 'mock', { mock: { input: 1, output: 1 } }, Date.now()),
    context: (() => {
      const c = new Context({ contextBudget: 1e6, triggerRatio: 0.75, keepLastTurns: 6 });
      c.pinTask({ role: 'user', content: [{ type: 'text', text: 'run the sentinel' }] });
      return c;
    })(),
    signal: new AbortController().signal,
    model: 'mock',
    system: 'test',
    maxOutputTokens: 1024,
    workspaceRoot: process.cwd(),
    dryRun: false,
    maxToolResultChars: 16384,
    contextBudget: 1e6,
    forceConfirm,
  };

  // `full` autonomy would normally auto-run exec — forceConfirm must still gate it.
  const res = await new AgentLoop(deps, 'full').run();
  assert.ok(events.some((e) => e.type === 'tool_denied'), 'denylisted command was gated and denied');
  assert.equal(res.finalAnswer, 'aborted as requested.');
});
