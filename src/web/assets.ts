import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLED_WEB_ASSETS } from './bundledAssets.js';

/**
 * Resolves a web UI asset (JS/CSS/HTML) by name, with the same dev/binary split the prompt
 * loader uses (`src/system/resolveSystem.ts`): in dev, the on-disk file under `src/web/ui`
 * wins for hot reload; in the compiled binary (no `src/` on disk) the codegen'd map is the
 * only source.
 */

const thisDir = dirname(fileURLToPath(import.meta.url));
const onDiskRoot = resolve(thisDir, 'ui');

/** The directory of frontend source, when running uncompiled from disk. */
export function uiSourceDir(): string {
  return onDiskRoot;
}

/** True when the on-disk source tree is present (dev / npm install from source). */
export function hasOnDiskAssets(): boolean {
  try {
    return existsSync(onDiskRoot) && statSync(onDiskRoot).isDirectory();
  } catch {
    return false;
  }
}

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Content-Type for an asset path. Defaults to plain text. */
export function contentTypeFor(name: string): string {
  const ext = name.slice(name.lastIndexOf('.'));
  return MIME[ext] ?? 'text/plain; charset=utf-8';
}

/**
 * Fetch an asset by relative path (e.g. `app.js`, `views/models.js`). Returns the content
 * or `null` if no such asset exists on disk or in the codegen map. Path traversal is
 * rejected: the resolved path must stay under the on-disk root.
 */
export function readAsset(name: string): string | null {
  // The codegen keys are POSIX-relative; normalize what we were handed.
  const clean = name.replace(/^\/+/, '').replace(/\\/g, '/');
  if (clean.includes('..')) return null;

  if (hasOnDiskAssets()) {
    const p = join(onDiskRoot, clean);
    // Resolve and confirm it stayed under root (defense against `..`/symlinks).
    const rel = resolve(p);
    if (rel.startsWith(onDiskRoot) && existsSync(rel)) {
      try {
        return readFileSync(rel, 'utf8');
      } catch {
        // fall through to bundled
      }
    }
  }
  return BUNDLED_WEB_ASSETS[clean] ?? null;
}

/** Every asset name known to the codegen map (used to list bundled assets in tests). */
export function bundledAssetNames(): string[] {
  return Object.keys(BUNDLED_WEB_ASSETS);
}

/**
 * The shell HTML, served verbatim — no token substitution.
 *
 * An earlier version stamped `?t=<token>` onto the asset URLs, reasoning that external ES
 * modules and stylesheets cannot send an `Authorization` header. That is true, but stamping
 * the entry point does not work: a module's relative import resolves against the *module
 * URL* and drops its query string, so `app.js`'s `import './api.js'` requested
 * `/assets/api.js` with no token, took a 401, and killed the module graph on its first line.
 * The page never rendered — it sat on "Loading…" indefinitely.
 *
 * The asset tree is served without a token instead (see `isPublicPath`), so the shell needs
 * no per-session rewriting and the served HTML is identical for every session.
 */
export function shellPage(): string {
  return readAsset('shell.html') ?? '<!doctype html><title>Shadow</title><body>UI assets missing';
}
