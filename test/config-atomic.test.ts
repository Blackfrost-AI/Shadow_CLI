import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

// Redirect ~/.shadow to a throwaway HOME BEFORE importing the store (GLOBAL_DIR is derived
// from homedir() at module load), and PROVE the redirect took. This test spawns child
// processes that hammer saveGlobalConfig on the isolated home; a runner that ignored
// process.env.HOME would race real ~/.shadow. See isolateHome.ts. `npm test`, never `bun test`.
const { home: HOME, shadowDir: SHADOW } = isolateHome('atomic');
const CONFIG = join(SHADOW, 'config.json');

const store = await import('../src/state/globalStore.js');
assertStoreIsolated(store.GLOBAL_DIR, HOME);

// URL of the store source, handed to the child processes so each imports the SAME module
// (resolved through tsx) with the SAME isolated HOME.
const STORE_URL = new URL('../src/state/globalStore.ts', import.meta.url).href;

test('concurrent saveGlobalConfig from multiple processes never renders config.json unparseable', async () => {
  // Seed the file so it always exists (atomic rename replaces an existing path, so a reader
  // never sees ENOENT once it's there).
  store.saveGlobalConfig({ seed: true });

  // A tiny worker: import the same store under the same HOME and write big, varying-length
  // payloads in a tight loop. Different lengths per worker mean any interleaving of two
  // writes into one shared temp file would splice into invalid JSON — which is exactly the
  // corruption a shared `${path}.tmp` produced before the pid+random temp-path fix.
  const worker = join(HOME, 'atomic-worker.mjs');
  writeFileSync(
    worker,
    `const store = await import(process.env.STORE_URL);
const id = process.env.WORKER_ID;
const iters = Number(process.env.ITERS);
for (let i = 0; i < iters; i++) {
  store.saveGlobalConfig({ ['w' + id]: 'x'.repeat(1500 + ((i * 37) % 900)), lastI: i });
}
`,
  );

  const ITERS = '250';
  const ids = ['0', '1', '2'];
  const children = ids.map((id) =>
    spawn(process.execPath, ['--import', 'tsx/esm', worker], {
      env: { ...process.env, HOME, USERPROFILE: HOME, STORE_URL, WORKER_ID: id, ITERS },
      stdio: 'inherit',
    }),
  );
  const exits = children.map(
    (c) => new Promise<number>((res) => c.on('exit', (code) => res(code ?? 0))),
  );

  // Sample the file on setImmediate (yields to the event loop so child `exit` events fire)
  // throughout the concurrent write window. A raw JSON.parse must never throw — that would
  // mean a spliced/partial temp file was renamed into place.
  let done = false;
  const parseErrors: string[] = [];
  let samples = 0;
  const sample = () => {
    try {
      const raw = readFileSync(CONFIG, 'utf8');
      if (raw.trim()) {
        JSON.parse(raw);
        samples++;
      }
    } catch (e) {
      parseErrors.push(String(e));
    }
    if (!done) setImmediate(sample);
  };
  setImmediate(sample);

  const codes = await Promise.all(exits);
  done = true;

  assert.deepEqual(codes, [0, 0, 0], 'every worker process exited cleanly');
  assert.ok(samples > 0, 'the sampler read the file at least once during the race');
  assert.equal(
    parseErrors.length,
    0,
    `config.json was unparseable ${parseErrors.length}x during concurrent writes: ${parseErrors[0]}`,
  );

  // Final state is a single complete JSON document, not the `{}` fallback that readJson would
  // silently return over a corrupt file.
  const finalObj = JSON.parse(readFileSync(CONFIG, 'utf8')) as Record<string, unknown>;
  assert.equal(typeof finalObj, 'object');
  assert.equal(finalObj.seed, true, 'seed key survived — the file is a real merged config, not a stub');
});

test('saveGlobalConfig merges onto the existing config, preserving model presets', () => {
  writeFileSync(CONFIG, JSON.stringify({ models: [{ label: 'keep-me' }], provider: 'openai' }, null, 2) + '\n');
  store.saveGlobalConfig({ lastTheme: 'dark' });
  const obj = JSON.parse(readFileSync(CONFIG, 'utf8')) as { models?: unknown[]; lastTheme?: string; provider?: string };
  assert.equal(obj.models?.length, 1, 'model preset survived the save');
  assert.equal((obj.models?.[0] as { label?: string }).label, 'keep-me');
  assert.equal(obj.lastTheme, 'dark', 'the patch applied');
  assert.equal(obj.provider, 'openai', 'unrelated fields preserved');
});

test('saveGlobalConfig REFUSES to overwrite a corrupt config instead of wiping every model', () => {
  // A config that EXISTS and holds a real endpoint but has a JSON typo (missing comma) — the exact
  // shape that made readJson return {} so the next save annihilated every preset with no error.
  const corrupt = '{\n  "models": [{ "label": "keep-me", "baseUrl": "http://x/v1" }]\n  "provider": "openai"\n}';
  writeFileSync(CONFIG, corrupt);
  assert.throws(
    () => store.saveGlobalConfig({ lastTheme: 'og' }),
    /refusing to overwrite a corrupt/,
    'a save over a corrupt config must throw, not silently wipe the models',
  );
  // The corrupt bytes are left exactly intact — NOT replaced with {} + patch…
  assert.equal(readFileSync(CONFIG, 'utf8'), corrupt, 'corrupt config must be preserved verbatim');
  // …and a timestamped rescue copy exists for recovery.
  assert.ok(
    readdirSync(SHADOW).some((f) => f.startsWith('config.json.corrupt-')),
    'a config.json.corrupt-* rescue copy should be written',
  );
});
