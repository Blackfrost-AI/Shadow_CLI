import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Redirect `~/.shadow` to a throwaway HOME and PROVE the redirect took effect.
 *
 * Why this exists: `globalStore` derives `GLOBAL_DIR` from `os.homedir()` at module load,
 * and tests isolate themselves by setting `process.env.HOME` before importing it. That
 * works under Node. It does NOT work under Bun — `bun`'s `os.homedir()` ignores
 * `process.env.HOME` and returns the real home:
 *
 *     bun:  process.env.HOME='/tmp/x'; os.homedir() -> /Users/you
 *     node: process.env.HOME='/tmp/x'; os.homedir() -> /tmp/x
 *
 * Under the wrong runner the tests believe they are sandboxed while the store points at
 * the user's real `~/.shadow` — and this suite calls `shredLegacyCredentials()`, which
 * overwrites and unlinks `credentials.json`. That has destroyed a real config once.
 *
 * So: assert, don't assume. If the redirect did not take, throw before any test body runs.
 * A loud failure is always better than a suite that silently operates on a real home.
 *
 * The project's runner is `npm test` (`node --import tsx/esm --test`). Do not run these
 * files with `bun test`.
 */
export function isolateHome(label: string): { home: string; shadowDir: string } {
  const home = mkdtempSync(join(tmpdir(), `shadow-${label}-`));
  process.env.HOME = home;
  process.env.USERPROFILE = home; // Windows

  // Verify the interpreter actually honours the override *before* the store is imported.
  const seen = homedir();
  if (resolve(seen) !== resolve(home)) {
    throw new Error(
      `REFUSING TO RUN: os.homedir() returned ${seen} after HOME was set to ${home}.\n` +
        `This runner ignores process.env.HOME, so ~/.shadow would resolve to a REAL home\n` +
        `directory and these tests would destroy live credentials.\n` +
        `Run the suite with \`npm test\` (node --import tsx/esm --test), not \`bun test\`.`,
    );
  }

  const shadowDir = join(home, '.shadow');
  mkdirSync(shadowDir, { recursive: true });
  return { home, shadowDir };
}

/**
 * Second line of defence, called AFTER the store is imported: confirm the module's own
 * resolved directory is inside the temp home. Catches any path that bypasses homedir().
 */
export function assertStoreIsolated(globalDir: string, home: string): void {
  if (!resolve(globalDir).startsWith(resolve(home))) {
    throw new Error(
      `REFUSING TO RUN: globalStore.GLOBAL_DIR is ${globalDir}, which is outside the\n` +
        `test home ${home}. These tests mutate and delete credential files — aborting\n` +
        `rather than touching a real ~/.shadow.`,
    );
  }
}
