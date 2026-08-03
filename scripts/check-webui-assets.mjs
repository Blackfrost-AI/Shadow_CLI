#!/usr/bin/env node
// Fails if src/web/bundledAssets.ts is stale with respect to src/web/ui/.
//
// Why this can rot silently: in dev the server prefers the on-disk ui/ tree (assets.ts
// `hasOnDiskAssets`), so a stale map is invisible locally. The compiled binary has no src/
// on disk and serves the map exclusively — so the staleness only shows up as "the binary
// ships the old UI", which is exactly the kind of bug nobody finds until a user reports it.
//
// The check is "does regenerating change the file", NOT `git diff --exit-code`. The latter
// conflates stale-vs-generated with merely-uncommitted, and would fail during normal work.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = join(root, 'src', 'web', 'bundledAssets.ts');
const generator = join(root, 'scripts', 'embed-webui.mjs');

const before = existsSync(target) ? readFileSync(target, 'utf8') : '';

// src/web/ui/vendor/ is itself generated (from src/util via tsconfig.web.json), so it must be
// rebuilt BEFORE embedding — otherwise a change to markdown.ts/highlight.ts/diff.ts would be
// invisible to both the check and the shipped binary.
execFileSync('npx', ['tsc', '-p', 'tsconfig.web.json'], { cwd: root, stdio: 'inherit' });
execFileSync(process.execPath, [generator], { stdio: 'ignore' });
const after = readFileSync(target, 'utf8');

if (before !== after) {
  console.error('web UI assets are STALE: src/web/ui/ changed without regenerating the map.');
  console.error('The compiled binary would ship the old UI while dev served the new one.');
  console.error('It has now been regenerated — commit the result:');
  console.error('  git add src/web/bundledAssets.ts');
  process.exit(1);
}

console.log('web UI assets in sync.');
