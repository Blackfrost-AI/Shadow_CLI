import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveCheckpoint,
  restoreCheckpoint,
  listCheckpointsForTurn,
} from '../src/state/checkpoints.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'shadow-ckpt-'));
}

test('saveCheckpoint writes .bak under .shadow/checkpoints and round-trips content', () => {
  const root = tmp();
  try {
    const content = 'before edit\n';
    const path = saveCheckpoint(root, 'sess-1', 3, 'src/foo.ts', content);
    assert.ok(path.endsWith('.bak'));
    assert.equal(restoreCheckpoint(path), content);

    const listed = listCheckpointsForTurn(root, 'sess-1', 3);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.relPath, 'src/foo.ts');
    assert.ok(existsSync(listed[0]!.absPath));

    const raw = readFileSync(join(root, '.shadow', 'checkpoints', 'sess-1', '3', 'index.json'), 'utf8');
    assert.match(raw, /src\/foo\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listCheckpointsForTurn returns empty for unknown turn', () => {
  const root = tmp();
  try {
    assert.deepEqual(listCheckpointsForTurn(root, 'none', 0), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});