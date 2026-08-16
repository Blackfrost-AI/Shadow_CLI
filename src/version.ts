/**
 * The single source of truth for the CLI version — package.json, never hard-coded. The compiled
 * single-file binary has no package.json on disk, so the build injects the version via
 * `--define process.env.SHADOW_BUILD_VERSION=...` (see scripts/build-binary.sh). Extracted from
 * index.ts so non-index entry points (the ACP adapter) can read it without importing main().
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { INSTALL_DIR } from './installDir.js';

export function readVersion(): string {
  if (process.env.SHADOW_BUILD_VERSION) return process.env.SHADOW_BUILD_VERSION;
  try {
    return (JSON.parse(readFileSync(resolve(INSTALL_DIR, 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}
