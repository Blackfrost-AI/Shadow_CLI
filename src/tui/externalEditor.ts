// External editor for the composer (F08-10) — Ctrl-X Ctrl-E opens $VISUAL/$EDITOR on the current
// draft, like bash's edit-and-execute-command. Pure bits (editor resolution, temp-file round-trip)
// live here so they unit-test without a terminal; the Ink-pause/spawn wiring stays in tui.tsx.

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Resolve the editor command: $VISUAL, then $EDITOR, then a sane per-platform default. */
export function resolveEditor(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const v = (env.VISUAL ?? env.EDITOR ?? '').trim();
  if (v) return v;
  return platform === 'win32' ? 'notepad' : 'vi';
}

export interface EditorSession {
  file: string;
  /** Read the (possibly edited) content back, trimming a single trailing newline the editor adds. */
  read(): string;
  /** Remove the temp file + its dir. Safe to call more than once. */
  cleanup(): void;
}

/** Create a temp file seeded with `initial` for the editor to open. */
export function openEditorFile(initial: string): EditorSession {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-compose-'));
  const file = join(dir, 'message.md');
  writeFileSync(file, initial, 'utf8');
  let cleaned = false;
  return {
    file,
    read() {
      const raw = readFileSync(file, 'utf8');
      return raw.replace(/\r\n?/g, '\n').replace(/\n$/, '');
    },
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}
