import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_LOCAL_CTX,
  DEFAULT_LOCAL_GPU_LAYERS,
  addLocalModel,
  buildLocalEntry,
  deriveLocalName,
  formatLocalList,
  listLocalModels,
  parseLocalAddArgs,
  removeLocalModel,
  sanitizeLocalName,
} from '../src/local/garage.js';
import type { ModelEntry } from '../src/config.js';

/** A real .gguf on disk so buildLocalEntry's existsSync check passes (never loaded). */
function fakeGguf(name = 'model.gguf'): string {
  const dir = mkdtempSync(join(tmpdir(), 'garage-'));
  const path = join(dir, name);
  writeFileSync(path, 'x');
  return path;
}

test('sanitizeLocalName cleans unsafe chars and trims edges', () => {
  assert.equal(sanitizeLocalName('  Qwen 2.5 Coder!! '), 'Qwen-2.5-Coder');
  assert.equal(sanitizeLocalName('a///b'), 'a-b');
  assert.equal(sanitizeLocalName('--weird--'), 'weird');
  assert.equal(sanitizeLocalName('***'), 'local-model'); // empty after cleaning → fallback
});

test('deriveLocalName strips dir + .gguf extension and sanitizes', () => {
  assert.equal(deriveLocalName('/models/Qwen2.5-Coder-7B.Q4_K_M.gguf'), 'Qwen2.5-Coder-7B.Q4_K_M');
  assert.equal(deriveLocalName('/x/My Model.GGUF'), 'My-Model'); // case-insensitive ext, space→dash
});

test('parseLocalAddArgs parses path, --name, --ctx, --gpu-layers (and --ngl alias)', () => {
  const ok = parseLocalAddArgs(['/m/x.gguf', '--name', 'mini', '--ctx', '4096', '--gpu-layers', '20']);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.value, { path: '/m/x.gguf', name: 'mini', ctx: 4096, gpuLayers: 20 });

  const ngl = parseLocalAddArgs(['/m/x.gguf', '--ngl', '0']);
  assert.equal(ngl.ok, true);
  if (ngl.ok) assert.equal(ngl.value.gpuLayers, 0);

  assert.equal(parseLocalAddArgs([]).ok, false); // no path
  assert.equal(parseLocalAddArgs(['/m/x.gguf', '--ctx', 'nope']).ok, false); // non-numeric ctx
  assert.equal(parseLocalAddArgs(['/m/x.gguf', '--ctx', '0']).ok, false); // ctx must be > 0
  assert.equal(parseLocalAddArgs(['/m/x.gguf', '--gpu-layers', '-1']).ok, false); // ngl must be >= 0
  assert.equal(parseLocalAddArgs(['/m/x.gguf', '--bogus']).ok, false); // unknown flag
  assert.equal(parseLocalAddArgs(['/m/x.gguf', 'extra']).ok, false); // unexpected positional
});

test('buildLocalEntry rejects non-.gguf and missing paths', () => {
  assert.equal(buildLocalEntry({ path: '/models/model.bin' }).ok, false); // wrong extension
  assert.equal(buildLocalEntry({ path: '/no/such/model.gguf' }).ok, false); // missing file
  assert.equal(buildLocalEntry({ path: '' }).ok, false); // empty
});

test('buildLocalEntry defaults ctx/gpu-layers and derives name; explicit values win', () => {
  const path = fakeGguf('Mistral-7B.gguf');
  const def = buildLocalEntry({ path });
  assert.equal(def.ok, true);
  if (def.ok) {
    assert.equal(def.value.label, 'Mistral-7B');
    assert.equal(def.value.model, 'Mistral-7B');
    assert.equal(def.value.provider, 'openai');
    assert.equal(def.value.group, 'Local');
    assert.equal(def.value.gguf, path); // absolute path stored
    assert.equal(def.value.ctx, DEFAULT_LOCAL_CTX);
    assert.equal(def.value.gpuLayers, DEFAULT_LOCAL_GPU_LAYERS);
  }

  const custom = buildLocalEntry({ path, name: 'my local', ctx: 16384, gpuLayers: 10 });
  assert.equal(custom.ok, true);
  if (custom.ok) {
    assert.equal(custom.value.label, 'my-local'); // sanitized
    assert.equal(custom.value.ctx, 16384);
    assert.equal(custom.value.gpuLayers, 10);
  }
});

test('addLocalModel → listLocalModels → removeLocalModel round-trip', () => {
  const path = fakeGguf('Round-Trip.gguf');
  // Start with one unrelated cloud preset to prove filtering works.
  let models: ModelEntry[] = [{ label: 'cloud', provider: 'openai', model: 'gpt-5' }];

  const added = addLocalModel(models, { path });
  assert.equal(added.ok, true);
  if (!added.ok) return;
  models = added.value.models;
  assert.equal(added.value.entry.label, 'Round-Trip');

  // listLocalModels returns only gguf entries (not the cloud preset).
  const locals = listLocalModels(models);
  assert.equal(locals.length, 1);
  assert.equal(locals[0]!.label, 'Round-Trip');

  // Duplicate label is rejected.
  assert.equal(addLocalModel(models, { path }).ok, false);

  // Removing a non-existent / non-local name fails.
  assert.equal(removeLocalModel(models, 'nope').ok, false);
  assert.equal(removeLocalModel(models, 'cloud').ok, false); // exists but not a .gguf model

  const removed = removeLocalModel(models, 'round-trip'); // case-insensitive
  assert.equal(removed.ok, true);
  if (!removed.ok) return;
  assert.equal(listLocalModels(removed.value).length, 0);
  assert.equal(removed.value.length, 1); // cloud preset survives
});

test('formatLocalList renders an empty hint and populated rows', () => {
  assert.match(formatLocalList([])[0]!, /No local models registered/);

  const path = fakeGguf('Fmt.gguf');
  const added = addLocalModel([], { path, ctx: 2048, gpuLayers: 5 });
  assert.equal(added.ok, true);
  if (!added.ok) return;
  const lines = formatLocalList(added.value.models);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /Fmt/);
  assert.match(lines[0]!, /Fmt\.gguf/); // basename, not full path
  assert.match(lines[0]!, /ctx 2048/);
  assert.match(lines[0]!, /gpu-layers 5/);
  assert.match(lines[0]!, /enabled/);
});
