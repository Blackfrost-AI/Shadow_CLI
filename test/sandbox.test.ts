import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { wrapCommand } from '../src/safety/sandbox.js';
import { makeRunShell } from '../src/tools/runShell.js';
import type { ToolContext } from '../src/tools/types.js';

test('wrapCommand: disabled → passthrough; enabled (mac) → sandbox-exec with the workspace param', () => {
  const off = wrapCommand({ command: 'echo hi', workspaceRoot: '/tmp/ws', allowNetwork: true, enabled: false });
  assert.equal(off.sandboxed, false);
  assert.notEqual(off.argv[0], 'sandbox-exec');

  const on = wrapCommand({ command: 'echo hi', workspaceRoot: '/tmp/ws', allowNetwork: true, enabled: true });
  if (process.platform === 'darwin') {
    assert.equal(on.argv[0], 'sandbox-exec');
    assert.ok(on.argv.some((a) => a.startsWith('WS=')), 'passes the workspace as a sandbox param');
    assert.equal(on.sandboxed, true);
  }
});

test('wrapCommand binds a granted additional dir into the sandbox when enabled', () => {
  const extra = mkdtempSync(join(tmpdir(), 'extra-'));
  try {
    const r = wrapCommand({
      command: 'echo hi',
      workspaceRoot: '/tmp/ws',
      additionalRoots: [extra],
      allowNetwork: true,
      enabled: true,
    });
    if (!r.sandboxed) return; // no OS sandbox available in this env — nothing to assert
    const joined = r.argv.join(' ');
    const real = realpathSync(extra);
    assert.ok(joined.includes(extra) || joined.includes(real), 'the granted dir is referenced in the sandbox invocation');
  } finally {
    rmSync(extra, { recursive: true, force: true });
  }
});

test('run_shell sandbox confines writes to the workspace + blocks ~/.shadow reads (macOS)', async (t) => {
  if (process.platform !== 'darwin') return t.skip('seatbelt is macOS-only');
  const ws = mkdtempSync(join(tmpdir(), 'sbx-it-'));
  const escape = join(homedir(), `sbx-escape-${Date.now()}.txt`);
  const tool = makeRunShell({ sandbox: 'auto' });
  const ctx: ToolContext = {
    workspaceRoot: ws,
    signal: new AbortController().signal,
    log: () => {},
    dryRun: false,
  };
  try {
    // 1) a write INSIDE the workspace succeeds and is actually sandboxed
    const a = await tool.run({ command: `echo hi > "${ws}/in.txt"` }, ctx);
    assert.ok(a.ok, a.summary);
    assert.equal(a.data?.sandboxed, true, 'the command actually ran under the sandbox');
    assert.ok(existsSync(join(ws, 'in.txt')));

    // 2) a write OUTSIDE the workspace ($HOME) is blocked — and nothing escapes
    const b = await tool.run({ command: `echo escaped > "${escape}"` }, ctx);
    assert.equal(b.ok, false, 'write outside the workspace must fail');
    assert.equal(existsSync(escape), false, 'no file escaped to $HOME');

    // 3) reading the credentials store (~/.shadow) is denied
    const shadowCfg = join(homedir(), '.shadow', 'config.json');
    if (existsSync(shadowCfg)) {
      const c = await tool.run({ command: `cat "${shadowCfg}"` }, ctx);
      assert.equal(c.ok, false, 'reading ~/.shadow is blocked inside the sandbox');
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(escape, { force: true });
  }
});

test('yolo / unrestricted disables sandbox and jail (sandbox:off, root granted)', async () => {
  const tool = makeRunShell({ sandbox: 'off' }); // as --yolo does
  const ctx: ToolContext = {
    workspaceRoot: '/tmp',
    additionalRoots: ['/'], // as yolo grants
    signal: new AbortController().signal,
    log: () => {},
    dryRun: true,
  };
  const res = await tool.run({ command: 'echo yolo > /tmp/yolo-test.txt' }, ctx);
  assert.ok(res.ok || res.summary.includes('dry'), 'yolo should allow outside write (simulated)');
});
