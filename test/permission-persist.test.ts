import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, persistPermissionRules } from '../src/config.js';

test('persistPermissionRules writes project shadow.config.json when present', () => {
  const ws = mkdtempSync(join(tmpdir(), 'perm-persist-'));
  const cfgPath = join(ws, 'shadow.config.json');
  writeFileSync(cfgPath, JSON.stringify({ provider: 'mock', model: 'm' }, null, 2) + '\n');
  try {
    const rules = [{ tool: 'write_file', action: 'deny' as const }];
    persistPermissionRules(ws, rules);
    const onDisk = JSON.parse(readFileSync(cfgPath, 'utf8')) as { permissionRules: typeof rules };
    assert.deepEqual(onDisk.permissionRules, rules);
    const loaded = loadConfig(ws, {});
    assert.deepEqual(loaded.permissionRules, rules);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});