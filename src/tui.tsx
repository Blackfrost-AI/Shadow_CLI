import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { render, Box, Text, Static, useApp, useInput, useStdout } from 'ink';
import { flattenItem } from './tui/flatten.js';
import { execFileSync, spawn } from 'node:child_process';
import type { Message, Provider, ToolCall, ContentBlock, ImageBlock, Effort } from './provider/provider.js';
import type { ToolRegistry } from './tools/registry.js';
import { EventBus } from './agent/events.js';
import { Budget } from './agent/budget.js';
import { parseMarkdown, renderTableLines, wrapSpans, isTableSeparator, FENCE as MD_FENCE, LIST_ITEM as MD_LIST_ITEM, QUOTE as MD_QUOTE, type MdSpan } from './util/markdown.js';
import { isBigPaste, expandPastes, isPathLikeSlashToken, pathExistsSafe } from './tui/composer.js';
import { withSynchronizedOutput } from './tui/syncOutput.js';
import type { BrandInfo, ToolInfo } from './tui/rows.js';
import {
  recommendedIndex,
  defaultQuestionSelection,
  buildQuestionAnswers,
  buildAutoAnswers,
  type QuestionSelection,
} from './tui/questions.js';
import { imageMediaType } from './util/image.js';
import { highlight, type CodeRole } from './util/highlight.js';
import { Context } from './agent/context.js';
import type { TodoItem, TodoList } from './agent/todo.js';
import type { PlanModeState, PlanSnapshot } from './agent/planMode.js';
import { AgentLoop, type LoopDeps } from './agent/loop.js';
import {
  type ApprovalDecision,
  type ApprovalGate,
  type ApprovalRequest,
  AutoApproveGate,
} from './agent/approval.js';
import { cycleAutonomy, type AutonomyLevel } from './safety/permissions.js';
import { applyPermissionCommand } from './safety/permissionCmd.js';
import { SessionLog } from './state/session.js';
import { createProvider } from './provider/index.js';
import {
  disableMcpServer,
  enableContextCooler,
  loadGlobalMcpServers,
  mcpListLines,
  mcpServerLines,
  saveGlobalMcpServers,
  type McpServers,
} from './mcp/manage.js';
import { ensureGgufServer } from './gguf.js';
import { runModelCheck } from './doctor/modelCheck.js';
import {
  resolveApiKey,
  resolveAuthToken,
  resolveBaseUrl,
  type ShadowConfig,
  type ModelEntry,
} from './config.js';
import {
  addModelPreset,
  defaultModelPatch,
  findModelPreset,
  parseModelAddArgs,
  removeModelPreset,
  setModelPresetEnabled,
  splitPresetArgs,
} from './config/modelPresets.js';
import {
  addLocalModel,
  formatLocalList,
  listLocalModels,
  parseLocalAddArgs,
  removeLocalModel,
} from './local/garage.js';
import { runDoctor, formatDoctorReport } from './doctor.js';
import { type OutputStyle } from './styles.js';
import {
  groupedModelRows,
  firstSelectableRow,
  stepSelectableRow,
  type PickerRow,
} from './util/modelGroups.js';
import { persistPermissionRules } from './config.js';
import { GLOBAL_DIR, saveGlobalConfig } from './state/globalStore.js';
import { exportSession } from './state/chatExport.js';
import { listResumableSessions, resumeSession } from './state/resume.js';
import { rewindToTurn } from './state/rewind.js';
import { ProjectMemory } from './state/memory.js';
import { buildCodexAuthUrl, clearSubAuth, getSubAuth, importOfficialCredential, type SubProvider } from './auth/index.js';
import { loadAgentDefs } from './agent/defs.js';
import { existsSync, writeFileSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { friendlyDeniedReason } from './util/deniedReason.js';
import type { UserAnswer, UserQuestion } from './agent/approval.js';
import { computeLayout, fitsWideBanner, formatStatusStrip, pinnedMaxItems } from './tui/layout.js';
import { vimNormalKey, type VimMode } from './tui/vim.js';
import { runHookPhase } from './hooks/runner.js';
import { discoverSkills } from './skills/loader.js';
import {
  cycleEffort,
  effortDescription,
  effortOrDefault,
  effortSymbol,
  normalizeEffort,
} from './agent/effort.js';
import { categorizeContext, contextSuggestions } from './tui/contextViz.js';
import { copyToClipboard, hasClipboard } from './util/clipboard.js';
import { redactString } from './util/redact.js';
import { useKeybindings } from './tui/keybindings/useKeybinding.js';
import { bindingsForDisplay, initKeybindingsFile } from './tui/keybindings/loader.js';
import type { ContextName } from './tui/keybindings/types.js';

interface TuiStyleState {
  style: OutputStyle;
  setStyle: (style: OutputStyle) => void;
  systemForStyle?: (style: OutputStyle) => string;
}

// ── Theme ────────────────────────────────────────────────────────────────────
// Ink/chalk color names + hex. These are passed as Ink `color` PROPS (never as
// raw ANSI escapes embedded in text — Ink does its own styling). The plain
// headless renderer below uses raw ANSI because it writes straight to stdout.
/**
 * Color palette. `C` is a MUTABLE singleton: `/theme` mutates it in place via
 * Object.assign and forces a re-render. Because every `C.xxx` is read at render
 * time (never captured), all ~85 call sites pick up the new palette on the next
 * paint without threading a context through the tree.
 */
// ACCESSIBILITY (WCAG 2.1 AA): primary text `fg` is WHITE for maximum legibility, and `dim` is an
// EXPLICIT readable gray (NOT Ink's `dimColor` faint attribute, which terminals render unpredictably
// and which routinely fails the 4.5:1 contrast floor). Every `fg`/`dim` here clears 4.5:1 on a black or
// dark-gray terminal; accents (cyan/green/yellow/purple/red) are chosen to clear it too.
const THEMES = {
  og: {
    fg: '#ffffff', // white — high contrast
    dim: '#b6bcc3', // ~9:1 on black — readable secondary text
    cyan: '#38dbf5',
    green: '#22d38f', // emerald, brightened for contrast
    red: '#ff6b6b', // red, brightened past AA
    yellow: '#f5b62e', // amber
    purple: '#b9a3ff', // violet, brightened
  },
  // Backward-compatible alias for configs saved before the OG name existed.
  dark: {
    fg: '#ffffff',
    dim: '#b6bcc3',
    cyan: '#38dbf5',
    green: '#22d38f',
    red: '#ff6b6b',
    yellow: '#f5b62e',
    purple: '#b9a3ff',
  },
  pipboy: {
    fg: '#e6ffcf', // bright green-white
    dim: '#a9cf86',
    cyan: '#9be07a',
    green: '#b6f58a',
    red: '#ff8a7a',
    yellow: '#ecd977',
    purple: '#c8ea86',
  },
  cyberpunk: {
    fg: '#f7fbff',
    dim: '#b3bccb',
    cyan: '#4fe0ff',
    green: '#4ff0b3',
    red: '#ff6f93',
    yellow: '#ffdc80',
    purple: '#e08cff',
  },
  'coder-chick': {
    fg: '#fff7fb',
    dim: '#dcc3cf',
    cyan: '#9fdcff',
    green: '#7fe0a0',
    red: '#ff7ba6',
    yellow: '#ffd485',
    purple: '#ff9fd4',
  },
  light: {
    fg: '#0a0a0a', // near-black (for light terminals)
    dim: '#565656', // ~6:1 on a light background
    cyan: '#0369a1', // sky-700
    green: '#047857', // emerald-700
    red: '#b91c1c', // red-700
    yellow: '#b45309', // amber-700
    purple: '#6d28d9', // violet-700
  },
  matrix: {
    fg: '#5cff9f', // brighter phosphor green
    dim: '#3fbf7a',
    cyan: '#33ffd6',
    green: '#5cff9f',
    red: '#ff5f7d',
    yellow: '#d6ff33',
    purple: '#7fffbf',
  },
  mono: {
    fg: '#f4f4f4', // bright grayscale — minimal color, terminal-default friendly
    dim: '#b4b4b4', // ~8:1 on black
    cyan: '#cfd3d8',
    green: '#d6d6d6',
    red: '#ff8a8a',
    yellow: '#ededed',
    purple: '#c4c4c4',
  },
} as const;
export type ThemeName = keyof typeof THEMES;
export const THEME_NAMES = ['og', 'pipboy', 'cyberpunk', 'coder-chick', 'matrix', 'mono', 'light'] as const;
type CanonicalThemeName = (typeof THEME_NAMES)[number];

const THEME_DESCRIPTIONS: Record<CanonicalThemeName, string> = {
  og: 'Original Shadow palette: calm dark terminal with cyan/violet accents.',
  pipboy: 'Soft green phosphor with amber warnings; retro but low-glare.',
  cyberpunk: 'Cyan, magenta, and yellow accents on a high-contrast dark base.',
  'coder-chick': 'Rose/pink accent palette with neutral text and readable status colors.',
  matrix: 'Green phosphor mode with sharper signal colors.',
  mono: 'Minimal grayscale for plain terminal focus.',
  light: 'Near-black text and restrained color for light terminals.',
};

const THEME_ALIASES: Record<string, CanonicalThemeName> = {
  dark: 'og',
  pink: 'coder-chick',
  coderchick: 'coder-chick',
  chick: 'coder-chick',
  pip: 'pipboy',
};

const C = { ...THEMES.og };

function normalizeThemeName(name: string | undefined): CanonicalThemeName | null {
  if (!name) return null;
  const raw = name.toLowerCase();
  if ((THEME_NAMES as readonly string[]).includes(raw)) return raw as CanonicalThemeName;
  return THEME_ALIASES[raw] ?? null;
}

/** Swap the active palette in place. Caller must trigger a re-render to repaint. */
export function applyTheme(name: ThemeName | string): void {
  const theme = normalizeThemeName(name) ?? 'og';
  Object.assign(C, THEMES[theme]);
}

/** Test seam: a copy of the active palette (colors change in place via applyTheme). */
export function paletteSnapshot(): Record<string, string> {
  return { ...C };
}

// `imageMediaType` now lives in util/image.ts (shared with the view_image tool);
// re-exported here so existing importers (and tui tests) keep working.
export { imageMediaType };

export interface StatusLineCtx {
  model: string;
  provider: string;
  cwd: string;
  autonomy: string;
}

/**
 * Run a user `/statusline` shell command and hand its first stdout line to `cb`.
 * Session context is provided both as SHADOW_* env vars and as a JSON blob on stdin
 * (the reference client statusLine contract), so existing statusline scripts work. Always
 * async + bounded: a 2s timeout kills a hung command and any failure yields ''.
 */
export function runStatusLine(cmd: string, ctx: StatusLineCtx, cb: (line: string) => void): void {
  let done = false;
  const finish = (line: string): void => {
    if (done) return;
    done = true;
    cb(line);
  };
  try {
    const child = spawn('sh', ['-c', cmd], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: {
        ...process.env,
        SHADOW_MODEL: ctx.model,
        SHADOW_PROVIDER: ctx.provider,
        SHADOW_CWD: ctx.cwd,
        SHADOW_AUTONOMY: ctx.autonomy,
      },
    });
    let out = '';
    const killer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish('');
    }, 2000);
    child.stdout?.on('data', (d: Buffer) => {
      if (out.length < 4096) out += d.toString();
    });
    child.on('error', () => {
      clearTimeout(killer);
      finish('');
    });
    child.on('close', () => {
      clearTimeout(killer);
      finish((out.split('\n')[0] ?? '').trim());
    });
    // A command that exits before reading stdin closes the pipe; the resulting EPIPE
    // arrives as an async 'error' event (not a throw), so swallow it here or it would
    // crash the process as an unhandled error.
    child.stdin?.on('error', () => {
      /* broken pipe — command didn't read stdin; ignore */
    });
    try {
      child.stdin?.end(JSON.stringify({ model: ctx.model, provider: ctx.provider, cwd: ctx.cwd, autonomy: ctx.autonomy }) + '\n');
    } catch {
      /* stdin may already be closed on a fast-failing command */
    }
  } catch {
    finish('');
  }
}

// ── the reference client visual vocabulary (parity with the reference) ───────────────────────
// The pulsing sparkle spinner: a dot swells to a star and back (forward then reverse), not a
// braille wheel. This + the orange brand color is the reference client's single most recognizable identity signal.
const IS_DARWIN = process.platform === 'darwin';
const SPARKLE = ['·', '✢', '✳', '✶', '✻', IS_DARWIN ? '✽' : '*'];
const SPINNER = [...SPARKLE, ...SPARKLE.slice(1, -1).reverse()]; // ·✢✳✶✻✽✻✶✳✢ — smooth pulse
// The signature left-gutter dot on assistant turns; color (not shape) carries tool state.
const BLACK_CIRCLE = IS_DARWIN ? '⏺' : '●';
// Claude's warm brand orange — the spinner glyph + the ⏺ accent.
const CLAUDE_ORANGE = '#d97757';
// Slash-menu contrast: a faint slate panel behind the whole command list so it reads as a distinct
// surface (not lost in the transcript), and a stronger tone on the selected row — a soft highlight
// bar, not the harsh reverse-video the redesign dropped.
const MENU_BG = '#1b2331';
const MENU_SEL_BG = '#31465f';
// The activity label shown beside the spinner while a turn runs. One brand-consistent word
// ('Shadowing…') instead of a rotating grab-bag of generic verbs. A CUSTOM per-action label (a tool
// or the app setting a contextual verb) can override it in future; there is no such source today.
const DEFAULT_STATUS_VERB = 'Shadowing';

// ── Slash commands (the `/` dropdown) ────────────────────────────────────────
interface SlashCommand {
  name: string;
  desc: string;
  dispatch?: string;
}
const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help', desc: 'Show keybindings and commands' },
  { name: '/keybindings', desc: 'Show / customize keybindings (/keybindings init writes a starter config)' },
  { name: '/clear', desc: 'Clear the screen and reset the conversation' },
  { name: '/new', desc: 'Start a fresh conversation (alias for /clear)' },
  { name: '/goal', desc: 'Set a standing goal the model works toward (/goal clear to remove)' },
  { name: '/model', desc: 'Switch, list, add, remove, enable, disable, or test (capability check) model presets' },
  { name: '/provider', desc: 'Show active provider, endpoint, auth status, and model presets' },
  { name: '/local', desc: 'Add / test / switch a local .gguf model' },
  { name: '/onboard', desc: 'Show provider setup guidance' },
  { name: '/style', desc: 'Cycle output style' },
  { name: '/output-style', desc: 'Cycle output style (alias for /style)', dispatch: '/style' },
  { name: '/autonomy', desc: 'Cycle autonomy: manual → auto-read → auto-edit → full' },
  { name: '/compact', desc: 'Summarize earlier turns to free up context' },
  { name: '/summary', desc: 'Summarize earlier turns to free up context (alias for /compact)', dispatch: '/compact' },
  { name: '/fast', desc: 'Toggle Anthropic fast mode (lower latency, no extended thinking)' },
  { name: '/effort', desc: 'Set or cycle reasoning effort: low | medium | high | xhigh | max' },
  { name: '/cost', desc: 'Show session token usage and cost' },
  { name: '/usage', desc: 'Alias for /cost' },
  { name: '/stats', desc: 'Show session token usage and cost (alias for /cost)', dispatch: '/cost' },
  { name: '/context', desc: 'Show context-window usage' },
  { name: '/export', desc: 'Export session to markdown (optional path)' },
  { name: '/copy', desc: 'Copy the last assistant answer to the clipboard' },
  { name: '/session', desc: 'Show current session id, log path, and message count' },
  { name: '/resume', desc: 'Resume a prior session (optional session id/path)' },
  { name: '/rewind', desc: 'Rewind to a turn index (e.g. /rewind 2)' },
  { name: '/init', desc: 'Scaffold SHADOW.md in the workspace' },
  { name: '/agents', desc: 'List agent definitions' },
  { name: '/skills', desc: 'List discovered repo skills' },
  { name: '/workflows', desc: 'List workflow files' },
  { name: '/plugins', desc: 'Show extension/plugin status' },
  { name: '/mcp', desc: 'List, inspect, enable, or disable MCP servers' },
  { name: '/memory', desc: 'Show project memory facts' },
  { name: '/tasks', desc: 'Show or clear the live task list (/tasks clear)' },
  { name: '/permissions', desc: 'List or edit permission rules' },
  { name: '/doctor', desc: 'Diagnose environment, credentials, and guardrails' },
  { name: '/status', desc: 'Show session status (model, autonomy, context, goal)' },
  { name: '/diff', desc: 'Show the working-tree git diff (--stat)' },
  { name: '/files', desc: 'Show changed files from git status' },
  { name: '/branch', desc: 'Show current git branch and status summary' },
  { name: '/config', desc: 'Show or set safe config values (secrets hidden)' },
  { name: '/hooks', desc: 'Show configured lifecycle hooks' },
  { name: '/login', desc: 'Show/import supported auth credentials' },
  { name: '/logout', desc: 'Clear supported subscription credentials' },
  { name: '/version', desc: 'Show Shadow version' },
  { name: '/color', desc: 'Switch color theme (alias for /theme)', dispatch: '/theme' },
  { name: '/theme', desc: 'Switch color theme (list, preview <name>, or name; no arg cycles)' },
  { name: '/vim', desc: 'Toggle modal (NORMAL/INSERT) editing in the composer' },
  { name: '/statusline', desc: 'Set a shell command for a custom footer line (/statusline none to clear)' },
  { name: '/add-dir', desc: 'Grant an extra directory to file tools for this session' },
  { name: '/image', desc: 'Attach an image file to your next message (/image clear to drop)' },
  { name: '/review', desc: 'Review the current uncommitted changes' },
  { name: '/quit', desc: 'Exit Shadow' },
  { name: '/exit', desc: 'Exit Shadow (alias for /quit)' },
];
const SLASH_NAME_WIDTH = Math.max(...SLASH_COMMANDS.map((c) => c.name.length)) + 1;
/** Commands whose name starts with the typed prefix — non-empty only while typing a `/word`. */
function slashMatches(input: string): SlashCommand[] {
  if (!input.startsWith('/') || /\s/.test(input)) return [];
  if (isPathLikeSlashToken(input)) return []; // a path (/Users/…, /x.y) is not a command — no menu
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(input));
}

function slashDispatchName(cmd: SlashCommand): string {
  return cmd.dispatch ?? cmd.name;
}

function findSlashCommand(name: string): SlashCommand | undefined {
  return SLASH_COMMANDS.find((c) => c.name === name);
}

/** Classify a `/`-leading submission: a KNOWN command, a likely TYPO (/modl), or a PATH/message the
 *  user pasted or typed (/Users/…, /tmp). This is what stops a directory being rejected as a command. */
function classifySlash(task: string): { cmd?: SlashCommand; kind: 'command' | 'typo' | 'message' } {
  const first = task.split(/\s+/)[0] ?? '';
  const cmd = findSlashCommand(first);
  if (cmd) return { cmd, kind: 'command' };
  return { kind: isPathLikeSlashToken(first) || pathExistsSafe(first) ? 'message' : 'typo' };
}

const SAFE_CONFIG_KEYS = [
  'fastMode',
  'effort',
  'cacheTtl',
  'maxIterations',
  'maxOutputTokens',
  'autoClassifier',
  'parallelTools',
  'costWarnUSD',
] as const;
type SafeConfigKey = (typeof SAFE_CONFIG_KEYS)[number];

function parseBool(value: string): boolean | null {
  const v = value.toLowerCase();
  if (['on', 'true', 'yes', '1'].includes(v)) return true;
  if (['off', 'false', 'no', '0'].includes(v)) return false;
  return null;
}

function parseSafeConfig(key: string, raw: string): { ok: true; key: SafeConfigKey; value: unknown } | { ok: false; message: string } {
  if (!(SAFE_CONFIG_KEYS as readonly string[]).includes(key)) {
    return { ok: false, message: `Config key "${key}" is not editable here. Editable: ${SAFE_CONFIG_KEYS.join(', ')}` };
  }
  const safeKey = key as SafeConfigKey;
  if (safeKey === 'fastMode' || safeKey === 'autoClassifier' || safeKey === 'parallelTools') {
    const value = parseBool(raw);
    return value === null ? { ok: false, message: `Use on/off for ${safeKey}.` } : { ok: true, key: safeKey, value };
  }
  if (safeKey === 'effort') {
    const allowed = ['low', 'medium', 'high', 'xhigh', 'max'];
    return allowed.includes(raw) ? { ok: true, key: safeKey, value: raw } : { ok: false, message: `effort must be one of: ${allowed.join(', ')}` };
  }
  if (safeKey === 'cacheTtl') {
    return raw === '5m' || raw === '1h' ? { ok: true, key: safeKey, value: raw } : { ok: false, message: 'cacheTtl must be 5m or 1h.' };
  }
  if (safeKey === 'costWarnUSD') {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0
      ? { ok: true, key: safeKey, value }
      : { ok: false, message: 'costWarnUSD must be a positive number (e.g. 5).' };
  }
  if (safeKey === 'maxOutputTokens') {
    const value = Number(raw);
    return Number.isInteger(value) && value >= 256
      ? { ok: true, key: safeKey, value }
      : { ok: false, message: 'maxOutputTokens must be an integer ≥ 256 (e.g. 65536).' };
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return { ok: false, message: `${safeKey} must be a non-negative integer.` };
  return { ok: true, key: safeKey, value };
}

function parseSubProvider(value: string | undefined): SubProvider | null {
  return value === 'codex' || value === 'grok' ? value : null;
}

/** Informational slash commands safe to run mid-turn without interrupting the agent. */
const SLASH_WHILE_RUNNING = new Set(['/help', '/cost', '/usage', '/context', '/fast', '/effort', '/version', '/copy']);

/**
 * The selectable model list for the `/model` picker: the configured `models`, or a
 * single synthesized entry from the active config so the picker is never empty.
 */
function modelEntries(cfg: ShadowConfig): ModelEntry[] {
  const entries =
    cfg.models && cfg.models.length > 0
      ? cfg.models.filter((m) => !m.disabled)
      : [{ label: cfg.model, provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl }];
  return entries;
}

/** Grouped picker rows for a config: a category header per company/"Local", then its models. */
function modelRows(cfg: ShadowConfig): PickerRow[] {
  return groupedModelRows(modelEntries(cfg));
}

function modelPresetLines(entries: ModelEntry[], current: { provider: string; model: string }): string[] {
  if (!entries.length) return ['No model presets configured. Use /model add <label> <provider> <model> [baseUrl].'];
  return entries.map((entry) => {
    const active = entry.provider === current.provider && entry.model === current.model;
    const baseUrl = entry.baseUrl ? ` · ${entry.baseUrl}` : '';
    const disabled = entry.disabled ? ' [disabled]' : '';
    const marker = active ? '* ' : '  ';
    return `${marker}${entry.label}${disabled} — ${entry.provider}/${entry.model}${baseUrl}`;
  });
}

function listNamedEntries(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() || d.isDirectory())
      .map((d) => `${d.name}${d.isDirectory() ? '/' : ''}`)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function workflowInventory(workspaceRoot: string): string[] {
  const roots = [
    { label: 'workspace', dir: join(workspaceRoot, '.shadow', 'workflows') },
    { label: 'global', dir: join(GLOBAL_DIR, 'workflows') },
  ];
  const lines: string[] = [];
  for (const root of roots) {
    const entries = listNamedEntries(root.dir);
    if (!entries.length) continue;
    lines.push(`${root.label}: ${shortPath(root.dir)}`);
    for (const entry of entries.slice(0, 20)) lines.push(`  ${entry}`);
    if (entries.length > 20) lines.push(`  ... ${entries.length - 20} more`);
  }
  return lines;
}

/** Human-readable elapsed time: `8s`, `2m 5s`, `1h 3m 12s` (the HUD "working…" timer). */
function formatDuration(totalSec: number): string {
  if (totalSec < 60) return `${totalSec}s`;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

// ── Structured transcript items (printed once, never re-rendered) ─────────────
interface BannerLine {
  text: string;
  color?: string;
  dimColor?: boolean;
  bold?: boolean;
}
interface TranscriptBase {
  id: number;
  kind: 'user' | 'assistant' | 'tool' | 'system' | 'blocked' | 'error' | 'banner' | 'reasoning' | 'finding';
  text: string;
  color?: string;
  dimColor?: boolean;
  bold?: boolean;
  meta?: string;
  /** Continuation block of a multi-block streamed answer — hug the previous block (gap 0). */
  tight?: boolean;
  /** Finding card title (kind === 'finding'). */
  title?: string;
  /** Finding card severity (kind === 'finding'). */
  severity?: 'info' | 'warn' | 'error';
  /** Grouped multi-line content rendered inside ONE box (welcome banner, /model, /help). */
  lines?: BannerLine[];
  /** v2 structured payloads consumed by flattenItem. `text`/`lines` remain the plain
   *  fallback the stock Ink components read, so both paths stay in sync. */
  brand?: BrandInfo;
  tool?: ToolInfo;
}
type TranscriptItem = TranscriptBase;
// Idle-countdown config: when the model asks a question and the user is away, auto-pick the
// recommended answer after this many seconds — like every other TUI's "(default in Ns)" prompt.
// `SHADOW_AUTO_ANSWER_SECS` overrides the delay; `SHADOW_NO_AUTO_ANSWER=1` turns it off (the
// dialog then waits indefinitely, the old behavior). Never applies to permission gates. The pure
// question/answer helpers (recommendedIndex, buildAutoAnswers, …) live in ./tui/questions.ts.
const AUTO_ANSWER_SECS = (() => {
  const n = Number(process.env.SHADOW_AUTO_ANSWER_SECS);
  return Number.isFinite(n) && n >= 3 ? Math.floor(n) : 60;
})();
const AUTO_ANSWER_ENABLED = process.env.SHADOW_NO_AUTO_ANSWER !== '1';

// ── Interactive approval gate ────────────────────────────────────────────────
/**
 * Bridges the headless loop's `ApprovalGate` contract to the React UI: `request`
 * surfaces the pending call to the component (via `show`) and parks a Promise;
 * the key handler calls `respond` to resolve it. One stable instance is shared
 * by the loop and the key handler (kept in a ref) so respond() always targets
 * the Promise the running loop is awaiting.
 */
class InteractiveGate implements ApprovalGate {
  private resolver: ((d: ApprovalDecision) => void) | null = null;
  /** Wired by the component to set/clear the pending-approval state. */
  show: (req: ApprovalRequest | null) => void = () => {};

  request(req: ApprovalRequest): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      this.resolver = resolve;
      this.show(req);
    });
  }

  respond(d: ApprovalDecision): void {
    const r = this.resolver;
    this.resolver = null;
    this.show(null);
    r?.(d);
  }

  get awaiting(): boolean {
    return this.resolver !== null;
  }
}

export interface TuiOpts {
  provider: Provider;
  registry: ToolRegistry;
  bus: EventBus;
  context: Context;
  sessionLog: SessionLog;
  forceConfirm?: (call: ToolCall, risk: string) => string | null;
  system: string;
  workspaceRoot: string;
  cfg: ShadowConfig;
  autonomy: AutonomyLevel;
  bypass: boolean; // --yolo
  offline?: boolean; // --offline (Offline Shadow Mode)
  version: string;
  styleState?: TuiStyleState;
  todoList?: TodoList;
  planMode?: PlanModeState;
  wakeupHandler?: { fire: (task: string, reason: string) => void };
  /** Extra granted roots (--add-dir / additionalDirectories) — widens jail + shell sandbox. */
  additionalRoots?: string[];
  /** Called on a live /model switch so the `agent` tool spawns sub-agents on the NEW model,
   *  not the startup one (which, on a single-model-at-a-time local box, may be an unloaded port). */
  onModelSwitch?: (provider: Provider, model: string) => void;
}

// Big "SHADOW" wordmark (figlet "big"). MUST be a PLAIN template literal, NOT String.raw: Bun's
// --compile bundler ASCII-escapes the block glyphs to \uXXXX, and String.raw would then keep that
// escape LITERAL (the binary printed "██…" instead of the wordmark). A plain template
// evaluates the escapes back to the real characters, so it renders under both Bun and Node.
const SHADOW_ART = `███████╗██╗  ██╗ █████╗ ██████╗  ██████╗ ██╗    ██╗
██╔════╝██║  ██║██╔══██╗██╔══██╗██╔═══██╗██║    ██║
███████╗███████║███████║██║  ██║██║   ██║██║ █╗ ██║
╚════██║██╔══██║██╔══██║██║  ██║██║   ██║██║███╗██║
███████║██║  ██║██║  ██║██████╔╝╚██████╔╝╚███╔███╔╝
╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝  ╚═════╝  ╚══╝╚══╝`.split('\n');

/**
 * One-time welcome card. On a wide terminal it spans the full width with build
 * info on the left and the big SHADOW wordmark on the right; on a narrow terminal
 * it falls back to a compact stacked card so the logo never wraps or clips.
 * Printed once (Static) and scrolls away as you work.
 */
function useTerminalSize(): { cols: number; rows: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    cols: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  });
  useEffect(() => {
    const apply = () =>
      setSize({ cols: stdout?.columns ?? 80, rows: stdout?.rows ?? 24 });
    apply();
    stdout?.on?.('resize', apply);
    return () => {
      stdout?.off?.('resize', apply);
    };
  }, [stdout]);
  return size;
}

function Banner({ item, cols }: { item: TranscriptItem; cols: number }) {
  const lines = item.lines ?? [];
  const leftMax = Math.max(0, ...lines.map((l) => l.text.length));

  if (fitsWideBanner(cols, leftMax)) {
    // Wide: two-column — build info left, SHADOW logo right (only when both fit).
    return (
      <Box
        borderStyle="round"
        borderColor="cyan"
        paddingX={2}
        marginTop={1}
        flexDirection="row"
        justifyContent="space-between"
        width={cols}
      >
        <Box flexDirection="column" justifyContent="center" flexShrink={0}>
          {lines.map((l, i) => (
            <Text key={i} color={l.color ?? (l.dimColor ? C.dim : undefined)} bold={l.bold}>
              {l.text}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" flexShrink={0}>
          {SHADOW_ART.map((l, i) => (
            <Text key={i} color={C.cyan} bold>
              {l}
            </Text>
          ))}
        </Box>
      </Box>
    );
  }

  // Narrow fallback: compact stacked card. lines[0] is the version — pair it with the wordmark.
  const [version, ...rest] = lines;
  return (
    <Box flexDirection="column" width={cols} borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text color={C.cyan} bold>{`✻ Shadow ${version?.text ?? ''}`}</Text>
      {rest.map((l, i) => (
        <Text key={i} color={l.color ?? (l.dimColor ? C.dim : undefined)} bold={l.bold}>
          {l.text}
        </Text>
      ))}
    </Box>
  );
}

/**
 * A single transcript entry, de-boxed: plain scrolling text like the reference client, no
 * per-message border. The "you/assistant/tool" header label that the old bordered
 * card carried is gone, so a tool/denial row folds its tool name (meta) inline.
 */
/** Inline run: bold / italic / inline-code spans rendered within one line. */
function Inline({ spans, color, dim, bold }: { spans: MdSpan[]; color?: string; dim?: boolean; bold?: boolean }) {
  return (
    <Text color={dim ? C.dim : color} bold={bold}>
      {spans.map((s, i) => (
        <Text key={i} color={s.code ? C.cyan : dim ? C.dim : color} bold={bold || s.bold} italic={s.italic}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

/** Map a highlighter token role to a canvas color (comments are dimmed separately). */
function codeRoleColor(role: CodeRole): string | undefined {
  switch (role) {
    case 'keyword':
      return C.purple;
    case 'string':
      return C.green;
    case 'number':
      return C.yellow;
    case 'comment':
      return C.dim; // ADA-readable gray (was Ink dimColor faint, which blended into the bg)
    case 'plain':
    default:
      return undefined; // default foreground (white)
  }
}

/**
 * The chat canvas: render a (possibly still-streaming) markdown string as flowing
 * blocks — headings, paragraphs, lists, blockquotes, fenced code, rules — so every
 * model's chat reads like the reference client's. Plain text round-trips unchanged.
 */
/**
 * Split an accumulating markdown stream into completed top-level blocks plus the
 * still-incomplete trailing remainder.
 *
 * A block boundary is a blank line at the TOP level; blank lines inside an open
 * ``` code fence are ignored so a fenced block is never split. Completed blocks
 * are returned in order (to be committed to <Static> — the terminal's native
 * scrollback); the trailing partial block — an as-yet-unclosed fence, plus the
 * final line that has no newline after it — is returned as `rest` and kept in the
 * live region. Committing finished blocks as they land is what keeps the live
 * region (and the input composer pinned below it) from growing with the answer.
 */
export function extractCompleteBlocks(buf: string): { blocks: string[]; rest: string } {
  const parts = buf.split('\n');
  const blocks: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    // The final element has no trailing newline in `buf` — it is still streaming,
    // so it always belongs to the live remainder, never to a committed block.
    if (i === parts.length - 1) {
      cur.push(line);
      break;
    }
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      cur.push(line);
      continue;
    }
    if (!inFence && line.trim() === '') {
      // Top-level blank line → block boundary. Emit the block and drop the blank
      // separator (TranscriptRow supplies spacing between committed blocks).
      if (cur.length) {
        blocks.push(cur.join('\n'));
        cur = [];
      }
      continue;
    }
    cur.push(line);
  }
  return { blocks, rest: cur.join('\n') };
}

/**
 * Like {@link extractCompleteBlocks} but commits at LINE granularity for the smoothest, most stable
 * composer (the reference clients feel): a completed PROSE / heading / rule line is flushed to
 * native scrollback immediately, so the live region shrinks to just the line currently being typed
 * and the input barely moves. Multi-line constructs that MUST render as a unit — fenced code, lists,
 * blockquotes, and pipe/table runs — are kept grouped and flushed only when the construct ends (a
 * blank line, or a line that breaks the run), exactly as parseMarkdown gathers them, so nothing
 * misrenders. The still-typing final line (and any open construct) stays in `rest` (the live region).
 *
 * Each unit carries `pad` — whether it must render with a gap before it. The rule mirrors the
 * NON-streamed Markdown renderer exactly (which puts one blank between EVERY block pair): a unit is
 * padded when (a) a top-level blank line preceded it, (b) it is itself a distinct block (heading,
 * rule, list, quote, table, fence), or (c) the previous unit was one — only prose-after-prose hugs,
 * because consecutive prose source lines ARE one paragraph (parseMarkdown joins them). This keeps
 * streamed and non-streamed output byte-for-byte identical in rhythm, with no dependence on where
 * the stream happened to be cut. Dropping every separator used to glue ALL blocks into a wall of
 * text — the #1 "cluttered output" complaint.
 * `startPadded` seeds the state from the PREVIOUS delta batch (the caller persists `trailingBlank`
 * across calls in a ref — it covers both a consumed blank AND a committed block at a batch seam).
 * (Only edge case: an inline emphasis span that straddles a hard line break renders literally;
 * vanishingly rare in chat output.)
 */
export interface CommitUnit {
  text: string;
  /** Render with a gap before this unit (blank line in source, or a block boundary). */
  pad: boolean;
}
/** Is this unit a distinct markdown BLOCK (anything but a plain paragraph)? Classified by
 *  parseMarkdown ITSELF — the renderer's parser is the single source of truth, so the streamed
 *  gap rhythm can never drift from the non-streamed render (hand-rolled regex copies did drift:
 *  looser fence opens, trimmed list tests, pipe-prose misread as tables). */
function isBlockUnit(text: string): boolean {
  return parseMarkdown(text).some((b) => b.type !== 'paragraph');
}
/** Strip trailing NEWLINES only — never trimEnd() a committed unit. Trailing spaces are semantic
 *  in markdown ("- " is an empty list item; trimEnd turned it into a stray "-" paragraph). */
export function stripTrailingNewlines(text: string): string {
  return text.replace(/[\r\n]+$/, '');
}
/** Normalize an assistant block to letters+digits (lowercased) for duplicate detection — so a
 *  repeat that differs only by a trailing emoji, punctuation, or whitespace still matches. */
export function dupKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}
/**
 * TURN-SCOPED verbatim-repeat detection for assistant blocks. Weak local models re-emit their whole
 * answer (which may be MULTIPLE blocks) verbatim in one generation. `run` is the ordered dupKeys of
 * assistant blocks committed THIS turn; `pos` is the position inside a detected repeat (0 = not in
 * one). Given the next block's dupKey, returns whether to SUPPRESS it and the new (run, pos).
 *
 * Only WHOLE-block exact (normalized) matches count — no prefix fuzz — so legitimate content is
 * never silently dropped, and the scope is the current turn only, so an identical short answer in a
 * LATER turn ("Done.") still commits. Blocks shorter than 12 normalized chars are never deduped.
 * This replaces isDuplicateBlock, which (a) compared only against the single most-recent block so a
 * multi-block repeat printed twice, and (b) matched across ALL turns + used an 0.8 prefix, dropping
 * legitimate content (a blank turn).
 */
export function repeatStep(run: string[], pos: number, key: string): { suppress: boolean; run: string[]; pos: number } {
  if (key.length < 12) return { suppress: false, run: [...run, key], pos: 0 };
  if (pos > 0) {
    if (run[pos] === key) {
      const next = pos + 1;
      return { suppress: true, run, pos: next >= run.length ? 0 : next };
    }
    return { suppress: false, run: [...run, key], pos: 0 }; // repeat broken → real new content
  }
  if (run.length > 0 && run[0] === key) {
    return { suppress: true, run, pos: run.length > 1 ? 1 : 0 }; // the answer is restarting
  }
  return { suppress: false, run: [...run, key], pos: 0 };
}

/** Which optional live-frame rows fit, and the composer hint. See fitHud. */
export interface HudFit {
  liveRows: number;   // height of the streaming preview region (0..liveWant)
  status: boolean;    // the 'working… Ns' / spacer line above the composer
  pinned: boolean;    // the 1-row pinned goal/task summary while running
  queued: boolean;    // the type-ahead queue line
  custom: boolean;    // the customStatus (/statusline) strip
  hint: boolean;      // the composer's keybinding hint row
  marginTop: boolean; // the blank spacer above the composer group
  strip: boolean;     // the main status strip
  height: number;     // total live-frame height this produces (always < rows for rows >= 4)
}

/**
 * Bound the LIVE (non-<Static>) frame so its height stays STRICTLY below `rows`. Ink wipes the whole
 * screen + scrollback and re-dumps the entire transcript on EVERY render when `outputHeight >= rows`
 * (node_modules/ink/build/ink.js:121) — the flicker/duplication you get on a short or split-pane
 * terminal. The composer's input + its two borders (3 rows) are mandatory; every other row is added
 * only while it still fits under `rows - 1`, in priority order, so as the terminal shrinks the least
 * important rows drop first (custom status → queued → pinned → margin → live preview → status line →
 * strip → hint) and the frame never reaches the terminal height. Pure; the invariant is unit-tested.
 */
export function fitHud(
  rows: number,
  want: { liveWant: number; pinned: boolean; queued: boolean; custom: boolean },
): HudFit {
  const cap = rows - 1; // outputHeight must be <= rows - 1 to stay under Ink's wipe threshold
  const f: HudFit = {
    liveRows: 0, status: false, pinned: false, queued: false, custom: false,
    hint: false, marginTop: false, strip: false, height: 3,
  };
  // Added high-priority → low: whatever doesn't fit as the terminal shrinks drops from the bottom of
  // this list first (cosmetic blank spacer goes first, then custom status, queued, pinned, …).
  // `liveWant` is the desired streaming-preview height (0 when there's nothing live to show).
  const add = (n: number, on: () => void): void => { if (f.height + n <= cap) { f.height += n; on(); } };
  add(1, () => (f.strip = true));   // status strip: model / mode / context / tokens
  add(1, () => (f.status = true));  // 'working…' status line (liveness)
  for (let i = 0; i < want.liveWant; i++) add(1, () => (f.liveRows += 1)); // streaming preview
  add(1, () => (f.hint = true));    // composer hint (keybindings)
  if (want.pinned) add(1, () => (f.pinned = true));  // goal / task summary
  if (want.queued) add(1, () => (f.queued = true));
  if (want.custom) add(1, () => (f.custom = true));
  add(1, () => (f.marginTop = true)); // cosmetic blank above the composer — first to go
  return f;
}

/** Does this text START with a distinct markdown block? Used by the leftover-commit sites
 *  (assistant_done / stop / error teardown) to space a block leftover correctly. */
export function leadsWithBlock(text: string): boolean {
  const first = parseMarkdown(text)[0];
  return first !== undefined && first.type !== 'paragraph';
}
export function extractCommittableUnits(
  buf: string,
  startPadded = false,
): { units: CommitUnit[]; rest: string; trailingBlank: boolean } {
  const lines = buf.split('\n');
  const n = lines.length;
  const units: CommitUnit[] = [];
  let pending: string[] = []; // an open multi-line construct, held until it completes
  let fenceChar: string | null = null; // the marker that OPENED the current fence (``` vs ~~~)
  let padNext = startPadded; // gap owed to the next unit (blank line or block boundary behind us)
  // Line-level grouping policy uses the PARSER'S OWN regexes (imported), so what we hold together
  // is exactly what parseMarkdown renders together. Pipe lines are held so a real table commits
  // whole; if the run turns out to be pipe-bearing PROSE, isBlockUnit classifies it back to a
  // paragraph and it renders tight — no phantom gaps around shell pipelines or type unions.
  const grouped = (line: string): boolean =>
    MD_LIST_ITEM.test(line) || MD_QUOTE.test(line) || line.includes('|');
  const push = (text: string): void => {
    // A distinct block pads itself AND owes a pad to whatever follows it — exactly the
    // marginTop-between-every-block-pair behavior of the non-streamed Markdown render.
    const block = isBlockUnit(text);
    units.push({ text, pad: padNext || block });
    padNext = block;
  };
  const flush = (): void => {
    if (!pending.length) return;
    // A pipe RUN can be pipe-bearing PROSE followed by a real table ("see `a | b` output:" then a
    // table) — one mixed unit would pad the prose half as if it were a block, diverging from the
    // parser (which joins that prose into the surrounding paragraph). Split the run at each table
    // START (a pipe line whose next line is a separator — parseMarkdown's own rule) so every piece
    // classifies as exactly what the parser sees.
    const held = pending;
    pending = [];
    // Split AT MOST ONCE, at the FIRST table start: once a table begins, parseMarkdown consumes
    // every subsequent pipe line as a body row (even separator-looking ones), so splitting again
    // inside the run would fabricate a second table the parser doesn't see.
    let splitAt = -1;
    for (let j = 0; j < held.length - 1; j++) {
      if (held[j]!.includes('|') && isTableSeparator(held[j + 1]!)) {
        splitAt = j;
        break;
      }
    }
    // splitAt === 0 → the run IS the table from its first line: no prose part, never split
    // (later separator-shaped rows are body content of THIS table, not a second header).
    if (splitAt > 0) {
      push(held.slice(0, splitAt).join('\n')); // the pipe-bearing PROSE part → classifies paragraph
      push(held.slice(splitAt).join('\n')); // the table (header + separator + all body rows)
    } else {
      push(held.join('\n'));
    }
  };

  // Every element except the last had a trailing newline in `buf` (a COMPLETE line); the last element
  // is still being typed and always stays live.
  for (let i = 0; i < n - 1; i++) {
    const line = lines[i]!;
    if (fenceChar !== null) {
      pending.push(line);
      // Close ONLY on a full fence line of the SAME marker (parseMarkdown's exact rule): a ``` inside
      // a ~~~ block is literal content, and `inline-code` at line start must not close anything.
      if (MD_FENCE.test(line) && line.trim().startsWith(fenceChar)) {
        fenceChar = null;
        flush(); // fence closed → commit the whole block
      }
      continue;
    }
    const fence = MD_FENCE.exec(line);
    if (fence) {
      flush();
      fenceChar = fence[1]![0]!;
      pending.push(line);
      continue;
    }
    if (line.trim() === '') {
      flush(); // blank line ends a construct; remember it so the NEXT unit renders with a gap
      padNext = true;
      continue;
    }
    if (grouped(line)) {
      pending.push(line);
      continue;
    }
    flush();
    // A standalone line commits right away; isBlockUnit (via parseMarkdown) decides whether it is
    // a heading/rule (block → gaps) or plain prose (paragraph continuation → hugs).
    push(line);
  }

  const tail = lines[n - 1] ?? '';
  // The `pending` lines were COMPLETE (each had a trailing newline in `buf`), so keep that newline
  // before the still-typing tail — otherwise carrying `rest` forward across deltas would glue the next
  // line onto a held construct (merging list items, or breaking a fence's closing ``` onto the code).
  const rest = pending.length ? pending.join('\n') + '\n' + tail : tail;
  // padNext survives to the caller: it covers a consumed blank OR a just-committed block at the batch
  // seam. A pending construct re-parses next call and owns its pad via this same seed.
  return { units, rest, trailingBlank: padNext };
}

/**
 * Bound `src` to its last `maxLines` lines so a still-open block (e.g. a long
 * code fence mid-stream) cannot grow the live region without limit. If the kept
 * tail begins INSIDE an open code fence, re-open the fence (with its language) so
 * the renderer still applies code styling to the dangling lines.
 */
export function clampTail(src: string, maxLines: number): string {
  if (maxLines <= 0) return src;
  const lines = src.split('\n');
  if (lines.length <= maxLines) return src;
  const tail = lines.slice(-maxLines);
  // Only the DROPPED head lines determine whether the tail begins inside an open fence.
  // Scanning the tail too would double-count an opener that is still present in the tail
  // and prepend a spurious second ``` (an empty code block + plain-text code).
  const head = lines.slice(0, lines.length - tail.length);
  let open = false;
  let lang = '';
  for (const line of head) {
    const m = /^\s*```(.*)$/.exec(line);
    if (m) {
      open = !open;
      lang = open ? m[1].trim() : '';
    }
  }
  return open ? '```' + lang + '\n' + tail.join('\n') : tail.join('\n');
}

/** Cap assistant prose to a readable measure so lines don't run edge-to-edge on wide terminals,
 *  and cap it IDENTICALLY for the streaming and committed renders so a finished turn never reflows.
 *  The `width` prop now constrains the whole block (previously it only reached table layout, so prose
 *  wrapped at the full pane width). */
const PROSE_MAX_COLS = 100;
/** Left/right page margin for transcript content — floats content off the terminal edges
 *  like the reference client instead of running flush to column 1. */
const PAGE_MARGIN = 4;
const MARGIN_PAD = ' '.repeat(PAGE_MARGIN);

/** The single palette handed to flattenItem (the FlatItem stock renderer). `dim` is the
 *  EXPLICIT ADA gray — v2 rows use it for all de-emphasis instead of the banned faint attribute. */
const PIN_THEME = { fg: '#c9d2da', bright: '#ffffff', dim: C.dim, green: C.green, cyan: C.cyan, yellow: C.yellow, red: C.red, purple: C.purple, codeBg: '#2d333b' };

export function Markdown({ source, color = C.fg, width = PROSE_MAX_COLS }: { source: string; color?: string; width?: number }) {
  const blocks = parseMarkdown(source);
  return (
    <Box flexDirection="column" width={width}>
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'heading':
            return (
              <Box key={i} marginTop={i === 0 ? 0 : 1}>
                <Inline spans={b.spans} color={C.purple} bold />
              </Box>
            );
          case 'paragraph':
            return (
              <Box key={i} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
                {wrapSpans(b.spans, width).map((ln, k) => (
                  <Inline key={k} spans={ln} color={color} />
                ))}
              </Box>
            );
          case 'list': {
            // Mirror flatten.ts's list rendering so the LIVE preview matches the committed block: a
            // dedicated ordinal advances only for top-level ordered items (a nested bullet must not
            // inflate the next number), and depth drives the bullet glyph + indent.
            const bullets = ['•', '◦', '▪', '‣'];
            let ordinal = b.start ?? 1;
            return (
              <Box key={i} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
                {b.items.map((it, j) => {
                  const depth = b.depths?.[j] ?? 0;
                  const indent = '  '.repeat(depth);
                  const marker =
                    b.ordered && depth === 0
                      ? `${ordinal++}. `
                      : `${bullets[Math.min(depth, bullets.length - 1)]} `;
                  const lead = indent + marker;
                  const wrapped = wrapSpans(it, Math.max(1, width - lead.length));
                  return (
                    <Box key={j} flexDirection="column">
                      {wrapped.map((ln, k) => (
                        <Box key={k}>
                          <Text color={color}>{k === 0 ? lead : ' '.repeat(lead.length)}</Text>
                          <Inline spans={ln} color={color} />
                        </Box>
                      ))}
                    </Box>
                  );
                })}
              </Box>
            );
          }
          case 'quote':
            return (
              <Box key={i} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
                {wrapSpans(b.spans, Math.max(1, width - 2)).map((ln, k) => (
                  <Box key={k}>
                    <Text color={C.yellow}>│ </Text>
                    <Inline spans={ln} color={color} dim />
                  </Box>
                ))}
              </Box>
            );
          case 'code': {
            const spans = highlight(b.code || ' ', b.lang);
            return (
              <Box key={i} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginTop={i === 0 ? 0 : 1}>
                {b.lang ? <Text color={C.dim}>{b.lang}</Text> : null}
                <Text>
                  {spans.map((s, j) => (
                    <Text key={j} color={codeRoleColor(s.role)}>
                      {s.text}
                    </Text>
                  ))}
                </Text>
              </Box>
            );
          }
          case 'rule':
            return (
              <Box key={i} marginTop={i === 0 ? 0 : 1}>
                <Text color={C.dim}>{'─'.repeat(Math.max(1, width))}</Text>
              </Box>
            );
          case 'table': {
            // Content-sized box-drawing table; collapses to a vertical key:value layout when it
            // would exceed the terminal width (renderTableLines handles it). Border rules are
            // dimmed so the data reads first; the header row is bold.
            const lines = renderTableLines(b, width);
            const bordered = lines[0]?.startsWith('┌') ?? false;
            return (
              <Box key={i} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
                {lines.map((l, j) => (
                  <Text key={j} color={/^[┌├└]/.test(l) ? C.dim : color} bold={bordered && j === 1}>
                    {l}
                  </Text>
                ))}
              </Box>
            );
          }
        }
      })}
    </Box>
  );
}

/** Large tool/diff output and reasoning are collapsible; everything else renders full.
 *  Collapsible items START collapsed; the `toggled` set flips them (Ctrl-O). */
// Fold a tool/process output block to its `⌄ output N lines · ^O` summary once it's more than a
// couple of lines — the reference client folds tool bodies by default (verbose off), so a run_shell / grep /
// read doesn't dump a wall of output into the transcript. 1–3 line results still show inline.
const COLLAPSE_THRESHOLD = 3;
function transcriptLineCount(item: TranscriptItem): number {
  if (item.lines) return item.lines.length;
  if (typeof item.text === 'string' && item.text) return item.text.split('\n').length;
  return 1;
}
function isCollapsible(item: TranscriptItem): boolean {
  if (item.kind === 'reasoning') return true;
  if (item.kind === 'tool' || item.kind === 'blocked') return transcriptLineCount(item) > COLLAPSE_THRESHOLD;
  return false;
}

/** Pinned agent state — a light, full-width block above the composer: a dim top
 *  rule, a one-line header (plan mode/title + task count), the todo items marked
 *  ✔/▶/·, then a closing rule. No borders, so it reads as part of the flow rather
 *  than a crowding card, and (unlike the old side panel) never sits beside <Static>. */
function PinnedState({
  goal,
  plan,
  todos,
  showPlan,
  showTodo,
  collapsed,
  cols,
  maxItems,
}: {
  goal: string | null;
  plan: PlanSnapshot;
  todos: TodoItem[];
  showPlan: boolean;
  showTodo: boolean;
  collapsed: boolean;
  cols: number;
  /** Terminal-height-aware cap on visible todo rows (block chrome ≈ 6 rows worst case), so the
   *  idle pinned block can never push the live frame to terminal height on short terminals. */
  maxItems?: number;
}) {
  const planActive = plan.mode === 'planning';
  const done = todos.filter((t) => t.status === 'completed').length;
  const planLabel = showPlan
    ? `${planActive ? 'Plan mode' : 'Implement mode'}${plan.title ? ` — ${plan.title}` : ''}`
    : '';
  const todoLabel = showTodo
    ? `${collapsed ? '▸' : '▾'} Task list ${done}/${todos.length}${collapsed ? ' · Ctrl-T' : ''}`
    : '';
  // todoLabel FIRST: the row truncates right, and the task count must survive a verbose plan title.
  const header = [todoLabel, planLabel].filter(Boolean).join('   ·   ');
  const rule = '─'.repeat(Math.max(8, cols));
  const MAX = maxItems ?? 8;
  const shown = todos.slice(0, MAX);
  const mark = (s: TodoItem['status']) => (s === 'completed' ? '✔' : s === 'in_progress' ? '▶' : '·');
  const itemColor = (s: TodoItem['status']) =>
    s === 'in_progress' ? C.yellow : s === 'completed' ? 'gray' : undefined;
  return (
    // Every row below is wrap="truncate": this block sits in the LIVE frame, whose height budget
    // counts physical rows. A model-written 70-char todo subject (or long goal / plan path)
    // wrapping to 2+ rows on a narrow terminal blew the budget and re-armed Ink's scrollback-
    // wiping clearTerminal fallback — maxItems bounds item COUNT, truncation bounds each row.
    <Box flexDirection="column" flexShrink={0} marginTop={1} width={cols}>
      <Text color={C.dim}>{rule}</Text>
      {goal ? <Text wrap="truncate" bold color={C.purple}>{`🎯 Goal: ${goal}`}</Text> : null}
      {header ? (
        <Text wrap="truncate" bold color={planActive ? C.yellow : C.green}>
          {header}
        </Text>
      ) : null}
      {showPlan && plan.path ? <Text wrap="truncate" color={C.dim}>{shortPath(plan.path)}</Text> : null}
      {showTodo && !collapsed
        ? shown.map((item) => (
            <Text key={item.id} wrap="truncate" color={item.status === 'completed' ? C.dim : itemColor(item.status)}>
              {` ${mark(item.status)} ${item.subject}`}
            </Text>
          ))
        : null}
      {showTodo && !collapsed && todos.length > MAX ? (
        <Text italic color={C.dim}>{`   … +${todos.length - MAX} more`}</Text>
      ) : null}
      <Text color={C.dim}>{rule}</Text>
    </Box>
  );
}

function StatusStrip({ text, marker }: { text: string; marker?: { text: string; color: string } }) {
  return (
    // wrap="truncate": the strip is budgeted at exactly ONE row. A verbose /statusline command
    // (customStatus renders through this too) used to wrap to several rows on narrow terminals,
    // silently blowing the frame budget and re-triggering Ink's scrollback-wiping fallback.
    <Box paddingX={1}>
      <Text wrap="truncate" color={C.dim}>
        {marker ? (
          <Text color={marker.color} bold>
            {marker.text + ' · '}
          </Text>
        ) : null}
        {text}
      </Text>
    </Box>
  );
}

/** Empty-composer placeholder — a dim prompt, not an example that could be mistaken for real input. */
const COMPOSER_PLACEHOLDER = 'Send a message…  ( / for commands )';

function Composer({
  input,
  cursor,
  hint,
  showHint = true,
  borderColor = C.dim,
  placeholder = COMPOSER_PLACEHOLDER,
}: {
  input: string;
  cursor: number;
  hint: string;
  /** Drop the hint row on a very short terminal to keep the composer at 3 rows (rule+input+rule). */
  showHint?: boolean;
  /** Mode tint for the composer rules: dim at rest, cyan running, yellow in plan mode. */
  borderColor?: string;
  placeholder?: string;
}) {
  const caret = Math.min(cursor, input.length);
  const empty = input.length === 0;
  return (
    <Box flexDirection="column" flexShrink={0}>
      {/* Open-sided input: a top and bottom rule with NO left/right edges — the field reads as a
          band in the flow, not a popped-up box. The chevron is a neutral dim gray (it brightens
          only via the mode-tinted rules around it), so an idle prompt doesn't shout. */}
      <Box borderStyle="single" borderColor={borderColor} borderLeft={false} borderRight={false} paddingX={0}>
        <Text>
          <Text color={C.dim}>{'❯ '}</Text>
          {empty ? (
            <>
              <Text inverse> </Text>
              <Text color={C.dim}>{placeholder}</Text>
            </>
          ) : (
            <>
              {input.slice(0, caret)}
              <Text inverse>{input.slice(caret, caret + 1) || ' '}</Text>
              {input.slice(caret + 1)}
            </>
          )}
        </Text>
      </Box>
      {/* Hint sits BELOW the bottom rule (outside the field). wrap="truncate": it is budgeted at ONE
          row; at cols < ~74 the running-state hint wrapped to 2, eating the frame headroom. */}
      {showHint ? (
        <Text wrap="truncate" color={C.dim}>
          {hint}
        </Text>
      ) : null}
    </Box>
  );
}

/**
 * Render a committed transcript item using the v2 flatten output (the SAME styling the pinned
 * renderer produces: ✦ brand, one-row tool results, ADA markdown), but as plain Ink <Text> rows
 * inside <Static>. This is the reference-client architecture — Ink owns the cursor and native scrollback, so the
 * whole scroll-region/absolute-paint bug class is structurally impossible — with the v2 look intact.
 * A left page margin (PAGE_MARGIN) insets content off the terminal edge.
 */
function FlatItem({ item, cols, collapsed, continuation = false }: { item: TranscriptItem; cols: number; collapsed: boolean; continuation?: boolean }) {
  const inner = Math.max(20, cols - PAGE_MARGIN * 2);
  const w = item.kind === 'banner' ? inner : Math.min(inner, PROSE_MAX_COLS);
  const lines = flattenItem(item as Parameters<typeof flattenItem>[0], w, collapsed, PIN_THEME, continuation);
  return (
    <Box flexDirection="column" paddingLeft={PAGE_MARGIN}>
      {lines.map((ln) => {
        const empty = ln.spans.every((s) => s.text === '');
        if (empty) return <Text key={ln.key}> </Text>; // preserve block-gap blank lines
        return (
          <Text key={ln.key} wrap="truncate">
            {ln.spans.map((s, i) => (
              <Text
                key={i}
                color={s.color ?? (s.dim ? C.dim : undefined)}
                backgroundColor={s.bg}
                bold={s.bold}
                italic={s.italic}
              >
                {s.text}
              </Text>
            ))}
          </Text>
        );
      })}
    </Box>
  );
}

// DiffPanel removed — diffs now render as a single collapsible transcript item
// (see the tool_end handler); no separate always-expanded live panel to flood the view.

// ── Main TUI component ────────────────────────────────────────────────────────
export function TuiApp({ opts }: { opts: TuiOpts }) {
  const { exit } = useApp();
  const { bus, context, sessionLog } = opts;
  const [style, setStyle] = useState<OutputStyle>(opts.styleState?.style ?? opts.cfg.lastStyle ?? 'proactive');

  const terminalSize = useTerminalSize();
  const [committed, setCommitted] = useState<TranscriptItem[]>([]);
  // (No live-banner state: the welcome card commits to <Static> once at startup — see showBanner.)
  const [showAllExpanded, setShowAllExpanded] = useState(false); // Ctrl-O: reveal ALL collapsible blocks (global, not per-item)
  const [stream, setStream] = useState('');
  const [think, setThink] = useState(''); // live extended-reasoning text (dim, cleared per step)
  // Uncommitted tail of the streaming answer: completed markdown blocks are flushed to
  // <Static> as they finish (see the 'text' event), leaving only this in-progress block
  // in `stream` so the live region — and the composer below it — never grows with the answer.
  const streamBufRef = useRef('');
  // Has the current answer already committed at least one block? Drives `tight` so the
  // 2nd…Nth blocks of one reply hug, and gates the e.text fallback on assistant_done.
  const answerOpenRef = useRef(false);
  // A top-level blank line was consumed at the end of the last delta batch — the NEXT committed
  // unit must render with a gap (extractCommittableUnits trailingBlank → startPadded round-trip),
  // so a paragraph break that lands exactly on a batch boundary is never lost.
  const padCarryRef = useRef(false);
  // Delta throttle: streaming providers emit text/thinking deltas faster than the terminal can
  // paint, which drops frames. Accumulate every delta synchronously into refs (no token lost) but
  // coalesce the re-render to ~30ms. setStreamNow/setThinkNow apply a value immediately AND drop
  // any pending flush, so a clear (turn end, /clear) can't be undone by a late timer.
  const thinkBufRef = useRef('');
  const pendingStreamRef = useRef<string | null>(null);
  const pendingThinkRef = useRef<string | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      if (pendingStreamRef.current !== null) {
        setStream(pendingStreamRef.current);
        pendingStreamRef.current = null;
      }
      if (pendingThinkRef.current !== null) {
        setThink(pendingThinkRef.current);
        pendingThinkRef.current = null;
      }
    }, 30);
  }, []);
  const setStreamNow = useCallback((v: string) => {
    pendingStreamRef.current = null;
    streamBufRef.current = v;
    setStream(v);
  }, []);
  const setThinkNow = useCallback((v: string) => {
    pendingThinkRef.current = null;
    thinkBufRef.current = v;
    setThink(v);
  }, []);
  useEffect(() => () => void (flushTimerRef.current && clearTimeout(flushTimerRef.current)), []);
  const [toolLine, setToolLine] = useState<string | null>(null);
  // The tool currently executing — rendered as a persistent live ⏺ Name(args) row that appears the
  // instant the call starts and resolves in place (into the committed green/red ⏺ row) on tool_end.
  const [activeTool, setActiveTool] = useState<{ name: string; arg: string } | null>(null);
  const [shellPid, setShellPid] = useState<number | null>(null); // active run_shell child, for the HUD
  const [shellWarn, setShellWarn] = useState<string | null>(null); // set when that child may survive ESC
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('0 tokens');
  const [pending, setPending] = useState<ApprovalRequest | null>(null);
  const [questionIndex, setQuestionIndexState] = useState(0);
  const [questionSelections, setQuestionSelectionsState] = useState<QuestionSelection>({});
  const [questionCursor, setQuestionCursorState] = useState<Record<number, number>>({}); // highlighted option per question
  const [autoAnswerSecs, setAutoAnswerSecs] = useState<number | null>(null); // idle countdown to auto-pick recommended
  const [autonomy, setAutonomyState] = useState<AutonomyLevel>(opts.autonomy);
  const [effort, setEffortState] = useState<Effort>(effortOrDefault(opts.cfg.effort));
  const [todoItems, setTodoItems] = useState<TodoItem[]>([]);
  const [planMode, setPlanMode] = useState<PlanSnapshot>(opts.planMode?.snapshot() ?? { mode: 'implement' });
  const [goal, setGoal] = useState<string | null>(null); // standing objective (/goal); injected into system each turn
  const [tick, setTick] = useState(0);
  const runStartRef = useRef(0); // wall-clock start of the current turn, for the elapsed timer
  const [menuIndex, setMenuIndex] = useState(0); // selected row in the slash-command menu
  const [cursor, setCursor] = useState(0); // caret position within the composer input
  const [current, setCurrent] = useState({ provider: opts.cfg.provider, model: opts.cfg.model }); // live model (for the footer + /model)
  const [pickerOpen, setPickerOpen] = useState(false); // model-picker has focus
  const [pickerIndex, setPickerIndex] = useState(0); // selected row in the model picker
  // Type-ahead queue: messages/slash-commands submitted WHILE a turn is running are
  // pushed here (FIFO) instead of interrupting the turn; the queue is flushed in order
  // when the turn ends. `queued` mirrors the ref for the live "queued" indicator.
  const queuedTasksRef = useRef<string[]>([]);
  const [queued, setQueuedState] = useState<string[]>([]);
  const setQueued = useCallback((next: string[]) => {
    queuedTasksRef.current = next;
    setQueuedState(next);
  }, []);
  const [todoCollapsed, setTodoCollapsed] = useState(false); // pinned task list folded to its header (Ctrl-T)
  // The transcript is an Ink <Static> that owns the terminal's NATIVE scrollback
  // (mouse-wheel / scrollbar work, reference-client style). `staticEpoch` is bumped to
  // force a re-flush when committed items must repaint (Ctrl-O collapse, /clear).
  const [staticEpoch, setStaticEpoch] = useState(0);
  // ── Hard reflow (user-initiated folds only) ──────────────────────────────────
  // On an explicit fold toggle (Ctrl-O collapses/expands a committed item, Ctrl-T folds the
  // task list) the committed transcript's rendered state must change, so we remount <Static>
  // (via staticEpoch) to re-emit it. The visible SCREEN is wiped first (2J + home, deliberately
  // NOT \x1b[3J — 3J would destroy the user's entire terminal scrollback, including everything
  // from before shadow started). Known tradeoff: each fold pushes one re-emitted transcript copy
  // into native scrollback — rare and user-initiated, far kinder than nuking history.
  //
  const hardReflow = useCallback(() => {
    const out = process.stdout;
    // Wipe screen AND scrollback (2J+3J) before the <Static> remount re-emits the FULL committed
    // transcript. Previously this used 2J only (to preserve scrollback), but that left the pre-fold
    // copy of the whole conversation stacked ABOVE the re-emitted one — every Ctrl-O/Ctrl-T pushed a
    // duplicate into native scrollback. Since the transcript is fully re-emitted from `committed`,
    // clearing scrollback loses nothing but the stale copies (and the pre-launch history we already
    // clear at startup). The epoch bump is the functional part; the wipe just avoids visible stacking.
    if (out.isTTY) out.write('\x1b[2J\x1b[3J\x1b[H');
    setStaticEpoch((n) => n + 1);
  }, []);
  // Task-list collapse/expand (Ctrl-T) shrinks/grows the pinned block — reflow so the
  // composer re-locks to the bottom instead of leaving (or jumping over) a blank gap.
  // Skip the first run (mount) so startup doesn't wipe the freshly drawn banner.
  const didMountReflowRef = useRef(false);
  useEffect(() => {
    if (!didMountReflowRef.current) {
      didMountReflowRef.current = true;
      return;
    }
    hardReflow();
  }, [todoCollapsed, hardReflow]);
  // RESIZE → debounced reflow. When cols/rows change, the terminal rewraps the already-printed
  // <Static> lines, but Ink erases its live frame against its OWN tracked geometry (now stale) and
  // leaves the previous composer/rules STRANDED on screen — the "ghost composer" a resize leaves
  // behind. A hardReflow (2J+3J wipe + <Static> remount) repaints everything clean at the new width;
  // the 3J clears scrollback so the re-emit can't duplicate (the reason resize-reflow was originally
  // disabled — no longer true). Debounced so a click-drag (a burst of resize events) reflows ONCE,
  // after it settles, not on every intermediate size. Mount is skipped (banner already drawn).
  const didFirstSizeRef = useRef(false);
  const resizeReflowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!didFirstSizeRef.current) {
      didFirstSizeRef.current = true;
      return;
    }
    if (resizeReflowTimer.current) clearTimeout(resizeReflowTimer.current);
    resizeReflowTimer.current = setTimeout(() => hardReflow(), 120);
    return () => {
      if (resizeReflowTimer.current) clearTimeout(resizeReflowTimer.current);
    };
  }, [terminalSize.cols, terminalSize.rows, hardReflow]);
  const lastUsageRef = useRef<{ inputTokens: number; outputTokens: number; costUSD: number; contextPct: number } | null>(null);
  const costWarnedRef = useRef(false);
  // Session-level cost accumulation. The per-turn Budget resets each turn, so we
  // sum deltas across turns: prevTurnCost holds the last seen costUSD within the
  // current turn (reset at turn start) so per-turn increases are counted once.
  const sessionCostRef = useRef(0);
  const prevTurnCostRef = useRef(0);

  // Refs for values read inside the (stable) key handler / async loop, to avoid
  // stale closures without re-subscribing on every render.
  const lineId = useRef(0);
  const committedRef = useRef<TranscriptItem[]>([]);
  // Turn-scoped verbatim-repeat detection (see repeatStep): the ordered dupKeys of assistant blocks
  // committed THIS turn, and the position inside a detected repeat. Reset when the user starts a turn.
  const answerRunRef = useRef<string[]>([]);
  const repeatPosRef = useRef(0);
  /** Feed an assistant block through the repeat detector; returns true if it's a verbatim repeat to
   *  SUPPRESS. Mutates the run/pos refs. */
  const absorbAssistant = useCallback((text: string): boolean => {
    const r = repeatStep(answerRunRef.current, repeatPosRef.current, dupKey(text));
    answerRunRef.current = r.run;
    repeatPosRef.current = r.pos;
    return r.suppress;
  }, []);
  const autonomyRef = useRef(autonomy);
  const effortRef = useRef(effort);
  const runningRef = useRef(running);
  const pendingRef = useRef(pending);
  const questionIndexRef = useRef(0);
  const questionSelectionsRef = useRef<QuestionSelection>({});
  const questionCursorRef = useRef<Record<number, number>>({});
  const autoAnswerSecsRef = useRef<number | null>(null);
  const inputRef = useRef(input);
  const firstRef = useRef(true);
  const controllerRef = useRef<AbortController | null>(null);
  const loopRef = useRef<AgentLoop | null>(null);
  const ctrlCArmedRef = useRef(false);
  const historyRef = useRef<string[]>([]);
  const histIdxRef = useRef(0);
  const menuIndexRef = useRef(0);
  const cursorRef = useRef(0);
  // Big pastes are condensed to a `[Pasted text #N]` chip in the composer; the real content lives
  // here (session registry, kept for the whole session so a history re-run still resolves the chip)
  // and is spliced back in at submit via expandPastes.
  const pastesRef = useRef<{ id: number; content: string; lines: number }[]>([]);
  const pasteCounterRef = useRef(0);
  // Active model — `providerRef` is the live Provider OBJECT the next turn runs on;
  // `currentRef` mirrors the displayed {provider, model} NAMES for the key handler.
  const providerRef = useRef(opts.provider);
  const currentRef = useRef(current);
  const pickerOpenRef = useRef(false);
  const pickerIndexRef = useRef(0);
  const styleRef = useRef(style);
  const runOneRef = useRef<((task: string) => void) | null>(null);
  const selectModelRef = useRef<((entry: ModelEntry) => Promise<void>) | null>(null);
  const flushQueueRef = useRef<(() => void) | null>(null);
  const goalRef = useRef<string | null>(null);
  // Extra granted roots, mutable at runtime via /add-dir (seeded from startup config/--add-dir).
  // The loop deps re-read this ref each turn, so a grant takes effect on the next turn.
  const additionalRootsRef = useRef<string[]>([...(opts.additionalRoots ?? [])]);
  // Force-repaint counter for /theme (the palette is a mutated singleton, not React state).
  const [, setThemeTick] = useState(0);
  // Custom footer line from /statusline: the shell command (ref) and its latest output (state).
  const statusLineRef = useRef<string>(typeof opts.cfg.statusLine === 'string' ? opts.cfg.statusLine : '');
  const [customStatus, setCustomStatus] = useState('');
  // Vim modal editing (/vim). Refs drive the key handler; state drives the footer indicator.
  const vimEnabledRef = useRef<boolean>(opts.cfg.vimMode === true);
  const [vimEnabled, setVimEnabled] = useState<boolean>(opts.cfg.vimMode === true);
  const vimModeRef = useRef<VimMode>('insert'); // start in INSERT so typing works immediately
  const [vimModeState, setVimModeState] = useState<VimMode>('insert');
  const vimPendingRef = useRef(''); // operator awaiting a motion (d/c)
  // Images queued via /image, sent with (and cleared by) the next submitted message.
  const attachmentsRef = useRef<ImageBlock[]>([]);
  const [attachCount, setAttachCount] = useState(0);
  const setVimMode = useCallback((m: VimMode) => {
    vimModeRef.current = m;
    setVimModeState(m);
  }, []);
  // Apply the persisted theme synchronously on first render so there's no flash.
  const themeAppliedRef = useRef(false);
  if (!themeAppliedRef.current) {
    themeAppliedRef.current = true;
    const saved = normalizeThemeName(opts.cfg.lastTheme as string | undefined);
    if (saved) applyTheme(saved);
  }
  runningRef.current = running;
  pendingRef.current = pending;
  // NOTE: inputRef/cursorRef are deliberately NOT synced from state here. They are
  // written directly by setLine/setComposer and the caret/backspace handlers and are
  // the source of truth for the key handler. A per-render sync RACED the handler while
  // streaming — a stale-state render committed mid-keystroke and clobbered the ref —
  // which made typed text "stick" and backspace no-op while the model was thinking.
  menuIndexRef.current = menuIndex;
  currentRef.current = current;
  pickerOpenRef.current = pickerOpen;
  pickerIndexRef.current = pickerIndex;
  styleRef.current = style;
  goalRef.current = goal;

  // Set the composer text and move the caret to the end (history nav, autocomplete, clear).
  const setLine = useCallback((v: string) => {
    inputRef.current = v;
    cursorRef.current = v.length;
    setInput(v);
    setCursor(v.length);
  }, []);

  const setComposer = useCallback((nextInput: string, nextCursor: number) => {
    inputRef.current = nextInput;
    cursorRef.current = nextCursor;
    setInput(nextInput);
    setCursor(nextCursor);
  }, []);

  const setQuestionIndex = useCallback((next: number) => {
    questionIndexRef.current = Math.max(0, next);
    setQuestionIndexState(questionIndexRef.current);
  }, []);

  const setQuestionSelection = useCallback((idx: number, selected: string[]) => {
    const next = { ...questionSelectionsRef.current, [idx]: selected };
    questionSelectionsRef.current = next;
    setQuestionSelectionsState(next);
  }, []);

  const setQuestionCursor = useCallback((idx: number, pos: number) => {
    const next = { ...questionCursorRef.current, [idx]: Math.max(0, pos) };
    questionCursorRef.current = next;
    setQuestionCursorState(next);
  }, []);

  const resetQuestionDialog = useCallback(() => {
    questionIndexRef.current = 0;
    questionSelectionsRef.current = {};
    questionCursorRef.current = {};
    setQuestionIndexState(0);
    setQuestionSelectionsState({});
    setQuestionCursorState({});
  }, []);

  // One stable gate instance for the whole session.
  const gateRef = useRef<ApprovalGate | null>(null);
  const igateRef = useRef<InteractiveGate | null>(null);
  if (!gateRef.current) {
    if (opts.bypass) {
      gateRef.current = new AutoApproveGate();
    } else {
      const g = new InteractiveGate();
      igateRef.current = g;
      gateRef.current = g;
    }
  }

  const pushLine = useCallback((l: Omit<TranscriptItem, 'id' | 'kind'> & { kind?: TranscriptItem['kind'] }) => {
    const entry = { id: lineId.current++, kind: l.kind ?? 'system', ...l } as TranscriptItem;
    setCommitted((c) => {
      const next = [...c, entry];
      committedRef.current = next;
      return next;
    });
  }, []);

  /** Print the welcome card ONCE to <Static> (native scrollback), exactly like every other transcript
   *  item — it is deliberately NOT kept as a live, reflowing block. A tall live block sitting above
   *  <Static> ghosts and DUPLICATES whenever the live region's height changes (the model picker
   *  opening/closing, a pushLine, a terminal resize): Ink appends the new line to scrollback while
   *  redrawing the tall block and leaves a stale copy behind. Real terminals — and the reference client — print
   *  the banner once and let it scroll away; scrollback never reflows, so neither do we. */
  const showBanner = useCallback(() => {
    const lines: BannerLine[] = [
      { text: `v${opts.version}`, color: C.cyan, bold: true },
      { text: `${opts.cfg.provider}/${opts.cfg.model}`, dimColor: true },
      // Full workspace path — operator wants it visible in the header. (The terminal WINDOW
      // title is set to "Shadow" in runTui so the path isn't leaked in the title bar / tab.)
      { text: opts.workspaceRoot, dimColor: true },
      { text: '/help · /model · Shift+Tab mode', dimColor: true },
    ];
    if (opts.bypass) {
      lines.push({ text: '⚠ YOLO mode — all permission checks disabled', color: C.yellow, bold: true });
    }
    pushLine({
      kind: 'banner',
      text: 'Shadow',
      lines,
      brand: {
        version: opts.version,
        providerModel: `${opts.cfg.provider}/${opts.cfg.model}`,
        workspace: opts.workspaceRoot,
        help: '/help · /model · Shift+Tab mode',
        yolo: opts.bypass,
        art: SHADOW_ART,
      },
    });
  }, [opts, pushLine]);

  const setAutonomy = useCallback((l: AutonomyLevel) => {
    autonomyRef.current = l;
    setAutonomyState(l);
  }, []);

  // Apply a new reasoning effort live: updates state, the mutable config, persists it
  // for next launch, and pushes it to the running loop (takes effect next turn).
  const setEffort = useCallback((level: Effort) => {
    effortRef.current = level;
    opts.cfg.effort = level;
    setEffortState(level);
    loopRef.current?.setEffort(level);
    void saveGlobalConfig({ effort: level });
  }, []);

  // ── Keybinding engine ───────────────────────────────────────────────────────
  // One engine instance for the screen: loads defaults + ~/.shadow/keybindings.json,
  // hot-reloads on edit, and exposes consume() that onKey calls first. Handlers for
  // migrated actions are registered here; everything else still falls through to the
  // legacy inline handling below (consume() returns false for unmatched/unregistered).
  const kb = useKeybindings();
  const kbConsume = kb.consume;
  const kbRegister = kb.register;
  const kbLoadedRef = useRef(kb.loaded);
  kbLoadedRef.current = kb.loaded;
  // Ctrl-O now toggles ALL collapsible blocks (thoughts + tool output) at once — matching Claude
  // Code's "reveal everything / hide everything" semantics. The old handler only ever toggled the
  // single LATEST collapsible item, so every earlier fold was permanently unreachable.
  useEffect(() => kbRegister('transcript:toggleFoldLatest', () => {
    setShowAllExpanded((v) => !v);
    hardReflow(); // <Static> caches committed rows; remount + clean re-emit reflects the new state
  }), [kbRegister, hardReflow]);
  useEffect(() => kbRegister('transcript:toggleTaskList', () => setTodoCollapsed((v) => !v)), [kbRegister]);

  // Re-run the /statusline command (if any) and stash its output for the footer.
  const refreshStatusLine = useCallback(() => {
    const cmd = statusLineRef.current;
    if (!cmd) {
      setCustomStatus('');
      return;
    }
    runStatusLine(
      cmd,
      { model: currentRef.current.model, provider: currentRef.current.provider, cwd: opts.workspaceRoot, autonomy: autonomyRef.current },
      (line) => setCustomStatus(line),
    );
  }, [opts.workspaceRoot]);

  // Refresh the custom status line on mount and whenever the turn settles or the
  // model/mode changes — never mid-turn (don't spawn a subprocess on every token).
  useEffect(() => {
    if (!running) refreshStatusLine();
  }, [running, current.model, current.provider, autonomy, refreshStatusLine]);

  // Execute a slash command (not sent to the agent).
  const runSlash = useCallback(
    (cmd: SlashCommand, rawLine?: string) => {
      setLine('');
      setMenuIndex(0);
      const dispatch = slashDispatchName(cmd);
      const arg = (rawLine ?? '').slice(cmd.name.length).trim();
      switch (dispatch) {
        case '/help':
          pushLine({
            kind: 'system',
            text: 'help',
            lines: [
              { text: 'Commands:', bold: true },
              ...SLASH_COMMANDS.map((c) => ({ text: `  ${c.name.padEnd(SLASH_NAME_WIDTH)} ${c.desc}`, dimColor: true })),
              {
                text: 'Keys: Shift+Tab mode · \\ + Enter newline · type while running to queue · Ctrl-O fold blocks · Ctrl-T fold tasks · scroll = native terminal scrollback · ↑/↓ history · Esc clear/interrupt · Ctrl-C quit',
                dimColor: true,
              },
              { text: 'Approvals: y/n · s session · f prefix (shell) · a always', dimColor: true },
            ],
          });
          break;
        case '/keybindings': {
          const loaded = kbLoadedRef.current;
          if (arg === 'init') {
            const res = initKeybindingsFile();
            if (res.error) {
              pushLine({ text: `Failed to write ${shortPath(res.path)}: ${res.error}`, color: C.red });
              break;
            }
            pushLine({
              text: res.created
                ? `Wrote starter config → ${shortPath(res.path)} (edit it; changes hot-reload).`
                : `Already exists: ${shortPath(res.path)}`,
              color: C.cyan,
            });
            break;
          }
          const rows = bindingsForDisplay(loaded.bindings);
          const lines: BannerLine[] = [
            { text: 'Keybindings (customize: /keybindings init → edit ~/.shadow/keybindings.json):', bold: true },
          ];
          let lastCtx = '';
          for (const r of rows) {
            if (r.context !== lastCtx) {
              lastCtx = r.context;
              lines.push({ text: `  ${r.context}`, color: C.purple });
            }
            lines.push({ text: `    ${r.stroke.padEnd(16)} ${r.action}`, dimColor: true });
          }
          for (const w of loaded.warnings) lines.push({ text: `  ${w.kind}: ${w.message}`, color: C.yellow });
          lines.push({ text: 'Hardcoded (not rebindable): ctrl+c, ctrl+d, ctrl+m.', dimColor: true });
          pushLine({ kind: 'system', text: 'keybindings', lines });
          break;
        }
        case '/new':
        case '/clear':
          process.stdout.write('\x1b[2J\x1b[3J\x1b[H'); // wipe screen + scrollback (Static already emitted)
          context.reset();
          firstRef.current = true;
          answerOpenRef.current = false;
          setStreamNow('');
          setThinkNow('');
          setToolLine(null);
          setCommitted([]);
          committedRef.current = [];
          setShowAllExpanded(false);
          setStaticEpoch((n) => n + 1); // remount <Static> so it forgets the wiped scrollback items
          setTodoItems([]); // clear the task list (was persisting stale tasks after /clear)
          opts.todoList?.write([]); // clear the backing source so the agent starts fresh
          attachmentsRef.current = []; // drop any queued image attachments
          setAttachCount(0);
          setPlanMode({ mode: 'implement' }); // drop any stale plan title
          showBanner();
          pushLine({ text: 'Cleared — conversation reset. (goal kept — use /goal clear to drop it)', dimColor: true });
          break;
        case '/goal': {
          if (!arg) {
            pushLine({ text: goalRef.current ? `Goal: ${goalRef.current}` : 'No goal set. Use /goal <text> to set one, /goal clear to remove.', dimColor: true });
          } else if (arg.toLowerCase() === 'clear') {
            setGoal(null);
            pushLine({ text: 'Goal cleared.', dimColor: true });
          } else {
            setGoal(arg);
            pushLine({ text: `Goal set: ${arg}`, color: C.purple });
          }
          break;
        }
        case '/model': {
          const parsed = splitPresetArgs(arg);
          if (!parsed.ok) {
            pushLine({ text: parsed.message, color: C.red });
            break;
          }
          const parts = parsed.value;
          const action = parts[0] ?? '';
          const allEntries = opts.cfg.models ?? [];
          if (action === 'list' || action === 'show') {
            pushLine({
              kind: 'system',
              text: 'model',
              lines: modelPresetLines(allEntries, currentRef.current).map((text, i) => ({
                text,
                color: i === 0 && text.startsWith('*') ? C.cyan : undefined,
                dimColor: !text.startsWith('*'),
              })),
            });
            break;
          }
          if (action === 'add') {
            const add = parseModelAddArgs(parts);
            if (!add.ok) {
              pushLine({ text: add.message, color: C.red });
              break;
            }
            const next = addModelPreset(allEntries, add.value);
            if (!next.ok) {
              pushLine({ text: next.message, color: C.red });
              break;
            }
            opts.cfg.models = next.value;
            saveGlobalConfig({ models: next.value });
            pushLine({ text: `Added model preset: ${add.value.label}`, color: C.cyan });
            break;
          }
          if (action === 'remove' || action === 'delete') {
            const next = removeModelPreset(allEntries, parts[1] ?? '');
            if (!next.ok) {
              pushLine({ text: next.message, color: C.red });
              break;
            }
            opts.cfg.models = next.value;
            saveGlobalConfig({ models: next.value });
            pushLine({ text: `Removed model preset: ${parts[1]}`, color: C.cyan });
            break;
          }
          if (action === 'enable' || action === 'disable') {
            const next = setModelPresetEnabled(allEntries, parts[1] ?? '', action === 'enable');
            if (!next.ok) {
              pushLine({ text: next.message, color: C.red });
              break;
            }
            opts.cfg.models = next.value;
            saveGlobalConfig({ models: next.value });
            pushLine({ text: `${action === 'enable' ? 'Enabled' : 'Disabled'} model preset: ${parts[1]}`, color: C.cyan });
            break;
          }
          if (action === 'default' || action === 'set-default') {
            const entry = findModelPreset(allEntries, parts[1] ?? '');
            if (!entry) {
              pushLine({ text: parts[1] ? `No model preset named "${parts[1]}".` : 'Usage: /model default <label>', color: C.red });
              break;
            }
            if (entry.disabled) {
              pushLine({ text: `Cannot make disabled preset "${entry.label}" the default.`, color: C.red });
              break;
            }
            const patch = defaultModelPatch(entry);
            opts.cfg.provider = entry.provider;
            opts.cfg.model = entry.model;
            opts.cfg.baseUrl = entry.baseUrl;
            opts.cfg.lastModel = entry.label;
            saveGlobalConfig(patch);
            pushLine({ text: `Default model saved: ${entry.label}`, color: C.cyan });
            break;
          }
          if (action === 'use' || action === 'switch') {
            const entry = findModelPreset(allEntries.filter((m) => !m.disabled), parts[1] ?? '');
            if (!entry) {
              pushLine({ text: parts[1] ? `No enabled model preset named "${parts[1]}".` : 'Usage: /model use <label>', color: C.red });
              break;
            }
            void selectModelRef.current?.(entry);
            break;
          }
          if (action === 'test') {
            // Capability triage: the ACTIVE model (no arg) reuses the live provider;
            // a named preset is resolved + built (incl. gguf auto-serve) without swapping.
            const targetName = parts[1];
            void (async () => {
              let prov = providerRef.current;
              let model = currentRef.current.model;
              let isLocal = false;
              let label = `${currentRef.current.provider}/${currentRef.current.model}`;
              if (targetName) {
                const entry = findModelPreset(allEntries, targetName);
                if (!entry) {
                  pushLine({ text: `No model preset named "${targetName}".`, color: C.red });
                  return;
                }
                label = entry.label;
                model = entry.model;
                isLocal = Boolean(entry.gguf);
                let p = entry.provider;
                let baseUrl = resolveBaseUrl(entry.provider, entry.baseUrl);
                let apiKey = entry.apiKey ?? resolveApiKey(entry.provider, { model: entry.model });
                if (entry.gguf) {
                  try {
                    const r = await ensureGgufServer(entry, (m) => pushLine({ text: m, dimColor: true }));
                    p = 'openai';
                    baseUrl = r.baseUrl;
                    apiKey = entry.apiKey ?? 'sk-local';
                  } catch (e) {
                    pushLine({ text: `Local model failed: ${(e as Error).message}`, color: C.red });
                    return;
                  }
                }
                prov = createProvider({ provider: p, model: entry.model, apiKey, authToken: entry.authToken ?? resolveAuthToken(entry.provider), baseUrl });
              }
              if (!prov) {
                pushLine({ text: 'No active provider to test.', color: C.red });
                return;
              }
              pushLine({ text: `Testing ${label} — running capability probes (this can take up to a minute)…`, dimColor: true });
              try {
                const result = await runModelCheck(prov, {
                  model,
                  providerName: currentRef.current.provider,
                  isLocal,
                  log: (m) => pushLine({ text: m, dimColor: true }),
                });
                const rows = [
                  ...result.probes.map((pr) => ({
                    text: `${pr.status === 'pass' ? '✓' : '✗'} [${pr.status}] ${pr.label}: ${pr.detail}`,
                    color: pr.status === 'pass' ? C.green : C.red,
                  })),
                  { text: `Verdict: ${result.verdict.toUpperCase()}`, color: result.verdict === 'agentic' ? C.green : result.verdict === 'limited' ? C.cyan : C.red },
                  { text: `  ${result.recommendation}`, dimColor: true },
                  { text: `  (${(result.elapsedMs / 1000).toFixed(1)}s)`, dimColor: true },
                ];
                pushLine({ kind: 'system', text: 'model test', lines: rows });
              } catch (e) {
                pushLine({ text: `Model test failed: ${(e as Error).message}`, color: C.red });
              }
            })();
            break;
          }
          if (action) {
            pushLine({
              text: 'Usage: /model [list|add <label> <provider> <model> [baseUrl]|remove <label>|enable <label>|disable <label>|default <label>|use <label>|test [name]]',
              dimColor: true,
            });
            break;
          }
          const entries = modelEntries(opts.cfg);
          if (entries.length <= 1) {
            pushLine({
              kind: 'system',
              text: 'model',
              lines: [
                { text: `${currentRef.current.provider} / ${currentRef.current.model}`, color: C.cyan },
                { text: 'Use /model add <label> <provider> <model> [baseUrl] to add a preset.', dimColor: true },
              ],
            });
            break;
          }
          const rows = modelRows(opts.cfg);
          const active = rows.findIndex(
            (r) =>
              r.kind === 'model' &&
              r.entry.provider === currentRef.current.provider &&
              r.entry.model === currentRef.current.model,
          );
          setPickerIndex(active >= 0 ? active : firstSelectableRow(rows));
          setPickerOpen(true);
          break;
        }
        case '/local': {
          const parsed = splitPresetArgs(arg);
          if (!parsed.ok) {
            pushLine({ text: parsed.message, color: C.red });
            break;
          }
          const parts = parsed.value;
          const action = parts[0] ?? '';
          const allEntries = opts.cfg.models ?? [];
          if (!action || action === 'list' || action === 'show') {
            pushLine({
              kind: 'system',
              text: 'local',
              lines: formatLocalList(allEntries).map((text) => ({ text, dimColor: true })),
            });
            break;
          }
          if (action === 'add') {
            const parsedAdd = parseLocalAddArgs(parts.slice(1));
            if (!parsedAdd.ok) {
              pushLine({ text: parsedAdd.message, color: C.red });
              break;
            }
            const res = addLocalModel(allEntries, parsedAdd.value);
            if (!res.ok) {
              pushLine({ text: res.message, color: C.red });
              break;
            }
            opts.cfg.models = res.value.models;
            saveGlobalConfig({ models: res.value.models });
            const e = res.value.entry;
            pushLine({
              kind: 'system',
              text: 'local',
              lines: [
                { text: `Added local model: ${e.label}`, color: C.cyan },
                { text: `  ${e.gguf}  ·  ctx ${e.ctx}  ·  gpu-layers ${e.gpuLayers}`, dimColor: true },
                { text: `  Switch to it now: /local use ${e.label}`, dimColor: true },
              ],
            });
            break;
          }
          if (action === 'remove' || action === 'delete') {
            const res = removeLocalModel(allEntries, parts[1] ?? '');
            if (!res.ok) {
              pushLine({ text: res.message, color: C.red });
              break;
            }
            opts.cfg.models = res.value;
            saveGlobalConfig({ models: res.value });
            pushLine({ text: `Removed local model: ${parts[1]}`, color: C.cyan });
            break;
          }
          if (action === 'use' || action === 'switch') {
            const entry = findModelPreset(
              listLocalModels(allEntries).filter((m) => !m.disabled),
              parts[1] ?? '',
            );
            if (!entry) {
              pushLine({
                text: parts[1] ? `No local model named "${parts[1]}".` : 'Usage: /local use <name>',
                color: C.red,
              });
              break;
            }
            void selectModelRef.current?.(entry); // reuses /model's switch (server spawn + memory intact)
            break;
          }
          pushLine({
            text: 'Usage: /local [list | add <path-to.gguf> [--name <n>] [--ctx <n>] [--gpu-layers <n>] | use <name> | remove <name>]',
            dimColor: true,
          });
          break;
        }
        case '/provider': {
          const activeEntry = (opts.cfg.models ?? []).find(
            (m) => !m.disabled && m.provider === currentRef.current.provider && m.model === currentRef.current.model,
          );
          const baseUrl = resolveBaseUrl(
            currentRef.current.provider,
            activeEntry?.baseUrl ?? (opts.cfg.provider === currentRef.current.provider ? opts.cfg.baseUrl : undefined),
          );
          const hasApiKey = Boolean(resolveApiKey(currentRef.current.provider, { model: currentRef.current.model }));
          const hasAuthToken = Boolean(resolveAuthToken(currentRef.current.provider));
          const total = opts.cfg.models?.length ?? 0;
          const disabled = opts.cfg.models?.filter((m) => m.disabled).length ?? 0;
          pushLine({
            kind: 'system',
            text: 'provider',
            lines: [
              { text: `${currentRef.current.provider}/${currentRef.current.model}`, color: C.cyan },
              { text: `endpoint: ${baseUrl || '(provider default)'}`, dimColor: true },
              { text: `auth: api key ${hasApiKey ? 'present' : 'missing'} · bearer ${hasAuthToken ? 'present' : 'missing'}`, dimColor: true },
              { text: `presets: ${total} configured${disabled ? ` · ${disabled} disabled` : ''}`, dimColor: true },
              { text: 'Commands: /model list · /model add · /model use <label> · /model default <label>', dimColor: true },
            ],
          });
          break;
        }
        case '/onboard': {
          pushLine({
            kind: 'system',
            text: 'onboard',
            lines: [
              { text: 'Run `shadow onboard` outside the TUI to edit provider credentials.', color: C.cyan },
              { text: 'Onboarding supports `back`/`b` at prompts and saves only after the final connection check.', dimColor: true },
              { text: 'Model presets can be managed live with /model add, /model remove, /model enable, /model disable, and /model default.', dimColor: true },
            ],
          });
          break;
        }
        case '/style': {
          const styles: OutputStyle[] = ['proactive', 'explanatory', 'learning', 'procedural'];
          const next = styles[(styles.indexOf(styleRef.current) + 1) % styles.length] ?? 'proactive';
          styleRef.current = next;
          setStyle(next);
          opts.styleState?.setStyle(next);
          void saveGlobalConfig({ lastStyle: next });
          pushLine({ text: `Style → ${next}`, color: C.purple });
          break;
        }
        case '/autonomy': {
          const next = cycleAutonomy(autonomyRef.current);
          setAutonomy(next);
          loopRef.current?.setAutonomy(next);
          pushLine({ text: `Autonomy → ${next}`, color: C.purple });
          break;
        }
        case '/fast': {
          const next = !opts.cfg.fastMode;
          opts.cfg.fastMode = next;
          void saveGlobalConfig({ fastMode: next });
          pushLine({
            text: `Fast mode → ${next ? 'on' : 'off'} (applies on the next model turn)`,
            color: C.cyan,
          });
          break;
        }
        case '/effort': {
          // No arg: cycle. With arg: set (validated). Live-applies next turn + persists.
          const parsed = normalizeEffort(arg);
          const next = parsed ?? cycleEffort(effortRef.current);
          setEffort(next);
          pushLine({
            text: `Effort → ${next} ${effortSymbol(next)} — ${effortDescription(next)} (applies next turn)`,
            color: C.cyan,
          });
          break;
        }
        case '/compact': {
          if (runningRef.current) {
            pushLine({ text: 'Finish the current turn before compacting.', dimColor: true });
            break;
          }
          pushLine({ text: 'Compacting context…', dimColor: true });
          void (async () => {
            try {
              const did = await context.maybeSummarize(providerRef.current, currentRef.current.model, true);
              pushLine(
                did
                  ? { text: 'Context compacted — earlier turns summarized.', color: C.cyan }
                  : { text: 'Nothing to compact yet.', dimColor: true },
              );
            } catch (e) {
              pushLine({ text: `Compact failed: ${(e as Error).message}`, color: C.red });
            }
          })();
          break;
        }
        case '/cost':
        case '/usage': {
          const u = lastUsageRef.current;
          if (!u) {
            pushLine({ text: 'No usage recorded yet this session.', dimColor: true });
            break;
          }
          pushLine({
            kind: 'system',
            text: 'cost',
            lines: [
              { text: `Tokens: ${u.inputTokens.toLocaleString()} in · ${u.outputTokens.toLocaleString()} out (session)` },
              { text: `Cost:   $${u.costUSD.toFixed(4)}`, color: C.cyan },
            ],
          });
          break;
        }
        case '/resume': {
          if (runningRef.current) {
            pushLine({ text: 'Finish the current turn before resuming.', dimColor: true });
            break;
          }
          const sessions = listResumableSessions(opts.workspaceRoot);
          if (!sessions.length) {
            pushLine({ text: 'No resumable sessions found.', dimColor: true });
            break;
          }
          const pick = arg
            ? sessions.find((s) => s.id === arg || s.path === arg || s.path.endsWith(arg))
            : sessions[0];
          if (!pick) {
            pushLine({ text: `No session matching "${arg}".`, dimColor: true });
            break;
          }
          try {
            const { context: resumed } = resumeSession(pick.path, {
              contextBudget: opts.cfg.contextBudget,
              triggerRatio: opts.cfg.summarizeTriggerRatio,
              keepLastTurns: opts.cfg.keepLastTurns,
            });
            context.loadState(resumed.exportState());
            firstRef.current = context.messages().length === 0;
            pushLine({
              text: `Resumed ${pick.id} (${context.messages().length} messages).`,
              color: C.cyan,
            });
          } catch (e) {
            pushLine({ text: `Resume failed: ${(e as Error).message}`, color: C.red });
          }
          break;
        }
        case '/rewind': {
          if (runningRef.current) {
            pushLine({ text: 'Finish the current turn before rewinding.', dimColor: true });
            break;
          }
          const turnArg = arg;
          const turnIndex = turnArg ? Number(turnArg) : NaN;
          if (!Number.isFinite(turnIndex) || turnIndex < 0) {
            pushLine({ text: 'Usage: /rewind <turn-index> (0 = first assistant turn).', dimColor: true });
            break;
          }
          try {
            const { context: rewound, restoredFiles, turn } = rewindToTurn(
              sessionLog.path,
              turnIndex,
              opts.workspaceRoot,
              {
                contextBudget: opts.cfg.contextBudget,
                triggerRatio: opts.cfg.summarizeTriggerRatio,
                keepLastTurns: opts.cfg.keepLastTurns,
              },
            );
            context.loadState(rewound.exportState());
            firstRef.current = context.messages().length === 0;
            pushLine({
              kind: 'system',
              text: 'rewind',
              lines: [
                { text: `Rewound to turn ${turn} (${context.messages().length} messages).`, color: C.cyan },
                ...(restoredFiles.length
                  ? [{ text: `Restored ${restoredFiles.length} file(s): ${restoredFiles.join(', ')}`, dimColor: true }]
                  : [{ text: 'No file checkpoints to restore for that turn.', dimColor: true }]),
              ],
            });
          } catch (e) {
            pushLine({ text: `Rewind failed: ${(e as Error).message}`, color: C.red });
          }
          break;
        }
        case '/init': {
          const target = join(opts.workspaceRoot, 'SHADOW.md');
          if (existsSync(target)) {
            pushLine({ text: 'SHADOW.md already exists — not overwritten.', dimColor: true });
            break;
          }
          const seed =
            'You are Shadow working in this project.\n\n' +
            'Add project-specific conventions, build commands, and hard rules here.\n';
          writeFileSync(target, seed, 'utf8');
          pushLine({ text: `Created ${target}`, color: C.cyan });
          break;
        }
        case '/agents': {
          const defs = loadAgentDefs(opts.workspaceRoot);
          pushLine({
            kind: 'system',
            text: 'agents',
            lines: defs.map((d) => ({
              text: `  ${d.name.padEnd(14)} ${d.description}${d.builtin ? ' (built-in)' : ''}`,
              dimColor: true,
            })),
          });
          break;
        }
        case '/skills': {
          const skills = discoverSkills(opts.workspaceRoot);
          pushLine({
            kind: 'system',
            text: 'skills',
            lines: skills.length
              ? skills.slice(0, 30).map((s) => ({
                  text: `  ${s.name.padEnd(18)} ${shortPath(s.path)} — ${s.description}`,
                  dimColor: true,
                }))
              : [{ text: 'No repo skills found under skills/ or .shadow/skills/.', dimColor: true }],
          });
          break;
        }
        case '/workflows': {
          const lines = workflowInventory(opts.workspaceRoot);
          pushLine({
            kind: 'system',
            text: 'workflows',
            lines: lines.length
              ? lines.map((text, i) => ({ text, color: i === 0 ? C.cyan : undefined, dimColor: i !== 0 }))
              : [{ text: 'No workflow files found under .shadow/workflows or ~/.shadow/workflows.', dimColor: true }],
          });
          break;
        }
        case '/plugins': {
          const workspacePlugins = listNamedEntries(join(opts.workspaceRoot, '.shadow', 'plugins'));
          const globalPlugins = listNamedEntries(join(GLOBAL_DIR, 'plugins'));
          const lines = [
            'Plugin manager: not installed in this build.',
            'Supported extension points: skills, agents, MCP servers, workflows, hooks.',
            ...(workspacePlugins.length ? [`workspace plugins: ${workspacePlugins.join(', ')}`] : []),
            ...(globalPlugins.length ? [`global plugins: ${globalPlugins.join(', ')}`] : []),
          ];
          pushLine({
            kind: 'system',
            text: 'plugins',
            lines: lines.map((text, i) => ({ text, color: i === 0 ? C.cyan : undefined, dimColor: i !== 0 })),
          });
          break;
        }
        case '/memory': {
          const mem = ProjectMemory.load(opts.workspaceRoot);
          const facts = mem.all();
          const keys = Object.keys(facts);
          if (!keys.length) {
            pushLine({ text: 'No memory facts stored yet.', dimColor: true });
            break;
          }
          pushLine({
            kind: 'system',
            text: 'memory',
            lines: keys.map((k) => ({ text: `  ${k}: ${facts[k]}`, dimColor: true })),
          });
          break;
        }
        case '/tasks': {
          if (arg.toLowerCase() === 'clear') {
            opts.todoList?.write([]);
            setTodoItems([]);
            pushLine({ text: 'Task list cleared.', dimColor: true });
            break;
          }
          const items = opts.todoList?.snapshot() ?? todoItems;
          if (!items.length) {
            pushLine({ text: 'No live tasks. The agent will create a task list for larger jobs.', dimColor: true });
            break;
          }
          const mark = (status: TodoItem['status']) => (status === 'completed' ? 'done' : status === 'in_progress' ? 'active' : 'todo');
          pushLine({
            kind: 'system',
            text: 'tasks',
            lines: items.map((item, i) => ({
              text: `${String(i + 1).padStart(2)}. [${mark(item.status)}] ${item.subject}${item.description ? ` — ${item.description}` : ''}`,
              color: item.status === 'in_progress' ? C.yellow : undefined,
              dimColor: item.status === 'completed',
            })),
          });
          break;
        }
        case '/permissions': {
          const argLine = arg;
          const result = applyPermissionCommand(opts.cfg.permissionRules ?? [], argLine);
          if (!result.ok) {
            pushLine({ text: result.message, color: C.red });
            break;
          }
          if (argLine.trim()) {
            opts.cfg.permissionRules = result.rules;
            persistPermissionRules(opts.workspaceRoot, result.rules);
            loopRef.current?.setPermissionRules(result.rules);
          }
          pushLine({
            kind: 'system',
            text: 'permissions',
            lines: result.message.split('\n').map((line) => ({ text: `  ${line}`, dimColor: true })),
          });
          break;
        }
        case '/context': {
          // Category breakdown of the context window: which message type is
          // consuming tokens, plus actionable token-saving suggestions.
          const total = context.estimateTokens(providerRef.current);
          const breakdown = categorizeContext(context.messages(), total, opts.cfg.contextBudget);
          const pct = Math.round(breakdown.pct * 100);
          const barLen = 24;
          const filled = Math.min(barLen, Math.round(breakdown.pct * barLen));
          const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
          const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
          const tips = contextSuggestions(breakdown);
          pushLine({
            kind: 'system',
            text: 'context',
            lines: [
              { text: `Context  ${bar}  ${pct}% · ${fmt(breakdown.total)} / ${fmt(opts.cfg.contextBudget)} tokens`, color: breakdown.pct > 0.75 ? C.yellow : C.cyan },
              ...breakdown.categories.map((c) => ({
                text: `  ${c.label.padEnd(14)} ${fmt(c.tokens)}`.trimEnd(),
                dimColor: true,
              })),
              ...(breakdown.overheadTokens > 0
                ? [{ text: `  ${'system + tools'.padEnd(14)} ${fmt(breakdown.overheadTokens)}`, dimColor: true }]
                : []),
              ...tips.map((t) => ({
                text: `${t.severity === 'critical' ? '✖' : t.severity === 'warn' ? '⚠' : '›'} ${t.title}${t.savings ? ` — save ~${fmt(t.savings)}` : ''}`,
                color: t.severity === 'critical' ? C.red : t.severity === 'warn' ? C.yellow : undefined,
                dimColor: t.severity === 'info',
              })),
            ],
          });
          break;
        }
        case '/export': {
          const outArg = arg;
          try {
            const { path, bytes } = exportSession({
              sessionPath: sessionLog.path,
              workspaceRoot: opts.workspaceRoot,
              outPath: outArg || undefined,
              meta: {
                version: opts.version,
                workspaceRoot: opts.workspaceRoot,
                provider: currentRef.current.provider,
                model: currentRef.current.model,
                style: styleRef.current,
                autonomy: autonomyRef.current,
                sessionPath: sessionLog.path,
                exportedAt: new Date().toISOString(),
              },
            });
            pushLine({ text: `Exported ${bytes} bytes → ${shortPath(path)}`, color: C.cyan });
          } catch (e) {
            pushLine({ text: `Export failed: ${(e as Error).message}`, color: C.red });
          }
          break;
        }
        case '/copy': {
          // Copy the last assistant answer to the system clipboard. Read-only and
          // safe mid-turn. (Per-message keyboard nav + selection needs the owned
          // viewport — see reports; this delivers the 80% copy value without it.)
          if (!hasClipboard()) {
            pushLine({ text: 'No clipboard helper found — install pbcopy (macOS), xclip/wl-copy (Linux), or run on Windows.', color: C.yellow });
            break;
          }
          const last = [...committedRef.current].reverse().find((it) => it.kind === 'assistant' && it.text);
          if (!last) {
            pushLine({ text: 'No assistant answer to copy yet.', dimColor: true });
            break;
          }
          // Redact secrets before they reach the OS clipboard — a broader sink than
          // the screen (macOS Universal Clipboard/iCloud sync, clipboard managers,
          // polling apps). Best-effort like all redaction, but never copy raw.
          const raw = last.text!;
          const safe = redactString(raw);
          const redacted = safe !== raw;
          void (async () => {
            const ok = await copyToClipboard(safe);
            pushLine(
              ok
                ? { text: `Copied ${safe.length} chars to clipboard${redacted ? ' (secrets redacted)' : ''}.`, color: C.cyan }
                : { text: 'Clipboard copy failed.', color: C.red },
            );
          })();
          break;
        }
        case '/session': {
          const messages = context.messages().length;
          const id = sessionLog.path ? SessionLog.sessionIdFromPath(sessionLog.path) : 'unknown';
          pushLine({
            kind: 'system',
            text: 'session',
            lines: [
              { text: `id: ${id}`, color: C.cyan },
              { text: `messages: ${messages.toLocaleString()} · style ${styleRef.current} · autonomy ${autonomyRef.current}`, dimColor: true },
              { text: `log: ${sessionLog.path ? shortPath(sessionLog.path) : 'not available'}`, dimColor: true },
              { text: 'Use /export to save a markdown transcript, /resume to load an earlier session.', dimColor: true },
            ],
          });
          break;
        }
        case '/doctor': {
          const report = runDoctor(opts.workspaceRoot);
          pushLine({
            kind: 'system',
            text: 'doctor',
            lines: formatDoctorReport(report, opts.version)
              .split('\n')
              .map((text) => ({ text, dimColor: !text.startsWith('  ✗') && !text.includes('failed') })),
          });
          break;
        }
        case '/status': {
          const u = lastUsageRef.current;
          const pct = u ? Math.round(u.contextPct * 100) : 0;
          pushLine({
            kind: 'system',
            text: 'status',
            lines: [
              { text: `${currentRef.current.provider}/${currentRef.current.model} · ${autonomyRef.current}${opts.bypass ? ' (yolo)' : ''} · style ${styleRef.current}`, color: C.cyan },
              { text: `context ${pct}% of ${opts.cfg.contextBudget.toLocaleString()} · ${u ? (u.inputTokens + u.outputTokens).toLocaleString() : 0} tokens · $${u ? u.costUSD.toFixed(4) : '0.0000'}`, dimColor: true },
              { text: `workspace ${opts.workspaceRoot}`, dimColor: true },
              ...(goalRef.current ? [{ text: `goal: ${goalRef.current}`, color: C.purple }] : []),
            ],
          });
          break;
        }
        case '/diff': {
          try {
            const out = execFileSync('git', ['-C', opts.workspaceRoot, 'diff', '--stat'], { encoding: 'utf8', timeout: 5000 }).trim();
            pushLine({
              kind: 'system',
              text: 'diff',
              lines: out ? out.split('\n').map((text) => ({ text, dimColor: true })) : [{ text: 'No uncommitted changes.', dimColor: true }],
            });
          } catch (e) {
            pushLine({ text: `git diff failed: ${(e as Error).message.split('\n')[0]}`, color: C.red });
          }
          break;
        }
        case '/files': {
          try {
            const out = execFileSync('git', ['-C', opts.workspaceRoot, 'status', '--short'], { encoding: 'utf8', timeout: 5000 }).trim();
            pushLine({
              kind: 'system',
              text: 'files',
              lines: out
                ? out.split('\n').slice(0, 40).map((text) => ({ text, dimColor: true }))
                : [{ text: 'No changed files.', dimColor: true }],
            });
          } catch (e) {
            pushLine({ text: `git status failed: ${(e as Error).message.split('\n')[0]}`, color: C.red });
          }
          break;
        }
        case '/branch': {
          try {
            const branch = execFileSync('git', ['-C', opts.workspaceRoot, 'branch', '--show-current'], { encoding: 'utf8', timeout: 5000 }).trim();
            const status = execFileSync('git', ['-C', opts.workspaceRoot, 'status', '--short', '--branch'], { encoding: 'utf8', timeout: 5000 }).trim();
            pushLine({
              kind: 'system',
              text: 'branch',
              lines: [
                { text: branch ? `branch: ${branch}` : 'branch: detached HEAD', color: C.cyan },
                ...(status ? status.split('\n').slice(0, 20).map((text) => ({ text, dimColor: true })) : [{ text: 'Working tree clean.', dimColor: true }]),
              ],
            });
          } catch (e) {
            pushLine({ text: `git branch failed: ${(e as Error).message.split('\n')[0]}`, color: C.red });
          }
          break;
        }
        case '/config': {
          const c = opts.cfg;
          const parts = arg.split(/\s+/).filter(Boolean);
          if (parts[0] === 'set') {
            const key = parts[1] ?? '';
            const valueRaw = parts[2] ?? '';
            if (!key || !valueRaw) {
              pushLine({ text: `Usage: /config set <${SAFE_CONFIG_KEYS.join('|')}> <value>`, dimColor: true });
              break;
            }
            const parsed = parseSafeConfig(key, valueRaw);
            if (!parsed.ok) {
              pushLine({ text: parsed.message, color: C.red });
              break;
            }
            (opts.cfg as unknown as Record<string, unknown>)[parsed.key] = parsed.value;
            saveGlobalConfig({ [parsed.key]: parsed.value });
            pushLine({ text: `Config saved: ${parsed.key} = ${String(parsed.value)}`, color: C.cyan });
            break;
          }
          if (parts[0] === 'get') {
            const key = parts[1] ?? '';
            if (!key) {
              pushLine({ text: 'Usage: /config get <key>', dimColor: true });
              break;
            }
            const value = (opts.cfg as unknown as Record<string, unknown>)[key];
            pushLine({ text: `${key}: ${value === undefined ? '(unset)' : JSON.stringify(value)}`, dimColor: true });
            break;
          }
          if (parts.length && parts[0] !== 'show') {
            pushLine({ text: 'Usage: /config [show|get <key>|set <key> <value>]', dimColor: true });
            break;
          }
          pushLine({
            kind: 'system',
            text: 'config',
            lines: [
              { text: `provider/model: ${c.provider}/${c.model}`, color: C.cyan },
              { text: `autonomy ${autonomyRef.current} · autoClassifier ${c.autoClassifier ? 'on' : 'off'} · fastMode ${c.fastMode ? 'on' : 'off'}`, dimColor: true },
              { text: `effort ${c.effort} · cacheTtl ${c.cacheTtl} · parallelTools ${c.parallelTools ? 'on' : 'off'}${c.costWarnUSD != null ? ` · costWarn $${c.costWarnUSD}` : ''}`, dimColor: true },
              { text: `maxIterations ${c.maxIterations || 'unlimited'} · contextBudget ${c.contextBudget.toLocaleString()}`, dimColor: true },
              { text: `${c.models?.length ?? 0} models configured · edit ~/.shadow/config.json (API keys hidden)`, dimColor: true },
              { text: `Editable here: ${SAFE_CONFIG_KEYS.join(', ')}`, dimColor: true },
            ],
          });
          break;
        }
        case '/login': {
          const parts = arg.split(/\s+/).filter(Boolean);
          const action = parts[0] ?? 'status';
          if (action === 'codex') {
            const { url } = buildCodexAuthUrl();
            pushLine({
              kind: 'system',
              text: 'login',
              lines: [
                { text: 'Open this URL to sign in with ChatGPT/Codex:', color: C.cyan },
                { text: url, dimColor: true },
                { text: 'After authorization, exchange support is still CLI-side work; API keys remain available through `shadow onboard`.', dimColor: true },
              ],
            });
            break;
          }
          if (action === 'import') {
            const target = parts[1] ?? 'all';
            const providers: SubProvider[] = target === 'all' ? ['codex', 'grok'] : parseSubProvider(target) ? [parseSubProvider(target)!] : [];
            if (!providers.length) {
              pushLine({ text: 'Usage: /login import codex|grok|all', dimColor: true });
              break;
            }
            const outcomes = providers.map((p) => importOfficialCredential(p));
            pushLine({
              kind: 'system',
              text: 'login',
              lines: outcomes.map((o) => ({
                text: o.imported
                  ? `${o.provider}: imported ${o.kind}${o.hasRefresh ? ' with refresh token' : ''}`
                  : `${o.provider}: no official CLI credential found`,
                color: o.imported ? C.cyan : undefined,
                dimColor: !o.imported,
              })),
            });
            break;
          }
          if (action !== 'status' && action !== 'show') {
            pushLine({ text: 'Usage: /login [status|codex|import codex|grok|all]', dimColor: true });
            break;
          }
          const codex = getSubAuth('codex');
          const grok = getSubAuth('grok');
          pushLine({
            kind: 'system',
            text: 'login',
            lines: [
              { text: 'API keys: run `shadow onboard` to save provider credentials.', color: C.cyan },
              { text: `codex subscription: ${codex ? codex.kind : 'not stored'}`, dimColor: !codex, color: codex ? C.cyan : undefined },
              { text: `grok subscription: ${grok ? grok.kind : 'not stored'}`, dimColor: !grok, color: grok ? C.cyan : undefined },
              { text: 'Codex subscription: run `shadow login codex` outside the TUI, then follow the printed URL.', dimColor: true },
              { text: 'Import official CLI credentials with: /login import codex|grok|all', dimColor: true },
              { text: 'Grok: use an xAI API key through `shadow onboard`; consumer OAuth is not supported.', dimColor: true },
              { text: 'Anthropic: API-key only in Shadow.', dimColor: true },
            ],
          });
          break;
        }
        case '/logout': {
          const target = arg.trim();
          if (target) {
            const providers: SubProvider[] = target === 'all' ? ['codex', 'grok'] : parseSubProvider(target) ? [parseSubProvider(target)!] : [];
            if (!providers.length) {
              pushLine({ text: 'Usage: /logout codex|grok|all', dimColor: true });
              break;
            }
            for (const provider of providers) clearSubAuth(provider);
            pushLine({ text: `Cleared subscription credentials: ${providers.join(', ')}`, color: C.cyan });
            break;
          }
          pushLine({
            kind: 'system',
            text: 'logout',
            lines: [
              { text: 'Shadow stores provider API credentials in ~/.shadow/credentials.json.', color: C.cyan },
              { text: 'Subscription credentials, when used, live in ~/.shadow/subscription-auth.json.', dimColor: true },
              { text: 'Remove the relevant file or rerun `shadow onboard` to replace credentials.', dimColor: true },
            ],
          });
          break;
        }
        case '/hooks': {
          const hooks = (opts.cfg.hooks ?? {}) as Record<string, unknown[]>;
          const phases = Object.keys(hooks).filter((k) => Array.isArray(hooks[k]) && hooks[k].length > 0);
          pushLine({
            kind: 'system',
            text: 'hooks',
            lines: phases.length
              ? phases.map((p) => ({ text: `  ${p}: ${hooks[p].length} hook(s)`, dimColor: true }))
              : [{ text: 'No hooks configured (set "hooks" in ~/.shadow/config.json).', dimColor: true }],
          });
          break;
        }
        case '/version': {
          pushLine({ text: `Shadow ${opts.version}`, color: C.cyan });
          break;
        }
        case '/mcp': {
          const parts = arg.split(/\s+/).filter(Boolean);
          const action = parts[0] ?? 'list';
          const effectiveServers = (opts.cfg.mcpServers ?? {}) as McpServers;
          if (action === 'get') {
            const name = parts[1] ?? '';
            const server = effectiveServers[name];
            if (!name || !server) {
              pushLine({ text: name ? `No MCP server "${name}" configured.` : 'Usage: /mcp get <name>', dimColor: true });
              break;
            }
            pushLine({
              kind: 'system',
              text: 'mcp',
              lines: mcpServerLines(name, server).map((text, i) => ({ text, color: i === 0 ? C.cyan : undefined, dimColor: i !== 0 })),
            });
            break;
          }
          if (action === 'enable') {
            if (parts[1] !== 'context-cooler') {
              pushLine({ text: 'Usage: /mcp enable context-cooler [--path <dir|server.js>]', dimColor: true });
              break;
            }
            const pathIndex = parts.indexOf('--path');
            const pathArg = pathIndex >= 0 ? parts[pathIndex + 1] : undefined;
            const servers = loadGlobalMcpServers();
            const change = enableContextCooler(servers, pathArg);
            if (change.ok) {
              saveGlobalMcpServers(change.servers);
              opts.cfg.mcpServers = change.servers;
            }
            pushLine({
              text: `${change.message}${change.ok ? ' Restart Shadow to load new MCP tools.' : ''}`,
              color: change.ok ? C.cyan : C.red,
            });
            break;
          }
          if (action === 'disable') {
            const servers = loadGlobalMcpServers();
            const change = disableMcpServer(servers, parts[1] ?? '');
            if (change.ok) {
              saveGlobalMcpServers(change.servers);
              opts.cfg.mcpServers = change.servers;
            }
            pushLine({ text: change.message, color: change.ok ? C.cyan : C.red });
            break;
          }
          if (action !== 'list' && action !== 'show') {
            pushLine({ text: 'Usage: /mcp [list|get <name>|enable context-cooler [--path <path>]|disable <name>]', dimColor: true });
            break;
          }
          pushLine({
            kind: 'system',
            text: 'mcp',
            lines: [
              ...mcpListLines(effectiveServers).map((text) => ({ text, dimColor: true })),
              { text: 'Commands: /mcp get <name> · /mcp enable context-cooler --path <path> · /mcp disable <name>', dimColor: true },
            ],
          });
          break;
        }
        case '/review': {
          if (runningRef.current) {
            pushLine({ text: 'Finish the current turn before /review.', dimColor: true });
            break;
          }
          runOneRef.current?.(
            'Review the current uncommitted changes for bugs, regressions, and issues. Run git diff yourself to see them, then report concrete findings (file:line) and any fixes you recommend.',
          );
          break;
        }
        case '/theme': {
          const themeArg = arg.toLowerCase();
          const parts = themeArg.split(/\s+/).filter(Boolean);
          const currentTheme = normalizeThemeName(opts.cfg.lastTheme as string | undefined) ?? 'og';
          if (parts[0] === 'list' || parts[0] === 'show') {
            pushLine({
              kind: 'system',
              text: 'themes',
              lines: [
                { text: 'Themes:', bold: true },
                ...THEME_NAMES.map((name) => ({
                  text: `  ${name.padEnd(12)} ${THEME_DESCRIPTIONS[name]}${name === currentTheme ? ' (current)' : ''}`,
                  color: name === currentTheme ? C.cyan : undefined,
                  dimColor: name !== currentTheme,
                })),
                { text: 'Aliases: dark → og, pink → coder-chick. Use /theme preview <name> to sample.', dimColor: true },
              ],
            });
            break;
          }
          if (parts[0] === 'preview') {
            const preview = normalizeThemeName(parts[1]);
            if (!preview) {
              pushLine({ text: `Usage: /theme preview <${THEME_NAMES.join('|')}>`, dimColor: true });
              break;
            }
            const palette = THEMES[preview];
            pushLine({
              kind: 'system',
              text: 'theme preview',
              lines: [
                { text: `Theme preview: ${preview}`, color: palette.cyan, bold: true },
                { text: 'Foreground text: readable transcript body', color: palette.fg },
                { text: 'Success/action: tool completed or model switched', color: palette.green },
                { text: 'Warning: approval, budget, or attention needed', color: palette.yellow },
                { text: 'Error: failed command or blocked operation', color: palette.red },
                { text: 'Accent: goals, modes, and selected controls', color: palette.purple },
                { text: `Use /theme ${preview} to apply.`, dimColor: true },
              ],
            });
            break;
          }
          let next: CanonicalThemeName;
          if (!themeArg) {
            next = THEME_NAMES[(THEME_NAMES.indexOf(currentTheme) + 1) % THEME_NAMES.length] ?? 'og';
          } else {
            const resolved = normalizeThemeName(parts[0]);
            if (!resolved) {
              pushLine({ text: `Unknown theme "${themeArg}". Available: ${THEME_NAMES.join(', ')}.`, color: C.red });
              break;
            }
            next = resolved;
          }
          applyTheme(next);
          opts.cfg.lastTheme = next; // keep the in-memory cfg in sync for the next cycle
          saveGlobalConfig({ lastTheme: next });
          setThemeTick((t) => t + 1); // repaint with the new palette
          pushLine({ text: `Theme: ${next}`, color: C.cyan });
          break;
        }
        case '/add-dir': {
          if (!arg) {
            const roots = additionalRootsRef.current;
            pushLine({
              kind: 'system',
              text: 'add-dir',
              lines: roots.length
                ? roots.map((d) => ({ text: `  ${d}`, dimColor: true }))
                : [{ text: 'No extra directories granted. Use /add-dir <path> to grant one.', dimColor: true }],
            });
            break;
          }
          const abs = isAbsolute(arg) ? arg : resolve(opts.workspaceRoot, arg);
          try {
            if (!statSync(abs).isDirectory()) {
              pushLine({ text: `Not a directory: ${abs}`, color: C.red });
              break;
            }
          } catch {
            pushLine({ text: `No such directory: ${abs}`, color: C.red });
            break;
          }
          if (abs === opts.workspaceRoot || additionalRootsRef.current.includes(abs)) {
            pushLine({ text: `Already accessible: ${abs}`, dimColor: true });
            break;
          }
          additionalRootsRef.current = [...additionalRootsRef.current, abs];
          pushLine({ text: `Granted (this session): ${abs}`, color: C.green });
          break;
        }
        case '/image': {
          if (!arg) {
            const n = attachmentsRef.current.length;
            pushLine({
              text: n ? `${n} image(s) queued for the next message. /image clear to drop them.` : 'Usage: /image <path> — attaches an image to your next message (png/jpg/gif/webp).',
              dimColor: true,
            });
            break;
          }
          if (/^(clear|none|off)$/i.test(arg)) {
            attachmentsRef.current = [];
            setAttachCount(0);
            pushLine({ text: 'Image attachments cleared.', dimColor: true });
            break;
          }
          const abs = isAbsolute(arg) ? arg : resolve(opts.workspaceRoot, arg);
          const mediaType = imageMediaType(abs);
          if (!mediaType) {
            pushLine({ text: `Unsupported image type: ${arg} (use png/jpg/gif/webp).`, color: C.red });
            break;
          }
          try {
            if (!statSync(abs).isFile()) {
              pushLine({ text: `Not a file: ${abs}`, color: C.red });
              break;
            }
            const data = readFileSync(abs).toString('base64');
            attachmentsRef.current = [...attachmentsRef.current, { type: 'image', mediaType, data }];
            setAttachCount(attachmentsRef.current.length);
            pushLine({ text: `Attached ${arg} — sent with your next message (${attachmentsRef.current.length} queued).`, color: C.green });
          } catch (e) {
            pushLine({ text: `Cannot read ${abs}: ${(e as Error).message.split('\n')[0]}`, color: C.red });
          }
          break;
        }
        case '/statusline': {
          if (!arg) {
            pushLine({
              text: statusLineRef.current ? `Status line: ${statusLineRef.current}` : 'No status line set. Use /statusline <shell command>, /statusline none to clear.',
              dimColor: true,
            });
            break;
          }
          if (/^(none|off|clear|remove)$/i.test(arg)) {
            statusLineRef.current = '';
            opts.cfg.statusLine = '';
            saveGlobalConfig({ statusLine: '' });
            setCustomStatus('');
            pushLine({ text: 'Status line cleared.', dimColor: true });
            break;
          }
          statusLineRef.current = arg;
          opts.cfg.statusLine = arg;
          saveGlobalConfig({ statusLine: arg });
          refreshStatusLine();
          pushLine({ text: `Status line set: ${arg}`, color: C.cyan });
          break;
        }
        case '/vim': {
          const vimArg = arg.toLowerCase();
          const next = vimArg === 'on' ? true : vimArg === 'off' ? false : !vimEnabledRef.current;
          vimEnabledRef.current = next;
          setVimEnabled(next);
          opts.cfg.vimMode = next;
          saveGlobalConfig({ vimMode: next });
          if (next) setVimMode('insert'); // enable starts in INSERT so typing works at once
          else vimPendingRef.current = '';
          pushLine({
            text: next
              ? 'Vim mode ON — Esc for NORMAL, i/a to insert. Motions: h l 0 $ w b e · edits: x dd dw D C.'
              : 'Vim mode OFF — standard composer editing restored.',
            dimColor: true,
          });
          break;
        }
        case '/exit':
        case '/quit':
          exit();
          break;
      }
    },
    [pushLine, showBanner, setAutonomy, exit, context, opts, setLine, sessionLog, refreshStatusLine],
  );

  // Apply a picked model: rebuild the provider, hot-swap it into the running loop
  // (there is none mid-pick — the picker can't open while a turn runs), point the
  // next turn's deps at it, mirror the change into the UI, and remember the choice.
  const selectModel = useCallback(
    async (entry: ModelEntry) => {
      setPickerOpen(false);
      let provider = entry.provider;
      let baseUrl = resolveBaseUrl(entry.provider, entry.baseUrl);
      let apiKey = entry.apiKey ?? resolveApiKey(entry.provider);
      // Local .gguf model: ensure a llama.cpp server is up and route to it (ollama-style).
      if (entry.gguf) {
        try {
          const r = await ensureGgufServer(entry, (m) => pushLine({ text: m, dimColor: true }));
          provider = 'openai';
          baseUrl = r.baseUrl;
          apiKey = entry.apiKey ?? 'sk-local';
        } catch (e) {
          pushLine({ text: `Local model failed: ${(e as Error).message}`, color: C.red });
          return;
        }
      }
      const newProvider = createProvider({
        provider,
        model: entry.model,
        apiKey,
        authToken: entry.authToken ?? resolveAuthToken(entry.provider),
        baseUrl,
      });
      providerRef.current = newProvider;
      loopRef.current?.setProvider(newProvider, entry.model);
      opts.onModelSwitch?.(newProvider, entry.model); // keep the agent tool's sub-agents on the live model
      setCurrent({ provider, model: entry.model });
      try {
        saveGlobalConfig({ lastModel: entry.label });
      } catch {
        // best-effort persistence; the live switch already applies this session
      }
      pushLine({ text: `Model → ${entry.label} (${provider}/${entry.model})`, color: C.cyan });
    },
    [pushLine],
  );
  selectModelRef.current = selectModel;

  // Welcome card.
  useEffect(() => {
    showBanner();
  }, []);

  // Wire the interactive gate to React state.
  useEffect(() => {
    if (igateRef.current) {
      igateRef.current.show = (req) => {
        resetQuestionDialog();
        setPending(req);
      };
    }
    if (opts.wakeupHandler) {
      opts.wakeupHandler.fire = (task, reason) => {
        const line = `[wakeup: ${reason}] ${task}`;
        answerRunRef.current = []; // new (injected) turn → fresh repeat detector
        repeatPosRef.current = 0;
        pushLine({ kind: 'user', text: `❯ ${line}`, color: C.green, bold: true, meta: 'wakeup' });
        runOneRef.current?.(line);
      };
    }
  }, [opts.wakeupHandler, pushLine, resetQuestionDialog]);

  // Idle countdown → auto-answer. When a QUESTION dialog is open (never a permission gate) and the
  // user is away, tick down and then respond with the recommended answer(s) on their behalf. Any
  // key resets the clock (see the key handler). Off when SHADOW_NO_AUTO_ANSWER=1.
  const fireAutoAnswer = useCallback(() => {
    const g = igateRef.current;
    const p = pendingRef.current;
    if (!g || !g.awaiting || p?.kind !== 'user_question' || !p.questions?.length) return;
    const answers = buildAutoAnswers(p.questions, questionSelectionsRef.current);
    pushLine({
      text: `  ⏱ no response in ${AUTO_ANSWER_SECS}s — auto-selected the recommended answer${p.questions.length > 1 ? 's' : ''}`,
      color: C.dim,
    });
    g.respond({ answers });
  }, [pushLine]);

  useEffect(() => {
    if (!AUTO_ANSWER_ENABLED || pending?.kind !== 'user_question') {
      autoAnswerSecsRef.current = null;
      setAutoAnswerSecs(null);
      return;
    }
    autoAnswerSecsRef.current = AUTO_ANSWER_SECS;
    setAutoAnswerSecs(AUTO_ANSWER_SECS);
    const id = setInterval(() => {
      const n = (autoAnswerSecsRef.current ?? 0) - 1;
      if (n <= 0) {
        autoAnswerSecsRef.current = null;
        setAutoAnswerSecs(null);
        clearInterval(id);
        fireAutoAnswer();
      } else {
        autoAnswerSecsRef.current = n;
        setAutoAnswerSecs(n);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [pending, fireAutoAnswer]);

  // Spinner animation while a run is in flight.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick((t) => t + 1), 120);
    return () => clearInterval(id);
  }, [running]);

  // Subscribe to loop events.
  useLayoutEffect(() => {
    return bus.on((e) => {
      switch (e.type) {
        case 'text':
          if (e.delta) {
            // Accumulate, then flush every completed top-level block to <Static> (native
            // scrollback) and keep only the still-open block live. Refs (not state) so this
            // is synchronous and immune to the stale-closure double-commit React would risk.
            streamBufRef.current += e.delta;
            // Commit at LINE granularity so the live region stays ~1 line and the composer holds still
            // (the reference client feel); multi-line constructs stay grouped. Units carry `pad` — a source
            // blank line preceded them — which maps to a rendered gap, so the streamed answer keeps
            // the model's paragraph rhythm instead of gluing into a wall of text.
            const { units, rest, trailingBlank } = extractCommittableUnits(streamBufRef.current, padCarryRef.current);
            for (const u of units) {
              if (!u.text.trim()) continue;
              // Turn-scoped: suppress a verbatim re-emission of the answer (even a multi-block one),
              // but never legitimate new content and never an identical short answer in a later turn.
              if (absorbAssistant(u.text)) continue;
              pushLine({ kind: 'assistant', text: stripTrailingNewlines(u.text), color: C.fg, meta: 'assistant', tight: answerOpenRef.current && !u.pad });
              answerOpenRef.current = true;
            }
            padCarryRef.current = trailingBlank;
            streamBufRef.current = rest;
            pendingStreamRef.current = rest;
            scheduleFlush();
          }
          break;
        case 'thinking':
          if (e.delta) {
            thinkBufRef.current += e.delta;
            pendingThinkRef.current = thinkBufRef.current;
            scheduleFlush();
          }
          break;
        case 'reasoning_done': {
          // Through pushLine (the single choke point every transcript item flows through) so a
          // future hook on commit sees reasoning items too.
          pushLine({ kind: 'reasoning', text: e.text.trimEnd(), dimColor: true, meta: 'reasoning' });
          setThinkNow('');
          // Keep open during stream; will auto-collapse on action (research collapse-when-done)
          break;
        }
        case 'assistant_done': {
          // The streamed blocks are already in <Static>; commit only the leftover open
          // block. If the provider streamed nothing (no `text` deltas), fall back to the
          // full e.text. Gating on `streamed` avoids re-committing the whole answer when
          // the stream happened to end exactly on a block boundary (rest === '').
          const streamed = answerOpenRef.current || streamBufRef.current.length > 0;
          const finalText = streamed ? streamBufRef.current : (e.text ?? '');
          setStreamNow('');
          setThinkNow('');
          // (Reasoning is folded by default now — no per-item collapse needed; Ctrl-O reveals all.)
          if (finalText.trim()) {
            // Weak local models re-emit the final line/paragraph after a tool step; committing it
            // again printed the answer twice. Same turn-scoped detector as the streaming path — the
            // leftover open block is one more unit in this turn's run, so a repeat is suppressed.
            if (!absorbAssistant(finalText)) {
              pushLine({ kind: 'assistant', text: stripTrailingNewlines(finalText), color: C.fg, meta: 'assistant', tight: answerOpenRef.current && !padCarryRef.current && !leadsWithBlock(finalText) });
            }
          }
          answerOpenRef.current = false;
          padCarryRef.current = false;
          break;
        }
        case 'finding':
          pushLine({
            kind: 'finding',
            title: e.title,
            text: e.body,
            severity: e.severity,
            meta: 'finding',
          });
          break;
        case 'tool_start':
          setThinkNow(''); // reasoning for this step is over once it acts (folded by default now)
          setActiveTool({ name: e.call.name, arg: previewOf(e.call.input) });
          setToolLine(`↳ ${e.call.name} ${previewOf(e.call.input)}`);
          break;
        case 'tool_end': {
          setToolLine(null);
          setActiveTool(null);
          setShellPid(null);
          setShellWarn(null);
          pushLine({
            kind: 'tool',
            text: `${e.result.ok ? '✓' : '✗'} ${e.call.name} ${Math.max(0, Math.round(e.result.meta.durationMs))}ms — ${oneLine(e.result.summary)}`,
            color: e.result.ok ? C.green : C.red,
            meta: e.call.name,
            tool: {
              name: e.call.name,
              arg: previewOf(e.call.input) || undefined,
              ok: e.result.ok,
              durationMs: Math.max(0, e.result.meta.durationMs),
              summary: oneLine(e.result.summary),
            },
          });
          // Shell output (run_shell / bash_output) is shown as a COLLAPSIBLE block — visible but folded
          // to "▸ output +N lines · Ctrl-O" once it passes the collapse threshold, so a noisy command
          // (a big cat/print) can't flood the transcript. Short output shows inline. (the reference client parity.)
          const sd = e.result.data as { stdout?: string; stderr?: string } | undefined;
          const shellOut = [sd?.stdout ?? '', sd?.stderr ?? ''].join('\n').replace(/^\n+|\n+$/g, '');
          if (shellOut.trim()) {
            pushLine({
              kind: 'tool',
              text: shellOut,
              meta: 'output',
              lines: shellOut.split('\n').map((l) => ({ text: l, color: C.dim })),
            });
          }
          // Edits/writes carry a UI-only diff on meta — render it as a collapsible
          // +/- block in the transcript (collapsed by default; Ctrl-O expands).
          const diff = e.result.meta?.diff;
          if (diff && diff.length) {
            pushLine({
              kind: 'tool',
              text: '',
              meta: 'diff',
              lines: diff.map((d) => ({
                text: `${d.tag} ${d.text}`,
                color: d.tag === '+' ? C.green : d.tag === '-' ? C.red : undefined,
                dimColor: d.tag === ' ',
              })),
            });
          }
          break;
        }
        case 'tool_denied':
          setToolLine(null);
          setActiveTool(null);
          pushLine({ kind: 'blocked', text: `  blocked ${friendlyDeniedReason(e.reason)}`, color: C.yellow, meta: e.call.name });
          break;
        case 'retry':
          pushLine({
            text: `  retry ${e.attempt} in ${e.delayMs}ms (${oneLine(e.reason)})`,
            dimColor: true,
          });
          break;
        case 'error':
          pushLine({ kind: 'error', text: `  ! ${e.message}`, color: C.red });
          break;
        case 'autonomy':
          setAutonomy(e.level);
          break;
        case 'compaction':
          pushLine({
            text: '  ⟳ context compacted — earlier turns summarized to free up room',
            color: C.cyan,
          });
          break;
        case 'usage':
          lastUsageRef.current = e;
          setStatus(formatUsage(e));
          // Accumulate SESSION cost from per-turn usage deltas (the Budget resets
          // each turn, so summing raw events would double-count within a turn).
          {
            const delta = e.costUSD - prevTurnCostRef.current;
            if (delta > 0) sessionCostRef.current += delta;
            prevTurnCostRef.current = e.costUSD;
          }
          // Soft cost guardrail: one-time notice when SESSION spend crosses the
          // configured threshold (distinct from budget.maxCostUSD's hard stop).
          if (
            !costWarnedRef.current &&
            opts.cfg.costWarnUSD != null &&
            sessionCostRef.current >= opts.cfg.costWarnUSD
          ) {
            costWarnedRef.current = true;
            pushLine({
              text: `⚠ Session cost crossed $${opts.cfg.costWarnUSD} (now $${sessionCostRef.current.toFixed(4)}). /cost for details; budget.maxCostUSD hard-stops the loop.`,
              color: C.yellow,
            });
          }
          break;
        case 'todo':
          setTodoItems(e.items);
          break;
        case 'plan_mode':
          setPlanMode(e.plan);
          break;
        case 'shell_output':
          // Live shell preview = the LAST non-empty output line only, capped — the raw chunks used to
          // accumulate unbounded into this state, ballooning the live region (and the composer with it)
          // during chatty commands. Full output still lands in the transcript via tool_end.
          setToolLine((prev) => {
            // Strip our own display prefix before merging so a chunk that CONTINUES the same output
            // line glues onto the raw text, not onto the decorated line (no "⚙ ⚙" compounding).
            const merged = `${(prev ?? '').replace(/^ {2}⚙ /, '')}${e.chunk}`.slice(-2000);
            const last = merged.split('\n').reverse().find((l) => l.trim() !== '');
            return last ? `  ⚙ ${last.trim().slice(0, 160)}` : prev;
          });
          break;
        case 'shell_pid':
          setShellPid(e.pid);
          setShellWarn(e.warn);
          break;
        case 'model_fallback':
          pushLine({
            text: `  model fallback: ${e.from} → ${e.to} (${oneLine(e.reason)})`,
            dimColor: true,
          });
          setCurrent({ provider: currentRef.current.provider, model: e.to });
          break;
        case 'bg_agent_launched':
          pushLine({
            text: `  launched bg sub-agent${e.subagentType ? ` (${e.subagentType})` : ''}: ${e.taskId}`,
            dimColor: true,
            color: 'cyan',
          });
          break;
        case 'task_notification':
          pushLine({
            text: `  <task-notification> ${e.fromSubagent ? `[${e.fromSubagent}] ` : ''}${oneLine(e.answer)}`,
            color: 'cyan',
          });
          break;
        case 'stop':
          // Interrupted mid-answer (Esc/Ctrl-C) before assistant_done? Commit whatever
          // streamed so the partial reply lands in scrollback instead of vanishing. On a
          // clean turn the buffer is already empty here, so this is a no-op.
          if (streamBufRef.current.trim()) {
            pushLine({ kind: 'assistant', text: stripTrailingNewlines(streamBufRef.current), color: C.fg, meta: 'assistant', tight: answerOpenRef.current && !padCarryRef.current && !leadsWithBlock(streamBufRef.current) });
          }
          answerOpenRef.current = false;
          padCarryRef.current = false;
          // Full live-state cleanup: also clear the THINKING indicator + buffers. An Esc mid-reasoning
          // (or a provider throw) used to strand a stuck "✻ Thinking…" line because stop only cleared
          // the stream side; and stale buf/pending refs could leak a ghost flush into the next turn.
          streamBufRef.current = '';
          thinkBufRef.current = '';
          pendingStreamRef.current = null;
          pendingThinkRef.current = null;
          setStreamNow('');
          setThinkNow('');
          setToolLine(null);
          setShellPid(null);
          setShellWarn(null);
          if (e.reason !== 'end_turn') pushLine({ text: `  · ${e.reason}`, dimColor: true });
          break;
      }
    });
  }, [bus, pushLine, setAutonomy]);

  // Run one task through the agent loop.
  const runOne = useCallback(
    async (task: string) => {
      // The welcome header committed to <Static> once at startup — nothing to commit here.
      const promptHooks = opts.cfg.hooks?.user_prompt_submit ?? [];
      if (promptHooks.length) {
        const h = runHookPhase('user_prompt_submit', promptHooks, {
          prompt: task,
          workspaceRoot: opts.workspaceRoot,
        });
        if (!h.ok) {
          pushLine({
            kind: 'error',
            text: `  ! ${h.message ?? 'user_prompt_submit hook denied this prompt'}`,
            color: C.red,
          });
          return;
        }
      }
      setRunning(true);
      runStartRef.current = Date.now();
      answerOpenRef.current = false;
      padCarryRef.current = false;
      // New turn → reset the turn-scoped verbatim-repeat detector. This is the single choke point every
      // turn passes through, so paths that call runOne directly (e.g. /review) can't leave a stale run
      // that silently drops this turn's blocks. (startTurn/wakeup also reset it; redundant but harmless.)
      answerRunRef.current = [];
      repeatPosRef.current = 0;
      setStreamNow('');
      setThinkNow('');
      ctrlCArmedRef.current = false;

      // Prepend any queued /image attachments, then clear the buffer (one-shot per message).
      const imgs = attachmentsRef.current;
      const content: ContentBlock[] = task ? [{ type: 'text', text: task }] : [];
      content.push(...imgs);
      if (imgs.length) {
        attachmentsRef.current = [];
        setAttachCount(0);
      }
      const userMsg: Message = { role: 'user', content: content.length ? content : [{ type: 'text', text: task }] };
      if (firstRef.current) {
        context.pinTask(userMsg);
        firstRef.current = false;
      } else {
        context.append(userMsg);
      }
      sessionLog.record({ kind: 'user', task });

      const controller = new AbortController();
      controllerRef.current = controller;
      const budget = new Budget(
        {
          maxIterations: opts.cfg.maxIterations,
          maxTotalTokens: opts.cfg.budget.maxTotalTokens,
          maxCostUSD: opts.cfg.budget.maxCostUSD,
          maxWallClockSec: opts.cfg.budget.maxWallClockSec,
        },
        currentRef.current.model,
        opts.cfg.priceTable,
        Date.now(),
      );
      const deps: LoopDeps = {
        provider: providerRef.current,
        registry: opts.registry,
        gate: gateRef.current!,
        bus,
        budget,
        context,
        signal: controller.signal,
        model: currentRef.current.model,
        system:
          (opts.styleState?.systemForStyle?.(styleRef.current) ?? opts.system) +
          (goalRef.current
            ? `\n\n## Standing goal\nThe user set a standing goal for this session. Keep working toward it until it is met or explicitly cleared; do not consider the task done while it is unmet:\n${goalRef.current}\n`
            : ''),
        maxOutputTokens: opts.cfg.maxOutputTokens,
        effort: opts.cfg.effort,
        cacheTtl: opts.cfg.cacheTtl,
        fastMode: opts.cfg.fastMode,
        workspaceRoot: opts.workspaceRoot,
        additionalRoots: additionalRootsRef.current,
        dryRun: opts.cfg.dryRun,
        maxToolResultChars: opts.cfg.maxToolResultChars,
        contextBudget: opts.cfg.contextBudget,
        forceConfirm: opts.forceConfirm,
        todoList: opts.todoList,
        planMode: opts.planMode,
        permissionRules: opts.cfg.permissionRules,
        autoClassifier: opts.cfg.autoClassifier,
        hooks: opts.cfg.hooks,
        models: opts.cfg.models,
        fallbackModel: opts.cfg.fallbackModel,
        parallelTools: opts.cfg.parallelTools,
        streamShell: true,
        sessionLog,
      };
      const loop = new AgentLoop(deps, autonomyRef.current);
      loopRef.current = loop;
      try {
        await loop.run();
      } catch (err) {
        pushLine({ text: `  ! ${(err as Error).message}`, color: C.red });
      } finally {
        loopRef.current = null;
        controllerRef.current = null;
        // Full live-state teardown, mirroring the 'stop' handler. A provider throw that never
        // reaches 'stop' (non-abort stream error with no fallback) used to strand non-empty
        // stream/think state — which keeps the Turn HUD mounted (its gate includes them) as a
        // stuck fixed-height box with a blank status row. Commit any streamed tail first so an
        // errored turn still leaves its partial answer in the transcript.
        if (streamBufRef.current.trim()) {
          pushLine({ kind: 'assistant', text: stripTrailingNewlines(streamBufRef.current), color: C.fg, meta: 'assistant', tight: answerOpenRef.current && !padCarryRef.current && !leadsWithBlock(streamBufRef.current) });
        }
        answerOpenRef.current = false;
        padCarryRef.current = false;
        streamBufRef.current = '';
        thinkBufRef.current = '';
        pendingStreamRef.current = null;
        pendingThinkRef.current = null;
        setStreamNow('');
        setThinkNow('');
        setToolLine(null);
        setRunning(false);
        // Turn ended — drain any type-ahead the user queued while it ran. flushQueue
        // either starts the next queued turn (which re-enters this finally on its own
        // completion) or runs queued slash commands in order.
        flushQueueRef.current?.();
      }
    },
    [opts, context, sessionLog, bus, pushLine],
  );
  runOneRef.current = (task: string) => {
    void runOne(task);
  };

  // Start a fresh turn exactly as an idle Enter would: print the `❯ task` user line, then
  // drive the loop. (The welcome banner is already committed to <Static> at startup, so there
  // is nothing to commit here.) Shared by the idle-submit path and the type-ahead queue flush.
  const startTurn = useCallback(
    (task: string) => {
      // Commit the finished turn's cost into the session total baseline, then reset
      // the per-turn cursor so the next turn's usage deltas accumulate from 0.
      prevTurnCostRef.current = 0;
      // New turn → the verbatim-repeat detector starts fresh (an identical short answer in this
      // turn is real, not a repeat of the last turn's).
      answerRunRef.current = [];
      repeatPosRef.current = 0;
      const nImg = attachmentsRef.current.length;
      const userText = task || `📎 ${nImg} image${nImg === 1 ? '' : 's'}`;
      pushLine({ kind: 'user', text: `❯ ${userText}`, color: C.green, bold: true, meta: 'you' });
      void runOne(task);
    },
    [pushLine, runOne],
  );

  // Flush the type-ahead queue in FIFO order. Slash commands run synchronously (same
  // dispatch path as a typed one) and we keep draining; a plain message starts a turn
  // and we stop — that turn's completion re-invokes flushQueue for the remainder.
  const flushQueue = useCallback(() => {
    while (queuedTasksRef.current.length > 0) {
      const [next, ...rest] = queuedTasksRef.current;
      setQueued(rest);
      const task = (next ?? '').trim();
      if (!task) continue;
      if (task.startsWith('/')) {
        const s = classifySlash(task);
        if (s.kind === 'command') {
          runSlash(s.cmd!, task);
          continue; // slash command is synchronous — keep draining
        }
        if (s.kind === 'typo') {
          pushLine({ text: `Unknown command: ${task.split(/\s+/)[0]} — type / for the list.`, color: C.red });
          continue;
        }
        // 'message' — a path — fall through to startTurn
      }
      startTurn(expandPastes(task, pastesRef.current)); // starts a turn; its completion resumes the drain
      return;
    }
  }, [setQueued, runSlash, pushLine, startTurn]);
  flushQueueRef.current = flushQueue;

  // Key handling — uses Ink's `key` object (NOT raw control bytes in `input`).
  const onKey = useCallback(
    (ch: string, key: import('ink').Key) => {
      // Mouse-tracking CSI (\x1b[< … ) is consumed by the wheel listener; never let
      // it reach the Esc/abort or composer-typing paths. (ESC[< can't be typed.)
      if (ch && (ch.includes('\x1b[<') || /\[<\d/.test(ch))) return;
      // Any key other than a second Ctrl-C disarms the "press again to quit" latch, so an old
      // Ctrl-C never lingers to make a later one quit unexpectedly.
      if (ctrlCArmedRef.current && !(key.ctrl && ch === 'c')) ctrlCArmedRef.current = false;
      // 1) Approval dialog has focus.
      if (pendingRef.current) {
        const g = igateRef.current;
        if (!g) return;
        const kind = pendingRef.current.kind;
        if (kind === 'user_question' && pendingRef.current.questions?.length) {
          const qs = pendingRef.current.questions;
          const idx = Math.min(questionIndexRef.current, qs.length - 1);
          const q = qs[idx];
          if (!q) return;
          // Any key means the user is present → restart the idle auto-answer countdown.
          if (AUTO_ANSWER_ENABLED) {
            autoAnswerSecsRef.current = AUTO_ANSWER_SECS;
            setAutoAnswerSecs(AUTO_ANSWER_SECS);
          }
          const cursor = questionCursorRef.current[idx] ?? recommendedIndex(q);
          const chooseAt = (pos: number) => {
            const label = q.options[pos]?.label;
            if (label === undefined) return;
            const current = questionSelectionsRef.current[idx] ?? [];
            const selected = q.multiSelect
              ? current.includes(label)
                ? current.filter((v) => v !== label)
                : [...current, label]
              : [label];
            setQuestionSelection(idx, selected);
          };
          // ↑/↓ move the option cursor. Single-select follows it (radio); multi just moves.
          if (key.upArrow) {
            const pos = Math.max(0, cursor - 1);
            setQuestionCursor(idx, pos);
            if (!q.multiSelect) chooseAt(pos);
            return;
          }
          if (key.downArrow) {
            const pos = Math.min(q.options.length - 1, cursor + 1);
            setQuestionCursor(idx, pos);
            if (!q.multiSelect) chooseAt(pos);
            return;
          }
          // ←/→ (and Tab) switch between questions in a multi-question dialog.
          if (key.leftArrow) {
            setQuestionIndex(Math.max(0, idx - 1));
            return;
          }
          if (key.rightArrow || key.tab) {
            setQuestionIndex(Math.min(qs.length - 1, idx + 1));
            return;
          }
          // Space toggles the highlighted option (multi-select).
          if (ch === ' ' && q.multiSelect) {
            chooseAt(cursor);
            return;
          }
          // Number keys jump straight to an option.
          if (ch >= '1' && ch <= '9') {
            const pos = Number(ch) - 1;
            if (q.options[pos]) {
              setQuestionCursor(idx, pos);
              chooseAt(pos);
            }
            return;
          }
          if (key.return) {
            // Single-select: commit the highlighted option if nothing is chosen yet.
            if (!q.multiSelect && !questionSelectionsRef.current[idx]?.length) chooseAt(cursor);
            if (idx < qs.length - 1) {
              setQuestionIndex(idx + 1);
              return;
            }
            g.respond({ answers: buildQuestionAnswers(qs, questionSelectionsRef.current) });
            return;
          }
          if (key.escape) g.respond('deny');
          return;
        }
        if (ch === 'y' || (key.return && kind !== 'user_question')) g.respond('approve');
        else if (ch === 'n' || key.escape) g.respond('deny');
        else if (ch === 's' && kind === 'permission') g.respond({ approveForSession: true });
        else if (ch === 'f' && kind === 'permission' && pendingRef.current?.call.name === 'run_shell') {
          const cmd = shellCommandOf(pendingRef.current.call.input) ?? '';
          const prefix = cmd.split(/\s+/).slice(0, 2).join(' ');
          g.respond({ approveForPrefix: prefix || cmd.slice(0, 24) });
        } else if (ch === 'a' && kind !== 'plan_enter') {
          const next = cycleAutonomy(autonomyRef.current);
          setAutonomy(next);
          g.respond({ setAutonomy: next });
        }
        return;
      }

      // 1.5) Model picker has focus — capture navigation, swallow the rest (mirrors
      // the approval-dialog gating above so composer/menu keys can't leak through).
      if (pickerOpenRef.current) {
        const rows = modelRows(opts.cfg);
        let sel = Math.min(pickerIndexRef.current, rows.length - 1);
        if (rows[sel]?.kind !== 'model') sel = firstSelectableRow(rows); // never land on a header
        if (key.upArrow) setPickerIndex(stepSelectableRow(rows, sel, -1));
        else if (key.downArrow) setPickerIndex(stepSelectableRow(rows, sel, 1));
        else if (key.return) {
          const row = rows[sel];
          if (row?.kind === 'model') selectModel(row.entry);
        } else if (key.escape) {
          setPickerOpen(false);
          pushLine({ text: 'Model unchanged.', dimColor: true });
        }
        return;
      }

      // Scrolling the transcript is the terminal's job again: the committed history
      // lives in an Ink <Static> (native scrollback), so PgUp/PgDn, the scrollbar, and
      // the mouse wheel all work without the app intercepting them. (The old in-app
      // scroll viewport detached native scrollback, which broke once the pinned task
      // list claimed rows from the fixed-height layout.)

      // 2) Ctrl-C — QUIT, always two-stage so a stray press can't kill the session. The first
      // press arms (and, if a turn is running, also interrupts it + drops the queue); a second
      // Ctrl-C quits. Any other key disarms (handled at the top of this handler). Esc is the
      // dedicated interrupt that keeps the session.
      if (key.ctrl && ch === 'c') {
        if (ctrlCArmedRef.current) {
          exit();
          return;
        }
        ctrlCArmedRef.current = true;
        if (runningRef.current) {
          controllerRef.current?.abort();
          if (queuedTasksRef.current.length > 0) setQueued([]);
        }
        pushLine({ text: '  ^C — press Ctrl-C again to quit (Esc just interrupts)', dimColor: true });
        return;
      }

      // 2.9) Vim modal editing (when enabled via /vim). ESC enters NORMAL mode; in
      // NORMAL, keys are motions/operators (never text). INSERT is the default composer.
      if (vimEnabledRef.current && !runningRef.current) {
        if (key.escape) {
          vimPendingRef.current = '';
          if (vimModeRef.current !== 'normal') setVimMode('normal');
          // Vim NORMAL keeps the caret on a char, not past the end of the line.
          const clamped = Math.min(cursorRef.current, Math.max(0, inputRef.current.length - 1));
          if (clamped !== cursorRef.current) {
            cursorRef.current = clamped;
            setCursor(clamped);
          }
          return;
        }
        if (vimModeRef.current === 'normal') {
          if (key.backspace || key.delete) {
            // Backspace moves left (vim), it does not delete.
            const next = Math.max(0, cursorRef.current - 1);
            cursorRef.current = next;
            setCursor(next);
            return;
          }
          // Enter (submit), Tab, arrows, paging, and Ctrl/Meta chords keep their handlers.
          const structural =
            key.return || key.tab || key.ctrl || key.meta || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.pageUp || key.pageDown;
          if (!structural && ch) {
            // Ink batches fast typing / paste into one `ch`, so step through it key by key.
            // If an edit switches to INSERT mid-batch, the rest is inserted literally.
            let text = inputRef.current;
            let cur = cursorRef.current;
            let pend = vimPendingRef.current;
            let mode: VimMode = vimModeRef.current;
            for (const c of ch) {
              if (mode === 'insert') {
                text = text.slice(0, cur) + c + text.slice(cur);
                cur += c.length;
                continue;
              }
              const r = vimNormalKey(text, cur, pend, c);
              text = r.input;
              cur = r.cursor;
              pend = r.pendingOp;
              mode = r.mode;
            }
            vimPendingRef.current = pend;
            setComposer(text, cur);
            if (mode !== vimModeRef.current) setVimMode(mode);
            return; // consume every non-structural key in NORMAL (unknown keys never insert)
          }
          if (!structural) return; // swallow any other non-structural key in NORMAL
        }
      }

      // 3) Esc — the interrupt key. While a turn runs, Esc stops it (and the type-ahead queue
      // then flushes, so a queued message runs next). When idle, Esc cancels a pending queue,
      // else clears the composer. Session always survives — only Ctrl-C quits.
      if (key.escape) {
        if (runningRef.current) {
          controllerRef.current?.abort();
          pushLine({ text: '  ⎋ interrupted', dimColor: true });
        } else if (queuedTasksRef.current.length > 0) {
          setQueued([]);
          pushLine({ text: '  queued input cleared', dimColor: true });
        } else setLine('');
        return;
      }

      // 3.25) Keybinding resolver — first dispatch for discrete action keys. Migrated
      // here from the old imperative chain: app:redraw (ctrl+l), transcript:toggleFoldLatest
      // (ctrl+o), transcript:toggleTaskList (ctrl+t), plus any user-defined chords. A
      // match with a registered handler consumes the key; everything else (incl. matched
      // but not-yet-migrated actions, and all char-level composer editing) falls through.
      const kbContexts: ContextName[] = [];
      // (A pending approval/question dialog is handled above and always returns, so
      // by here no dialog is open — the resolver only sees the normal editing view.)
      if (pickerOpenRef.current) kbContexts.push('ModelPicker');
      if (slashMatches(inputRef.current).length > 0) kbContexts.push('Autocomplete');
      kbContexts.push('Transcript', 'Chat', 'Global');
      if (kbConsume(ch, key, kbContexts)) return;

      // 3.5) Slash-command menu: while "/word" has matches it captures ↑/↓/Tab/Enter — including
      // mid-turn, so you can still pick a command while the model works.
      const menu = slashMatches(inputRef.current);
      if (menu.length > 0) {
        const sel = Math.min(menuIndexRef.current, menu.length - 1);
        if (key.upArrow) {
          setMenuIndex(Math.max(0, sel - 1));
          return;
        }
        if (key.downArrow) {
          setMenuIndex(Math.min(menu.length - 1, sel + 1));
          return;
        }
        if (key.tab) {
          setLine(menu[sel]!.name); // autocomplete to the selected command
          setMenuIndex(0);
          return;
        }
        if (key.return) {
          const cmd = menu[sel]!;
          // Mid-turn, a command that isn't live-safe is QUEUED (runs when the turn ends); a
          // live-safe one (/help, /cost, …) and any command when idle runs immediately.
          if (runningRef.current && !SLASH_WHILE_RUNNING.has(slashDispatchName(cmd))) {
            setQueued([...queuedTasksRef.current, cmd.name]);
            setLine('');
            setMenuIndex(0);
          } else {
            runSlash(cmd);
          }
          return;
        }
        // typing / backspace fall through below to re-filter the menu
      }

      // 4) Tab / Shift+Tab — cycle the working mode (applies live to a running loop too).
      //    Ring (reference-client style): manual → auto-read → auto-edit → full → plan → (wraps).
      //    Plan mode is the last stop; leaving it restarts the ring at the most cautious level.
      if (key.tab) {
        const pm = opts.planMode;
        if (pm?.active) {
          pm.exit(); // leave plan mode → back to the start of the autonomy ring
          setAutonomy('manual');
          loopRef.current?.setAutonomy('manual');
        } else if (pm && autonomyRef.current === 'full') {
          pm.enter(); // top of the autonomy ring → step into plan mode
        } else {
          const next = cycleAutonomy(autonomyRef.current);
          setAutonomy(next);
          loopRef.current?.setAutonomy(next);
        }
        return;
      }

      // 5) Caret movement within the composer.
      if (key.leftArrow) {
        const next = Math.max(0, cursorRef.current - 1);
        cursorRef.current = next;
        setCursor(next);
        return;
      }
      if (key.rightArrow) {
        const next = Math.min(inputRef.current.length, cursorRef.current + 1);
        cursorRef.current = next;
        setCursor(next);
        return;
      }

      // 6) History (↑/↓) — replaces the whole line, caret to end.
      if (key.upArrow) {
        if (historyRef.current.length && histIdxRef.current > 0) {
          histIdxRef.current -= 1;
          setLine(historyRef.current[histIdxRef.current] ?? '');
        }
        return;
      }
      if (key.downArrow) {
        if (histIdxRef.current < historyRef.current.length) {
          histIdxRef.current += 1;
          setLine(historyRef.current[histIdxRef.current] ?? '');
        }
        return;
      }

      // 7) Backspace — delete the char before the caret. (macOS Delete key reports
      //    as key.delete; treat both as backspace — forward-delete is rarely used.)
      if (key.backspace || key.delete) {
        const c = cursorRef.current;
        const s = inputRef.current;
        if (c > 0) {
          setComposer(s.slice(0, c - 1) + s.slice(c), c - 1);
        }
        setMenuIndex(0);
        return;
      }

      // 8) Submit.
      if (key.return) {
        // Multiline: a trailing backslash turns Enter into a newline instead of submit.
        if (inputRef.current.endsWith('\\')) {
          const next = inputRef.current.slice(0, -1) + '\n';
          setComposer(next, next.length);
          return;
        }
        const task = inputRef.current.trim();
        if (!task && !attachmentsRef.current.length) return; // allow an image-only message
        if (runningRef.current) {
          // Type-ahead: a turn is in flight. Informational slash commands run live;
          // everything else is QUEUED (FIFO) and flushed when the turn ends — the turn
          // is NOT interrupted (reference-client style). Esc clears the queue; Ctrl-C aborts.
          if (task.startsWith('/')) {
            const cmdName = task.split(/\s+/)[0] ?? '';
            const cmd = findSlashCommand(cmdName);
            if (cmd && SLASH_WHILE_RUNNING.has(slashDispatchName(cmd))) {
              runSlash(cmd, task);
              return;
            }
          }
          if (!task) return; // image-only can't be queued (attachments flush with the next typed message)
          setQueued([...queuedTasksRef.current, task]);
          historyRef.current.push(task);
          histIdxRef.current = historyRef.current.length;
          setLine('');
          return;
        }
        if (task.startsWith('/')) {
          const s = classifySlash(task);
          if (s.kind === 'command') {
            runSlash(s.cmd!, task);
            return;
          }
          if (s.kind === 'typo') {
            pushLine({ text: `Unknown command: ${task.split(/\s+/)[0]} — type / for the list.`, color: C.red });
            setLine('');
            return;
          }
          // 'message' — a path like /Users/… — fall through and send it to the agent
        }
        if (task === 'exit' || task === 'quit') {
          exit();
          return;
        }
        historyRef.current.push(task);
        histIdxRef.current = historyRef.current.length;
        setLine('');
        if (vimEnabledRef.current) setVimMode('insert'); // next prompt starts ready to type
        startTurn(expandPastes(task, pastesRef.current));
        return;
      }

      // 9) Printable input — insert at the caret (Ink delivers pasted strings here too).
      if (!key.ctrl && !key.meta && ch) {
        const c = cursorRef.current;
        const s = inputRef.current;
        if (isBigPaste(ch)) {
          // Condense a big paste into a compact [Pasted text #N] chip (the reference clients feel) so
          // the composer never balloons; the full text is restored at submit via expandPastes.
          const id = (pasteCounterRef.current += 1);
          const lines = (ch.match(/\n/g)?.length ?? 0) + 1;
          pastesRef.current.push({ id, content: ch, lines });
          const chip = `[Pasted text #${id} +${lines} lines]`;
          setComposer(s.slice(0, c) + chip + s.slice(c), c + chip.length);
        } else {
          setComposer(s.slice(0, c) + ch + s.slice(c), c + ch.length);
        }
        setMenuIndex(0);
      }
    },
    [exit, pushLine, runOne, runSlash, selectModel, setAutonomy, setComposer, setLine, setQuestionIndex, setQuestionSelection, opts, startTurn, setQueued, kbConsume],
  );

  useInput(onKey);

  const spinner = SPINNER[tick % SPINNER.length];
  // Elapsed seconds of the current turn — re-derived each spinner tick (~120ms) so a
  // slow/stalled model reads as "still waiting", not a frozen UI.
  const elapsedSec = running ? Math.floor((Date.now() - runStartRef.current) / 1000) : 0;
  const todoDone = todoItems.filter((item) => item.status === 'completed').length;
  // The pinned Task list disappears once the work is genuinely finished — every item complete AND the
  // turn has ended. It stays up mid-turn (live progress) and when a turn ends with items still open (so
  // you can see what's left), so a COMPLETED list no longer lingers until the next task loads.
  const showTodo = todoItems.length > 0 && (running || todoDone < todoItems.length);
  const todoStatus = showTodo ? ` · todo ${todoDone}/${todoItems.length}` : '';
  const planStatus = planMode.mode === 'planning' ? ' · plan: planning' : '';
  const showPlan = !!planMode.title;

  // Layout is consulted only for `cols` (Banner + status-strip width). The transcript
  // is an Ink <Static> that owns the terminal's native scrollback, so the vertical
  // chrome math never clips it; todo/plan render as a pinned block above the composer.
  const layout = computeLayout(terminalSize.cols, terminalSize.rows);
  // ── Turn-HUD frame budget ─────────────────────────────────────────────────────
  // While a turn runs, the live region is a CONSTANT-HEIGHT HUD (fixed stream window + exactly one
  // status line + at most one pinned-tasks line) so the composer never moves mid-turn — the Claude
  // Code architecture: its input isn't hard-anchored, its live region just never changes height.
  // The budget also guarantees the worst-case live frame stays well under terminal rows: if Ink's
  // frame ever reaches the terminal height it falls back to clearTerminal every render (wiping the
  // user's scrollback and re-writing the whole transcript — the historical "ghosting/clutter" bug),
  // so streamTail is sized to make that fallback UNREACHABLE.
  // Reserved rows outside the stream window — MEASURED, not guessed (the first budget assumed 9 and
  // was breached on ≤22-row terminals): HUD status 1 + HUD marginTop 1 + pinned line 1 + composer
  // marginTop 1 + composer box 4 (border+input+hint+border) + queued 1 + status strip 1 +
  // customStatus 1 + safety 3 = 14. Worst-case live frame = streamTail + 13 ≤ rows − 1, so Ink's
  // fallback (fires at outputHeight ≥ rows) stays strictly unreachable on terminals ≥ 17 rows.
  // Composer stationarity has exactly TWO one-time, turn-scoped +1 shifts (both inside the safety
  // rows): the todo pin line appearing, and the queued row appearing on the first type-ahead.
  const streamTail = Math.max(3, Math.min(12, terminalSize.rows - 14));
  const statusStrip = formatStatusStrip(
    {
      provider: current.provider,
      model: current.model,
      autonomy,
      bypass: opts.bypass,
      planStatus,
      todoStatus,
      effortStatus: ` · ${effortSymbol(effort)} ${effort}`,
      sandboxStatus: opts.bypass ? ' · sandbox:off' : '',
      status,
    },
    layout.cols,
  );
  // The slash menu shows whenever "/word" has matches — including while a turn runs, so you can
  // still autocomplete a command to queue it (or run a live-safe one). Only an active overlay
  // (approval / model picker) suppresses it.
  const menu = !pending && !pickerOpen ? slashMatches(input) : [];
  const selIndex = Math.min(menuIndex, Math.max(0, menu.length - 1));
  // Slash menu is windowed (10 rows) and scrolls with the selection so ↑/↓ can reach
  // every command — not capped at the first 10 (which hid the highlight past row 10).
  // The menu box costs MENU_MAX + 5 physical rows worst case (2 border + header + BOTH scroll
  // indicators), so its cap is terminal-derived: fits 17-row terminals at the floor of 3. Reserve
  // 14 (not 13): the 1-row status spacer above the composer now stays mounted while the menu is open
  // (so the input bar doesn't shift up when you type '/'), so the menu yields it one more row.
  const MENU_MAX = Math.max(1, Math.min(running ? 6 : 10, terminalSize.rows - 14));
  const menuStart = Math.min(Math.max(0, selIndex - MENU_MAX + 1), Math.max(0, menu.length - MENU_MAX));
  // Menu open = command-picking mode: the HUD (stream window + status line), the pinned line/block,
  // and the queued row ALL yield their rows to the menu — measured, that is the only arithmetic that
  // keeps the frame under terminal rows down to 17-row terminals (menu 8 + composer 4 + margins 2 +
  // strip 1 + customStatus 1 = 16). The composer itself still doesn't move (menu renders BELOW it),
  // and everything returns the moment the menu closes. On a terminal too short to hold the dropdown
  // box + composer + strip under the wipe threshold, the menu simply doesn't open (you can still type
  // the whole command); MENU_MAX+5 for the box, +5 for composer(4)+strip(1), +1 headroom.
  const menuOpen = menu.length > 0 && terminalSize.rows >= MENU_MAX + 5 + 5 + 1;
  const hudStreamRows = menuOpen ? 0 : streamTail;
  // Stock live-region cap: keep the preview short so the input bar below it barely moves as an answer
  // streams (the "bar still jumps" tradeoff). The CONTENT tail and the Box height MUST use this same
  // number — if the box is shorter than the clamped content, Ink clips the BOTTOM and the newest
  // streamed line disappears (the CODE_199 regression). 6 rows is the sweet spot: enough to read, not
  // enough to shove the composer around.
  // PINNED live slot: a SMALL constant-height region above the composer (the latest LIVE_ROWS
  // streaming lines, bottom-aligned, + the one 'working… Ns' status). Constant height ⇒ the composer
  // never moves mid-turn — finished lines scroll up into <Static> as they commit. Capped at 2: each
  // row here is one row the composer rises when the turn ends and the slot collapses (the answer has
  // committed to scrollback by then, so the content stays visible — the jump is just the slot going
  // away). Tighter = smaller turn-end settle. (the reference client pins its input the same way: content scrolls above.)
  const liveWant = Math.min(hudStreamRows, 2);
  // reference-client style activity line: an orange pulsing sparkle (rendered separately, below) + a playful
  // per-turn verb + a quiet metric tail. No 'working… 0s · Esc to interrupt' clutter — the elapsed
  // only appears after a beat, and the interrupt hint already lives in the composer footer.
  const statusVerb = running ? `${DEFAULT_STATUS_VERB}…` : '';
  const statusTail = running
    ? `${elapsedSec >= 1 ? ` (${formatDuration(elapsedSec)})` : ''}${toolLine ? ` · ${toolLine.trim()}` : ''}${shellPid ? ` · shell ${shellPid}` : ''}${shellPid && shellWarn ? ' · ⚠ may survive Esc' : elapsedSec >= 25 && !toolLine ? ' · model slow to respond' : ''}`
    : '';
  // Pinned agent state collapses to ONE line while running (the full PinnedState block is a 3→14-row
  // accordion that shoved the composer around mid-turn); the full list still renders between turns.
  const todoCurrent = todoItems.find((t) => t.status === 'in_progress')?.subject ?? '';
  const hudPinnedLine = [
    goal ? `🎯 ${goal}` : '',
    showPlan ? `${planMode.mode === 'planning' ? 'plan' : 'implement'}: ${planMode.title ?? ''}` : '',
    showTodo ? `▸ tasks ${todoDone}/${todoItems.length}${todoCurrent ? ` · ${todoCurrent}` : ''} · Ctrl-T` : '',
  ].filter(Boolean).join('   ·   ');
  // Frame budget: keep the live (non-Static) frame strictly under the terminal height so Ink never
  // trips its whole-screen wipe on a short/split-pane terminal. Drives which optional rows render.
  const hasLive = running || stream !== '' || think !== '';
  // Pinned zone: the full multi-row PinnedState block only renders IDLE on a comfortably tall terminal
  // (it's ~5 rows of chrome + items); running, or idle on a short/split-pane terminal, it collapses to
  // the single-row summary so it can't push the live frame past Ink's wipe threshold.
  const idlePinned = !running && !!(showPlan || showTodo || goal);
  const showFullPinned = idlePinned && terminalSize.rows >= 16;
  const wantPinnedLine = hudPinnedLine !== '' && !menuOpen && (running || (idlePinned && !showFullPinned));
  const hudFit = fitHud(terminalSize.rows, {
    liveWant: menuOpen || !hasLive ? 0 : liveWant,
    pinned: wantPinnedLine,
    queued: queued.length > 0 && !menuOpen,
    custom: !!customStatus,
  });
  const pickerRows = modelRows(opts.cfg);
  let pickerSel = Math.min(pickerIndex, Math.max(0, pickerRows.length - 1));
  if (pickerRows[pickerSel]?.kind !== 'model') pickerSel = firstSelectableRow(pickerRows);
  // The model picker is WINDOWED exactly like the slash menu (it used to render every row unclipped —
  // a long model list made the overlay taller than the screen).
  const PICKER_MAX = 10;
  const pickStart = Math.min(Math.max(0, pickerSel - PICKER_MAX + 1), Math.max(0, pickerRows.length - PICKER_MAX));
  const pendingQuestions = pending?.kind === 'user_question' ? (pending.questions ?? []) : [];
  const activeQuestionIndex = Math.min(questionIndex, Math.max(0, pendingQuestions.length - 1));
  const activeQuestion = pendingQuestions[activeQuestionIndex];
  const activeQuestionSelection = activeQuestion
    ? (questionSelections[activeQuestionIndex] ?? defaultQuestionSelection(activeQuestion))
    : [];
  const vimTag = vimEnabled ? (vimModeState === 'normal' ? '-- NORMAL -- · ' : '-- INSERT -- · ') : '';
  const attachTag = attachCount > 0 ? `📎 ${attachCount} · ` : '';
  const composerHint =
    attachTag +
    vimTag +
    (menu.length > 0
      ? `↑/↓ select · Tab complete · Enter ${running ? 'queues' : 'runs'} · Esc cancel`
      : running
        ? 'Type to queue · Enter queues for next · Esc interrupts · Ctrl-C ×2 quits'
        : 'Shift+Tab mode · / commands');

  // Suppress the live stream PREVIEW when the model is re-typing an answer it already committed this
  // turn (weak models repeat the final block(s) verbatim in one generation) — that's the "answer
  // shown twice" the screenshots caught: committed copy above + this preview below. Mirrors the
  // committer's turn-scoped detector: hide the preview while we're mid-repeat, or while the open
  // block is (a prefix of) this turn's first block — i.e. the answer visibly restarting. This is the
  // one place a PREFIX is right: the preview is transient, and the committer still makes the real
  // whole-block decision when the unit closes, so an over-eager hide only ever costs a brief flicker.
  const sk = dupKey(stream);
  const previewIsRepeat =
    stream !== '' &&
    (repeatPosRef.current > 0 ||
      (answerRunRef.current.length > 0 && sk.length >= 12 && (answerRunRef.current[0] ?? '').startsWith(sk)));
  const previewStream = previewIsRepeat ? '' : stream;

  return (
    // Flow mode: NO fixed height, so the committed transcript scrolls into the terminal's own
    // native scrollback (mouse wheel / PgUp work, nothing is EVER hidden). The composer sits under
    // the content and reaches the terminal bottom once the screen fills — and while a turn runs the
    // constant-height Turn HUD (see below) keeps the whole live frame a FIXED size, so the composer
    // never moves mid-turn. We deliberately do NOT pad a full-screen blank spacer to bottom-pin it
    // early: a frame as tall as the terminal trips Ink's clearTerminal fallback (scrollback wipe +
    // full-transcript rewrite EVERY render). The HUD's frame budget keeps us far below that line.
    <Box flexDirection="column">
      {/* Committed transcript → <Static>: each item is printed to native scrollback
          ONCE and never repainted, so the mouse wheel / scrollbar / PgUp all work while
          the live region below stays small. `staticEpoch` (Ctrl-O fold, /clear) forces a
          fresh flush when a committed item's rendered state must change. */}
      <Static key={staticEpoch} items={committed}>
        {(item, index) => (
          <FlatItem
            key={String(item.id)}
            item={item}
            cols={terminalSize.cols}
            collapsed={isCollapsible(item) && !showAllExpanded}
            // ⏺ once per contiguous assistant run: continuation if the previous committed item was
            // also an assistant block — so a multi-line/multi-paragraph answer reads as ONE turn.
            continuation={item.kind === 'assistant' && index > 0 && committed[index - 1]?.kind === 'assistant'}
          />
        )}
      </Static>

      {/* ── Live stream (pinned, reference-client style) ── split into two parts so the composer NEVER snaps up
          at turn end:
          (1) a fixed-height TAIL slot (latest ~liveRows streaming lines, bottom-aligned) — mounted
              only while a turn is active. Constant height ⇒ the composer holds still mid-turn.
          (2) a one-row STATUS line ('working… Ns') that stays mounted across the turn boundary.
          When the turn ends the tail slot unmounts, but its lines have committed to <Static>
          (scrollback) in the same breath — so the status row + the grown <Static> keep the composer
          at exactly the same row. The only cost is one row of space above the composer when idle.
          An active overlay (question / approval / model picker) replaces both. */}
      {!pending && !pickerOpen ? (
        <>
          {/* Live region yields to the menu (its rows go to the command box); the status spacer below
              stays so the composer never shifts up when the menu opens. hudFit.liveRows is 0 on a
              terminal too short to afford it — then the preview is dropped so the frame stays under
              the wipe threshold. */}
          {!menuOpen && hudFit.liveRows > 0 && (running || stream !== '' || think !== '') ? (
            // The live turn — rendered as the DIRECT CONTINUATION of the transcript, not a detached
            // preview. The height is bounded to hudFit.liveRows ONLY while an answer is actively
            // streaming (there, overflow:hidden clips any wrap/gap past the budget so a long open block
            // can't trip Ink's wipe). A lone '∴ Thinking…' or tool row is exactly ONE line — no reserved
            // rectangular slot with empty rows above it (that reserved space was the "tiny thinking
            // port" — peephole scaffolding). The uncommitted answer tail flows through the SAME FlatItem
            // path as committed blocks (identical ⏺/indent + markdown), growing out of the same column
            // it will scroll away in. Finished lines commit to <Static> as they stream (native scrollback).
            <Box flexDirection="column" height={previewStream ? hudFit.liveRows : 1} overflow="hidden" justifyContent="flex-end">
              {activeTool && !previewStream ? (
                // Persistent live tool row: the ⏺ is orange while the call runs (matches the spinner),
                // then tool_end commits the resolved green/red ⏺ row to <Static> in its place.
                <Box paddingLeft={PAGE_MARGIN}>
                  <Text wrap="truncate">
                    <Text color={CLAUDE_ORANGE}>{BLACK_CIRCLE} </Text>
                    <Text bold>{activeTool.name}</Text>
                    {activeTool.arg ? <Text color={C.dim}>{`(${activeTool.arg})`}</Text> : null}
                  </Text>
                </Box>
              ) : null}
              {think && !previewStream ? (
                // While the model thinks, a single compact ∴ Thinking… indicator aligned under the
                // gutter — NEVER the raw multi-line thought (that was the ugly split). The full thought
                // still commits COLLAPSED to the transcript ('∴ Thinking · ^O') on reasoning_done.
                <Box paddingLeft={PAGE_MARGIN}>
                  <Text italic color={C.dim}>{'∴ Thinking…'}</Text>
                </Box>
              ) : null}
              {previewStream ? (
                (() => {
                  const clamped = clampTail(previewStream, hudFit.liveRows);
                  // An OPEN code fence would render as a bordered code box needing ~4 rows — in this
                  // short slot Ink clips it to a broken/empty box. Show the newest raw code lines as
                  // plain dim text (no box), indented under the gutter so it aligns with the answer.
                  if (/^\s*(```|~~~)/.test(clamped)) {
                    const codeTail = previewStream
                      .split('\n')
                      .filter((l) => !/^\s*(```|~~~)/.test(l))
                      .slice(-hudFit.liveRows);
                    return (
                      <Box flexDirection="column" paddingLeft={PAGE_MARGIN}>
                        {codeTail.map((l, k) => (
                          <Text key={k} wrap="truncate"><Text>{'  '}</Text><Text color={C.dim}>{l || ' '}</Text></Text>
                        ))}
                      </Box>
                    );
                  }
                  // The uncommitted tail as a real transcript node: ⏺ only when nothing has committed
                  // yet (turn start); once a line is in <Static> the tail is a continuation and aligns
                  // under it — one seamless answer, live and committed rendered identically.
                  return (
                    <FlatItem
                      item={{ id: -1, kind: 'assistant', text: clamped, color: C.fg } as TranscriptItem}
                      cols={terminalSize.cols}
                      collapsed={false}
                      continuation={answerOpenRef.current}
                    />
                  );
                })()
              ) : null}
            </Box>
          ) : null}
          {hudFit.status ? (
            <Box paddingLeft={PAGE_MARGIN}>
              {running ? (
                <Text wrap="truncate">
                  <Text color={CLAUDE_ORANGE}>{spinner}</Text>
                  <Text> {statusVerb}</Text>
                  {statusTail ? <Text color={C.dim}>{statusTail}</Text> : null}
                </Text>
              ) : (
                <Text> </Text>
              )}
            </Box>
          ) : null}
        </>
      ) : null}

      {/* Overlays and active turn status. */}
      {pending ? (
        <Box flexDirection="column" borderStyle={pending.kind === 'user_question' ? 'round' : 'single'} borderColor={pending.kind === 'user_question' ? C.cyan : 'yellow'} paddingX={1} marginTop={1}>
          <Text bold color={pending.kind === 'user_question' ? C.cyan : C.yellow}>
            {pending.kind === 'user_question'
              ? (activeQuestion?.header ? `◆ ${activeQuestion.header}` : '◆ A quick decision')
              : pending.kind === 'plan_enter'
                ? 'Enter plan mode?'
                : pending.kind === 'plan_exit'
                  ? 'Approve plan?'
                  : 'Permission required'}
          </Text>
          <Text wrap="truncate">
            <Text bold color={C.yellow}>
              {pending.kind === 'user_question'
                ? `question${pendingQuestions.length > 1 ? ` ${activeQuestionIndex + 1}/${pendingQuestions.length}` : ''}: `
                : 'approve? '}
            </Text>
            <Text color={C.fg}>
              {pending.kind === 'user_question'
                ? (activeQuestion?.question ?? pending.preview)
                : pending.preview}
            </Text>
          </Text>
          {pending.kind === 'user_question' && activeQuestion ? (
            // Window the option list around the cursor and force each row to ONE truncated line.
            // Without this a long option list (or long descriptions) grows the live frame past the
            // terminal height, re-triggering Ink's clearTerminal fallback — the whole transcript
            // flickers and wipes every frame while the dialog is open. (audit P0 #3)
            (() => {
              // Cap the visible options by terminal height too: the dialog (borders/header/question/
              // hint ≈ 6) + the composer + strip below must stay under the wipe threshold on a short
              // terminal. rows-14 keeps ~8 on a normal screen and shrinks the window as it gets short.
              const OPTION_MAX = Math.max(1, Math.min(8, terminalSize.rows - 14));
              const opts_ = activeQuestion.options;
              const cursor = questionCursor[activeQuestionIndex] ?? recommendedIndex(activeQuestion);
              const rec = recommendedIndex(activeQuestion);
              const start = Math.min(Math.max(0, cursor - OPTION_MAX + 1), Math.max(0, opts_.length - OPTION_MAX));
              return (
                <>
                  {start > 0 ? <Text italic color={C.dim}>{`  ↑ ${start} more`}</Text> : null}
                  {opts_.slice(start, start + OPTION_MAX).map((o, jj) => {
                    const i = start + jj; // absolute index — selection/cursor compare against the full list
                    const selected = activeQuestionSelection.includes(o.label);
                    const isCursor = i === cursor;
                    const isRec = i === rec;
                    // ❯ points at the cursor row; a green ✓ marks a chosen option (multi-select only).
                    // Single-select needs no glyph — the ❯ pointer IS the selection. No radio/checkbox.
                    const mark = activeQuestion.multiSelect ? (selected ? '✓ ' : '  ') : '';
                    return (
                      <Text key={o.label} wrap="truncate" color={selected ? C.green : isCursor ? C.fg : C.dim} bold={isCursor}>
                        {`${isCursor ? '❯' : ' '} ${i + 1}. ${mark}${o.label}`}
                        {isRec ? <Text color={C.yellow}>{'  ★ recommended'}</Text> : ''}
                        {o.description ? <Text color={C.dim}>{`  — ${o.description}`}</Text> : ''}
                      </Text>
                    );
                  })}
                  {start + OPTION_MAX < opts_.length ? (
                    <Text italic color={C.dim}>{`  ↓ ${opts_.length - start - OPTION_MAX} more`}</Text>
                  ) : null}
                </>
              );
            })()
          ) : (
            <Text wrap="truncate" color={C.dim}>{`  [${pending.risk}] ${pending.reason}`}</Text>
          )}
          {pending.kind === 'user_question' && autoAnswerSecs != null ? (
            <Text wrap="truncate" color={C.yellow}>
              {`  ⏳ auto-picking the recommended answer in ${autoAnswerSecs}s · any key to take over`}
            </Text>
          ) : null}
          <Text>
            {pending.kind === 'user_question' ? (
              <>
                <Text color={C.green}>↑/↓</Text> move{' '}
                {activeQuestion?.multiSelect ? (
                  <>
                    · <Text color={C.green}>Space</Text> toggle{' '}
                  </>
                ) : null}
                · <Text color={C.green}>Enter</Text>{' '}
                {pendingQuestions.length > 1 && activeQuestionIndex < pendingQuestions.length - 1
                  ? 'next'
                  : 'confirm'}{' '}
                {pendingQuestions.length > 1 ? (
                  <>
                    · <Text color={C.cyan}>←/→</Text> question{' '}
                  </>
                ) : null}
                · <Text color={C.red}>Esc</Text> skip
              </>
            ) : pending.kind === 'plan_enter' ? (
              <>
                <Text color={C.green}>(y)</Text>es{'  '}
                <Text color={C.red}>(n)</Text>o
              </>
            ) : pending.kind === 'plan_exit' ? (
              <>
                <Text color={C.green}>(y)</Text>es{'  '}
                <Text color={C.red}>(n)</Text>o{'  '}
                <Text color={C.purple}>(a)</Text>lways
              </>
            ) : (
              <>
                <Text color={C.green}>(y)</Text>es{'  '}
                <Text color={C.red}>(n)</Text>o{'  '}
                <Text color={C.cyan}>(s)</Text>ession{'  '}
                <Text color={C.cyan}>(f)</Text>prefix{'  '}
                <Text color={C.purple}>(a)</Text>lways
              </>
            )}
          </Text>
        </Box>
      ) : pickerOpen ? (
        <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1} marginTop={1}>
          <Text bold color={C.cyan}>
            Select a model
          </Text>
          {pickStart > 0 ? <Text italic color={C.dim}>{`  ↑ ${pickStart} more`}</Text> : null}
          {pickerRows.slice(pickStart, pickStart + PICKER_MAX).map((r, j) => {
            const i = pickStart + j; // absolute index — selection compares against the full list
            if (r.kind === 'header') {
              return (
                <Text key={`h${i}`} wrap="truncate" bold color={C.yellow}>
                  {r.label}
                </Text>
              );
            }
            const e = r.entry;
            const active = e.provider === current.provider && e.model === current.model;
            const cur = i === pickerSel;
            // ❯ points at the cursor row (bright); a green ● marks the model in use. No reverse-video
            // bar — the pointer + brightness carry the cursor, siblings recede into the dim gray.
            return (
              <Text key={`m${i}`} wrap="truncate">
                <Text color={cur ? C.green : C.dim}>{cur ? '❯ ' : '  '}</Text>
                <Text color={active ? C.green : C.dim}>{active ? '● ' : '  '}</Text>
                <Text color={cur ? C.fg : C.dim} bold={cur}>{e.label.padEnd(14)} </Text>
                <Text color={C.dim}>{`${e.provider}/${e.model}`}</Text>
              </Text>
            );
          })}
          {pickStart + PICKER_MAX < pickerRows.length ? (
            <Text italic color={C.dim}>{`  ↓ ${pickerRows.length - pickStart - PICKER_MAX} more`}</Text>
          ) : null}
          <Text color={C.dim}>↑/↓ select · Enter switch · Esc cancel</Text>
        </Box>
      ) : null}
      {/* (The running spinner/working line lives INSIDE the Turn HUD's status row now — one
          always-mounted line, not a fourth independently-appearing block.) */}

      {/* Pinned agent state — while a turn RUNS (stock path) it is a single truncated summary line
          (goal · plan · tasks n/m · current subject), so the 3→14-row PinnedState accordion can't
          shove the composer around mid-turn. The full block still renders between turns, where the
          composer is stationary anyway. Cell path keeps the full block (fixed-height viewport). */}
      {menuOpen ? null : showFullPinned ? (
        <PinnedState
          goal={goal}
          plan={planMode}
          todos={todoItems}
          showPlan={showPlan}
          showTodo={showTodo}
          collapsed={todoCollapsed}
          cols={layout.cols}
          maxItems={pinnedMaxItems(terminalSize.rows, !!goal, !!(showPlan && planMode.path), !!customStatus)}
        />
      ) : hudFit.pinned ? (
        // Single-row summary — used while running, and idle on a terminal too short for the full block.
        // Dropped entirely (hudFit.pinned false) when even one row would breach Ink's wipe threshold.
        <Text wrap="truncate" color={C.green}>
          {MARGIN_PAD + hudPinnedLine}
        </Text>
      ) : null}

      <Box flexDirection="column" flexShrink={0} marginTop={hudFit.marginTop ? 1 : 0}>
        {/* Type-ahead queue — what the user submitted while the turn is running, flushed
            in order when it finishes. Visible so they know the input was accepted (Esc clears). */}
        {hudFit.queued ? (
          // wrap="truncate": 3+ queued items would wrap to a 2nd row and shift the composer mid-turn.
          // Hidden while the menu is open — those rows belong to the menu's frame budget. Inset to the
          // page margin in stock so it lines up with the composer/strip rather than sitting flush-left.
          <Box paddingLeft={PAGE_MARGIN}>
            <Text wrap="truncate" color={C.cyan}>
              {`⏳ queued (${queued.length}): ${queued
                .map((q) => (q.length > 40 ? q.slice(0, 39) + '…' : q))
                .join('  ·  ')}`}
            </Text>
          </Box>
        ) : null}
        <Box flexDirection="column">
          <Composer
            input={input}
            cursor={cursor}
            hint={composerHint}
            showHint={hudFit.hint}
            borderColor={running ? C.cyan : planMode.mode === 'planning' ? C.yellow : C.dim}
          />
        </Box>
        {/* Slash-command dropdown — BELOW the composer (the reference client style), so typing "/" never
            moves the input box: the menu grows downward, shifting only the status strip. `menuOpen`
            already accounts for the terminal being tall enough to hold the box under the wipe line. */}
        {menuOpen ? (
          // A borderless but SHADED command list: a faint slate panel (MENU_BG) sits behind every row
          // so the menu reads as its own surface instead of blending into the transcript, and the
          // selected row gets a brighter bar (MENU_SEL_BG). Every row is padded to a common width so
          // the panel is a clean rectangle. (No box, no reverse-video — the contrast carries it.)
          (() => {
            const BAR_W = Math.max(24, Math.min(terminalSize.cols - PAGE_MARGIN * 2 - 1, 74));
            const bar = (s: string) => (s.length >= BAR_W ? s.slice(0, BAR_W) : s + ' '.repeat(BAR_W - s.length));
            return (
              <Box flexDirection="column" paddingLeft={PAGE_MARGIN}>
                <Text wrap="truncate" backgroundColor={MENU_BG} color={C.cyan} bold>
                  {bar(` Commands (${selIndex + 1}/${menu.length})`)}
                </Text>
                {menuStart > 0 ? (
                  <Text wrap="truncate" backgroundColor={MENU_BG} color={C.dim} italic>{bar(`   ↑ ${menuStart} more`)}</Text>
                ) : null}
                {menu.slice(menuStart, menuStart + MENU_MAX).map((c, j) => {
                  const i = menuStart + j;
                  const cur = i === selIndex;
                  const bg = cur ? MENU_SEL_BG : MENU_BG;
                  const namePart = c.name.padEnd(SLASH_NAME_WIDTH);
                  const used = 2 + namePart.length + 1 + c.desc.length; // pointer + name + space + desc
                  const pad = used < BAR_W ? ' '.repeat(BAR_W - used) : '';
                  // wrap="truncate": a long row must never wrap to a 2nd line — it eats the frame budget.
                  return (
                    <Text key={c.name} wrap="truncate">
                      <Text backgroundColor={bg} color={cur ? C.green : C.dim} bold={cur}>{cur ? '❯ ' : '  '}</Text>
                      <Text backgroundColor={bg} color={C.fg} bold={cur}>{`${namePart} `}</Text>
                      <Text backgroundColor={bg} color={cur ? C.fg : C.dim}>{c.desc}</Text>
                      {pad ? <Text backgroundColor={bg}>{pad}</Text> : null}
                    </Text>
                  );
                })}
                {menuStart + MENU_MAX < menu.length ? (
                  <Text wrap="truncate" backgroundColor={MENU_BG} color={C.dim} italic>{bar(`   ↓ ${menu.length - menuStart - MENU_MAX} more`)}</Text>
                ) : null}
              </Box>
            );
          })()
        ) : null}
        {hudFit.strip ? (
          <Box paddingLeft={PAGE_MARGIN}>
            <StatusStrip text={statusStrip} marker={opts.offline ? { text: 'OFFLINE', color: C.cyan } : undefined} />
          </Box>
        ) : null}
        {customStatus && hudFit.custom ? (
          // Same page-margin inset as the main strip above — a custom /statusline was flush-left in stock.
          <Box paddingLeft={PAGE_MARGIN}>
            <StatusStrip text={customStatus} />
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

// ── Entry point ────────────────────────────────────────────────────────────────
/**
 * Escape sequence to emit ONCE at TUI launch on a real TTY. Two privacy measures:
 *   1. Set the terminal title to "Shadow" (pushed onto the xterm title stack, popped on exit) so the
 *      working-directory path terminals show by default doesn't leak in screenshots / over-the-shoulder.
 *   2. Wipe the visible screen AND the scrollback (`2J` + `3J`, then home) so your PRE-LAUNCH shell
 *      history — earlier commands, other work, secrets — can't be scrolled up to from inside the
 *      Shadow session. Same escape `/clear` uses; the transcript then accumulates in a fresh
 *      scrollback below. Opt out with `SHADOW_KEEP_SCROLLBACK=1` to preserve your terminal history.
 * Returns '' when not a TTY (piped / CI writes stay clean). Pure — the sequencing is unit-tested.
 */
export function startupSequence(isTTY: boolean, env: NodeJS.ProcessEnv = process.env): string {
  if (!isTTY) return '';
  let seq = '\x1b[22;2t\x1b]2;Shadow\x07'; // push prior title, set to "Shadow"
  if (env.SHADOW_KEEP_SCROLLBACK !== '1') seq += '\x1b[2J\x1b[3J\x1b[H'; // wipe screen + scrollback, home
  return seq;
}

export function runTui(opts: TuiOpts): Promise<void> {
  // Launch-time privacy: title → "Shadow" (hide cwd) + wipe scrollback (hide pre-launch shell
  // history from scroll-up). See startupSequence. Title is popped on exit via cleanup.
  const ownsTitle = !!process.stdout.isTTY;
  if (ownsTitle) process.stdout.write(startupSequence(true));
  const cleanup = (): void => {
    if (ownsTitle) process.stdout.write('\x1b[23;2t');
  };
  // Atomic frames (synchronized output, DEC mode 2026) — kills the tmux/terminal repaint flicker; a
  // silent no-op on terminals that don't support it. Only for a real TTY (piped/CI writes stay clean).
  const stdout = ownsTitle ? withSynchronizedOutput(process.stdout) : process.stdout;
  const { waitUntilExit } = render(<TuiApp opts={opts} />, { stdout, exitOnCtrlC: false });
  return waitUntilExit().finally(cleanup);
}

// ── Headless renderer (one-shot / piped) — raw ANSI straight to stdout ───────
const A = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[38;2;16;185;129m',
  red: '\x1b[38;2;239;68;68m',
  yellow: '\x1b[38;2;245;158;11m',
  cyan: '\x1b[36m',
};

/** A lightweight renderer for the headless path that writes directly to stdout. */
export function attachRenderer(bus: EventBus, _opts?: { animate: boolean }): () => void {
  return bus.on((e) => {
    switch (e.type) {
      case 'text':
        if (e.delta) process.stdout.write(e.delta);
        break;
      case 'tool_start':
        process.stdout.write(`\n${A.dim}↳ ${e.call.name} ${previewOf(e.call.input)}${A.reset}\n`);
        break;
      case 'tool_end': {
        const mark = e.result.ok ? `${A.green}ok${A.reset}` : `${A.red}err${A.reset}`;
        process.stdout.write(`  ${mark} ${oneLine(e.result.summary)}\n`);
        break;
      }
      case 'tool_denied':
        process.stdout.write(`  ${A.yellow}blocked${A.reset} ${friendlyDeniedReason(e.reason)}\n`);
        break;
      case 'reasoning_done':
        process.stdout.write(`\n${A.dim}▸ Reasoning${A.reset}\n${A.dim}${e.text}${A.reset}\n`);
        break;
      case 'finding': {
        const color = e.severity === 'error' ? A.red : e.severity === 'warn' ? A.yellow : A.cyan;
        process.stdout.write(`\n${color}▣ ${e.title}${A.reset}\n${e.body}\n`);
        break;
      }
      case 'shell_output':
        process.stdout.write(e.chunk);
        break;
      case 'shell_pid':
        if (e.warn) process.stderr.write(`  ${A.yellow}⚠ shell pid ${e.pid}: ${e.warn} — kill manually if needed${A.reset}\n`);
        break;
      case 'model_fallback':
        process.stdout.write(`  ${A.dim}model fallback: ${e.from} → ${e.to}${A.reset}\n`);
        break;
      case 'compaction':
        process.stdout.write(`  ${A.dim}⟳ context compacted — earlier turns summarized${A.reset}\n`);
        break;
      case 'retry':
        process.stdout.write(`  retry ${e.attempt} in ${e.delayMs}ms (${oneLine(e.reason)})\n`);
        break;
      case 'error':
        process.stdout.write(`  ${A.red}${e.message}${A.reset}\n`);
        break;
      case 'stop': {
        const empty = e.reason === 'max_tokens' && !e.finalAnswer.trim();
        if (e.reason === 'provider_error' || e.reason === 'fatal_tool_error' || empty) {
          const msg = empty ? 'max_tokens (no output produced)' : e.reason;
          process.stderr.write(`  ${A.red}stopped: ${msg}${A.reset}\n`);
        }
        break;
      }
      default:
        break;
    }
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────
interface UsageEvent {
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  contextPct: number;
}

function formatUsage(e: UsageEvent): string {
  const total = e.inputTokens + e.outputTokens;
  return `${formatCount(total)} tokens · ctx ${Math.round(e.contextPct * 100)}% · $${e.costUSD.toFixed(4)}`;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function shellCommandOf(input: unknown): string | null {
  const o = input as Record<string, unknown> | undefined;
  if (o && typeof o.command === 'string') return o.command;
  return null;
}

function previewOf(input: unknown): string {
  const o = input as Record<string, unknown> | undefined;
  if (o && typeof o === 'object') {
    if (typeof o.command === 'string') {
      // Collapse a multi-line command (e.g. a python -c heredoc) to one line and cap it, so the live
      // "↳ run_shell $ …" preview can't fill the window while the command runs.
      const cmd = o.command.replace(/\s+/g, ' ').trim();
      return `$ ${cmd.length > 120 ? cmd.slice(0, 119) + '…' : cmd}`;
    }
    if (typeof o.path === 'string') return o.path;
    if (typeof o.url === 'string') return o.url;
    if (typeof o.pattern === 'string') return o.pattern;
  }
  return '';
}

function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > 140 ? `${flat.slice(0, 137)}…` : flat;
}

function shortPath(path: string): string {
  const home = process.env.HOME;
  const value = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  return value.length > 42 ? `…${value.slice(-41)}` : value;
}
