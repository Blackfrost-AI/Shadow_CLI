// src/tui/slash.ts — the `/` command registry and its execution engine (P3-02 / F06-04).
//
// Carved out of tui.tsx: the command table, its lookup helpers, and the big runSlash body all
// live here now. tui.tsx keeps a stable `runSlash` bridge that assembles a live `SlashCtx`
// (setters, callbacks, refs, live objects) and hands it to `runSlashCommand`. The body reads
// ONLY through that ctx + module-scope helpers, so this file has no runtime dependency back on
// tui.tsx (type-only imports, erased at compile) and no cycle.
//
// Invariants the body relies on (kept identical to the pre-extraction code):
//  - `committed` is append-only (pushLine) or replaced wholesale (/clear, context repaint) —
//    never mutated in place. The appendable tool-run cache in flatten.ts depends on it.
//  - Self-recursive dispatches (/local test → /model test) go through runSlashCommand(ctx, …).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { Dispatch, SetStateAction } from 'react';
import type { SessionApprovals } from '../agent/approval.js';
import type { Context } from '../agent/context.js';
import { loadAgentDefs } from '../agent/defs.js';
import { cycleEffort, effortDescription, effortSymbol, normalizeEffort } from '../agent/effort.js';
import type { EventBus } from '../agent/events.js';
import type { AgentLoop } from '../agent/loop.js';
import type { PlanSnapshot } from '../agent/planMode.js';
import type { TodoItem } from '../agent/todo.js';
import { buildCodexAuthUrl, clearSubAuth, getSubAuth, importOfficialCredential, type SubProvider } from '../auth/index.js';
import { vaultExists } from '../auth/vault.js';
import { addModelPreset, defaultModelPatch, findModelPreset, parseModelAddArgs, removeModelPreset, setModelPresetEnabled, splitPresetArgs } from '../config/modelPresets.js';
import { persistPermissionRules, resolveApiKey, resolveAuthToken, resolveBaseUrl, resolveEntryCredential, type ModelEntry } from '../config.js';
import { formatDoctorReport, runDoctor } from '../doctor.js';
import { runModelCheck } from '../doctor/modelCheck.js';
import { ensureLocalServer, isLocalServedEntry } from '../gguf.js';
import { addLocalModel, formatLocalList, listLocalModels, parseLocalAddArgs, removeLocalModel } from '../local/garage.js';
import { disableMcpServer, enableContextCooler, enablePlaywrightBrowser, loadGlobalMcpServers, mcpListLines, mcpServerLines, saveGlobalMcpServers, type McpServers } from '../mcp/manage.js';
import { PLUGIN_CONTENT_DIRS, displaySafe, enabledPluginDirs, listPlugins, setPluginEnabled } from '../plugins/manager.js';
import { createProvider, entryStreamContract } from '../provider/index.js';
import type { Effort, ImageBlock, Provider } from '../provider/provider.js';
import { egressSummary } from '../safety/egress.js';
import { cycleAutonomy, type AutonomyLevel } from '../safety/permissions.js';
import { applyPermissionCommand } from '../safety/permissionCmd.js';
import { sandboxConfinement, sandboxToolAvailable } from '../safety/sandbox.js';
import { discoverSkills } from '../skills/loader.js';
import { exportSession } from '../state/chatExport.js';
import { forkSession } from '../state/fork.js';
import { GLOBAL_DIR, saveGlobalConfig, vaultUnlocked } from '../state/globalStore.js';
import { ProjectMemory } from '../state/memory.js';
import { listResumableSessions, resumeSession } from '../state/resume.js';
import { rewindToTurn, type RewindableTurn } from '../state/rewind.js';
import { SessionLog } from '../state/session.js';
import { customStyleNames, type OutputStyle } from '../styles.js';
import { imageMediaType, MAX_IMAGE_BYTES } from '../util/image.js';
import { firstSelectableRow, modelEntries, modelRows } from '../util/modelGroups.js';
import { isSecretKey, maskSecret, redactConfig } from '../util/redact.js';
import { categorizeContext, contextSuggestions } from './contextViz.js';
import { expandCommandBody } from './customCommands.js';
import { shortPath } from './format.js';
import { bindingsForDisplay, initKeybindingsFile } from './keybindings/loader.js';
import type { LoadedBindings } from './keybindings/types.js';
import type { SubAgentView } from './subagentPanel.js';
import { updateReset } from './terminalState.js';
import { C, THEMES, THEME_DESCRIPTIONS, THEME_NAMES, applyTheme, backgroundSequence, normalizeThemeName, type CanonicalThemeName } from './theme.js';
import type { ToastKind } from './toast.js';
import { NEWLINE_HINT } from './platform.js';
import type { VimFind, VimMode } from './vim.js';
import type { BannerLine, TranscriptBase, TuiOpts } from '../tui.js';

export interface SlashCommand {
  name: string;
  desc: string;
  dispatch?: string;
  /** F10-07: a user-defined command loaded from .shadow/commands or .claude/commands. Its body is
   *  a prompt template submitted as a turn (with $ARGUMENTS/$1 substitution), not a builtin action. */
  custom?: { body: string };
  /** F08-04: an @-file candidate row. Accepting it REPLACES the `@partial` token with `@path`,
   *  rather than running a command. `start` is the index of the `@` in the composer. */
  mention?: { start: number; path: string };
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help', desc: 'Show keybindings and commands' },
  { name: '/keybindings', desc: 'Show / customize keybindings (/keybindings init writes a starter config)' },
  { name: '/clear', desc: 'Clear the screen and reset the conversation' },
  { name: '/new', desc: 'Start a fresh conversation (alias for /clear)' },
  { name: '/goal', desc: 'Set a standing goal the model works toward (/goal clear to remove)' },
  { name: '/model', desc: 'Switch, list, add, remove, enable, disable, or test (capability check) model presets' },
  { name: '/table', desc: 'Collaboration Mode (experimental): /table <model> <model> — a live round-table; @handle to route, /table done to end' },
  { name: '/provider', desc: 'Show active provider, endpoint, auth status, and model presets' },
  { name: '/local', desc: 'Add / test / switch a local model (.gguf or MLX)' },
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
  { name: '/connections', desc: 'Show the egress receipt: every host Shadow reached this session, why, allowed/denied' },
  { name: '/export', desc: 'Export session to markdown (optional path)' },
  { name: '/copy', desc: 'Copy the last answer to the clipboard (/copy code → last code block); Alt+C' },
  { name: '/session', desc: 'Show current session id, log path, and message count' },
  { name: '/sessions', desc: 'List resumable sessions in this workspace (/resume <id> to load one)' },
  { name: '/resume', desc: 'Resume a prior session (opens a picker; or /resume <id|path>)' },
  { name: '/rewind', desc: 'Rewind to a turn (picker shows each turn’s prompt; or /rewind <n> [--code-only|--chat-only])' },
  { name: '/fork', desc: 'Fork this session: copy the transcript to a new session id and switch to it' },
  { name: '/init', desc: 'Scaffold SHADOW.md in the workspace' },
  { name: '/agents', desc: 'List running agents + definitions; /agents kill <id|all> cancels a background agent' },
  { name: '/skills', desc: 'List discovered repo skills' },
  { name: '/workflows', desc: 'List workflow files' },
  { name: '/plugins', desc: 'List installed plugins; /plugins enable|disable <name>' },
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
  { name: '/terminal-setup', desc: 'Make Shift+Enter insert a newline (per-terminal instructions)' },
  { name: '/vim', desc: 'Toggle modal (NORMAL/INSERT) editing in the composer' },
  { name: '/statusline', desc: 'Set a shell command for a custom footer line (/statusline none to clear)' },
  { name: '/add-dir', desc: 'Grant an extra directory to file tools for this session' },
  { name: '/image', desc: 'Attach an image file to your next message (/image clear to drop)' },
  { name: '/review', desc: 'Review the current uncommitted changes' },
  { name: '/quit', desc: 'Exit Shadow' },
  { name: '/exit', desc: 'Exit Shadow (alias for /quit)' },
];
export const SLASH_NAME_WIDTH = Math.max(...SLASH_COMMANDS.map((c) => c.name.length)) + 1;

const AUTONOMY_LEVELS: AutonomyLevel[] = ['manual', 'auto-read', 'auto-edit', 'full'];

export function slashDispatchName(cmd: SlashCommand): string {
  return cmd.dispatch ?? cmd.name;
}

export function findSlashCommand(name: string, extra: SlashCommand[] = []): SlashCommand | undefined {
  return SLASH_COMMANDS.find((c) => c.name === name) ?? extra.find((c) => c.name === name);
}

const SAFE_CONFIG_KEYS = [
  'temperature',
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

export function parseSafeConfig(key: string, raw: string): { ok: true; key: SafeConfigKey; value: unknown } | { ok: false; message: string } {
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
  if (safeKey === 'temperature') {
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 && value <= 2
      ? { ok: true, key: safeKey, value }
      : { ok: false, message: 'temperature must be a number from 0 to 2 (default 1.0).' };
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

/** Keep the documented default visibly `1.0` while preserving useful fractional precision. */
function formatTemperature(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

function modelPresetLines(entries: ModelEntry[], current: { provider: string; model: string }): string[] {
  if (!entries.length) {
    return [
      'No model presets configured. Use /model add <label> <provider> <model> [baseUrl] [--self-hosted].',
    ];
  }
  return entries.map((entry) => {
    const active = entry.provider === current.provider && entry.model === current.model;
    const baseUrl = entry.baseUrl ? ` · ${entry.baseUrl}` : '';
    const selfHosted = entry.selfHosted ? ' · self-hosted' : '';
    const disabled = entry.disabled ? ' [disabled]' : '';
    const marker = active ? '* ' : '  ';
    return `${marker}${entry.label}${disabled} — ${entry.provider}/${entry.model}${baseUrl}${selfHosted}`;
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
    // Enabled plugins contribute workflow runbooks too (P3-07); the dir is <plugin>/workflows.
    ...enabledPluginDirs('workflows').map((dir) => ({ label: `plugin:${basename(dirname(dir))}`, dir })),
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

type HelpTopic = 'overview' | 'keys' | 'all';

/** Progressive help: keep the default useful at a glance; put exhaustive reference one level down. */
function helpLines(topic: HelpTopic): BannerLine[] {
  if (topic === 'all') {
    return [
      { text: 'All commands', color: C.cyan, bold: true },
      { text: 'Type / and a few letters to search this list interactively.', dimColor: true },
      ...SLASH_COMMANDS.map((c) => ({
        text: `  ${c.name.padEnd(SLASH_NAME_WIDTH)} ${c.desc}`,
        dimColor: true,
      })),
      { text: 'Shortcuts: /help keys  ·  quick start: /help overview', dimColor: true },
    ];
  }

  if (topic === 'keys') {
    return [
      { text: 'Keyboard shortcuts', color: C.cyan, bold: true },
      { text: 'Compose', color: C.purple, bold: true },
      { text: `  Enter send  ·  ${NEWLINE_HINT} newline  ·  Ctrl+V paste  ·  Ctrl+R search history`, dimColor: true },
      { text: '  ↑/↓ move through a multi-line draft; at its edges they browse history.', dimColor: true },
      { text: 'Navigate', color: C.purple, bold: true },
      { text: '  / opens commands  ·  ↑/↓ select  ·  Tab completes  ·  Esc closes', dimColor: true },
      { text: '  Shift+Tab changes mode  ·  Ctrl+O folds details  ·  Ctrl+T expands tasks', dimColor: true },
      { text: 'While Shadow works', color: C.purple, bold: true },
      { text: '  Keep typing and press Enter to steer the active turn  ·  Esc interrupts', dimColor: true },
      { text: '  State-changing slash commands wait until the current turn ends.', dimColor: true },
      { text: 'Approvals: y once · n deny · s session · f shell prefix · a raise autonomy', dimColor: true },
      { text: 'Exit: Ctrl+C twice (or Ctrl+D on an empty composer)', dimColor: true },
      { text: 'Customize bindings with /keybindings init.', dimColor: true },
    ];
  }

  return [
    { text: 'Shadow help', color: C.cyan, bold: true },
    { text: 'Start here', color: C.purple, bold: true },
    { text: '  Type what you want done, then press Enter. You can keep typing while Shadow works.', dimColor: true },
    { text: '  /model switches models  ·  /doctor checks setup  ·  /status explains the current session', dimColor: true },
    { text: 'Everyday commands', color: C.purple, bold: true },
    { text: '  Session    /clear  /resume  /rewind  /fork  /export', dimColor: true },
    { text: '  Model      /model  /local  /provider  /effort', dimColor: true },
    { text: '  Agent      /goal  /autonomy  /permissions  /tasks', dimColor: true },
    { text: '  Workspace  /diff  /files  /branch  /review', dimColor: true },
    { text: `Keys: Enter send · ${NEWLINE_HINT} newline · Shift+Tab mode · Esc interrupt · Ctrl+C twice to quit`, dimColor: true },
    { text: 'Approvals: y once · n deny · s session · f shell prefix · a raise autonomy', dimColor: true },
    { text: 'More: /help keys for shortcuts · /help all for every command · type / to search', dimColor: true },
  ];
}

/**
 * Everything the slash engine needs from the live TuiApp, handed over as one object.
 * Rebuilt on EVERY render by the tui.tsx bridge (stable setters/refs pass through; state values
 * stay fresh), so the engine never sees stale state. Refs are structural (`{ current: T }`) so
 * this file needs no React runtime types beyond Dispatch/SetStateAction.
 */
export interface SlashCtx {
  // ── state setters ──────────────────────────────────────────────────────────
  setLine: (v: string) => void;
  setMenuIndex: Dispatch<SetStateAction<number>>;
  setStreamNow: (v: string) => void;
  setThinkNow: (v: string) => void;
  /** Nulls the live shell-preview line AND drains its throttle refs (an armed flush
   *  timer must never resurrect a wiped preview). */
  clearToolLine: () => void;
  /** Erase queued-but-uncommitted streamed blocks (/clear mid-stream — drain would re-commit). */
  dropStreamedUnits: () => void;
  setCommitted: Dispatch<SetStateAction<TranscriptBase[]>>;
  setShowAllExpanded: Dispatch<SetStateAction<boolean>>;
  setStaticEpoch: Dispatch<SetStateAction<number>>;
  setTodoItems: Dispatch<SetStateAction<TodoItem[]>>;
  setAttachCount: Dispatch<SetStateAction<number>>;
  setStatus: Dispatch<SetStateAction<string>>;
  setPlanMode: Dispatch<SetStateAction<PlanSnapshot>>;
  setGoal: Dispatch<SetStateAction<string | null>>;
  setPickerIndex: Dispatch<SetStateAction<number>>;
  setPickerOpen: Dispatch<SetStateAction<boolean>>;
  setAutonomy: (l: AutonomyLevel) => void;
  setEffort: (level: Effort) => void;
  setStyle: Dispatch<SetStateAction<OutputStyle>>;
  setVimEnabled: Dispatch<SetStateAction<boolean>>;
  setVimMode: (m: VimMode) => void;
  setThemeTick: Dispatch<SetStateAction<number>>;
  setCustomStatus: Dispatch<SetStateAction<string>>;
  setComposer: (nextInput: string, nextCursor: number) => void;
  // ── callbacks (defined in tui.tsx, stable across renders) ─────────────────
  pushLine: (l: Omit<TranscriptBase, 'id' | 'kind'> & { kind?: TranscriptBase['kind'] }) => void;
  /** T1: transient one-line ack (never reaches the transcript). Falls back to a dim pushLine
   *  internally when the HUD has no room for a toast row — callers just fire and forget. */
  showToast: (text: string, kind?: ToastKind) => void;
  showBanner: () => void;
  exit: () => void;
  refreshStatusLine: () => void;
  copyLast: (what: 'answer' | 'code') => void;
  refreshRewindTurns: () => void;
  showResumeRecap: () => Promise<void>;
  pushImage: (bytes: string, mediaType: string, alt: string, source: string) => void;
  loadCustomCommands: () => void;
  // ── refs (structural; the component passes its useRefs through) ───────────
  startTurnRef: { current: ((task: string) => void) | null };
  kbLoadedRef: { current: LoadedBindings };
  firstRef: { current: boolean };
  answerOpenRef: { current: boolean };
  committedRef: { current: TranscriptBase[] };
  attachmentsRef: { current: ImageBlock[] };
  pastesRef: { current: { id: number; content: string; lines: number }[] };
  lastUsageRef: { current: { inputTokens: number; outputTokens: number; costUSD: number; contextPct: number } | null };
  sessionCostRef: { current: number };
  prevTurnCostRef: { current: number };
  sessionInTokRef: { current: number };
  sessionOutTokRef: { current: number };
  prevTurnInTokRef: { current: number };
  prevTurnOutTokRef: { current: number };
  sessionTurnsRef: { current: number };
  costWarnedRef: { current: boolean };
  fileListLoadedRef: { current: boolean };
  goalRef: { current: string | null };
  startTableRef: { current: ((arg: string) => void) | null };
  currentRef: { current: { provider: string; model: string } };
  selectModelRef: { current: ((entry: ModelEntry) => Promise<void>) | null };
  asyncCommandRef: { current: boolean };
  providerRef: { current: Provider };
  activeTargetRef: { current: { baseUrl?: string; selfHosted: boolean } };
  styleRef: { current: OutputStyle };
  autonomyRef: { current: AutonomyLevel };
  loopRef: { current: AgentLoop | null };
  effortRef: { current: Effort };
  runningRef: { current: boolean };
  compactingRef: { current: boolean };
  compactAbortRef: { current: AbortController | null };
  sessionLogRef: { current: SessionLog };
  sessionApprovalsRef: { current: SessionApprovals };
  rewindableTurnsRef: { current: RewindableTurn[] };
  additionalRootsRef: { current: string[] };
  statusLineRef: { current: string };
  vimEnabledRef: { current: boolean };
  vimPendingRef: { current: string };
  vimFindRef: { current: VimFind | null };
  vimCountRef: { current: number };
  vimRegRef: { current: string };
  flushQueueRef: { current: (() => void) | null };
  runOneRef: { current: ((task: string) => void) | null };
  repaintFromContextRef: { current: (() => void) | null };
  // ── live objects ───────────────────────────────────────────────────────────
  context: Context;
  opts: TuiOpts;
  bus: EventBus;
  subAgents: Map<string, SubAgentView>;
  todoItems: TodoItem[];
}

/**
 * Execute one slash command (never sent to the agent). This is the body that lived inline in
 * tui.tsx's `runSlash` useCallback before P3-02; it now reads every component-scoped symbol
 * through `ctx` (destructured once below) and module-scope helpers. Behavior is unchanged.
 */
export function runSlashCommand(ctx: SlashCtx, cmd: SlashCommand, rawLine?: string): void {
  const {
    setLine, setMenuIndex, setStreamNow, setThinkNow, clearToolLine, dropStreamedUnits, setCommitted,
    setShowAllExpanded, setStaticEpoch, setTodoItems, setAttachCount, setStatus,
    setPlanMode, setGoal, setPickerIndex, setPickerOpen, setAutonomy, setEffort,
    setStyle, setVimEnabled, setVimMode, setThemeTick, setCustomStatus, setComposer,
    pushLine, showBanner, exit, refreshStatusLine, copyLast, refreshRewindTurns,
    showToast,
    showResumeRecap, pushImage, loadCustomCommands,
    startTurnRef, kbLoadedRef, firstRef, answerOpenRef, committedRef, attachmentsRef,
    pastesRef, lastUsageRef, sessionCostRef, prevTurnCostRef, sessionInTokRef,
    sessionOutTokRef, prevTurnInTokRef, prevTurnOutTokRef, sessionTurnsRef,
    costWarnedRef, fileListLoadedRef, goalRef, startTableRef, currentRef,
    selectModelRef, asyncCommandRef, providerRef, activeTargetRef, styleRef,
    autonomyRef, loopRef, effortRef, runningRef, compactingRef, compactAbortRef,
    sessionLogRef, sessionApprovalsRef, rewindableTurnsRef, additionalRootsRef,
    statusLineRef, vimEnabledRef, vimPendingRef, vimFindRef, vimCountRef, vimRegRef,
    flushQueueRef, runOneRef, repaintFromContextRef,
    context, opts, bus, subAgents, todoItems,
  } = ctx;
  setLine('');
  setMenuIndex(0);
  const dispatch = slashDispatchName(cmd);
  const arg = (rawLine ?? '').slice(cmd.name.length).trim();
  // F10-07: a custom command isn't a builtin action — its body is a prompt template. Expand the
  // arguments and submit it as a normal turn (goes through the same gate/steer path as typing).
  if (cmd.custom) {
    const prompt = expandCommandBody(cmd.custom.body, arg);
    if (prompt.trim()) startTurnRef.current?.(prompt);
    return;
  }
  switch (dispatch) {
    case '/help': {
      const topic = (arg || 'overview').toLowerCase();
      if (topic !== 'overview' && topic !== 'keys' && topic !== 'all') {
        pushLine({
          text: `Unknown help topic "${arg}". Use /help overview, /help keys, or /help all.`,
          color: C.red,
        });
        break;
      }
      pushLine({ kind: 'system', text: 'help', lines: helpLines(topic) });
      break;
    }
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
      // isTTY-gated like every sibling escape site (reflow, theme, paste, mouse, startupSequence
      // all are). This one was not, so it leaked 2J/3J into pipes and files — and since several
      // tests drive /clear, `npm test` could wipe the developer's own scrollback.
      if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[3J\x1b[H'); // wipe screen + scrollback
      context.reset();
      firstRef.current = true;
      answerOpenRef.current = false;
      setStreamNow('');
      setThinkNow('');
      clearToolLine();
      dropStreamedUnits(); // queued stream blocks die with the transcript being wiped
      setCommitted([]);
      committedRef.current = [];
      setShowAllExpanded(false);
      setStaticEpoch((n) => n + 1); // remount <Static> so it forgets the wiped scrollback items
      setTodoItems([]); // clear the task list (was persisting stale tasks after /clear)
      opts.todoList?.write([]); // clear the backing source so the agent starts fresh
      attachmentsRef.current = []; // drop any queued image attachments
      setAttachCount(0);
      pastesRef.current = []; // F02-06: the draft is gone, so its parked paste contents are too
      // P1B-03: /clear resets the conversation, so reset the session usage readout too — the
      // old code left stale token/cost totals (and the status line) attributed to a new session.
      lastUsageRef.current = null;
      sessionCostRef.current = 0;
      prevTurnCostRef.current = 0;
      sessionInTokRef.current = 0;
      sessionOutTokRef.current = 0;
      prevTurnInTokRef.current = 0;
      prevTurnOutTokRef.current = 0;
      sessionTurnsRef.current = 0;
      costWarnedRef.current = false;
      setStatus('0 tokens');
      loadCustomCommands(); // F10-07: pick up any commands added since launch
      fileListLoadedRef.current = false; // F08-04: re-walk for @-mentions on next use
      // Same log path — the size-keyed gate makes this a no-op re-list unless something else
      // appended; keeps the /rewind menu consistent no matter what /clear evolves to touch.
      refreshRewindTurns();
      // Exit plan mode for REAL, not just in React state (D2). setPlanMode alone changed the
      // badge while PlanModeState stayed active — so plan.block() kept going into the system
      // prompt and every write was denied afterwards with NO on-screen explanation, because
      // the UI had already stopped saying plan mode was on. Drive the state object and let its
      // bus event update the UI, so the two can't disagree again.
      opts.planMode?.exit();
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
    case '/table':
      startTableRef.current?.(arg);
      break;
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
        opts.cfg.selfHosted = entry.selfHosted;
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
        asyncCommandRef.current = true;
        void (async () => {
          try {
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
              isLocal = isLocalServedEntry(entry);
              let p = entry.provider;
              let baseUrl = resolveBaseUrl(entry.provider, entry.baseUrl);
              const testCred = resolveEntryCredential(entry, {
                vaultIsLocked: vaultExists() && !vaultUnlocked(),
              });
              let apiKey = testCred.ok ? testCred.apiKey : undefined;
              if (!testCred.ok) {
                pushLine({
                  text: `${entry.label}: vault slot "${testCred.slot}" is ${testCred.reason === 'locked' ? 'locked' : 'empty'} — cannot test.`,
                  color: C.red,
                });
                return;
              }
              if (isLocalServedEntry(entry)) {
                try {
                  const r = await ensureLocalServer(entry, (m) => pushLine({ text: m, dimColor: true }));
                  p = 'openai';
                  baseUrl = r.baseUrl;
                  apiKey = entry.apiKey ?? 'sk-local';
                } catch (e) {
                  pushLine({ text: `Local model failed: ${(e as Error).message}`, color: C.red });
                  return;
                }
              }
              prov = createProvider({
                // F10-01: probe the entry with its real wire contract (idle knobs +
                // capability block) so /model test exercises what a session would use.
                ...entryStreamContract(entry, opts.cfg.stream),
                provider: p,
                model: entry.model,
                apiKey,
                authToken: testCred.authToken,
                baseUrl,
                selfHosted: p === 'openai' ? entry.selfHosted : undefined,
                reasoningRoundtrip: opts.cfg.reasoningRoundtrip,
              });
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
                temperature: opts.cfg.temperature,
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
          } finally {
            asyncCommandRef.current = false;
            flushQueueRef.current?.();
          }
        })();
        break;
      }
      if (action) {
        pushLine({
          text: 'Usage: /model [list|add <label> <provider> <model> [baseUrl] [--self-hosted]|remove <label>|enable <label>|disable <label>|default <label>|use <label>|test [name]]',
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
            { text: 'Use /model add <label> <provider> <model> [baseUrl] [--self-hosted] to add a preset.', dimColor: true },
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
      // `/local test` is advertised in the argument menu ("Launch it and check it answers") but
      // was never handled — it fell through to the unknown-action branch. `/model test` already
      // does exactly this (including ensureLocalServer for a local-served preset), so route to
      // it rather than growing a second copy that would drift.
      if (action === 'test') {
        const target = parts.slice(1).join(' ').trim();
        runSlashCommand(ctx, findSlashCommand('/model')!, `/model test${target ? ` ${target}` : ''}`);
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
            { text: e.mlx ? `  ${e.mlx}  ·  mlx` : e.vllm ? `  ${e.vllm}  ·  vllm` : `  ${e.gguf}  ·  ctx ${e.ctx}  ·  gpu-layers ${e.gpuLayers}`, dimColor: true },
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
        text: 'Usage: /local [list | add <path-to.gguf | mlx-folder | mlx-community/model> [--name <n>] [--ctx <n>] [--gpu-layers <n>] | use <name> | remove <name>]',
        dimColor: true,
      });
      break;
    }
    case '/provider': {
      const target = activeTargetRef.current;
      const baseUrl = target.baseUrl;
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
          ...(target.selfHosted
            ? [{ text: `temperature: ${formatTemperature(opts.cfg.temperature ?? 1.0)} · self-hosted sampling`, dimColor: true }]
            : []),
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
      // No arg: cycle (original behavior). With arg: set directly. F08-12: custom styles from
      // .shadow/.claude output-styles dirs join the built-ins in the cycle + validation.
      const styles: OutputStyle[] = ['proactive', 'explanatory', 'learning', 'procedural', ...(customStyleNames() as OutputStyle[])];
      const req = arg.toLowerCase();
      if (req && !(styles as readonly string[]).includes(req)) {
        pushLine({ text: `Unknown style "${arg}". Styles: ${styles.join(', ')}.`, color: C.red });
        break;
      }
      const next = req
        ? (req as OutputStyle)
        : styles[(styles.indexOf(styleRef.current) + 1) % styles.length] ?? 'proactive';
      styleRef.current = next;
      setStyle(next);
      opts.styleState?.setStyle(next);
      void saveGlobalConfig({ lastStyle: next });
      showToast(`Style → ${next}`, 'ok');
      break;
    }
    case '/autonomy': {
      // No arg: cycle (original behavior). With arg: jump straight to a level.
      const req = arg.toLowerCase();
      if (req && !(AUTONOMY_LEVELS as readonly string[]).includes(req)) {
        pushLine({ text: `Unknown autonomy "${arg}". Levels: ${AUTONOMY_LEVELS.join(', ')}.`, color: C.red });
        break;
      }
      const next = req ? (req as AutonomyLevel) : cycleAutonomy(autonomyRef.current);
      setAutonomy(next);
      loopRef.current?.setAutonomy(next);
      showToast(`Autonomy → ${next}`, 'ok');
      break;
    }
    case '/fast': {
      // `/fast on` / `/fast off` are documented and were silently ignored — the handler always
      // toggled, so a user scripting "make sure fast is on" turned it OFF half the time.
      const want = arg.trim().toLowerCase();
      if (want && want !== 'on' && want !== 'off') {
        pushLine({ text: 'Usage: /fast [on|off] — no argument toggles.', dimColor: true });
        break;
      }
      const next = want === 'on' ? true : want === 'off' ? false : !opts.cfg.fastMode;
      opts.cfg.fastMode = next;
      void saveGlobalConfig({ fastMode: next });
      showToast(`Fast mode → ${next ? 'on' : 'off'} (applies on the next model turn)`, 'ok');
      break;
    }
    case '/effort': {
      // No arg: cycle. With arg: set (validated). Live-applies next turn + persists.
      // A garbage argument used to fall through to the CYCLE, so `/effort hgih` silently set
      // some unrelated level and reported success. Only a bare /effort cycles.
      const parsed = normalizeEffort(arg);
      if (arg.trim() && !parsed) {
        pushLine({ text: `Unknown effort "${arg.trim()}". Use: low, medium, high, xhigh, max — or /effort alone to cycle.`, color: C.red });
        break;
      }
      const next = parsed ?? cycleEffort(effortRef.current);
      setEffort(next);
      showToast(`Effort → ${next} ${effortSymbol(next)} — ${effortDescription(next)} (applies next turn)`, 'ok');
      break;
    }
    case '/compact': {
      if (runningRef.current) {
        pushLine({ text: 'Finish the current turn before compacting.', dimColor: true });
        break;
      }
      if (compactingRef.current) {
        pushLine({ text: 'Already compacting — Esc to cancel.', dimColor: true });
        break;
      }
      pushLine({ text: 'Compacting context… (Esc cancels)', dimColor: true });
      compactingRef.current = true;
      compactAbortRef.current = new AbortController();
      void (async () => {
        const ctl = compactAbortRef.current;
        try {
          const did = await context.maybeSummarize(
            providerRef.current,
            currentRef.current.model,
            true,
            ctl?.signal,
            { temperature: opts.cfg.temperature },
          );
          if (ctl?.signal.aborted) {
            pushLine({ text: 'Compaction cancelled — context unchanged.', dimColor: true });
          } else if (did === 'summarized') {
            pushLine({ text: 'Context compacted — earlier turns summarized.', color: C.cyan });
          } else if (did === 'truncated') {
            sessionLogRef.current.record({ kind: 'compaction_degraded', mode: 'truncated', source: 'manual' });
            pushLine({
              text:
                'Summarizer unavailable — context reclaimed by dropping the oldest tool results ' +
                '(re-read any file you still need).',
              color: C.yellow,
            });
          } else if (did === 'failed') {
            sessionLogRef.current.record({ kind: 'compaction_degraded', mode: 'failed', source: 'manual' });
            pushLine({
              text:
                'Compaction failed — summarizer unavailable and nothing left to reclaim. ' +
                'Try /clear, or /model to a larger window.',
              color: C.red,
            });
          } else {
            pushLine({ text: 'Nothing to compact yet.', dimColor: true });
          }
        } catch (e) {
          pushLine(
            ctl?.signal.aborted
              ? { text: 'Compaction cancelled — context unchanged.', dimColor: true }
              : { text: `Compact failed: ${(e as Error).message}`, color: C.red },
          );
        } finally {
          compactingRef.current = false;
          compactAbortRef.current = null;
          // Anything typed while the lock was held is queued but has no turn-end to flush it —
          // compaction finishing IS that moment.
          flushQueueRef.current?.();
        }
      })();
      break;
    }
    case '/cost':
    case '/usage': {
      const u = lastUsageRef.current;
      const sIn = sessionInTokRef.current;
      const sOut = sessionOutTokRef.current;
      if (!u && sIn === 0 && sOut === 0) {
        pushLine({ text: 'No usage recorded yet this session.', dimColor: true });
        break;
      }
      // P1B-03: SESSION totals (summed across every turn + sub-agents) are the headline; the
      // last turn is a separate line. The old readout showed only the last turn but labeled it
      // "(session)" — a mislabel that undercounted multi-turn sessions.
      const lines: BannerLine[] = [
        { text: `Session (${sessionTurnsRef.current} turn${sessionTurnsRef.current === 1 ? '' : 's'}): ${sIn.toLocaleString()} in · ${sOut.toLocaleString()} out · ${(sIn + sOut).toLocaleString()} total` },
        // Local / unpriced models never accrue cost — say so instead of a fake-precision
        // $0.0000 (founder decision 2026-07-16: no dollar readouts on local models).
        sessionCostRef.current > 0
          ? { text: `Session cost: $${sessionCostRef.current.toFixed(4)}`, color: C.cyan }
          : { text: 'Session cost: none — local/unpriced model', dimColor: true },
      ];
      if (u) {
        lines.push({ text: `Last turn:    ${u.inputTokens.toLocaleString()} in · ${u.outputTokens.toLocaleString()} out${u.costUSD > 0 ? ` · $${u.costUSD.toFixed(4)}` : ''}`, dimColor: true });
      }
      pushLine({ kind: 'system', text: 'cost', lines });
      break;
    }
    case '/connections': {
      // P2-01: the session-scoped view of the egress receipt (`shadow egress` reads the
      // persistent log from a fresh process; this shows the live in-memory aggregate).
      const rows = egressSummary();
      if (rows.length === 0) {
        pushLine({ text: 'No egress recorded yet this session — nothing has left the box.', dimColor: true });
        break;
      }
      const lines: BannerLine[] = [
        { text: `Connections this session (${rows.length} host${rows.length === 1 ? '' : 's'}) — full receipt: \`shadow egress\``, bold: true },
      ];
      for (const r of rows) {
        const counts = [
          r.allowed > 0 ? `${r.allowed} allowed` : '',
          r.denied > 0 ? `${r.denied} denied` : '',
          // P3-08 Phase 2: tool fetches made OUTSIDE the egress allowlist (quarantine).
          r.flagged > 0 ? `${r.flagged} ⚑ outside allowlist` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        const seen = new Date(r.lastSeen).toLocaleTimeString();
        lines.push({
          text: `  ${r.host}  —  ${counts} · ${[...r.purposes].sort().join(', ')} · ${seen}`,
          color: r.denied > 0 || r.flagged > 0 ? C.yellow : undefined,
          dimColor: r.denied === 0 && r.flagged === 0,
        });
      }
      lines.push({ text: 'Every outbound request flows the egress broker; --offline denies all non-local egress.', dimColor: true });
      pushLine({ kind: 'system', text: 'connections', lines });
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
      // F02-04: bare /resume used to silently auto-pick the newest session — with several
      // candidates that is a coin flip the user never sees. Auto-pick ONLY when there is
      // exactly one; otherwise open the picker menu (the same one typing `/resume ` opens) so
      // the choice is explicit.
      if (!arg && sessions.length > 1) {
        setComposer('/resume ', '/resume '.length);
        pushLine({
          text: `${sessions.length} resumable sessions — pick one below (Esc closes the menu).`,
          dimColor: true,
        });
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
        // Repaint BEFORE the confirmation line, so the notice sits at the bottom of the
        // conversation it is describing rather than above a stale one.
        repaintFromContextRef.current?.();
        // Seed THIS session's log with the restored context. `/export` reads the CURRENT log
        // file, which is brand new after a resume — so exporting a resumed session produced a
        // file containing nothing but frontmatter, silently losing the very conversation the
        // user had just restored in order to keep working on it.
        try {
          sessionLogRef.current.recordSnapshot(context, 0);
          sessionLogRef.current.record({ kind: 'resumed_from', sessionId: pick.id, path: pick.path });
        } catch {
          /* a log that cannot be written must not fail the resume itself */
        }
        // The seeded turn-0 snapshot appended to the log — re-list so a /rewind right after
        // the resume sees the resumed lineage (the size-keyed gate makes this cheap).
        refreshRewindTurns();
        pushLine({
          text: `Resumed ${pick.id} (${context.messages().length} messages).`,
          color: C.cyan,
        });
        // A different session is a different grant scope: "approve run_shell for this session"
        // must not silently carry into the one just loaded.
        sessionApprovalsRef.current.clear();
        // F08-11: "While you were away" recap — one non-streaming summary of the restored
        // conversation via the CURRENT provider. Opt-in (cfg.resumeRecap), silent on any error
        // or if there's too little to summarize; never blocks the resume itself.
        if (opts.cfg.resumeRecap && context.messages().length >= 6) void showResumeRecap();
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
      // F08-07: /rewind [turn-index] [--code-only|--chat-only]. Bare /rewind opens the picker.
      const rwParts = (arg ?? '').split(/\s+/).filter(Boolean);
      const rwFlags = rwParts.filter((p) => p.startsWith('--'));
      const badFlag = rwFlags.find((f) => f !== '--code-only' && f !== '--chat-only');
      if (badFlag) {
        pushLine({
          text: `Unknown flag ${badFlag}. Usage: /rewind <turn-index> [--code-only|--chat-only]`,
          color: C.red,
        });
        break;
      }
      if (new Set(rwFlags).size === 2) {
        pushLine({ text: '--code-only and --chat-only are mutually exclusive.', color: C.red });
        break;
      }
      const rwScope: 'code' | 'chat' | undefined = rwFlags.includes('--code-only')
        ? 'code'
        : rwFlags.includes('--chat-only')
          ? 'chat'
          : undefined;
      const rwTurnArg = rwParts.find((p) => !p.startsWith('--'));
      refreshRewindTurns(); // the list must reflect anything appended since the last turn end
      const rwTurns = rewindableTurnsRef.current;
      if (!rwTurnArg) {
        if (!rwTurns.length) {
          pushLine({ text: 'Nothing to rewind to yet — no turns this session.', dimColor: true });
          break;
        }
        // The /resume pattern: auto-pick ONLY when there is exactly one candidate; otherwise
        // open the picker menu (the same one typing `/rewind ` opens) so the choice is
        // explicit — each row names the turn by the prompt that produced it.
        if (rwTurns.length > 1) {
          const stem = rwScope ? `/rewind --${rwScope}-only ` : '/rewind ';
          setComposer(stem, stem.length);
          pushLine({
            text: `${rwTurns.length} turns to rewind to — pick one below (Esc closes the menu).`,
            dimColor: true,
          });
          break;
        }
      }
      const turnIndex = rwTurnArg ? Number(rwTurnArg) : (rwTurns[0]?.turn ?? NaN);
      // STRICT validation: an explicit turn must be an integer AND one the log actually has a
      // snapshot for. The old path silently clamped any number (3.7, 999) to the nearest
      // known turn, so "/rewind 12" could land on turn 2 with no word about it.
      if (!Number.isInteger(turnIndex) || turnIndex < 0) {
        pushLine({
          text: 'Usage: /rewind <turn-index> [--code-only|--chat-only] (0 = first assistant turn).',
          dimColor: true,
        });
        break;
      }
      if (!rwTurns.some((t) => t.turn === turnIndex)) {
        const avail = rwTurns.map((t) => t.turn).sort((a, b) => a - b).join(', ');
        pushLine({
          text: `No snapshot for turn ${turnIndex}. Rewindable turns: ${avail || 'none yet'}.`,
          color: C.red,
        });
        break;
      }
      try {
        const { context: rewound, restoredFiles, deletedFiles, partialFiles, turn } = rewindToTurn(
          sessionLogRef.current.path,
          turnIndex,
          opts.workspaceRoot,
          {
            contextBudget: opts.cfg.contextBudget,
            triggerRatio: opts.cfg.summarizeTriggerRatio,
            keepLastTurns: opts.cfg.keepLastTurns,
            scope: rwScope,
          },
        );
        if (rewound) {
          context.loadState(rewound.exportState());
          // F08-07: make the REWOUND state durable — append a snapshot for the rewound turn so
          // a later /resume resurrects the post-rewind conversation instead of the pre-rewind
          // one (rewindToTurn's pick is latest-append-wins). This also makes the rewind itself
          // a rewind target. --code-only leaves the conversation untouched → no snapshot.
          sessionLogRef.current?.recordSnapshot(rewound, turn);
          firstRef.current = context.messages().length === 0;
          repaintFromContextRef.current?.();
          refreshRewindTurns(); // the appended snapshot changed the turn's backing state
        }
        pushLine({
          kind: 'system',
          text: 'rewind',
          lines: [
            {
              text:
                rwScope === 'code'
                  ? `Rewound workspace files to turn ${turn} (conversation untouched).`
                  : rwScope === 'chat'
                    ? `Rewound conversation to turn ${turn} (${context.messages().length} messages; files untouched).`
                    : `Rewound to turn ${turn} (${context.messages().length} messages).`,
              color: C.cyan,
            },
            ...(rwScope !== 'chat' && restoredFiles.length
              ? [{ text: `Restored ${restoredFiles.length} file(s): ${restoredFiles.join(', ')}`, dimColor: true }]
              : []),
            ...(rwScope !== 'chat' && deletedFiles.length
              ? [{ text: `Removed ${deletedFiles.length} file(s) created after that turn: ${deletedFiles.join(', ')}`, dimColor: true }]
              : []),
            ...(rwScope !== 'chat' && partialFiles.length
              ? [{
                  text: `${partialFiles.length} file(s) only PARTIALLY restored (oldest backup missing — they stay at a newer state): ${partialFiles.join(', ')}`,
                  color: C.yellow,
                }]
              : []),
            ...(rwScope !== 'chat' && !restoredFiles.length && !deletedFiles.length && !partialFiles.length
              ? [{ text: 'No file checkpoints to restore for that turn.', dimColor: true }]
              : []),
          ],
        });
        // F08-07: prefill the composer with the prompt of the first UNDONE turn — the one just
        // after the rewind point — so it can be tweaked and re-sent, which is the point of
        // rewinding. Skipped for --code-only (the conversation did not move).
        if (rwScope !== 'code') {
          const redo = rwTurns.filter((t) => t.turn > turn).sort((a, b) => a.turn - b.turn)[0];
          if (redo?.prompt) setComposer(redo.prompt, redo.prompt.length);
        }
      } catch (e) {
        pushLine({ text: `Rewind failed: ${(e as Error).message}`, color: C.red });
      }
      break;
    }
    case '/fork': {
      if (runningRef.current) {
        pushLine({ text: 'Finish the current turn before forking.', dimColor: true });
        break;
      }
      try {
        const source = sessionLogRef.current;
        const sourceId = SessionLog.sessionIdFromPath(source.path);
        const { log, forkId } = forkSession(source, opts.workspaceRoot);
        sessionLogRef.current = log;
        // A different session id is a different grant scope — /resume parity: "approve for
        // this session" must not silently carry into the fork.
        sessionApprovalsRef.current.clear();
        // New log path → the /rewind menu must now list the FORK's lineage (not the source's).
        refreshRewindTurns();
        pushLine({
          kind: 'system',
          text: 'fork',
          lines: [
            { text: `Forked → session ${forkId} (source ${sourceId} left untouched).`, color: C.cyan },
            { text: 'New turns and /rewind now live in the fork.', dimColor: true },
          ],
        });
      } catch (e) {
        pushLine({ text: `Fork failed: ${(e as Error).message}`, color: C.red });
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
      // An unwritable workspace (read-only mount, permissions, a full disk) threw straight out
      // of the slash dispatcher and took the whole TUI down — losing the session over a failed
      // file write. Report it like every other command failure instead.
      try {
        writeFileSync(target, seed, 'utf8');
        pushLine({ text: `Created ${target}`, color: C.cyan });
      } catch (e) {
        pushLine({ text: `Could not create ${shortPath(target)}: ${(e as Error).message}`, color: C.red });
      }
      break;
    }
    case '/agents': {
      // `/agents kill <id|all>` cancels a running BACKGROUND sub-agent (F10-02 cancellation);
      // bare `/agents` lists LIVE agents (running now) then the available definitions.
      const parts = arg.split(/\s+/).filter(Boolean);
      if (parts[0] === 'kill') {
        const target = parts[1];
        const live = [...subAgents.values()].filter((a) => a.background && !a.done);
        if (!live.length) {
          pushLine({ text: 'No background agents are running.', dimColor: true });
          break;
        }
        if (!target) {
          pushLine({ text: 'Usage: /agents kill <id|all>. Running: ' + live.map((a) => a.taskId).join(', '), dimColor: true });
          break;
        }
        if (target === 'all') {
          bus.emit({ type: 'cancel_subagent', taskId: '*' });
          pushLine({ text: `Cancelling ${live.length} background agent${live.length === 1 ? '' : 's'}…`, color: C.yellow });
          break;
        }
        const match = live.find((a) => a.taskId === target || a.taskId.endsWith(target));
        if (!match) {
          pushLine({ text: `No running background agent matches "${target}".`, color: C.red });
          break;
        }
        bus.emit({ type: 'cancel_subagent', taskId: match.taskId });
        pushLine({ text: `Cancelling ${match.subagentType} (${match.taskId})…`, color: C.yellow });
        break;
      }
      const live = [...subAgents.values()];
      const defs = loadAgentDefs(opts.workspaceRoot);
      const lines: BannerLine[] = [];
      if (live.length) {
        lines.push({ text: 'Running now:', color: C.cyan });
        for (const a of live) {
          // F06-10: a queued agent is NOT running — it holds no slot and runs no tools.
          const state = a.done
            ? a.ok === false ? 'failed' : 'done'
            : a.queued
              ? 'queued (waiting for a slot)'
              : a.tool
                ? `${a.tool}`
                : 'running';
          lines.push({ text: `  ${a.subagentType.padEnd(14)} ${a.taskId}${a.background ? ' [bg]' : ''} · ${state}`, dimColor: true });
        }
        lines.push({ text: `  (/agents kill <id|all> to cancel a background agent)`, dimColor: true });
        lines.push({ text: 'Definitions:', color: C.cyan });
      }
      for (const d of defs) {
        lines.push({ text: `  ${d.name.padEnd(14)} ${d.description}${d.builtin ? ' (built-in)' : ''}`, dimColor: true });
      }
      pushLine({ kind: 'system', text: 'agents', lines });
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
      const sub = arg.trim().split(/\s+/);
      if (sub[0] === 'enable' || sub[0] === 'disable') {
        const name = sub[1] ?? '';
        if (!name) {
          pushLine({ text: `usage: /plugins ${sub[0]} <name>`, dimColor: true });
          break;
        }
        try {
          const info = setPluginEnabled(name, sub[0] === 'enable');
          pushLine({
            text:
              sub[0] === 'enable'
                ? `enabled plugin "${info.name}" — start a new session (or restart) to load its content.`
                : `disabled plugin "${info.name}" — start a new session (or restart) to unload its content.`,
            color: sub[0] === 'enable' ? C.green : C.yellow,
          });
        } catch (err) {
          pushLine({ text: (err as Error).message, color: C.red });
        }
        break;
      }
      const plugins = listPlugins();
      const lines: BannerLine[] = [];
      if (!plugins.length) {
        lines.push({ text: 'No plugins installed. `shadow plugin add <git-url | path>` installs one (disabled until enabled).', dimColor: true });
      }
      for (const p of plugins) {
        const counts =
          PLUGIN_CONTENT_DIRS.filter((k) => p.counts[k] > 0)
            .map((k) => `${p.counts[k]} ${k}`)
            .join(' · ') || 'no content';
        const prov =
          p.meta.source.kind === 'git'
            ? `${p.meta.source.url}${p.meta.source.commit ? ` @ ${p.meta.source.commit.slice(0, 12)}` : ''}`
            : p.meta.source.path;
        lines.push({
          text: `${p.meta.enabled ? '●' : '○'} ${p.name} v${displaySafe(p.manifest.version, 64)} [${p.meta.enabled ? 'enabled' : 'disabled'}] — ${displaySafe(p.manifest.description, 300)}`,
          color: p.meta.enabled ? C.green : C.yellow,
        });
        lines.push({ text: `    ${counts} · from ${displaySafe(prov, 320)}`, dimColor: true });
      }
      const offers = listNamedEntries(join(opts.workspaceRoot, '.shadow', 'plugins'));
      if (offers.length) {
        lines.push({
          text: `workspace offers: ${offers.join(', ')} — a repo can only OFFER a plugin; install it with \`shadow plugin add <path>\`.`,
          dimColor: true,
        });
      }
      lines.push({ text: 'plugins are DATA-only bundles: commands · output-styles · skills · agents · workflows (never hooks/MCP).', dimColor: true });
      lines.push({ text: '/plugins enable <name> · /plugins disable <name> · CLI: shadow plugin add|list|remove|search', dimColor: true });
      pushLine({ kind: 'system', text: 'plugins', lines });
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
          sessionPath: sessionLogRef.current.path,
          workspaceRoot: opts.workspaceRoot,
          outPath: outArg || undefined,
          meta: {
            version: opts.version,
            workspaceRoot: opts.workspaceRoot,
            provider: currentRef.current.provider,
            model: currentRef.current.model,
            style: styleRef.current,
            autonomy: autonomyRef.current,
            sessionPath: sessionLogRef.current.path,
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
      // Copy the last assistant answer (or `/copy code` → its last fenced code
      // block) to the system clipboard. Read-only and safe mid-turn. Also on
      // Alt+C. (Per-message keyboard nav + selection needs the owned viewport —
      // see reports; this delivers the 80% copy value without it.)
      copyLast(arg.toLowerCase() === 'code' ? 'code' : 'answer');
      break;
    }
    case '/sessions': {
      // F02-04: an INVENTORY of what /resume can load — the picker menu is only reachable by
      // typing `/resume ` and waiting for a completion, and there was no way to just look.
      const sessions = listResumableSessions(opts.workspaceRoot);
      if (!sessions.length) {
        pushLine({ text: 'No resumable sessions in this workspace yet.', dimColor: true });
        break;
      }
      const currentId = sessionLogRef.current.path ? SessionLog.sessionIdFromPath(sessionLogRef.current.path) : '';
      const SHOWN = 50;
      pushLine({
        kind: 'system',
        text: 'sessions',
        lines: [
          { text: `Resumable sessions (${sessions.length}) — /resume <id> to load one`, bold: true },
          ...sessions.slice(0, SHOWN).map((s) => ({
            text: `  ${s.id === currentId ? '▸ ' : '  '}${s.id}${s.ts ? `  · snapshot ${s.ts}` : ''}`,
            color: s.id === currentId ? C.cyan : undefined,
            dimColor: s.id !== currentId,
          })),
          ...(sessions.length > SHOWN
            ? [{ text: `  …and ${sessions.length - SHOWN} more — /resume <id-prefix> reaches them`, dimColor: true }]
            : []),
        ],
      });
      break;
    }
    case '/session': {
      const messages = context.messages().length;
      const id = sessionLogRef.current.path ? SessionLog.sessionIdFromPath(sessionLogRef.current.path) : 'unknown';
      pushLine({
        kind: 'system',
        text: 'session',
        lines: [
          { text: `id: ${id}`, color: C.cyan },
          { text: `messages: ${messages.toLocaleString()} · style ${styleRef.current} · autonomy ${autonomyRef.current}`, dimColor: true },
          { text: `log: ${sessionLogRef.current.path ? shortPath(sessionLogRef.current.path) : 'not available'}`, dimColor: true },
          { text: 'Use /export to save a markdown transcript, /resume to load an earlier session.', dimColor: true },
        ],
      });
      break;
    }
    case '/doctor': {
      // `/doctor model` is advertised in the argument menu ("Probe the active model: tools,
      // vision, context window") and its argument was silently ignored — you got the generic
      // environment report and no indication the probe had not run. The real implementation is
      // `/model test`, so route to it rather than shipping a second copy.
      if (arg.trim().toLowerCase() === 'model') {
        runSlashCommand(ctx, findSlashCommand('/model')!, '/model test');
        break;
      }
      if (arg.trim()) {
        pushLine({ text: `Unknown /doctor argument "${arg.trim()}". Use /doctor or /doctor model.`, color: C.red });
        break;
      }
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
      const target = activeTargetRef.current;
      pushLine({
        kind: 'system',
        text: 'status',
        lines: [
          { text: `${currentRef.current.provider}/${currentRef.current.model} · ${autonomyRef.current}${opts.bypass ? ' (yolo)' : ''} · style ${styleRef.current}`, color: C.cyan },
          // P2-11 — the active named profile is part of the session's identity; show exactly
          // which keys it contributed so a surprise model/effort is never invisible.
          ...(opts.cfg.activeProfile
            ? [{
                text: `profile ${opts.cfg.activeProfile}${
                  Object.entries(opts.cfg.profile ?? {}).length > 0
                    ? ` (${Object.entries(opts.cfg.profile ?? {})
                        .map(([k, v]) => `${k}=${v}`)
                        .join(', ')})`
                    : ''
                }`,
                color: C.cyan,
              }]
            : []),
          // The `· $…` tail only when real cost accrued — local/unpriced sessions stay clean
          // (same rule as formatUsage in the status strip).
          { text: `context ${pct}% of ${opts.cfg.contextBudget.toLocaleString()} · ${u ? (u.inputTokens + u.outputTokens).toLocaleString() : 0} tokens${u && u.costUSD > 0 ? ` · $${u.costUSD.toFixed(4)}` : ''}`, dimColor: true },
          ...(target.selfHosted
            ? [{ text: `temperature ${formatTemperature(opts.cfg.temperature ?? 1.0)} · self-hosted only`, dimColor: true }]
            : []),
          { text: `workspace ${opts.workspaceRoot}`, dimColor: true },
          // P2-12 — the confinement state is session-critical security context; keep it visible.
          sandboxConfinement(opts.cfg.sandbox) === 'unconfined'
            ? {
                text: `sandbox UNAVAILABLE on this host — run_shell ${
                  opts.cfg.sandboxFailurePolicy === 'warn'
                    ? 'runs UNCONFINED (policy: warn)'
                    : `gates at approval (policy: ${opts.cfg.sandboxFailurePolicy})`
                }`,
                color: C.yellow,
              }
            : { text: `sandbox ${sandboxConfinement(opts.cfg.sandbox)}`, dimColor: true },
          ...(goalRef.current ? [{ text: `goal: ${goalRef.current}`, color: C.purple }] : []),
        ],
      });
      break;
    }
    case '/diff': {
      try {
        const out = execFileSync('git', ['-C', opts.workspaceRoot, 'diff', '--stat'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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
        const out = execFileSync('git', ['-C', opts.workspaceRoot, 'status', '--short'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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
        const branch = execFileSync('git', ['-C', opts.workspaceRoot, 'branch', '--show-current'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        const status = execFileSync('git', ['-C', opts.workspaceRoot, 'status', '--short', '--branch'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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
        pushLine({
          text: `Config saved: ${parsed.key} = ${parsed.key === 'temperature' ? formatTemperature(parsed.value as number) : String(parsed.value)}${parsed.key === 'temperature' ? ' (self-hosted models only)' : ''}`,
          color: C.cyan,
        });
        break;
      }
      if (parts[0] === 'get') {
        const key = parts[1] ?? '';
        if (!key) {
          pushLine({ text: 'Usage: /config get <key>', dimColor: true });
          break;
        }
        const value = (opts.cfg as unknown as Record<string, unknown>)[key];
        // The command advertises "API keys hidden", and it did not hide them: `/config get
        // models` printed every inline apiKey/authToken verbatim onto a screen that gets
        // screen-shared and recorded. Mask by KEY NAME (deep, so nested models[] and
        // mcpServers[].env are covered) — a locally-served key has no recognisable SHAPE, so
        // the pattern scrubber alone returned it untouched.
        const shown = isSecretKey(key) && value != null && value !== ''
          ? maskSecret(value)
          : JSON.stringify(redactConfig(value));
        pushLine({ text: `${key}: ${value === undefined ? '(unset)' : shown}`, dimColor: true });
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
          { text: `temperature ${formatTemperature(c.temperature ?? 1.0)} · self-hosted models only`, dimColor: true },
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
          // P3-08: report the EFFECTIVE jail state (session sandbox flag × host tooling), never just the config.
          lines: mcpServerLines(name, server, {
            requested: (opts.cfg.sandbox ?? 'auto') !== 'off',
            toolAvailable: sandboxToolAvailable(),
          }).map((text, i) => ({ text, color: i === 0 ? C.cyan : undefined, dimColor: i !== 0 })),
        });
        break;
      }
      if (action === 'enable') {
        const preset = parts[1];
        if (preset !== 'browser' && preset !== 'context-cooler') {
          pushLine({ text: 'Usage: /mcp enable <browser | context-cooler [--path <dir|server.js>]>', dimColor: true });
          break;
        }
        const servers = loadGlobalMcpServers();
        const pathIndex = parts.indexOf('--path');
        const pathArg = pathIndex >= 0 ? parts[pathIndex + 1] : undefined;
        const change = preset === 'browser'
          ? enablePlaywrightBrowser(servers)
          : enableContextCooler(servers, pathArg);
        if (change.ok) {
          saveGlobalMcpServers(change.servers);
          opts.cfg.mcpServers = change.servers;
        }
        const restart = preset === 'browser'
          ? ' Restart Shadow to load browser tools. Uses an isolated Chrome profile; requires Node.js, npm, and npx.'
          : ' Restart Shadow to load new MCP tools.';
        pushLine({
          text: `${change.message}${change.ok ? restart : ''}`,
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
        pushLine({ text: 'Usage: /mcp [list|get <name>|enable browser|enable context-cooler [--path <path>]|disable <name>]', dimColor: true });
        break;
      }
      pushLine({
        kind: 'system',
        text: 'mcp',
        lines: [
          ...mcpListLines(effectiveServers).map((text) => ({ text, dimColor: true })),
          { text: 'Browser: /mcp enable browser (isolated Chrome; requires Node/npm+npx)', dimColor: true },
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
      // Push (or release) the terminal background the theme asserts. Switching AWAY from a
      // background theme resets to the user's own — the palette is swapped in place, so this
      // has to fire on every switch, not just when the new theme has a bg.
      if (process.stdout.isTTY) {
        process.stdout.write(backgroundSequence(THEMES[next].bg, true));
        // Keep the EXIT reset in step with the live theme. runTui captured the launch theme in
        // a const, so `/theme shadow` mid-session pushed OSC 11 with no matching OSC 111 — a
        // clean exit then left the terminal permanently black, while the confirmation line
        // promised it would be "restored on exit".
        updateReset('theme-bg', THEMES[next].bg ? backgroundSequence(null, true) : null);
      }
      opts.cfg.lastTheme = next; // keep the in-memory cfg in sync for the next cycle
      saveGlobalConfig({ lastTheme: next });
      setThemeTick((t) => t + 1); // repaint with the new palette
      // T1: theme apply is a fire-and-forget ack — toast it (falls back to the transcript
      // internally when the HUD can't fit a row) so it doesn't clutter /rewindable history.
      showToast(
        THEMES[next].bg
          ? `Theme: ${next} — the terminal background is now ${THEMES[next].bg} (restored on exit; SHADOW_NO_BG=1 opts out).`
          : `Theme: ${next}`,
        'ok',
      );
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
        const info = statSync(abs);
        if (!info.isFile()) {
          pushLine({ text: `Not a file: ${abs}`, color: C.red });
          break;
        }
        if (info.size > MAX_IMAGE_BYTES) {
          pushLine({ text: `Image is too large: ${arg} (${(info.size / 1024 / 1024).toFixed(1)} MiB; max 20 MiB).`, color: C.red });
          break;
        }
        const data = readFileSync(abs).toString('base64');
        attachmentsRef.current = [...attachmentsRef.current, { type: 'image', mediaType, data }];
        setAttachCount(attachmentsRef.current.length);
        pushLine({ text: `Attached ${arg} — sent with your next message (${attachmentsRef.current.length} queued).`, color: C.green });
        // Echo the attached image inline so the user sees what they're sending.
        pushImage(data, mediaType, arg, 'attach');
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
    case '/terminal-setup': {
      // Terminal.app, iTerm2 and the VS Code terminal all send a BARE \r for Shift+Enter, so
      // no application can distinguish it from Enter. Shadow understands the CSI-u and
      // modifyOtherKeys encodings; this tells you how to make your terminal send one.
      // Deliberately PRINTS rather than writes: these are files outside the workspace
      // (iTerm2 prefs, VS Code keybindings.json) and silently editing them is not something a
      // CLI should do on its own.
      const tp = process.env.TERM_PROGRAM ?? '';
      const term = process.env.TERM ?? '';
      const native = /kitty|wezterm|ghostty|foot/i.test(term) || /WezTerm|ghostty/i.test(tp);
      const lines: { text: string; color?: string; dimColor?: boolean }[] = [];
      lines.push({ text: 'Shift+Enter — insert a newline instead of sending', color: C.cyan });
      lines.push({ text: '' });
      if (native) {
        lines.push({ text: `Your terminal (${tp || term}) speaks CSI-u natively — Shift+Enter should already work.`, dimColor: true });
        lines.push({ text: 'If it does not, check that no keybinding overrides it.', dimColor: true });
      } else if (tp === 'iTerm.app') {
        lines.push({ text: 'iTerm2:', color: C.green });
        lines.push({ text: '  Settings → Profiles → Keys → Key Mappings → +', dimColor: true });
        lines.push({ text: '  Shortcut: Shift+Enter   Action: Send Escape Sequence', dimColor: true });
        lines.push({ text: '  Esc+:  [13;2u', dimColor: true });
      } else if (tp === 'vscode') {
        lines.push({ text: 'VS Code — add to keybindings.json (⌘⇧P → "Open Keyboard Shortcuts (JSON)"):', color: C.green });
        lines.push({ text: '  {', dimColor: true });
        lines.push({ text: '    "key": "shift+enter",', dimColor: true });
        lines.push({ text: '    "command": "workbench.action.terminal.sendSequence",', dimColor: true });
        lines.push({ text: '    "when": "terminalFocus",', dimColor: true });
        lines.push({ text: '    "args": { "text": "\\u001b[13;2u" }', dimColor: true });
        lines.push({ text: '  }', dimColor: true });
      } else if (tp === 'Apple_Terminal') {
        lines.push({ text: 'Terminal.app cannot send CSI-u — it has no per-key escape mapping.', color: C.yellow });
        lines.push({ text: 'Use Option+Enter (works today), or switch to iTerm2/WezTerm/kitty.', dimColor: true });
      } else {
        lines.push({ text: `Terminal not recognised (TERM_PROGRAM=${tp || 'unset'}, TERM=${term || 'unset'}).`, dimColor: true });
        lines.push({ text: 'Bind Shift+Enter to send the escape sequence:  ESC [ 1 3 ; 2 u', dimColor: true });
      }
      lines.push({ text: '' });
      lines.push({ text: `Working today with no setup: ${NEWLINE_HINT}, Ctrl+J, or a trailing \\ then Enter.`, dimColor: true });
      pushLine({ kind: 'system', text: 'terminal-setup', lines });
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
      else {
        vimPendingRef.current = '';
        vimFindRef.current = null;
        vimCountRef.current = 0;
        vimRegRef.current = '';
      }
      showToast(
        next
          ? 'Vim mode ON — Esc for NORMAL, i/a to insert. Motions: h l 0 $ w b e j k f F t T ; , · edits: x s d c y D C p o O r J · counts work (3w, d2w, 2dd).'
          : 'Vim mode OFF — standard composer editing restored.',
        'info',
      );
      break;
    }
    case '/exit':
    case '/quit':
      exit();
      break;
  }
}
