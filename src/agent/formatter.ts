// Auto-format after writes (plan 2.1, v1: format-only, no diagnostics feedback).
//
// After the agent's file tools successfully write a file inside the workspace, the
// project's formatter runs on that file. PURE + injectable by design: detection only
// inspects project files (never executes anything), the runner only spawns the detected
// binary through a caller-injectable exec seam, and nothing here reaches for the home
// directory or the network. Failure policy: a formatter problem NEVER fails the write —
// at most a one-line note rides back on the tool result.
//
// Detection priority (first match wins):
//   biome (dep + biome.json/jsonc) > prettier (dep or .prettierrc*/prettier.config.*)
//   > ruff ([tool.ruff] or .ruff.toml/ruff.toml) > gofmt (go.mod) > rustfmt (Cargo.toml)
//   > shfmt (.shfmt)

import { accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { scrubbedEnv } from '../util/safeEnv.js';

export const FORMATTER_KINDS = ['prettier', 'biome', 'ruff', 'gofmt', 'rustfmt', 'shfmt'] as const;
export type FormatterKind = (typeof FORMATTER_KINDS)[number];

/** A detected (or overridden) formatter: its kind plus the argv to format one file in place. */
export interface FormatterSpec {
  kind: FormatterKind;
  /** argv for formatting `filePath` in place; argv[0] is the binary name. */
  commandFor(filePath: string): string[];
}

export type FormatterOverride = FormatterKind | 'off';

/** The `formatters` config block (src/config.ts). All fields optional; defaults applied here. */
export interface FormatterConfig {
  enabled?: boolean; // default true
  /** Extension-like key (".ts" or "ts") → formatter for that extension, or "off" to skip. */
  overrides?: Record<string, FormatterOverride>;
}

export interface ExecOutcome {
  exitCode: number | null; // null = failed to start / killed
  output: string; // combined stdout+stderr
  timedOut: boolean;
}

/** Injectable runner seam: spawn `argv` (argv[0] = binary) and report the outcome. */
export type FormatterExec = (argv: string[], opts: { cwd: string; timeoutMs: number }) => Promise<ExecOutcome>;

/** Minimal fs view of a project dir — injectable so detection is testable without disk fixtures. */
export interface DetectFs {
  /** Does `<projectDir>/<name>` exist? */
  exists(name: string): boolean;
  /** Read `<projectDir>/<name>` as UTF-8, or null when missing/unreadable. */
  read(name: string): string | null;
  /** Entry names directly in the project dir ([] when unreadable). */
  readdir(): string[];
}

export type FormatSkipReason =
  | 'kill-switch' // SHADOW_NO_FORMAT=1
  | 'disabled' // config formatters.enabled === false
  | 'outside-workspace' // file not inside the project dir
  | 'not-detected' // no formatter detected and no override applies
  | 'override-off' // an override explicitly disables this extension
  | 'binary-missing'; // detected, but the binary is not on PATH

export interface FormatOutcome {
  /** true = the formatter binary was executed (check `note` for whether it succeeded). */
  ran: boolean;
  skipped?: FormatSkipReason;
  /** One-line failure note (formatter name + exit reason, trimmed) when it ran and failed. */
  note?: string;
}

// ── specs ──────────────────────────────────────────────────────────────────────

const COMMANDS: Record<FormatterKind, (file: string) => string[]> = {
  prettier: (f) => ['prettier', '--write', f],
  biome: (f) => ['biome', 'format', '--write', f],
  ruff: (f) => ['ruff', 'format', f],
  gofmt: (f) => ['gofmt', '-w', f],
  rustfmt: (f) => ['rustfmt', f],
  shfmt: (f) => ['shfmt', '-w', f],
};

/** Build the spec for a known kind. */
export function specForKind(kind: FormatterKind): FormatterSpec {
  return { kind, commandFor: (filePath: string) => COMMANDS[kind](filePath) };
}

// ── detection ──────────────────────────────────────────────────────────────────

function realDetectFs(projectDir: string): DetectFs {
  return {
    exists: (name) => existsSync(join(projectDir, name)),
    read: (name) => {
      try {
        return readFileSync(join(projectDir, name), 'utf8');
      } catch {
        return null;
      }
    },
    readdir: () => {
      try {
        return readdirSync(projectDir);
      } catch {
        return [];
      }
    },
  };
}

function readJson(fs: DetectFs, name: string): Record<string, unknown> | null {
  const text = fs.read(name);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Detect the project's formatter by inspecting files ONLY (nothing is executed).
 * First match wins: biome > prettier > ruff > gofmt > rustfmt > shfmt.
 */
export function detectFormatter(projectDir: string, fsOverride?: DetectFs): FormatterSpec | null {
  const fs = fsOverride ?? realDetectFs(projectDir);
  const pkg = readJson(fs, 'package.json');
  const deps: Record<string, unknown> = {
    ...((pkg?.dependencies as Record<string, unknown> | undefined) ?? {}),
    ...((pkg?.devDependencies as Record<string, unknown> | undefined) ?? {}),
  };

  // 1. biome — package.json dep AND a biome.json/jsonc config.
  if (('biome' in deps || '@biomejs/biome' in deps) && (fs.exists('biome.json') || fs.exists('biome.jsonc'))) {
    return specForKind('biome');
  }
  // 2. prettier — package.json dep OR a .prettierrc* / prettier.config.* file.
  const prettierRc = fs.readdir().some((n) => n.startsWith('.prettierrc') || n.startsWith('prettier.config.'));
  if ('prettier' in deps || prettierRc) return specForKind('prettier');
  // 3. ruff — pyproject.toml with a [tool.ruff] table, or a ruff.toml/.ruff.toml.
  const pyproject = fs.read('pyproject.toml');
  if ((pyproject !== null && /\[tool\.ruff\]/.test(pyproject)) || fs.exists('.ruff.toml') || fs.exists('ruff.toml')) {
    return specForKind('ruff');
  }
  // 4–6. ecosystem markers.
  if (fs.exists('go.mod')) return specForKind('gofmt');
  if (fs.exists('Cargo.toml')) return specForKind('rustfmt');
  if (fs.exists('.shfmt')) return specForKind('shfmt');
  return null;
}

// ── binary lookup ──────────────────────────────────────────────────────────────

// Cached per session (PATH is part of the key, so a changed PATH re-checks).
const lookpathCache = new Map<string, string | null>();

/** Drop cached lookups (tests flip PATH between cases). */
export function clearLookpathCache(): void {
  lookpathCache.clear();
}

/**
 * Find `bin` on PATH (executable regular file). Returns the absolute path or null.
 * `pathVar` overrides the PATH value to scan (defaults to the current process PATH).
 */
export function lookpath(bin: string, pathVar?: string): string | null {
  const pathValue = pathVar ?? process.env.PATH ?? '';
  const key = `${bin}\x00${pathValue}`;
  const cached = lookpathCache.get(key);
  if (cached !== undefined) return cached;
  let found: string | null = null;
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) {
        found = candidate;
        break;
      }
    } catch {
      /* not here — keep scanning */
    }
  }
  lookpathCache.set(key, found);
  return found;
}

// ── runner ─────────────────────────────────────────────────────────────────────

/** Kill the child's whole process group (runShell's killTree precedent): a plain
 *  child.kill leaves grandchildren (e.g. a formatter's own spawns) holding the pipes. */
function killTree(child: ChildProcess): void {
  try {
    if (process.platform !== 'win32' && typeof child.pid === 'number') process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

/** Default exec: spawn the binary directly (no shell); the timeout kills the tree. Exported
 *  for the env-scrubbing pin (a PATH-resolved formatter must never see Shadow's secrets). */
export const defaultExec: FormatterExec = (argv, { cwd, timeoutMs }) =>
  new Promise<ExecOutcome>((resolvePromise) => {
    let output = '';
    let timedOut = false;
    let settled = false;

    let child: ChildProcess;
    try {
      // detached → process-group leader, so the timeout kill takes the whole tree.
      // Scrubbed env: an auto-formatter is a PATH-resolved binary we hand no secrets to
      // (same invariant as run_shell/MCP/LSP children — see src/util/safeEnv.ts).
      child = spawn(argv[0]!, argv.slice(1), {
        cwd,
        env: scrubbedEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      resolvePromise({ exitCode: null, output: (e as Error).message, timedOut: false });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ exitCode, output, timedOut });
    };
    child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (output += d.toString()));
    // ENOENT-style spawn failures surface via 'error' (no exit code); keep the message.
    child.on('error', (e) => {
      if (!output) output = e.message;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });

/** First non-empty line of the formatter output, trimmed and capped (for the one-line note). */
function firstLine(text: string, max = 160): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? '';
  const trimmed = line.trim();
  return trimmed.length > max ? trimmed.slice(0, max) + '…' : trimmed;
}

export interface Formatter {
  /** The spec that WOULD format this file (override or detection), or null. */
  specFor(absPath: string): FormatterSpec | null;
  /** Format one file in place. NEVER throws. */
  formatFile(absPath: string): Promise<FormatOutcome>;
}

export interface CreateFormatterOptions {
  /** The workspace/project root: detection base, exec cwd, and the containment boundary. */
  projectDir: string;
  config?: FormatterConfig; // default: enabled, no overrides
  /** Env to read SHADOW_NO_FORMAT from (defaults to process.env) — injectable for tests. */
  env?: Record<string, string | undefined>;
  exec?: FormatterExec; // default: real spawn
  which?: (bin: string) => string | null; // default: lookpath on PATH
  detectFs?: DetectFs; // default: real fs on projectDir
  timeoutMs?: number; // default 10_000; kill on timeout
}

function normalizeOverrideKey(key: string): string {
  return key.replace(/^\.+/, '').toLowerCase();
}

export function insideProject(projectDir: string, absPath: string): boolean {
  try {
    const root = existsSync(projectDir) ? realpathSync(projectDir) : resolve(projectDir);
    // The file was just written, so it exists; realpath it too so symlinks can't sneak out.
    const target = realpathSync(absPath);
    if (target === root) return true;
    const rel = relative(root, target);
    return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
  } catch {
    return false;
  }
}

/**
 * Build a formatter runner bound to one project dir. Everything is injectable; the
 * defaults touch only the project dir, PATH, and the detected binary.
 */
export function createFormatter(opts: CreateFormatterOptions): Formatter {
  const env = opts.env ?? process.env;
  const exec = opts.exec ?? defaultExec;
  const which = opts.which ?? ((bin: string) => lookpath(bin, env.PATH ?? ''));
  const detectFs = opts.detectFs ?? realDetectFs(opts.projectDir);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const enabled = opts.config?.enabled !== false;
  const overrides = new Map<string, FormatterOverride>(
    Object.entries(opts.config?.overrides ?? {}).map(([k, v]) => [normalizeOverrideKey(k), v]),
  );

  const specFor = (absPath: string): FormatterSpec | null => {
    const override = overrides.get(normalizeOverrideKey(extname(absPath).slice(1)));
    if (override === 'off') return null;
    if (override) return specForKind(override);
    return detectFormatter(opts.projectDir, detectFs);
  };

  const formatFile = async (absPath: string): Promise<FormatOutcome> => {
    try {
      if ((env.SHADOW_NO_FORMAT ?? '') === '1') return { ran: false, skipped: 'kill-switch' };
      if (!enabled) return { ran: false, skipped: 'disabled' };
      if (!insideProject(opts.projectDir, absPath)) return { ran: false, skipped: 'outside-workspace' };

      const override = overrides.get(normalizeOverrideKey(extname(absPath).slice(1)));
      if (override === 'off') return { ran: false, skipped: 'override-off' };
      const spec = override ? specForKind(override) : detectFormatter(opts.projectDir, detectFs);
      if (!spec) return { ran: false, skipped: 'not-detected' };

      const argv = spec.commandFor(absPath);
      if (!which(argv[0]!)) return { ran: false, skipped: 'binary-missing' }; // silent skip

      const out = await exec(argv, { cwd: opts.projectDir, timeoutMs });
      if (out.timedOut) {
        return { ran: true, note: `formatter ${spec.kind} timed out after ${timeoutMs}ms` };
      }
      if (out.exitCode !== 0) {
        const detail = firstLine(out.output);
        const reason = out.exitCode === null ? 'failed to run' : `exit ${out.exitCode}`;
        return { ran: true, note: `formatter ${spec.kind} ${reason}${detail ? `: ${detail}` : ''}` };
      }
      return { ran: true };
    } catch {
      // Formatting is best-effort: an unexpected internal error skips silently.
      return { ran: false };
    }
  };

  return { specFor, formatFile };
}

// ── tool-layer seam ────────────────────────────────────────────────────────────

/** What the post-write hook needs from the tool context. */
export interface FormatHookContext {
  workspaceRoot: string;
  formatters?: FormatterConfig;
  formatterExec?: FormatterExec;
  /** Binary-availability lookup (defaults to PATH); injectable so tests stay hermetic. */
  formatterWhich?: (bin: string) => string | null;
}

/**
 * The single hook the file tools call after a SUCCESSFUL write of `absPath`. Formats the
 * file when a formatter applies; returns a one-line note when the formatter ran and failed,
 * null on success or any skip. NEVER throws and NEVER fails the write (v1 failure policy).
 */
export async function formatAfterWrite(absPath: string, ctx: FormatHookContext): Promise<string | null> {
  try {
    const formatter = createFormatter({
      projectDir: ctx.workspaceRoot,
      config: ctx.formatters,
      exec: ctx.formatterExec,
      which: ctx.formatterWhich,
    });
    const outcome = await formatter.formatFile(absPath);
    return outcome.note ?? null;
  } catch {
    return null;
  }
}
