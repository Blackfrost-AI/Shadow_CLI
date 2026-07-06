/**
 * User keybinding config: load `~/.shadow/keybindings.json`, validate + merge it
 * over the defaults, and (optionally) hot-reload on file change.
 *
 * File format (matches Claude Code's shape so existing muscle memory / docs map):
 *
 *   {
 *     "bindings": [
 *       { "context": "Global", "bindings": { "ctrl+l": "app:redraw" } },
 *       { "context": "Chat",    "bindings": { "ctrl+x ctrl+k": "chat:cancel" } }
 *     ]
 *   }
 *
 * Validation is best-effort and NEVER throws: a bad file degrades to the defaults
 * plus a list of warnings the `/keybindings` command surfaces. Hardcoded shortcuts
 * (ctrl+c/d/m) are rejected; OS/terminal shortcuts are allowed but warned.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GLOBAL_DIR } from '../../state/globalStore.js';
import { buildDefaultBindings } from './defaultBindings.js';
import { parseChord, keystrokeToString } from './parser.js';
import { checkReserved } from './reserved.js';
import { KEYBINDING_CONTEXTS, type ContextName, type KeybindingWarning, type LoadedBindings, type ParsedBinding, type UserKeybindingsFile } from './types.js';

export function keybindingsPath(): string {
  return join(GLOBAL_DIR, 'keybindings.json');
}

function normalizeContext(name: string): ContextName | null {
  const n = name.trim().toLowerCase();
  for (const c of KEYBINDING_CONTEXTS) if (c.toLowerCase() === n) return c;
  return null;
}

/**
 * Parse + validate one user block into bindings, collecting warnings (no throw).
 * Accepts `unknown` because the source is JSON.parse — a structurally-wrong file
 * must degrade to warnings, never crash startup. Every field is guarded.
 */
function parseUserBlock(block: unknown, warnings: KeybindingWarning[]): ParsedBinding[] {
  if (!block || typeof block !== 'object') {
    warnings.push({ kind: 'parse_error', message: 'a "bindings" entry is not an object — skipped' });
    return [];
  }
  const raw = block as { context?: unknown; bindings?: unknown };
  if (typeof raw.context !== 'string') {
    warnings.push({ kind: 'invalid_context', message: 'context missing or not a string — skipped' });
    return [];
  }
  const ctx = normalizeContext(raw.context);
  if (!ctx) {
    warnings.push({ kind: 'invalid_context', message: `unknown context "${raw.context}" — skipped` });
    return [];
  }
  if (!raw.bindings || typeof raw.bindings !== 'object') {
    warnings.push({ kind: 'parse_error', message: `${ctx}: "bindings" is not an object — skipped` });
    return [];
  }
  const out: ParsedBinding[] = [];
  const seen = new Set<string>();
  for (const [stroke, action] of Object.entries(raw.bindings as Record<string, unknown>)) {
    if (action !== null && typeof action !== 'string') {
      warnings.push({ kind: 'parse_error', message: `${ctx}: "${stroke}" action must be a string or null — skipped` });
      continue;
    }
    const chord = parseChord(stroke);
    if (!chord) {
      warnings.push({ kind: 'invalid_keystroke', message: `${ctx}: "${stroke}" did not parse — skipped` });
      continue;
    }
    const canon = chord.map(keystrokeToString).join(' ');
    if (seen.has(canon)) {
      warnings.push({ kind: 'duplicate', message: `${ctx}: duplicate "${stroke}" — earlier kept` });
      continue;
    }
    seen.add(canon);
    if (chord.length === 1) {
      const r = checkReserved(chord[0]!);
      if (r.severity === 'hard') {
        warnings.push({ kind: 'reserved', message: `${ctx}: "${stroke}" — ${r.reason} (ignored)` });
        continue;
      }
      if (r.severity === 'warn') {
        warnings.push({ kind: 'reserved', message: `${ctx}: "${stroke}" — ${r.reason}` });
      }
    }
    out.push({ context: ctx, chord, action });
  }
  return out;
}

/**
 * Merge user blocks over the defaults (pure, FS-free — unit-testable). Defaults
 * come first; user overrides come after so the resolver's last-wins rule makes the
 * user's binding win per (context, chord). Never throws.
 */
export function mergeKeybindings(userBlocks: readonly unknown[] | null): LoadedBindings {
  const { bindings: defaults, warnings } = buildDefaultBindings();
  const userBindings = (userBlocks ?? []).flatMap((b) => parseUserBlock(b, warnings));
  return { bindings: [...defaults, ...userBindings], warnings };
}

/**
 * Load + merge: defaults first, user overrides after (the resolver's last-wins rule
 * makes user bindings take precedence). Safe to call before the user file exists.
 */
export function loadKeybindingsSync(): LoadedBindings {
  const path = keybindingsPath();
  if (!existsSync(path)) return mergeKeybindings(null);

  let parsed: UserKeybindingsFile;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as UserKeybindingsFile;
  } catch (e) {
    const out = mergeKeybindings(null);
    out.warnings.push({ kind: 'parse_error', message: `keybindings.json: ${(e as Error).message} — using defaults` });
    return out;
  }
  return mergeKeybindings(Array.isArray(parsed.bindings) ? parsed.bindings : null);
}

/**
 * Hot-reload via mtime polling. Unlike watchFile-on-an-absent-path (which is a
 * silent no-op), this notices the file even when it is CREATED mid-session (after
 * `/keybindings init`) and on every later edit. Cheap (one stat per tick). Returns
 * a stop() that clears the interval. Read-only — no telemetry.
 */
export function initKeybindingsWatcher(cb: (next: LoadedBindings) => void): () => void {
  const path = keybindingsPath();
  let lastMtime = 0;
  try {
    lastMtime = statSync(path).mtimeMs;
  } catch {
    lastMtime = 0; // absent at mount — picked up on the first poll once created
  }
  const timer = setInterval(() => {
    let m = 0;
    try {
      m = statSync(path).mtimeMs;
    } catch {
      m = 0;
    }
    if (m && m !== lastMtime) {
      lastMtime = m;
      try {
        cb(loadKeybindingsSync());
      } catch {
        /* never let a reload failure crash the UI */
      }
    }
  }, 1500);
  return () => clearInterval(timer);
}

/** A starter `~/.shadow/keybindings.json` with every default spelled out + docs. */
export function generateKeybindingsTemplate(): string {
  const { bindings } = buildDefaultBindings();
  const byCtx = new Map<ContextName, Record<string, string>>();
  for (const b of bindings) {
    const stroke = b.chord.map(keystrokeToString).join(' ');
    const map = byCtx.get(b.context) ?? {};
    map[stroke] = b.action ?? '';
    byCtx.set(b.context, map);
  }
  const blocks = [...byCtx.entries()].map(
    ([ctx, map]) => `    { "context": "${ctx}", "bindings": ${JSON.stringify(map, null, 6).replace(/\n\s{6}/g, '\n      ')} }`,
  );
  return [
    '{',
    '  "//": "Shadow keybindings — overrides the defaults. Last match per context+chord wins.",',
    '  "//": "Hardcoded keys (ctrl+c, ctrl+d, ctrl+m) cannot be reassigned. Set an action to null to disable it.",',
    '  "bindings": [',
    blocks.join(',\n'),
    '  ]',
    '}',
  ].join('\n');
}

/** Write the template to ~/.shadow/keybindings.json (idempotent; does not overwrite). */
export function initKeybindingsFile(): { path: string; created: boolean; error?: string } {
  const path = keybindingsPath();
  if (existsSync(path)) return { path, created: false };
  try {
    // Ensure the parent exists (an un-onboarded install or read-only HOME must not
    // crash the input loop — surface a friendly error instead).
    mkdirSync(GLOBAL_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(path, generateKeybindingsTemplate(), { mode: 0o600 });
    return { path, created: true };
  } catch (e) {
    return { path, created: false, error: (e as Error).message };
  }
}

export interface DisplayRow {
  context: ContextName;
  stroke: string;
  action: string;
}

/**
 * Collapse the merged binding list to one row per (context, chord), with the
 * winning action (last wins) — for the `/keybindings` listing. Drops null/unbound.
 */
export function bindingsForDisplay(bindings: readonly ParsedBinding[]): DisplayRow[] {
  const win = new Map<string, DisplayRow>();
  for (const b of bindings) {
    if (b.action === null) {
      // a null binding wins → remove any earlier real binding for this chord.
      const key = `${b.context}|${b.chord.map(keystrokeToString).join(' ')}`;
      win.delete(key);
      continue;
    }
    const stroke = b.chord.map(keystrokeToString).join(' ');
    win.set(`${b.context}|${stroke}`, { context: b.context, stroke, action: b.action });
  }
  return [...win.values()].sort(
    (a, b) => a.context.localeCompare(b.context) || a.stroke.localeCompare(b.stroke),
  );
}
