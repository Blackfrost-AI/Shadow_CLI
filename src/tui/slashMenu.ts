// src/tui/slashMenu.ts — the `/` dropdown + argument pickers (extracted from tui.tsx, plan 2.4).
// This is the session picker (`/resume`), the turn picker (`/rewind`), and the model/local
// provider pickers (`/model`, `/local`) — the enumerable FIRST-argument menus each command opens.
import type { ShadowConfig } from '../config.js';
import { effortDescription } from '../agent/effort.js';
import { listLocalModels } from '../local/garage.js';
import { type RewindableTurn } from '../state/rewind.js';
import { fuzzyRank } from '../util/fuzzy.js';
import { isPathLikeSlashToken, pathExistsSafe } from './composer.js';
import { SLASH_COMMANDS, findSlashCommand, slashDispatchName, type SlashCommand } from './slash.js';
import { THEME_NAMES, THEME_DESCRIPTIONS } from './theme.js';

// ── Slash commands (the `/` dropdown) ────────────────────────────────────────
/** A dropdown row: a command, or (when `base` is set) a completed first ARGUMENT of one —
 *  `name` then holds the full submission text ("/theme colorblind") and `base` the command. */
export interface SlashMenuItem extends SlashCommand {
  base?: string;
  /** An informational row ("no prior sessions yet") — shown, but never completed or run. */
  hint?: boolean;
}

// Enumerable FIRST arguments per command (keyed by dispatch name). Typing `/cmd ` opens a
// second-level menu of these — users pick values instead of memorizing them. Only verified
// vocabularies belong here (a completion that the command then rejects is worse than none).
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** One selectable argument row. */
export interface ArgCompletion {
  value: string;
  desc: string;
}

/**
 * What a DYNAMIC completion may look at. The commands that most need a picker are exactly the
 * ones whose vocabulary only exists at runtime — which session to resume, which turn to rewind
 * to, which rule to remove — so a completion may be a function of the live session instead of a
 * constant. Keep this surface small and cheap: it is called on every keystroke while the menu
 * is open.
 */
export interface ArgContext {
  cfg: ShadowConfig;
  workspaceRoot: string;
  /** Prior sessions, newest first (for /resume). */
  sessions: { id: string; label: string }[];
  /**
   * The rewindable SNAPSHOT turns this session has (for /rewind), newest first, each carrying
   * the prompt that produced its turn (F08-07 — the picker names turns by what the user asked,
   * not just an index, and a rewind prefills that prompt back into the composer).
   *
   * NOT the composer-history length. `rewindToTurn` addresses context snapshots written by the
   * loop — the submission count counts slash commands that never ran a turn and misses injected
   * (wakeup) turns, so the two drift apart within minutes of normal use, and "Turn 3" in the
   * menu would revert WORKSPACE FILES to a different point than the label named.
   */
  turns: RewindableTurn[];
  /** Extra directories granted this session (for /add-dir remove). */
  extraRoots: string[];
}

type ArgProvider = ArgCompletion[] | ((ctx: ArgContext) => ArgCompletion[]);

const SLASH_ARG_COMPLETIONS: Record<string, ArgProvider> = {
  '/accessibility': [
    { value: 'motion off', desc: 'Disable spinner animation; keep status updates' },
    { value: 'motion on', desc: 'Enable spinner animation' },
  ],
  '/logo': [
    { value: 'off', desc: 'Use the compact welcome header' },
    { value: 'on', desc: 'Show the large welcome wordmark' },
  ],
  '/help': [
    { value: 'overview', desc: 'Quick start, everyday commands, and essential keys' },
    { value: 'keys', desc: 'Keyboard shortcuts and approval controls' },
    { value: 'all', desc: 'Complete slash-command catalog' },
  ],
  '/theme': [
    ...THEME_NAMES.map((n) => ({ value: n, desc: THEME_DESCRIPTIONS[n] })),
    { value: 'preview', desc: 'Try a theme without saving it (/theme preview <name>)' },
    { value: 'list', desc: 'List every theme with its description' },
  ],
  '/effort': EFFORT_LEVELS.map((l) => ({ value: l, desc: effortDescription(l) })),
  '/autonomy': [
    { value: 'manual', desc: 'Approve every tool call' },
    { value: 'auto-read', desc: 'Reads are automatic; writes and commands ask' },
    { value: 'auto-edit', desc: 'Reads and edits are automatic; commands ask' },
    { value: 'full', desc: 'Routine tools run without asking; this session keeps its current filesystem boundary' },
  ],
  '/style': [
    { value: 'proactive', desc: 'Lead with the result; act, then report' },
    { value: 'explanatory', desc: 'Explain the reasoning alongside the work' },
    { value: 'learning', desc: 'Teach while working — more context, more why' },
    { value: 'procedural', desc: 'Terse step-by-step execution' },
  ],
  '/copy': [{ value: 'code', desc: 'Copy only the last fenced code block' }],
  '/plugins': [
    { value: 'enable', desc: 'Enable an installed plugin: /plugins enable <name>' },
    { value: 'disable', desc: 'Disable a plugin: /plugins disable <name>' },
  ],
  '/config': [
    { value: 'show', desc: 'Show safe runtime settings (secrets hidden)' },
    { value: 'get temperature', desc: 'Show self-hosted sampling temperature' },
    { value: 'set temperature', desc: 'Append a value from 0..2 (default 1.0)' },
    { value: 'get fastMode', desc: 'Show Anthropic fast mode' },
    { value: 'set fastMode', desc: 'Append on/off' },
    { value: 'get effort', desc: 'Show reasoning effort' },
    { value: 'set effort', desc: 'Append low | medium | high | xhigh | max' },
    { value: 'get cacheTtl', desc: 'Show prompt-cache TTL' },
    { value: 'set cacheTtl', desc: 'Append 5m or 1h' },
    { value: 'get maxIterations', desc: 'Show the agent loop cap' },
    { value: 'set maxIterations', desc: 'Append a non-negative integer' },
    { value: 'get maxOutputTokens', desc: 'Show the per-call output cap' },
    { value: 'set maxOutputTokens', desc: 'Append an integer ≥ 256' },
    { value: 'get autoClassifier', desc: 'Show automatic safety classification' },
    { value: 'set autoClassifier', desc: 'Append on/off' },
    { value: 'get parallelTools', desc: 'Show parallel tool execution' },
    { value: 'set parallelTools', desc: 'Append on/off' },
    { value: 'get costWarnUSD', desc: 'Show the session cost warning threshold' },
    { value: 'set costWarnUSD', desc: 'Append a positive USD amount' },
  ],
  '/mcp': [
    { value: 'list', desc: 'List configured MCP servers' },
    { value: 'get', desc: 'Inspect one server: /mcp get <name>' },
    { value: 'enable browser', desc: 'Add isolated Chrome tools (requires Node/npm+npx)' },
    { value: 'enable context-cooler', desc: 'Add token-efficient ctx_* retrieval tools' },
    { value: 'disable', desc: 'Disable a server: /mcp disable <name>' },
  ],
  '/tasks': [{ value: 'clear', desc: 'Clear the live task list' }],
  '/image': [{ value: 'clear', desc: 'Drop queued image attachments' }],
  '/goal': [{ value: 'clear', desc: 'End the active mission' }],
  '/keybindings': [{ value: 'init', desc: 'Write a starter ~/.shadow/keybindings.json' }],
  '/table': [{ value: 'done', desc: 'End the round-table and return to single-model chat' }],
  '/statusline': [{ value: 'none', desc: 'Clear the custom footer line' }],

  // ── on/off toggles ─────────────────────────────────────────────────────────
  // Bare `/vim` flips the switch, so the menu's job is to let you set it EXPLICITLY (and to show
  // which way it currently points via the "✓ current" row).
  '/vim': [
    { value: 'on', desc: 'Modal editing — Esc for NORMAL, i/a to insert' },
    { value: 'off', desc: 'Standard composer editing' },
  ],
  '/fast': [
    { value: 'on', desc: 'Lower latency, no extended thinking (Anthropic)' },
    { value: 'off', desc: 'Normal latency with extended thinking' },
  ],

  // ── verbs whose vocabulary is fixed ────────────────────────────────────────
  '/permissions': [
    { value: 'list', desc: 'Show every rule in match order' },
    { value: 'add', desc: 'Add a rule: /permissions add <allow|ask|deny> <tool> [pattern]' },
    { value: 'remove', desc: 'Remove a rule by index: /permissions remove <n>' },
    { value: 'set', desc: 'Replace a rule: /permissions set <n> <allow|ask|deny>' },
    { value: 'clear', desc: 'Remove every rule (back to the autonomy defaults)' },
  ],
  '/doctor': [{ value: 'model', desc: 'Probe the active model: tools, vision, context window' }],
  '/login': [{ value: 'codex', desc: 'Sign in with ChatGPT/Codex' }],

  // ── dynamic: the vocabulary only exists at runtime ─────────────────────────
  // These are the reason ArgProvider accepts a function. A constant table cannot list YOUR
  // sessions or YOUR turn count, which is exactly where "type the id from memory" hurt most.
  '/resume': (ctx) =>
    ctx.sessions.length
      ? ctx.sessions.map((s) => ({ value: s.id, desc: s.label }))
      : [{ value: '', desc: 'No prior sessions in this workspace yet' }],
  // Turn indexes are 0-based (`0` = the first assistant turn — see the /rewind handler), and the
  // newest is listed first because that is overwhelmingly the one you want.
  // Rows are newest-first and name each turn by the prompt that produced it (F08-07) — "Turn 2"
  // alone forced the user to remember their own history by index.
  '/rewind': (ctx) =>
    ctx.turns.length
      ? ctx.turns.map((t, i) => ({
          value: String(t.turn),
          desc: t.label
            ? `Turn ${t.turn} — ${t.label}`
            : i === 0
              ? `Turn ${t.turn} — the most recent`
              : t.turn === 0
                ? 'Turn 0 — the first turn'
                : `Turn ${t.turn}`,
        }))
      : [{ value: '', desc: 'Nothing to rewind to yet — no turns this session' }],
  '/add-dir': (ctx) =>
    ctx.extraRoots.length
      ? ctx.extraRoots.map((d) => ({ value: d, desc: 'Already granted this session' }))
      : [{ value: '', desc: 'Type a path to grant it to the file tools' }],
  '/model': (ctx) => [
    { value: 'list', desc: 'Show configured model presets' },
    { value: 'add', desc: 'Add a preset: /model add <name> …' },
    { value: 'remove', desc: 'Remove a preset by name' },
    { value: 'enable', desc: 'Enable a disabled preset' },
    { value: 'disable', desc: 'Disable a preset (kept in config)' },
    { value: 'test', desc: 'Capability-check a preset (tools, vision, context)' },
    // Bare `/model` opens the grouped picker; naming a preset switches straight to it.
    ...(ctx.cfg.models ?? [])
      .filter((m) => !m.disabled)
      .map((m) => ({ value: m.label, desc: `Switch to ${m.provider}/${m.model}` })),
  ],
  '/local': (ctx) => [
    { value: 'list', desc: 'Show local model presets (.gguf / MLX / vLLM)' },
    { value: 'add', desc: 'Register one: /local add <path.gguf | mlx-folder | org/repo>' },
    { value: 'use', desc: 'Switch to a registered local model' },
    { value: 'test', desc: 'Launch it and check it answers' },
    { value: 'remove', desc: 'Unregister a local model' },
    // The registered locals by name, so `/local use <tab-completed>` never needs the name typed
    // from memory — the failure mode that made a hash-named preset unreachable in the first place.
    ...listLocalModels(ctx.cfg.models ?? []).map((m) => ({
      value: `use ${m.label}`,
      desc: `Switch to ${m.label} (${m.gguf ? 'gguf' : m.mlx ? 'MLX' : 'vLLM'})`,
    })),
  ],
};

/**
 * Build the dropdown for the current composer text.
 *  - `/wor` → commands, FUZZY-ranked (`/thm` finds /theme; falls back to description search)
 *  - bare `/` → the curated browse list, with pure-alias rows folded out (they still match typed)
 *  - `/cmd part` → the command's known first arguments, fuzzy-filtered; `current` (dispatch →
 *    active value) marks the live setting so pickers double as status readouts
 */
export function slashMatches(
  input: string,
  current?: Record<string, string | undefined>,
  ctx?: ArgContext,
  extra: SlashCommand[] = [],
): SlashMenuItem[] {
  if (!input.startsWith('/')) return [];
  if (isPathLikeSlashToken(input)) return []; // a path (/Users/…, /x.y) is not a command — no menu
  const all = extra.length ? [...SLASH_COMMANDS, ...extra] : SLASH_COMMANDS;
  const sp = input.indexOf(' ');
  if (sp < 0) {
    const q = input.slice(1);
    if (!q) return all.filter((c) => !/\balias\b/i.test(c.desc));
    // NAME-only fuzzy — deliberately no description search: Enter runs the selected row, and
    // a desc match on a mistyped name ("/modle") would execute an unrelated command instead
    // of falling through to the did-you-mean suggestion.
    return fuzzyRank(all, q, (c) => c.name.slice(1)).map((r) => r.item);
  }
  const cmd = findSlashCommand(input.slice(0, sp), extra);
  if (!cmd) return [];
  const provider = SLASH_ARG_COMPLETIONS[slashDispatchName(cmd)];
  if (!provider) return [];
  // A dynamic provider needs the live session; without a context (headless/unit callers) it
  // simply contributes nothing rather than throwing.
  const completions = typeof provider === 'function' ? (ctx ? provider(ctx) : []) : provider;
  // An empty `value` is a HINT row ("no sessions yet") — informational, never completable, so it
  // can't put a bare `/resume ` on the composer and run the wrong thing on Enter.
  if (!completions.length) return [];
  const partial = input.slice(sp + 1);
  if (/\s/.test(partial)) return []; // only the FIRST argument completes
  const active = current?.[slashDispatchName(cmd)];
  const items: SlashMenuItem[] = completions.map((a) => ({
    name: a.value ? `${cmd.name} ${a.value}` : cmd.name,
    desc: a.value === active ? `✓ current · ${a.desc}` : a.desc,
    dispatch: cmd.dispatch,
    base: cmd.name,
    ...(a.value ? {} : { hint: true }),
  }));
  if (!partial) return items;
  return fuzzyRank(items, partial, (i) => i.name.slice(cmd.name.length + 1)).map((r) => r.item);
}

/** Levenshtein distance, early-exiting when it must exceed `max` — for did-you-mean on typos.
 *  Fuzzy subsequence matching can't see TRANSPOSITIONS (/modle ⊄ /model), so this fills that gap. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i, ...new Array<number>(b.length).fill(0)];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]!);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** Best "did you mean" candidate for a mistyped command name, or undefined when nothing is close.
 *  Fuzzy first (catches abbreviations: /thm), then edit-distance ≤ 2 (catches transpositions: /modle). */
function suggestSlash(first: string): string | undefined {
  const q = first.slice(1);
  if (!q) return undefined;
  const fuzzy = fuzzyRank(SLASH_COMMANDS, q, (c) => c.name.slice(1))[0];
  if (fuzzy) return fuzzy.item.name;
  let best: { name: string; d: number } | undefined;
  for (const c of SLASH_COMMANDS) {
    const d = editDistance(q.toLowerCase(), c.name.slice(1), 2);
    if (d <= 2 && (!best || d < best.d)) best = { name: c.name, d };
  }
  return best?.name;
}

/** Classify a `/`-leading submission: a KNOWN command, a likely TYPO (/modl), or a PATH/message the
 *  user pasted or typed (/Users/…, /tmp). This is what stops a directory being rejected as a command.
 *  Typos carry a `suggestion` when a command is plausibly close. */
export function classifySlash(task: string, extra: SlashCommand[] = []): { cmd?: SlashCommand; kind: 'command' | 'typo' | 'message'; suggestion?: string } {
  const first = task.split(/\s+/)[0] ?? '';
  const cmd = findSlashCommand(first, extra);
  if (cmd) return { cmd, kind: 'command' };
  if (isPathLikeSlashToken(first) || pathExistsSafe(first)) return { kind: 'message' };
  return { kind: 'typo', suggestion: suggestSlash(first) };
}
