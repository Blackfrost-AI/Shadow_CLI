// Custom slash commands (F10-07) — CC / opencode parity. A `*.md` file under `.shadow/commands`
// or `.claude/commands` (workspace OR ~/.shadow / ~/.claude) becomes a `/<name>` command whose body
// is a prompt template submitted as a turn, with argument substitution. Lets teams keep a shared
// command library in the repo and lets CC users port theirs unchanged — a day-one churn tripwire
// when it's missing.
//
// Security: same jail/cap/symlink discipline as the skills loader (untrusted repo). A custom command
// can NEVER override a builtin (the caller filters collisions), and its body is only ever run when
// the user explicitly types the command — it is user-invoked intent, not auto-executed.

import { existsSync, lstatSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveWithin } from '../safety/workspaceJail.js';
import { enabledPluginDirs } from '../plugins/manager.js';

export interface CustomCommand {
  /** Command name WITHOUT the leading slash, e.g. "review". */
  name: string;
  description: string;
  /** The prompt template (frontmatter stripped). */
  body: string;
  path: string;
  /** True for a workspace-sourced (untrusted-repo) command; false for a global (~) one. */
  workspace: boolean;
}

const COMMAND_DIRS = ['.shadow/commands', '.claude/commands'];
/** Hard cap on a command body spliced into a prompt — a hostile repo can't OOM us or flood context. */
const MAX_COMMAND_BYTES = 64 * 1024;
const DESC_CAP = 100;
/** Command names must be simple tokens so a file can't smuggle a path or an option into the slash line. */
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

/** Parse an optional leading `--- … ---` YAML-ish frontmatter for `description`; return {desc, body}. */
export function parseCommandFile(raw: string): { description: string; body: string } {
  let body = raw;
  let description = '';
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fm) {
    body = raw.slice(fm[0].length);
    const d = fm[1]!.match(/^\s*description\s*:\s*(.+?)\s*$/im);
    if (d) description = d[1]!.replace(/^["']|["']$/g, '').trim();
  }
  if (!description) {
    // First non-empty, non-heading line.
    const line = body.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    if (line) description = line;
  }
  description = description.replace(/\s+/g, ' ').replace(/[`*_#[\]<>]/g, '').trim();
  if (description.length > DESC_CAP) description = description.slice(0, DESC_CAP) + '…';
  return { description: description || 'custom command', body: body.trim() };
}

/**
 * Substitute arguments into a command body. `$ARGUMENTS` → the whole arg string; `$1`…`$9` →
 * positional args (whitespace-split). If the template references NEITHER and args were given,
 * the args are appended on a new line so a bare "/cmd extra context" still passes the context.
 */
export function expandCommandBody(body: string, argString: string): string {
  const args = argString.trim();
  const positional = args ? args.split(/\s+/) : [];
  const usesPlaceholders = /\$ARGUMENTS\b/.test(body) || /\$[1-9]\b/.test(body);
  let out = body
    .replace(/\$ARGUMENTS\b/g, args)
    .replace(/\$([1-9])\b/g, (_, d) => positional[Number(d) - 1] ?? '');
  if (!usesPlaceholders && args) out = `${out}\n\n${args}`;
  return out.trim();
}

/** Discover custom commands from workspace + plugin + global command dirs. Global (~) wins on name collision. */
export function discoverCustomCommands(workspaceRoot: string, homeDir: string): CustomCommand[] {
  const byName = new Map<string, CustomCommand>();
  // Workspace FIRST (untrusted), then ENABLED PLUGINS (data-only installs; the user opted each one
  // in), then global — later roots overwrite earlier, so a trusted ~ command wins over a plugin,
  // and a plugin wins over a repo. Plugin dirs are already-complete paths (P3-07).
  const roots: Array<{ dirs: string[]; workspace: boolean }> = [
    { dirs: COMMAND_DIRS.map((d) => resolve(workspaceRoot, d)), workspace: true },
    { dirs: enabledPluginDirs('commands'), workspace: false },
    { dirs: COMMAND_DIRS.map((d) => resolve(join(homeDir, '.shadow'), d)), workspace: false },
    { dirs: COMMAND_DIRS.map((d) => resolve(homeDir, d)), workspace: false }, // for ~/.claude/commands
  ];
  for (const { dirs, workspace } of roots) {
    for (const root of dirs) {
      if (!existsSync(root)) continue;
      try {
        if (lstatSync(root).isSymbolicLink()) continue; // a symlinked dir could redirect discovery out of jail
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
        const name = file.slice(0, -3);
        if (!NAME_RE.test(name)) continue;
        const full = join(root, file);
        try {
          if (lstatSync(full).isSymbolicLink()) continue; // a symlinked .md could read a secret into a prompt
          // Only jail-check workspace files; ~ is the user's own trusted home.
          const safe = workspace ? resolveWithin(workspaceRoot, full) : full;
          const { description, body } = parseCommandFile(readCapped(safe, MAX_COMMAND_BYTES));
          if (!body) continue;
          byName.set(name.toLowerCase(), { name, description, body, path: full, workspace });
        } catch {
          // skip unreadable / out-of-jail
        }
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
