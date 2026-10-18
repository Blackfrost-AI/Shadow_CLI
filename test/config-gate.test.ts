import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isolateHome } from './helpers/isolateHome.js';
import type { ToolCall } from '../src/provider/provider.js';

// Redirect ~/.shadow to a throwaway HOME BEFORE importing the loop (its `globalStore` import binds
// GLOBAL_DIR to homedir() at load). touchesConfigFile() resolves a path against that GLOBAL_DIR, so
// without the redirect the absolute-global-path assertions below would aim at the REAL ~/.shadow and miss.
const { home: HOME } = isolateHome('cfg-gate');
const { touchesConfigFile, writeTouchesConfigFile } = await import('../src/agent/loop.js');
const GLOBAL_CFG = join(HOME, '.shadow', 'config.json');

/**
 * F07-01 (P1A-01) — defense-in-depth: editing the config that DISARMS the safety gates must
 * always prompt, at EVERY autonomy level, over every allow rule / session approval / fast path.
 * This test pins the detector that the loop's gate (forced `|| configTouch || ...`) uses to force
 * requestApproval on write_file/edit_file targeting shadow.config.json or ~/.shadow/config.json.
 */

const call = (path: string): ToolCall => ({ id: 'c1', name: 'write_file', input: { path } });
const edit = (path: string): ToolCall => ({ id: 'c1', name: 'edit_file', input: { path } });

test('snapshot restores always prompt, including directory roots; non-restores do not', () => {
  for (const path of ['shadow.config.json', GLOBAL_CFG, '.', 'nested/tree', 'ordinary.bin']) {
    assert.equal(writeTouchesConfigFile('target_snapshot', { action: 'restore', path }), true);
    for (const action of ['baseline', 'verify', 'list']) {
      assert.equal(writeTouchesConfigFile('target_snapshot', { action, path }), false);
    }
  }
  assert.equal(writeTouchesConfigFile('patch_bytes', { action: 'revert', path: GLOBAL_CFG }), true);
});

test('denying a snapshot restore protects configs at auto-edit and full autonomy', async () => {
  const { AgentLoop } = await import('../src/agent/loop.js');
  const { Budget } = await import('../src/agent/budget.js');
  const { Context } = await import('../src/agent/context.js');
  const { EventBus } = await import('../src/agent/events.js');
  const { MockProvider } = await import('../src/provider/mock.js');
  const { ToolRegistry } = await import('../src/tools/registry.js');
  const { targetSnapshot } = await import('../src/tools/targetSnapshot.js');
  const root = mkdtempSync(join(tmpdir(), 'cfg-restore-'));
  const ctx = { workspaceRoot: root, signal: new AbortController().signal, log: () => {}, dryRun: false };
  try {
    mkdirSync(join(root, 'tree'));
    const config = join(root, 'tree', 'shadow.config.json');
    for (const path of ['tree/shadow.config.json', 'tree']) {
      writeFileSync(config, '{"marker":"old"}');
      const baseline = await targetSnapshot.run({ action: 'baseline', path }, ctx);
      assert.equal(baseline.ok, true, baseline.summary);
      writeFileSync(config, '{"marker":"current"}');
      for (const autonomy of ['auto-edit', 'full'] as const) {
        let approvalRequests = 0;
        const registry = new ToolRegistry();
        registry.register(targetSnapshot);
        const loop = new AgentLoop({
          ...ctx, registry, provider: new MockProvider(), model: 'mock', system: 'test',
          gate: { async request() { approvalRequests++; return 'deny' as const; } },
          bus: new EventBus(), budget: new Budget({ maxIterations: 10 }, 'mock', {}, Date.now()),
          context: new Context({ contextBudget: 100_000, triggerRatio: 0.9, keepLastTurns: 6 }),
          maxOutputTokens: 256, maxToolResultChars: 1000, contextBudget: 100_000,
        }, autonomy);
        const result = await loop.runToolCall({
          id: 'restore', name: 'target_snapshot', input: {
            action: 'restore', path, snapshot_id: (baseline.data as { snapshotId: string }).snapshotId,
            overwrite_drift: true,
          },
        });
        assert.equal(approvalRequests, 1, `${autonomy}: restore must reach the gate`);
        assert.equal(result.ok, false);
        assert.equal(readFileSync(config, 'utf8'), '{"marker":"current"}');
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('write_file/edit_file targeting any shadow.config.json is detected (→ always prompts)', () => {
  // Project config (relative).
  assert.ok(touchesConfigFile(call('shadow.config.json')));
  assert.ok(touchesConfigFile(call('./shadow.config.json')));
  assert.ok(touchesConfigFile(call('nested/dir/shadow.config.json')));
  // A touching backup/name-variant still prompts — false positive is cheap.
  assert.ok(touchesConfigFile(call('x/shadow.config.json.bak')));
  assert.ok(touchesConfigFile(call('x/shadow.config.json/tmp')));
  // The GLOBAL trusted config under its real absolute path (any route to it).
  assert.ok(touchesConfigFile(call(GLOBAL_CFG)));
  assert.ok(touchesConfigFile(edit(GLOBAL_CFG)));
  // edit_file on a project config too.
  assert.ok(touchesConfigFile(edit('shadow.config.json')));
});

test('non-config writes are NOT flagged (no UX regression for ordinary edits)', () => {
  assert.equal(touchesConfigFile(call('src/index.ts')), false);
  assert.equal(touchesConfigFile(call('config.json')), false, 'bare config.json is not shadow.config.json');
  assert.equal(touchesConfigFile(call('shadow.config')), false);
  assert.equal(touchesConfigFile(call('src/shadow.config.json.ts')), false, 'must match the exact filename');
  assert.equal(touchesConfigFile(call('/etc/hosts')), false);
});

test('read-only tools are NOT flagged (a read of the config stays quiet)', () => {
  const read = (path: string): ToolCall => ({ id: 'c1', name: 'read_file', input: { path } });
  // The detector is only wired to write_file/edit_file at the gate, but verify the helper itself
  // doesn't treat a read-path specially — the gate's tool-name check is the scope guard. So the
  // path looks identical, but the loop only consults the helper for write_file/edit_file.
  assert.equal(read('shadow.config.json').name, 'read_file');
  // Safety net: if the helper is ever called on a read tool, it still detects the path by name —
  // the gate restricts WHICH tools consult it, so behavior stays scoped regardless.
  assert.equal(touchesConfigFile(read('shadow.config.json')), true, 'helper is name-agnostic; gate scopes by tool');
});

test('missing/typed input is safe (no path → no flag, never throws)', () => {
  assert.equal(touchesConfigFile({ id: 'c1', name: 'write_file', input: {} }), false);
  assert.equal(touchesConfigFile({ id: 'c1', name: 'write_file', input: { path: 42 } }), false);
  assert.equal(touchesConfigFile({ id: 'c1', name: 'write_file', input: undefined }), false);
  assert.equal(touchesConfigFile({ id: 'c1', name: 'run_shell', input: { command: 'echo shadow.config.json' } }), false,
    'a shell command merely MENTIONING the filename is not a config write');
});

test('multi_edit and apply_patch targeting the config are detected (the patch-grammar wedge)', () => {
  // These go through writeTouchesConfigFile — the WRITE-tool wrapper the gate consults (the bare
  // touchesConfigFile is the per-path probe underneath it).
  // multi_edit carries its path at top level like write_file — same detection must apply.
  assert.ok(writeTouchesConfigFile('multi_edit', { path: GLOBAL_CFG, edits: [] }));
  assert.ok(writeTouchesConfigFile('multi_edit', { path: 'shadow.config.json', edits: [] }));
  // apply_patch hides its paths inside the patch TEXT — the Add/Update/Delete headers and the
  // Move-to line must each be scanned, or the gate is bypassed by the Codex/Grok edit grammar.
  const patch = (body: string): { patch: string } => ({
    patch: `*** Begin Patch\n${body}\n*** End Patch`,
  });
  assert.ok(writeTouchesConfigFile('apply_patch', patch('*** Update File: shadow.config.json\n@@')));
  assert.ok(writeTouchesConfigFile('apply_patch', patch(`*** Add File: ${GLOBAL_CFG}\n+{}`)));
  assert.ok(writeTouchesConfigFile('apply_patch', patch('*** Delete File: ./shadow.config.json')));
  assert.ok(
    writeTouchesConfigFile('apply_patch', patch('*** Update File: other.json\n@@\n*** Move to: shadow.config.json')),
    'a Move-to rename onto the config is a config write',
  );
  // Ordinary patches stay quiet.
  assert.equal(writeTouchesConfigFile('apply_patch', patch('*** Update File: src/index.ts\n@@')), false);
  // Non-write tools are out of the wrapper's scope even with a config path in hand.
  assert.equal(writeTouchesConfigFile('read_file', { path: GLOBAL_CFG }), false);
});

test('config gate closes the respellings: ./ prefix, case, and the workspace base', () => {
  // `.shadow/config.json` is how a model naturally writes `./.shadow/config.json`, and the old
  // leading class (`^|[/\\]`) did not match it — so with `--workspace $HOME` the most obvious
  // spelling of the global config skipped the gate at auto-edit, where a `write` risk is otherwise
  // auto-approved. On a case-insensitive filesystem `.SHADOW/CONFIG.JSON` is the same file.
  assert.equal(touchesConfigFile({ id: 'c', name: 'write_file', input: { path: '.shadow/config.json' } }, [HOME]), true);
  assert.equal(touchesConfigFile({ id: 'c', name: 'write_file', input: { path: './shadow.config.json' } }), true);
  assert.equal(touchesConfigFile({ id: 'c', name: 'write_file', input: { path: GLOBAL_CFG.toUpperCase() } }), true);
  assert.equal(touchesConfigFile({ id: 'c', name: 'write_file', input: { path: 'shadow.config.json' } }, [HOME]), true);
  // A relative path is resolved against the WORKSPACE the write lands in, not the process cwd.
  assert.equal(
    touchesConfigFile({ id: 'c', name: 'write_file', input: { path: '.shadow/config.json' } }, ['/somewhere-else']),
    false,
    'the same spelling outside the home workspace is an ordinary file',
  );
  // Ordinary source files stay quiet (the gate is not "anything named config.json").
  assert.equal(touchesConfigFile({ id: 'c', name: 'write_file', input: { path: 'config.json' } }, ['/ws']), false);
  assert.equal(touchesConfigFile({ id: 'c', name: 'write_file', input: { path: 'src/shadow.config.json.ts' } }), false);
});
