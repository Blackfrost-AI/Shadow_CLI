// Custom output styles (F08-12) — CC parity. A `*.md` file under `.shadow/output-styles` or
// `.claude/output-styles` (workspace OR ~) defines a named output style whose body is appended to
// the system prompt, alongside the four built-ins. Same jail/cap/symlink discipline as the skills
// and custom-command loaders (untrusted repo). Pure + Ink-free so it unit-tests without React.

import { existsSync, lstatSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveWithin } from '../safety/workspaceJail.js';
import { enabledPluginDirs } from '../plugins/manager.js';

export interface CustomStyle {
  /** Style name (the /style argument), lowercased; no leading punctuation. */
  name: string;
  label: string;
  /** The system-prompt block appended for this style (the .md body, frontmatter stripped). */
  block: string;
}

const STYLE_DIRS = ['.shadow/output-styles', '.claude/output-styles'];
const MAX_STYLE_BYTES = 32 * 1024;
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

function readCapped(file: string, max: number): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** Parse an optional `--- … ---` frontmatter for `label`/`description`; return {label, block}. */
export function parseStyleFile(name: string, raw: string): { label: string; block: string } {
  let body = raw;
  let label = '';
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fm) {
    body = raw.slice(fm[0].length);
    const l = fm[1]!.match(/^\s*(?:label|name|description)\s*:\s*(.+?)\s*$/im);
    if (l) label = l[1]!.replace(/^["']|["']$/g, '').trim();
  }
  if (!label) label = name.charAt(0).toUpperCase() + name.slice(1);
  return { label: label.replace(/[`*_#[\]<>]/g, '').slice(0, 60), block: body.trim() };
}

/** The prompt block for a custom style: a titled section wrapping the user's markdown. */
export function styleBlockFor(label: string, body: string): string {
  return ['', `## Output style — ${label}`, body, ''].join('\n');
}

/** Discover custom output styles from workspace + plugin + global dirs. Global (~) wins on name collision. */
export function discoverCustomStyles(workspaceRoot: string, homeDir: string): CustomStyle[] {
  const byName = new Map<string, CustomStyle>();
  // Precedence: workspace (untrusted) < enabled plugins (P3-07; data-only, user-enabled) < global ~.
  // Plugin dirs are already-complete paths.
  const roots: Array<{ dirs: string[]; workspace: boolean }> = [
    { dirs: STYLE_DIRS.map((d) => resolve(workspaceRoot, d)), workspace: true },
    { dirs: enabledPluginDirs('output-styles'), workspace: false },
    { dirs: STYLE_DIRS.map((d) => resolve(join(homeDir, '.shadow'), d)), workspace: false },
    { dirs: STYLE_DIRS.map((d) => resolve(homeDir, d)), workspace: false }, // for ~/.claude/output-styles
  ];
  for (const { dirs, workspace } of roots) {
    for (const root of dirs) {
      if (!existsSync(root)) continue;
      try {
        if (lstatSync(root).isSymbolicLink()) continue;
      } catch {
        continue;
      }
      let files: string[];
      try {
        files = readdirSync(root, { withFileTypes: true })
          .filter((d) => d.isFile() && d.name.endsWith('.md'))
          .map((d) => d.name);
      } catch {
        continue;
      }
      for (const file of files) {
        const name = file.slice(0, -3).toLowerCase();
        if (!NAME_RE.test(name)) continue;
        const full = join(root, file);
        try {
          if (lstatSync(full).isSymbolicLink()) continue;
          const safe = workspace ? resolveWithin(workspaceRoot, full) : full;
          const { label, block } = parseStyleFile(name, readCapped(safe, MAX_STYLE_BYTES));
          if (!block) continue;
          byName.set(name, { name, label, block: styleBlockFor(label, block) });
        } catch {
          // skip unreadable / out-of-jail
        }
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
