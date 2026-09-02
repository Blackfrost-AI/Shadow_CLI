import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { render, Box, Text, Static, useApp, useInput, useStdin, useStdout } from 'ink';
import { itemIsCollapsible, computeToolRunsAppendable, type ToolRunsCache } from './tui/flatten.js';
import { type BannerLine, type TranscriptItem } from './tui/rows.js';
import { collapseKind, displayToolArg, displayToolName, formatReconSummary, isCollapsibleTool, isWriteTool, reconCount, type CollapseKind } from './tui/toolDisplay.js';
import { renderSubAgentPanel, type SubAgentView } from './tui/subagentPanel.js';
import { emitNotification, NOTIFY_MIN_TURN_MS, NOTIFY_APPROVAL_WAIT_MS } from './util/notify.js';
import { discoverCustomCommands } from './tui/customCommands.js';
import { resolveEditor, openEditorFile } from './tui/externalEditor.js';
import { atMentionToken, walkWorkspaceFiles, rankFileCandidates, expandFileMentions } from './tui/fileMentions.js';
import { supportsInlineImages, saveAndOpen, canOpenViewer } from './util/termImage.js';
import { extractCommittableUnits, clampTail, clampLiveRest, stripTrailingNewlines, dupKey, repeatStep, leadsWithBlock } from './tui/streamCommit.js';
import { computeLayout, formatStatusStrip, pinnedMaxItems, composerMaxRows, fitHud, type HudFit } from './tui/layout.js';
import { clampToastText, toastColor, TOAST_TTL_MS, type ToastKind } from './tui/toast.js';
import { decideInstructionAutopilot, seedInstructionFile, autopilotToastText, autopilotEnabledForBoot } from './tui/instructionAutopilot.js';
import { IS_DARWIN, NEWLINE_HINT } from './tui/platform.js';
import { PendingOverlay, ModelPickerOverlay } from './tui/overlays.js';
import { buildSeats, resolveTableEntries, parseTableInput, seatTag, MIN_SEATS, MAX_SEATS, type Seat, type SpeakerTag } from './tui/roundTable.js';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import type { Message, Provider, ToolCall, ContentBlock, ImageBlock, Effort } from './provider/provider.js';
import type { ToolRegistry } from './tools/registry.js';
import { EventBus, type StopReasonExt } from './agent/events.js';
import { Budget } from './agent/budget.js';
import { maybeNotifyUpdate } from './update/checkUpdate.js';
import { providerErrorHint } from './util/errorHints.js';
import { isBigPaste, expandPastes, prunePastes, PASTE_CAP, visibleComposerWindow, clickToCursor, parseSgrMouse, lastKeySequence, historySearchPrompt, type HistorySearchState, COMPOSER_MAX_VISIBLE_ROWS, COMPOSER_GUTTER, composerPaintRows } from './tui/composer.js';
import { withSynchronizedOutput } from './tui/syncOutput.js';
import { recommendedIndex, defaultQuestionSelection, buildQuestionAnswers, buildAutoAnswers, type QuestionSelection } from './tui/questions.js';
import { fetchRemoteImage, imageMediaType, MAX_IMAGE_BYTES } from './util/image.js';
import { Context } from './agent/context.js';
import type { TodoItem, TodoList } from './agent/todo.js';
import type { PlanModeState, PlanSnapshot } from './agent/planMode.js';
import type { MissionSnapshot, MissionState } from './agent/mission.js';
import { missionHudLine, missionPinnedRow } from './tui/missionHud.js';
import { drainTurnInput } from './tui/turnInput.js';
import { AgentLoop } from './agent/loop.js';
import { buildLoopDeps } from './agent/loopDeps.js';
import { runLock, CLI_HOLDER } from './web/runLock.js';
import { type ApprovalGate, type ApprovalRequest, AutoApproveGate, SessionApprovals } from './agent/approval.js';
import { raiseAutonomy, type AutonomyLevel } from './safety/permissions.js';

import { isLocalBaseUrl, isLocalModelTarget } from './safety/offline.js';

import { clampLocalContextBudget, keepLastTurnsForBudget, triggerRatioForBudget } from './util/contextBudget.js';
import { familyProfile } from './config/familyProfiles.js';
import { SessionLog } from './state/session.js';
import { createProvider, entryStreamContract, type ProviderName } from './provider/index.js';

import { configuredContextWindow, detectServerContextWindow, ensureLocalServer, isLocalServedEntry, mlxOfflineReady } from './gguf.js';

import { resolveBaseUrl, resolveEntryCredential, type ShadowConfig, type ModelEntry } from './config.js';
import { vaultExists } from './auth/vault.js';

import { type OutputStyle } from './styles.js';
import { firstSelectableRow, modelRows } from './util/modelGroups.js';

import { saveGlobalConfig, vaultUnlocked } from './state/globalStore.js';

import { listResumableSessions } from './state/resume.js';
import { listRewindableTurns, type RewindableTurn } from './state/rewind.js';

import { statSync, readFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';

import { friendlyDeniedReason } from './util/deniedReason.js';
import type { VimFind, VimMode } from './tui/vim.js';
import { runHookPhase } from './hooks/runner.js';

import { effortOrDefault, effortSymbol } from './agent/effort.js';

import { copyToClipboard, hasClipboard, readClipboard } from './util/clipboard.js';
import { redactString } from './util/redact.js';
import { useKeybindings } from './tui/keybindings/useKeybinding.js';

import { dispatchKey } from './tui/keys/router.js';
import { batchedTextReturn } from './tui/keys/common.js';
import type { KeyEnv } from './tui/keys/types.js';
import { claimMode, releaseMode, restoreTerminal, installRestoreHandlers } from './tui/terminalState.js';
import { sanitizeTerminalEscapes, scrubForDisplay } from './util/scrub.js';
import { splitStreamToolIntentCapped } from './tui/streamIntent.js';
import { scrubbedEnv } from './util/safeEnv.js';
import { displayWidth, takeByWidth } from './util/width.js';
import { stripCtl, formatUsage, shellCommandOf, agentAttr, oneLine, formatDiffStats } from './tui/format.js';
import { THEMES, THEME_NAMES, C, normalizeThemeName, applyTheme, paletteSnapshot, backgroundSequence, themeBackground, type ThemeName, type Palette } from './tui/theme.js';
import { SLASH_COMMANDS, SLASH_NAME_WIDTH, findSlashCommand, runSlashCommand, slashDispatchName, type SlashCommand, type SlashCtx } from './tui/slash.js';
import { slashMatches, classifySlash, type SlashMenuItem, type ArgContext } from './tui/slashMenu.js';
import { sanitizeAssistantText } from './tui/sanitize.js';
import { InteractiveGate } from './tui/gate.js';
import {
  PAGE_MARGIN,
  MARGIN_PAD,
  PinnedState,
  StatusStrip,
  ChromeMarkers,
  isChatter,
  Composer,
  FlatItem,
  type ChromeMarker,
} from './tui/chrome.js';
import { previewOf } from './tui/headless.js';
export { parseSafeConfig } from './tui/slash.js';
export type { SlashCommand } from './tui/slash.js';
// Moved to modules (plan 2.4 structural budget) — re-exported so existing importers keep working.
export { attachRenderer } from './tui/headless.js';
export { Markdown } from './tui/markdown.js';
export { Composer };

interface TuiStyleState {
  style: OutputStyle;
  setStyle: (style: OutputStyle) => void;
  systemForStyle?: (style: OutputStyle) => string;
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
      // F07-03: run the statusLine with cwd = HOME, NOT the workspace (which spawn inherits from
      // Shadow's own cwd). A relative script path inside a statusLine command would otherwise resolve
      // against a potentially hostile cloned repo — the same drive-by bait class as hooks. Pinning to
      // HOME removes that vector without breaking legitimate `date`-style commands. The workspace is
      // still available to the command via the explicit $SHADOW_CWD env var below.
      cwd: homedir(),
      env: {
        ...scrubbedEnv(),
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
// The Shadow spinner: a circle spinning between LIGHT and DARK — the half-disc rotates through
// four phases (founder pick, 2026-07-11; replaced the sparkle pulse). Reads as an eclipse: on
// brand for a client named Shadow, and it's the ◐ "working" glyph the redesign spec already used.
// IS_DARWIN moved to ./tui/platform.js (shared with slash help lines) — imported below.
const SPINNER = ['◐', '◓', '◑', '◒']; // light/dark halves chase around the circle
// The signature left-gutter dot on assistant turns; color (not shape) carries tool state.
const BLACK_CIRCLE = IS_DARWIN ? '⏺' : '●';
// The spinner glyph + live-region ⏺ accent — reads the THEME token so the streaming
// preview matches the committed transcript under /theme (incl. colorblind/high-contrast).
// (Historically Claude's warm brand orange, now og's `accent` value.)
const CLAUDE_ORANGE = '#d97757'; // fallback only — prefer C.accent at render time
// The activity label shown beside the spinner while a turn runs. One brand-consistent word
// ('Shadowing…') instead of a rotating grab-bag of generic verbs. A CUSTOM per-action label (a tool
// or the app setting a contextual verb) can override it in future; there is no such source today.
const DEFAULT_STATUS_VERB = 'Shadowing';
// Bracketed-paste markers moved to src/tui/keys/reserved.ts (P3-01 focus-owner router).


export type QueuedTask = {
  text: string;
  /** Human messages steer the active agent; commands and scheduled wakeups wait for turn-end. */
  kind: 'steer' | 'deferred';
};
// queuedTaskKind moved to src/tui/keys/common.ts (P3-01 — the key router owns submit-classification).


/** Informational slash commands safe to run mid-turn without interrupting the agent. */
// SLASH_WHILE_RUNNING moved to src/tui/keys/composerOwner.ts (P3-01 focus-owner router).

/** Resolve the active model's effective endpoint and whether it is a self-hosted target. */
function activeModelTarget(
  cfg: ShadowConfig,
  current: { provider: string; model: string },
  runtimeBaseUrl?: string,
  runtimeSelfHosted?: boolean,
): { baseUrl: string | undefined; selfHosted: boolean } {
  const entry = (cfg.models ?? []).find(
    (m) => !m.disabled && m.provider === current.provider && m.model === current.model,
  );
  const baseUrl =
    runtimeBaseUrl ??
    resolveBaseUrl(
      current.provider,
      entry?.baseUrl ?? (cfg.provider === current.provider ? cfg.baseUrl : undefined),
    );
  return {
    baseUrl,
    selfHosted:
      current.provider === 'openai' &&
      (runtimeSelfHosted ??
        ((runtimeBaseUrl === undefined &&
          (entry?.selfHosted === true ||
            (cfg.provider === current.provider &&
              cfg.model === current.model &&
              cfg.selfHosted === true))) ||
          isLocalModelTarget({
            // A generated/runtime URL identifies the provider object that is actually live. Do not
            // borrow local-file flags from the first same-name preset: duplicate provider/model
            // pairs can legitimately point at different endpoints.
            gguf: runtimeBaseUrl === undefined ? entry?.gguf : undefined,
            mlx: runtimeBaseUrl === undefined ? entry?.mlx : undefined,
            vllm: runtimeBaseUrl === undefined ? entry?.vllm : undefined,
            baseUrl,
          }))),
  };
}

/** Human-readable elapsed time: `8s`, `2m 5s`, `1h 3m 12s` (the HUD "working…" timer). */
function formatDuration(totalSec: number): string {
  if (totalSec < 60) return `${totalSec}s`;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}


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

// dialogArmMs moved to src/tui/keys/reserved.ts (P3-01 focus-owner router).


export interface TuiOpts {
  provider: Provider;
  /** Effective endpoint backing `provider` (including a managed local server's generated port). */
  activeBaseUrl?: string;
  /** Runtime classification for `provider`; needed for explicitly self-hosted public endpoints. */
  activeSelfHosted?: boolean;
  registry: ToolRegistry;
  bus: EventBus;
  context: Context;
  sessionLog: SessionLog;
  /**
   * P2-11 (/fork): shared mutable holder for the live log, owned by the host (index.ts). The
   * host's long-lived writers (the bus→recordEvent subscriber, the sub-agent loop-deps factory,
   * the wakeup rate-limit recorder) read through it, and /fork re-points it at the fork so those
   * writers follow the swap. Absent on standalone/test mounts, where a local ref suffices.
   */
  sessionLogBox?: { current: SessionLog };
  forceConfirm?: (call: ToolCall, risk: string) => string | null;
  system: string;
  workspaceRoot: string;
  cfg: ShadowConfig;
  baseContextPolicy?: { contextBudget: number; triggerRatio: number; keepLastTurns: number };
  autonomy: AutonomyLevel;
  bypass: boolean; // --yolo
  offline?: boolean; // --offline (Offline Shadow Mode)
  /** F06-09: resolves when the background MCP connect settles — the "mcp: connecting…" chip
   *  shows until then. Late registration is safe (tools resolve by name at call time), so this
   *  is a status surface only, never a gate. */
  mcpPending?: Promise<void>;
  version: string;
  styleState?: TuiStyleState;
  todoList?: TodoList;
  planMode?: PlanModeState;
  /** Session /goal mission — drives the pinned HUD row and the /goal slash trio. */
  mission?: MissionState;
  /** bg sub-agent results drained into the NEXT user turn (index.ts attachBgAgentDelivery). */
  pendingNotifications?: { drain(): string[]; size(): number };
  wakeupHandler?: { fire: (task: string, reason: string) => void };
  /** Extra granted roots (--add-dir / additionalDirectories) — widens jail + shell sandbox. */
  additionalRoots?: string[];
  /**
   * Called whenever autonomy changes (Tab ring, `/autonomy`, an approval-dialog `a`; a
   * Shift+Tab or /plan exit from plan mode lands here at `manual`).
   * Without it the process-level binding stayed at its STARTUP value, so a sub-agent spawned
   * after the user dropped to `manual` was still constructed at the startup level — directly
   * contradicting AgentToolDeps' own claim that a sub-agent "inherits it, never escalates".
   */
  onAutonomyChange?: (level: AutonomyLevel) => void;
  /** Called on a live /model switch so the `agent` tool spawns sub-agents on the NEW model,
   *  not the startup one (which, on a single-model-at-a-time local box, may be an unloaded port). */
  onModelSwitch?: (provider: Provider, model: string) => void;
  /** Publish the TUI's live turn-abort getter to the caller (main()), so the `shadow --web`
   *  mirror can interrupt the terminal's turn from the browser. Called once at mount. */
  setAbortGetter?: (fn: () => AbortController | null) => void;
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

/**
 * A single transcript entry, de-boxed: plain scrolling text like the reference client, no
 * per-message border. The "you/assistant/tool" header label that the old bordered
 * card carried is gone, so a tool/denial row folds its tool name (meta) inline.
 */
/** Inline run: bold / italic / inline-code spans rendered within one line. */
/** Terminal answer to a DSR cursor-position query (CSI 6n). Ink strips a chunk-leading ESC. */
const DSR_REPLY = /\x1b?\[(\d+);(\d+)R/;
// DSR_REPLY_EXACT / HOME_KEYS / END_KEYS / FORWARD_DELETE / SHIFT_ENTER moved to the
// The key object a real '\r' carries (parse-keypress: name 'return', use-input: the `return`
// flag) — the synthetic Enter dispatched after a batched-text replay in onKey.
const SYNTH_RETURN_KEY = { return: true, name: 'return', sequence: '\r' } as unknown as import('ink').Key;

// focus-owner router (src/tui/keys/reserved.ts + composerOwner.ts, P3-01). DSR_REPLY stays —
// the raw click tap still parses the cursor-position report itself.
/** Collaboration Mode: the baton is always this warm orange (Shadow's brand ⏺ color) — never a seat color. */
const BATON_ORANGE = '#d97757';


/** Large tool/diff output and reasoning are collapsible; everything else renders full.
 *  Collapsible items START collapsed; Ctrl-O expands ALL. Threshold lives in flatten.ts so the
 *  renderer and the classifier never drift (was 3 here / 8 in flattenTranscript). */
function isCollapsible(item: TranscriptItem): boolean {
  return itemIsCollapsible(item);
}

/**
 * Cap a multi-line tool body before it enters the transcript. Prefer the TAIL (shell logs,
 * test runners) — the end is usually the signal. A head notice records how many lines were
 * dropped so the fold count still reads honestly after expand.
 */
const MAX_TRANSCRIPT_BODY_LINES = 200;
function capTranscriptBody(rawLines: string[]): string[] {
  if (rawLines.length <= MAX_TRANSCRIPT_BODY_LINES) return rawLines;
  const omitted = rawLines.length - MAX_TRANSCRIPT_BODY_LINES;
  return [`… ${omitted} earlier lines omitted …`, ...rawLines.slice(-MAX_TRANSCRIPT_BODY_LINES)];
}


// DiffPanel removed — diffs now render as a single collapsible transcript item
// (see the tool_end handler); no separate always-expanded live panel to flood the view.

// ── Main TUI component ────────────────────────────────────────────────────────
export function TuiApp({ opts }: { opts: TuiOpts }) {
  const { exit } = useApp();
  const { bus, context, sessionLog } = opts;
  // P2-11 (/fork): the session log is a MOUNT-TIME prop, but /fork must swap the live log to a
  // new session id without remounting the app. Every read/write goes through this ref; /fork
  // points it at the forked SessionLog and the next loop/banner/status reads pick it up.
  // The ref object itself is stable, so it replaces `sessionLog` in useCallback dep arrays.
  // When the host passes a SHARED `sessionLogBox` we alias it, so the long-lived writers that
  // live in the host (bus→recordEvent, sub-agent loop deps, wakeup recorder) track the /fork
  // swap too — otherwise events after a fork would keep landing in the SOURCE transcript.
  const localSessionLogRef = useRef(sessionLog);
  const sessionLogRef = opts.sessionLogBox ?? localSessionLogRef;
  const [style, setStyle] = useState<OutputStyle>(opts.styleState?.style ?? opts.cfg.lastStyle ?? 'proactive');

  const terminalSize = useTerminalSize();
  const [committed, setCommitted] = useState<TranscriptItem[]>([]);
  // (No live-banner state: the welcome card commits to <Static> once at startup — see showBanner.)
  const [showAllExpanded, setShowAllExpanded] = useState(false); // Ctrl-O: reveal ALL collapsible blocks
  /** Per-item expands (Alt/Option+O on the latest). Cleared when Ctrl-O collapses/expands all. */
  const [expandedIds, setExpandedIds] = useState<Set<number>>(() => new Set());
  const [stream, setStream] = useState('');
  const [think, setThink] = useState(''); // live extended-reasoning text (dim, cleared per step)
  // Uncommitted tail of the streaming answer: completed markdown blocks are flushed to
  // <Static> as they finish (see the 'text' event), leaving only this in-progress block
  // in `stream` so the live region — and the composer below it — never grows with the answer.
  const streamBufRef = useRef('');
  // Completed-but-uncommitted answer blocks (perf): pushLine() per streamed unit re-rendered the
  // app once per line while a fast model landed dozens per second, defeating the 30ms delta
  // throttle below. Units queue here and drain (a) on the flush tick and (b) at the TOP of every
  // pushLine — so a tool row, a repetition marker, or turn-end can never land ABOVE a queued
  // answer block. absorb/dedup still runs synchronously per unit at ENQUEUE time (marker order
  // unchanged); only the state update is deferred ≤30ms.
  const pendingUnitsRef = useRef<{ text: string; tight: boolean }[]>([]);
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
  /** Wall-clock start of the current reasoning stream (first thinking delta) — for `thought for Ns`. */
  const thinkStartedAtRef = useRef<number | null>(null);
  const pendingStreamRef = useRef<string | null>(null);
  const pendingThinkRef = useRef<string | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      drainUnitsRef.current?.(); // queued answer blocks land in the SAME render as the live tail
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
  // Perf: chatty shell commands emit hundreds of chunks/sec; one setState per chunk re-rendered
  // the live region PER CHUNK. Chunks now accumulate raw into shellRawRef and state updates at
  // most every SHELL_FLUSH_MS — the first chunk of a burst paints immediately (no perceived
  // latency), the rest coalesce. The flush sanitizes the FULL accumulated text (not per chunk),
  // so an escape sequence split across chunk boundaries reassembles instead of degrading to
  // literal bytes — strictly better than the old per-chunk merge.
  const SHELL_FLUSH_MS = 50;
  const shellRawRef = useRef('');
  const shellDirtyRef = useRef(false);
  const shellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shellFlush = useCallback(() => {
    const merged = sanitizeTerminalEscapes(shellRawRef.current, true).slice(-2000);
    const last = merged.split('\n').reverse().find((l) => l.trim() !== '');
    setToolLine(last ? `  ⚙ ${last.trim().slice(0, 160)}` : null);
  }, []);
  const shellClear = useCallback(() => {
    shellRawRef.current = '';
    shellDirtyRef.current = false;
    if (shellTimerRef.current) {
      clearTimeout(shellTimerRef.current);
      shellTimerRef.current = null;
    }
  }, []);
  // Every "the preview is over" path goes through this (new tool, tool_end, blocked, retry, stop,
  // /clear via the slash bridge) — clearing state without draining the refs would let a still-
  // armed flush timer resurrect the stale preview ~50ms later.
  const clearToolLine = useCallback(() => {
    shellClear();
    setToolLine(null);
  }, [shellClear]);
  useEffect(() => () => void (shellTimerRef.current && clearTimeout(shellTimerRef.current)), []);
  useEffect(() => () => void (toastTimerRef.current && clearTimeout(toastTimerRef.current)), []);
  // The tool currently executing — rendered as a persistent live ⏺ Name(args) row that appears the
  // instant the call starts and resolves in place (into the committed green/red ⏺ row) on tool_end.
  const [activeTool, setActiveTool] = useState<{ name: string; arg: string; agent?: { subagentType?: string; description?: string } } | null>(null);
  // Sub-agent visibility (BUG 3): live delegated agents keyed by taskId. Populated from
  // SUBAGENT_START/SUBAGENT_END lifecycle events emitted by the agent tool, and from the TAGGED
  // tool_start/tool_end forwarded events (SubagentBus.meta) for each agent's current activity.
  // Rendered as a distinct "Running N agents" panel so a sub-agent never hijacks the parent's own
  // activeTool row. Map stays immutable (every update returns a fresh Map) so Ink re-renders.
  const [subAgents, setSubAgents] = useState<Map<string, SubAgentView>>(new Map());
  // Fresh snapshot of the sub-agent map for one-shot bus handlers (the bus effect registers ONCE,
  // so it must not read the captured `subAgents` state — that would be stale forever).
  const subAgentsRef = useRef(subAgents);
  subAgentsRef.current = subAgents;
  // T1: transient toast (copy/paste/theme/style/autonomy acks) — a single row that NEVER reaches
  // the committed transcript. Replaces itself and expires after TOAST_TTL_MS. Ref-mirrored so
  // async callbacks (the clipboard read resolves later) and key handlers can fire it.
  const [toast, setToast] = useState<{ text: string; kind: ToastKind } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref mirror of the toast so showToast can tell whether fitHud ALREADY budgeted a toast row
  // (if one is on screen, replacing it costs zero extra rows — otherwise we'd add 1 and
  // double-count, wrongly falling back to pushLine inside the 3.2s replace window).
  const toastRef = useRef<{ text: string; kind: ToastKind } | null>(null);
  toastRef.current = toast;
  // The last fitHud result — showToast uses it to decide PRECISELY whether the HUD's priority
  // ladder would accept one more row (the toast is 1 row; the ladder grants it iff headroom
  // remains). Updated during render below.
  const lastHudFitRef = useRef<HudFit | null>(null);
  // Ref mirror of the terminal size for the same async-safe reason (showToast fires from async
  // clipboard reads, long after the render that produced the size).
  const terminalSizeRef = useRef(terminalSize);
  // F06-09: MCP servers connect in the background so first paint is never gated on them. This
  // flag drives the transient "mcp: connecting…" chip; it clears the moment the settle promise
  // resolves (success OR failure — per-server failures already warn on stderr).
  const [mcpConnecting, setMcpConnecting] = useState(opts.mcpPending != null);
  useEffect(() => {
    if (!opts.mcpPending) return;
    let alive = true;
    const clear = (): void => {
      if (alive) setMcpConnecting(false);
    };
    opts.mcpPending.then(clear, clear);
    return () => {
      alive = false;
    };
  }, []);
  // Mid-turn recon burst (read/grep/glob…): counts accumulate so the live row reads
  // "Reading 3 files, Grepping 1 pattern · path" instead of flashing every single call.
  // Cleared when a signal tool (edit/shell/…) starts or the turn ends.
  const [liveRecon, setLiveRecon] = useState<{ kinds: Partial<Record<CollapseKind, number>>; hint?: string } | null>(null);
  const [shellPid, setShellPid] = useState<number | null>(null); // active run_shell child, for the HUD
  const [shellWarn, setShellWarn] = useState<string | null>(null); // set when that child may survive ESC
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('0 tokens');
  const [pending, setPending] = useState<ApprovalRequest | null>(null);
  /** When the current dialog became visible — the type-ahead guard's reference point (onKey §1). */
  const dialogShownAtRef = useRef(0);
  /** Once dialog-opening interrupts typed text, printable keys stay with the composer until the
   * user explicitly re-focuses the dialog with a non-printable key. */
  const dialogTypeaheadRef = useRef(false);
  /** Session-lifetime "approve for session/prefix" grants, shared by every per-message AgentLoop. */
  const sessionApprovalsRef = useRef(new SessionApprovals());
  const [questionIndex, setQuestionIndexState] = useState(0);
  const [questionSelections, setQuestionSelectionsState] = useState<QuestionSelection>({});
  const [questionCursor, setQuestionCursorState] = useState<Record<number, number>>({}); // highlighted option per question
  const [autoAnswerSecs, setAutoAnswerSecs] = useState<number | null>(null); // idle countdown to auto-pick recommended
  const [autonomy, setAutonomyState] = useState<AutonomyLevel>(opts.autonomy);
  const [effort, setEffortState] = useState<Effort>(effortOrDefault(opts.cfg.effort));
  const [todoItems, setTodoItems] = useState<TodoItem[]>([]);
  const todoItemsRef = useRef<TodoItem[]>([]);
  todoItemsRef.current = todoItems;
  const [planMode, setPlanMode] = useState<PlanSnapshot>(opts.planMode?.snapshot() ?? { mode: 'implement' });
  // /goal mission state: the session-scoped MissionState is the truth; this snapshot
  // mirrors its bus events for render. `goal` stays as the one-line HUD text (missionHudLine)
  // so the layout's hasGoal accounting keeps meaning exactly one pinned row.
  const [missionSnap, setMissionSnap] = useState<MissionSnapshot | null>(opts.mission?.snapshot() ?? null);
  const [tick, setTick] = useState(0);
  const runStartRef = useRef(0); // wall-clock start of the current turn, for the elapsed timer
  const [menuIndex, setMenuIndex] = useState(0); // selected row in the slash-command menu
  const [cursor, setCursor] = useState(0); // caret position within the composer input
  const [current, setCurrent] = useState({ provider: opts.cfg.provider, model: opts.cfg.model }); // live model (for the footer + /model)
  // Collaboration Mode (experimental): the active round-table (null = normal single-model session).
  const [table, setTable] = useState<{ seats: Seat[] } | null>(null);
  const tableRef = useRef<{ seats: Seat[] } | null>(null);
  tableRef.current = table;
  const speakerRef = useRef<SpeakerTag | null>(null); // seat that currently holds the baton (tags its turns)
  const preTableRef = useRef<{
    client: Provider;
    provider: ProviderName;
    model: string;
    target: { baseUrl?: string; selfHosted: boolean };
    policy: ReturnType<Context['policy']>;
  } | null>(null);
  const routeInFlightRef = useRef(false); // a seat route is building/running — block a second concurrent route
  const [pickerOpen, setPickerOpen] = useState(false); // model-picker has focus
  const [pickerIndex, setPickerIndex] = useState(0); // selected row in the model picker
  // Pending input remains FIFO, but human messages now STEER the active loop: model-side work is
  // cancelled immediately and the message starts at the next safe boundary. Commands and wakeups
  // remain deferred until turn-end. `queued` mirrors the ref for the live pending indicator.
  const queuedTasksRef = useRef<QueuedTask[]>([]);
  const [queued, setQueuedState] = useState<QueuedTask[]>([]);
  const setQueued = useCallback((next: QueuedTask[]) => {
    queuedTasksRef.current = next;
    setQueuedState(next);
  }, []);
  // Default COLLAPSED: one-line chrome summary; Ctrl-T expands the full list (redesign: accordion dies).
  const [todoCollapsed, setTodoCollapsed] = useState(true);
  // The transcript is an Ink <Static> that owns the terminal's NATIVE scrollback
  // (mouse-wheel / scrollbar work, reference-client style). `staticEpoch` is bumped to
  // force a re-flush when committed items must repaint (Ctrl-O collapse, /clear).
  const [staticEpoch, setStaticEpoch] = useState(0);
  // ── Reflow (Static remount when committed rows must repaint) ─────────────────
  // Ink <Static> paints each item once; toggling collapse needs a remount (epoch bump).
  //   soft — clear the VISIBLE screen only (2J+H). Keeps native scrollback so PgUp history
  //          survives Ctrl-O. May leave one stale pre-fold copy above the re-emit — rare and
  //          user-initiated; far less of a flashbang than wiping the whole scrollback.
  //   hard — also wipe scrollback (2J+3J+H). Used by app:redraw (explicit Ctrl+L), where a ghost
  //          composer or stacked rewrap must be scrubbed on demand. Startup already cleared
  //          pre-launch history. RESIZE deliberately never reflows — see below (P3-03).
  const reflow = useCallback((mode: 'soft' | 'hard' = 'hard') => {
    const out = process.stdout;
    if (out.isTTY) out.write(reflowSequence(mode));
    setStaticEpoch((n) => n + 1);
  }, []);
  // Ctrl-T only mutates LIVE chrome (PinnedState / one-line summary) — never the committed
  // Static transcript — so it must NOT reflow. A reflow on every task-list toggle was wiping
  // the screen for a pure live-height change.
  //
  // RESIZE → deliberately NO reflow (P3-03). When COLUMNS change, the terminal NATIVELY rewraps
  // the already-printed <Static> scrollback to the new width — the committed history reflows
  // in place, so re-emitting it (epoch bump) would stack a second copy over the rewrapped one
  // and wiping it (3J) would destroy it: the old resize bug was exactly that hard reflow
  // wiping scrollback mid-stream. Rows-only resize never rewraps text at all, so it needs
  // nothing. The setSize re-render repaints the live HUD/composer below. Known tradeoff: when
  // NARROWING, the terminal reflows the last live frame's printed rows too, so Ink's tracked
  // frame height goes stale and a few ghost rows can persist ABOVE the live region — they do
  // not self-heal (later renders only erase the tracked height). Recovery is any explicit
  // repaint: Ctrl-O/Ctrl-T soft reflow, app:redraw (opt-in ctrl+l binding), or /clear. That is
  // strictly cheaper than the old behavior, which destroyed the entire scrollback on every
  // resize including pure rows changes.
  const lastUsageRef = useRef<{ inputTokens: number; outputTokens: number; costUSD: number; contextPct: number } | null>(null);
  const costWarnedRef = useRef(false);
  // Session-level cost accumulation. The per-turn Budget resets each turn, so we
  // sum deltas across turns: prevTurnCost holds the last seen costUSD within the
  // current turn (reset at turn start) so per-turn increases are counted once.
  const sessionCostRef = useRef(0);
  const prevTurnCostRef = useRef(0);
  // Session-level TOKEN accumulation (P1B-03), by the same delta method as cost: the per-turn
  // Budget resets each turn, so sum incremental in/out tokens across turns (prevTurn* reset at turn
  // start). Sub-agent tokens accrue here too via subagent_usage. This is the real SESSION total —
  // lastUsageRef is only the LAST TURN, which /cost used to mislabel "(session)".
  const sessionInTokRef = useRef(0);
  const sessionOutTokRef = useRef(0);
  const prevTurnInTokRef = useRef(0);
  const prevTurnOutTokRef = useRef(0);
  const sessionTurnsRef = useRef(0);

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
  /**
   * Manual /compact in flight. Compaction REWRITES the shared Context, and the composer stayed
   * live throughout — so a message submitted mid-compaction started a turn that read the context
   * while it was being rebuilt. The lock closes that window; the controller makes Esc mean
   * something (context.maybeSummarize has always accepted a signal — the TUI just never passed
   * one, so its own comment "ESC must be able to stop a compaction" was untrue here).
   */
  const compactingRef = useRef(false);
  const compactAbortRef = useRef<AbortController | null>(null);
  /** Long-running slash work that probes providers but does not own an AgentLoop/run lock. */
  const asyncCommandRef = useRef(false);

  /**
   * Rewindable snapshot turns (F08-07: with each turn's prompt), refreshed when a turn ends.
   * Read from the session log rather than counted in the UI, so the /rewind menu is always in
   * the same unit rewindToTurn consumes.
   */
  const rewindableTurnsRef = useRef<RewindableTurn[]>([]);
  /** Last (path, log size) the ref above was refreshed for — only re-read the log when a new
   *  snapshot actually landed (or the session changed), never once per turn unconditionally. */
  const rewindSeenRef = useRef<{ path: string; size: number } | null>(null);
  /**
   * Sync rewindableTurnsRef with the CURRENT session log. Called at turn end and after anything
   * that moves the lineage (/resume, /fork, /clear, /rewind). The gate keys on path + file SIZE
   * rather than countSnapshots (= max snapshot turn + 1): a same-turn snapshot APPEND — rewind
   * durability, /resume re-seeding turn 0 — does not move the max turn but must still re-list.
   * listRewindableTurns is incremental, so the reparse costs only the bytes appended since.
   */
  const refreshRewindTurns = (): void => {
    try {
      const rwPath = sessionLogRef.current?.path;
      if (!rwPath) {
        rewindableTurnsRef.current = [];
        rewindSeenRef.current = null;
        return;
      }
      let size = -1;
      try {
        size = statSync(rwPath).size;
      } catch {
        return; // unreadable — keep whatever list we had
      }
      const seen = rewindSeenRef.current;
      if (!seen || seen.path !== rwPath || seen.size !== size) {
        rewindSeenRef.current = { path: rwPath, size };
        rewindableTurnsRef.current = listRewindableTurns(rwPath);
      }
    } catch {
      /* an unreadable log must never break the caller */
    }
  };

  /**
   * Repaint the visible transcript from the loaded context.
   *
   * `/resume` and `/rewind` replaced the model's context but left the SCREEN showing the previous
   * conversation, so the transcript and the model disagreed about what had been said — with no
   * indication which one was real. This replays the context that is actually in force: user and
   * assistant text, with tool traffic summarized (the tool results are in context, but re-rendering
   * their full output would flood the screen and is not what the user is checking).
   */
  const repaintFromContextRef = useRef<(() => void) | null>(null);

  /** Forward reference to pushLine, which is defined below this hook. */
  const pushLineRef = useRef<((l: Omit<TranscriptItem, 'id' | 'kind'> & { kind?: TranscriptItem['kind'] }) => void) | null>(null);
  // Drain of pendingUnitsRef — a ref (assigned after pushLine exists) so pushLine can empty the
  // queue above itself without a circular definition.
  const drainUnitsRef = useRef<(() => void) | null>(null);
  const absorbAssistant = useCallback((text: string): boolean => {
    const r = repeatStep(answerRunRef.current, repeatPosRef.current, dupKey(text));
    answerRunRef.current = r.run;
    repeatPosRef.current = r.pos;
    // A suppressed block leaves a mark. The detector cannot distinguish "the model restarted its
    // answer" from "this paragraph legitimately appears twice", so dropping one without a trace
    // meant the transcript quietly disagreed with what the model actually said. One dim line per
    // RUN (pos <= 1 is the run's start) keeps it honest without narrating every collapsed block.
    if (r.suppress && r.pos <= 1) {
      pushLineRef.current?.({ text: '  ⋮ identical block repeated — collapsed', dimColor: true });
    }
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
  /**
   * Latched the moment the user touches a question dialog. The countdown used to RESTART on every
   * key, which is not the same thing: a user who engaged and then stepped away mid-decision still
   * had an answer submitted for them, overwriting selections they were in the middle of making.
   * Engagement means "a human is handling this" — the idle timer's whole premise is gone.
   */
  const autoAnswerEngagedRef = useRef(false);
  const inputRef = useRef(input);
  const firstRef = useRef(true);
  const controllerRef = useRef<AbortController | null>(null);
  const loopRef = useRef<AgentLoop | null>(null);
  // Last completed run's stop reason — feeds the next loop's priorStopReason so an empty-response
  // failure right after a max_tokens stop is diagnosed as a starved output budget (P1A-08).
  const lastStopReasonRef = useRef<StopReasonExt | undefined>(undefined);
  // Hand main() a getter for the live turn controller so `shadow --web` can interrupt the
  // terminal's turn from the browser. controllerRef is stable; the closure always reads live.
  // On unmount, abandon any in-flight turn's run lock: in production the TUI unmounts only at
  // exit (harmless), and it keeps a torn-down instance from starving the process-wide lock (a
  // turn whose loop can no longer complete would otherwise hold it forever). The turn's own
  // finally release is then a no-op — the grant token no longer matches.
  useEffect(() => {
    opts.setAbortGetter?.(() => controllerRef.current);
    return () => {
      controllerRef.current?.abort();
      runLock.releaseFor(CLI_HOLDER);
    };
  }, [opts]);
  /** The shared "press again to quit" latch, armed by Ctrl-C or Ctrl-D on an empty composer. */
  const ctrlCArmedRef = useRef(false);
  const historyRef = useRef<string[]>([]);
  const histIdxRef = useRef(0);
  /** The unsent draft, parked when ↑ steps into history so ↓ can bring it back. */
  const draftRef = useRef('');
  const menuIndexRef = useRef(0);
  const cursorRef = useRef(0);
  // Goal-column memory for a run of ↑/↓ keys (readline): the column the run started from, cleared
  // by any other key (composerOwner §6) or caret move (moveCaret — click, motion, edit).
  const goalColRef = useRef<number | null>(null);
  // Rows rendered BELOW the composer input's last line (bottom rule + hint + custom-status),
  // refreshed each render so the click-to-caret handler can map a screen Y to a draft row without
  // guessing. -1 means "a menu/overlay is open below the composer" → don't place a caret from a click.
  const belowComposerRef = useRef(1);
  // Big pastes are condensed to a `[Pasted text #N]` chip in the composer; the real content lives
  // here (session registry, kept for the whole session so a history re-run still resolves the chip)
  // and is spliced back in at submit via expandPastes.
  const pastesRef = useRef<{ id: number; content: string; lines: number }[]>([]);
  const pasteCounterRef = useRef(0);
  // Bracketed paste (mode 2004): between the \x1b[200~ … \x1b[201~ markers every input chunk
  // is BUFFERED here and inserted atomically at the end — embedded newlines can't submit
  // mid-paste and pasted Esc/Tab bytes can't fire their key handlers.
  const pastingRef = useRef(false);
  const pasteBufRef = useRef('');
  // Active model — `providerRef` is the live Provider OBJECT the next turn runs on;
  // `currentRef` mirrors the displayed {provider, model} NAMES for the key handler.
  const providerRef = useRef(opts.provider);
  const currentRef = useRef(current);
  // Runtime endpoint truth. A managed gguf/MLX/vLLM server chooses its loopback URL/port while
  // launching; the model preset often has no baseUrl at all, so re-resolving config in /provider
  // would misleadingly show OPENAI_BASE_URL or "provider default". Model builds update this ref.
  const initialTarget = activeModelTarget(
    opts.cfg,
    current,
    opts.activeBaseUrl,
    opts.activeSelfHosted,
  );
  const activeTargetRef = useRef<{ baseUrl?: string; selfHosted: boolean }>({
    baseUrl: initialTarget.baseUrl,
    selfHosted: initialTarget.selfHosted,
  });
  // The session's ORIGINAL context budget — /model switches to a gguf clamp under its window,
  // and switching back to a cloud model restores this (see selectModel).
  const baseContextPolicyRef = useRef(
    opts.baseContextPolicy ?? {
      contextBudget: opts.cfg.contextBudget,
      triggerRatio: opts.cfg.summarizeTriggerRatio,
      keepLastTurns: opts.cfg.keepLastTurns,
    },
  );
  const modelSwitchSeqRef = useRef(0);
  const modelSwitchingRef = useRef(false);
  const pickerOpenRef = useRef(false);
  const pickerIndexRef = useRef(0);
  const styleRef = useRef(style);
  const runOneRef = useRef<((task: string) => void) | null>(null);
  const selectModelRef = useRef<((entry: ModelEntry) => Promise<void>) | null>(null);
  const buildProviderRef = useRef<((entry: ModelEntry, opts?: { clampBudget?: boolean; applyPolicy?: () => boolean }) => Promise<
    | { ok: true; client: Provider; provider: ProviderName; model: string; baseUrl?: string; selfHosted: boolean }
    | { ok: false; error: string; fatal?: boolean }
  >) | null>(null);
  const handleTableInputRef = useRef<((raw: string) => void) | null>(null);
  const startTableRef = useRef<((arg: string) => void) | null>(null);
  const flushQueueRef = useRef<(() => void) | null>(null);
  // startTurn is defined below but runSlash (above it) needs it for custom-command dispatch (F10-07).
  const startTurnRef = useRef<((task: string) => void) | null>(null);
  // F10-07: custom slash commands loaded from .shadow/commands / .claude/commands (workspace + ~).
  // Builtins always win — a repo can't shadow /clear etc. Loaded once at mount; refreshed on /clear.
  const customCommandsRef = useRef<SlashCommand[]>([]);
  const customCommandsLoadedRef = useRef(false);
  // F08-04: cached workspace file list for @-mention completion. Walked lazily on first @ use (a
  // big repo walk shouldn't tax startup) and reused for the session; refreshed on /clear.
  const fileListRef = useRef<string[]>([]);
  const fileListLoadedRef = useRef(false);
  const ensureFileList = useCallback((): string[] => {
    if (!fileListLoadedRef.current) {
      fileListLoadedRef.current = true;
      try { fileListRef.current = walkWorkspaceFiles(opts.workspaceRoot); } catch { fileListRef.current = []; }
    }
    return fileListRef.current;
  }, [opts.workspaceRoot]);
  const loadCustomCommands = useCallback(() => {
    try {
      const builtin = new Set(SLASH_COMMANDS.map((c) => c.name));
      customCommandsRef.current = discoverCustomCommands(opts.workspaceRoot, homedir())
        .filter((c) => !builtin.has(`/${c.name}`))
        .map((c) => ({ name: `/${c.name}`, desc: c.description, custom: { body: c.body } }));
    } catch {
      customCommandsRef.current = [];
    }
  }, [opts.workspaceRoot]);
  if (!customCommandsLoadedRef.current) {
    customCommandsLoadedRef.current = true;
    loadCustomCommands();
  }
  const missionRef = useRef<MissionSnapshot | null>(null); // live mission snapshot for slash/turn seams
  // Extra granted roots, mutable at runtime via /add-dir (seeded from startup config/--add-dir).
  // The loop deps re-read this ref each turn, so a grant takes effect on the next turn.
  const additionalRootsRef = useRef<string[]>([...(opts.additionalRoots ?? [])]);
  // Force-repaint counter for /theme (the palette is a mutated singleton, not React state).
  const [, setThemeTick] = useState(0);
  // Custom footer line from /statusline: the shell command (ref) and its latest output (state).
  const statusLineRef = useRef<string>(typeof opts.cfg.statusLine === 'string' ? opts.cfg.statusLine : '');
  const statusLineGenerationRef = useRef(0);
  const [customStatus, setCustomStatus] = useState('');
  // Vim modal editing (/vim). Refs drive the key handler; state drives the footer indicator.
  const vimEnabledRef = useRef<boolean>(opts.cfg.vimMode === true);
  const [vimEnabled, setVimEnabled] = useState<boolean>(opts.cfg.vimMode === true);
  const vimModeRef = useRef<VimMode>('insert'); // start in INSERT so typing works immediately
  const [vimModeState, setVimModeState] = useState<VimMode>('insert');
  const vimPendingRef = useRef(''); // operator awaiting a motion (d/c/y/r) or a find target (f/F/t/T)
  const vimFindRef = useRef<VimFind | null>(null); // last f/F/t/T — ; repeats, , repeats backwards
  const vimCountRef = useRef(0); // numeric prefix being typed (0 = none)
  const vimRegRef = useRef(''); // unnamed register: last yank/delete, pasted by p/P
  // Click-to-place-caret. OFF unless explicitly opted in — enabling mouse reporting takes the
  // WHEEL away from the terminal, and native scrollback is not negotiable here. Opt in per-run
  // with SHADOW_MOUSE=1 (or `"mouse": true` in config); there is deliberately no slash command,
  // because a toggle invites exactly the "why is my scrolling broken" state this caused.
  const mouseInitial = process.env.SHADOW_MOUSE === '1' || opts.cfg.mouse === true;
  const mouseEnabledRef = useRef<boolean>(mouseInitial);
  const [mouseEnabled] = useState<boolean>(mouseInitial); // fixed at mount — no runtime toggle by design
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
  missionRef.current = missionSnap;
  const goal = missionHudLine(missionSnap); // ONE pinned row, same slot the standing goal used

  // Set the composer text and move the caret to the end (history nav, autocomplete, clear).
  const setLine = useCallback((v: string) => {
    inputRef.current = v;
    cursorRef.current = v.length;
    setInput(v);
    setCursor(v.length);
  }, []);

  /**
   * Reverse history search (Ctrl+R). Null when closed. The composer keeps showing the current
   * HIT while this is open — typing narrows, Ctrl+R again steps to the next older match, Enter
   * accepts it, Esc restores the draft that was there before the search opened.
   */
  const searchRef = useRef<HistorySearchState | null>(null);
  const [searchLine, setSearchLine] = useState<string | null>(null);
  const applySearch = useCallback(
    (st: HistorySearchState | null) => {
      searchRef.current = st;
      if (!st) {
        setSearchLine(null);
        return;
      }
      setSearchLine(historySearchPrompt(st, historyRef.current));
      setLine(st.index >= 0 ? (historyRef.current[st.index] ?? '') : '');
    },
    [setLine],
  );
  /**
   * Live values the DYNAMIC argument menus read (which session, which turn, which granted dir).
   * Refreshed each render and held in a ref so the key handler — which is not re-created per
   * render — always sees the current one.
   *
   * `sessions` is deliberately read from disk ONCE per mount: listResumableSessions opens every
   * session log in the workspace looking for a snapshot, and the menu re-filters on every
   * keystroke. The set only grows when a NEW session starts, which by definition is not this one.
   */
  const argCtxRef = useRef<ArgContext | null>(null);
  const resumableRef = useRef<{ id: string; label: string }[] | null>(null);
  if (resumableRef.current === null) {
    try {
      resumableRef.current = listResumableSessions(opts.workspaceRoot).map((s) => ({
        id: s.id,
        label: s.ts ? `Snapshot ${s.ts}` : s.path,
      }));
    } catch {
      resumableRef.current = []; // an unreadable session dir must never break the menu
    }
  }

  const setComposer = useCallback((nextInput: string, nextCursor: number) => {
    inputRef.current = nextInput;
    cursorRef.current = nextCursor;
    setInput(nextInput);
    setCursor(nextCursor);
  }, []);

  // ── Composer editing: kill ring + undo ──────────────────────────────────────
  // The kill ring is readline's single-slot clipboard: whatever Ctrl+W / Ctrl+U / Ctrl+K /
  // Option+Delete removed, ready for Ctrl+Y. Undo snapshots every DESTRUCTIVE edit (never plain
  // typing — a per-character stack would make Ctrl+Z useless), so an over-eager word delete costs
  // one keystroke to take back.
  const killRingRef = useRef('');
  const undoRef = useRef<{ text: string; cursor: number }[]>([]);
  const pushUndo = useCallback(() => {
    const top = undoRef.current[undoRef.current.length - 1];
    if (top && top.text === inputRef.current) return; // don't stack identical states
    undoRef.current.push({ text: inputRef.current, cursor: cursorRef.current });
    if (undoRef.current.length > 100) undoRef.current.shift();
  }, []);
  /** Apply an EditResult from the pure helpers: snapshot for undo, load the kill ring, commit. */
  const applyEdit = useCallback(
    (r: { text: string; cursor: number; killed: string }) => {
      if (r.killed === '' && r.text === inputRef.current) return; // no-op (caret at a buffer edge)
      pushUndo();
      if (r.killed) killRingRef.current = r.killed;
      setComposer(r.text, r.cursor);
      setMenuIndex(0);
    },
    [pushUndo, setComposer],
  );
  const moveCaret = useCallback((next: number) => {
    const c = Math.max(0, Math.min(inputRef.current.length, next));
    cursorRef.current = c;
    goalColRef.current = null; // caret moved outside vertical motion — a stale goal must not re-fire
    setCursor(c);
  }, []);

  // ── Click-to-place-caret ────────────────────────────────────────────────────
  // A click reports a TERMINAL cell (x, y); to turn that into a caret we need to know which screen
  // row the composer's first input line is on. The old code assumed the live frame is pinned to the
  // bottom of the terminal — true only once the transcript has scrolled the screen full, and wrong
  // for the whole first screenful (exactly when you type your first long prompt). So we ask the
  // terminal instead: Ink's log-update writes `frame + '\n'`, parking the cursor on the row directly
  // BELOW the frame, and a DSR query (CSI 6n) reports it. One round trip per click, resolved in the
  // raw tap below; if the terminal never answers we fall back to the bottom-anchored estimate.
  const pendingClickRef = useRef<{ x: number; y: number; token: number } | null>(null);
  const clickTokenRef = useRef(0);
  /** Turn a click at 1-based cell (x, y) into a caret, given the cursor's resting row (1-based). */
  const resolveClick = useCallback(
    (x: number, y: number, restingRow: number) => {
      const below = belowComposerRef.current;
      if (below < 0) return; // a menu/overlay owns the rows under the composer
      const cols = process.stdout.columns ?? 80;
      const rows = process.stdout.rows ?? 24;
      const inner = Math.max(8, cols - COMPOSER_GUTTER - PAGE_MARGIN * 2);
      const winMax = Math.max(1, Math.min(COMPOSER_MAX_VISIBLE_ROWS, rows - 3));
      const win = visibleComposerWindow(inputRef.current, cursorRef.current, inner, winMax);
      // restingRow = frameLastRow + 1; frameLastRow = lastInputRow + below (bottom rule + hint + custom)
      const lastInputRow = restingRow - 1 - below;
      const firstInputRow = lastInputRow - win.lines.length + 1;
      if (y < firstInputRow || y > lastInputRow) return; // clicked outside the input — not a caret move
      const localRow = y - firstInputRow;
      const localCol = Math.max(0, x - 1 - PAGE_MARGIN - COMPOSER_GUTTER);
      moveCaret(clickToCursor(inputRef.current, localRow, localCol, inner, win.offset));
    },
    [moveCaret],
  );
  const handleMouse = useCallback(
    (raw: string) => {
      if (!mouseEnabledRef.current) return;
      const ev = parseSgrMouse(raw);
      // Left-button PRESS only. Wheel (64/65), right/middle, drags and releases are ignored —
      // we take as little from the terminal as the protocol allows.
      if (!ev || !ev.press || ev.button !== 0) return;
      if (belowComposerRef.current < 0) return;
      const token = (clickTokenRef.current += 1);
      pendingClickRef.current = { x: ev.x, y: ev.y, token };
      process.stdout.write('\x1b[6n'); // DSR — answered as CSI row ; col R on stdin
      setTimeout(() => {
        const p = pendingClickRef.current;
        if (!p || p.token !== token) return; // already resolved by the DSR reply
        pendingClickRef.current = null;
        // No answer: assume the frame is bottom-anchored (cursor parked on the last row).
        resolveClick(p.x, p.y, process.stdout.rows ?? 24);
      }, 150);
    },
    [resolveClick],
  );

  // ── Raw keypress tap ────────────────────────────────────────────────────────
  // Ink's `key` object has no field for Home/End, and it collapses forward-delete (\x1b[3~) onto
  // the SAME `key.delete` as Backspace (\x7f) — so through useInput alone those keys are either
  // invisible or actively wrong (forward-delete deleting backwards). Ink emits every raw stdin
  // chunk on its internal input emitter before parsing it, so we tap that and keep the bytes for
  // the current keypress; the composer consults them only to disambiguate. Declared ABOVE the
  // useInput(onKey) call so this listener is registered FIRST and the ref is fresh inside onKey.
  const rawKeyRef = useRef('');
  // The WHOLE raw chunk (untrimmed). rawKeyRef holds only the last ESC-led sequence (F03-05) for
  // key disambiguation; the anchored DSR suppress in onKey must see the entire chunk so a cursor
  // report batched with typed text swallows ONLY the report, not the text typed alongside it.
  const rawChunkRef = useRef('');
  const { internal_eventEmitter: inkInputEvents, setRawMode } = useStdin();
  // F08-10: Ctrl-X arms the external-editor chord; the next Ctrl-E opens $EDITOR on the draft.
  const ctrlXArmedRef = useRef(false);
  useEffect(() => {
    if (!inkInputEvents) return;
    const onData = (d: unknown): void => {
      const raw = typeof d === 'string' ? d : String(d);
      // F03-05 — batched chunks. Ink dispatches the FIRST keypress of a merged stdin read and
      // drops the rest, and the composer's raw-sequence tests are ^…$ anchored — so against the
      // WHOLE batch they never matched and Home/End/forward-delete/Shift-Enter died whenever the
      // terminal coalesced them with a neighbour. Keep the LAST complete ESC-led sequence (split
      // on ESC boundaries) so the most recent key is the one the disambiguation tests see. The
      // DSR match below keeps the whole chunk: that reply regex is deliberately unanchored so a
      // position report batched with typed text still resolves the parked click.
      rawKeyRef.current = lastKeySequence(raw);
      rawChunkRef.current = raw; // the whole chunk, for the anchored DSR suppress in onKey
      // A cursor-position report answering our click DSR — resolve the parked click here, before
      // Ink's parser turns `[38;1R` into composer text (onKey drops it by the same test).
      const dsr = DSR_REPLY.exec(raw);
      if (dsr && pendingClickRef.current) {
        const p = pendingClickRef.current;
        pendingClickRef.current = null;
        resolveClick(p.x, p.y, Number(dsr[1]));
      }
    };
    inkInputEvents.on('input', onData);
    return () => {
      inkInputEvents.removeListener('input', onData);
    };
  }, [inkInputEvents, resolveClick]);

  // Insert text into the composer at the caret. Enormous blobs condense to a
  // `[Pasted text #N +M lines]` chip (content parked in pastesRef, spliced back at submit);
  // anything smaller inserts verbatim and stays editable. Newlines are already normalized
  // (\r\n and bare \r → \n) by every caller — macOS terminals paste line ends as \r, which
  // used to defeat the chip's line count and render as invisible garbage in the composer.
  const insertPastable = useCallback((rawText: string) => {
    // Strip escapes and stray C0 bytes, matching what the TYPED path already does. Bracketed paste
    // delivers whatever the clipboard holds verbatim: pasting terminal output (or a crafted blob)
    // put raw CSI/OSC bytes straight into the draft, where they corrupted the rendered composer,
    // broke width measurement, and were then sent to the provider. Tabs and newlines survive —
    // they are legitimate content in a paste.
    // stripCtl removes ESC-led sequences, but Ink strips a chunk-LEADING ESC before we see it, so a
    // stray paste-marker fragment can arrive as the bare text `[200~`/`[201~`. Drop those too so a
    // fragment can never land literally in the draft (P1A-14: paste markers are transport, not text).
    const text = stripCtl(rawText).replace(/\[20[01]~/g, '');
    const c = cursorRef.current;
    const s = inputRef.current;
    if (isBigPaste(text)) {
      const id = (pasteCounterRef.current += 1);
      const lines = (text.match(/\n/g)?.length ?? 0) + 1;
      pastesRef.current.push({ id, content: text, lines });
      const chip = `[Pasted text #${id} +${lines} lines]`;
      setComposer(s.slice(0, c) + chip + s.slice(c), c + chip.length);
      // F02-06: keep the paste registry BOUNDED. Above the cap, only entries still referenced
      // by the draft, a queued task, or a history entry survive — history counts because a
      // recalled entry re-renders its chip and a re-run must still resolve it (the submit paths
      // deliberately no longer drop spent chips for exactly that reason).
      if (pastesRef.current.length > PASTE_CAP) {
        const queuedText = queuedTasksRef.current.map((q) => q.text ?? '').join('\n');
        pastesRef.current = prunePastes(pastesRef.current, [inputRef.current, queuedText, ...historyRef.current]);
      }
    } else {
      setComposer(s.slice(0, c) + text + s.slice(c), c + text.length);
    }
    setMenuIndex(0);
  }, [setComposer]);

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

  // Shared question-dialog actions — used by BOTH the keybinding resolver handlers (question:*)
  // and the legacy inline key path below, so the two cannot drift. They read live state from refs
  // so a handler registered once always acts on the current dialog (gate, questions, selections).
  const chooseAtQuestion = useCallback((idx: number, pos: number) => {
    const q = pendingRef.current?.questions?.[idx];
    if (!q) return;
    const label = q.options[pos]?.label;
    if (label === undefined) return;
    const current = questionSelectionsRef.current[idx] ?? [];
    const selected = q.multiSelect
      ? current.includes(label)
        ? current.filter((v) => v !== label)
        : [...current, label]
      : [label];
    setQuestionSelection(idx, selected);
  }, [setQuestionSelection]);

  const confirmQuestion = useCallback(() => {
    const g = igateRef.current;
    const qs = pendingRef.current?.questions;
    if (!g || !qs?.length || pendingRef.current?.kind !== 'user_question') return;
    const idx = Math.min(questionIndexRef.current, qs.length - 1);
    const q = qs[idx];
    if (!q) return;
    const cursor = questionCursorRef.current[idx] ?? recommendedIndex(q);
    // Commit the highlighted option if nothing is chosen yet — for BOTH kinds.
    //
    // Multi-select was excluded, so Enter with nothing ticked committed an empty answer `[]` while
    // the dialog was visibly highlighting a row (and marking one "★ recommended"). The user saw a
    // choice on screen, pressed Enter, and the model received "nothing selected". Taking the
    // highlighted row matches what the frame shows; a genuinely empty answer is still reachable
    // with Esc, which denies.
    if (!questionSelectionsRef.current[idx]?.length) chooseAtQuestion(idx, cursor);
    if (idx < qs.length - 1) {
      setQuestionIndex(idx + 1);
      return;
    }
    g.respond({ answers: buildQuestionAnswers(qs, questionSelectionsRef.current) });
  }, [chooseAtQuestion, setQuestionIndex]);

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

  // Ref so pushLine (stable, no deps) can trigger markdown-image scanning without a hook cycle
  // (scan → pushImage → pushLine). Assigned below where enqueueMdImages is defined.
  const enqueueMdImagesRef = useRef<(text: string) => void>(() => {});
  const pushLine = useCallback((l: Omit<TranscriptItem, 'id' | 'kind'> & { kind?: TranscriptItem['kind'] }) => {
    drainUnitsRef.current?.(); // ordering: a queued answer block must never land below this row
    const kind = l.kind ?? 'system';
    // Collaboration Mode: while a seat holds the baton, tag its assistant turns with the active
    // speaker so the flattener draws the colored attribution header. Explicit speaker on the call wins.
    const speaker = l.speaker ?? (kind === 'assistant' ? speakerRef.current ?? undefined : undefined);
    const entry = { id: lineId.current++, kind, ...l, speaker } as TranscriptItem;
    setCommitted((c) => {
      const next = [...c, entry];
      committedRef.current = next;
      return next;
    });
    // Markdown ![](url) in a committed assistant answer → enqueue an inline render. Remote http(s)
    // is opt-in (SHADOW_FETCH_REMOTE_IMAGES=1); local paths + data: URIs always load. Fire-and-forget.
    if (kind === 'assistant' && typeof l.text === 'string') enqueueMdImagesRef.current(l.text);
  }, []);
  pushLineRef.current = pushLine;
  const drainUnits = useCallback(() => {
    if (pendingUnitsRef.current.length === 0) return;
    const queued = pendingUnitsRef.current;
    pendingUnitsRef.current = [];
    for (const u of queued) {
      pushLine({ kind: 'assistant', text: u.text, color: C.fg, meta: 'assistant', tight: u.tight });
    }
  }, [pushLine]);
  drainUnitsRef.current = drainUnits;
  // /clear mid-stream: the turn being erased must take its QUEUED blocks with it (drain would
  // re-commit them on top of the wipe).
  const dropStreamedUnits = useCallback(() => {
    pendingUnitsRef.current = [];
  }, []);

  const repaintFromContext = useCallback(() => {
    drainUnitsRef.current?.(); // flush queued stream blocks INTO the list the next line wipes
    setCommitted([]);
    committedRef.current = [];
    setStaticEpoch((n) => n + 1); // remount <Static> so it forgets the previous conversation
    const msgs = context.messages();
    let tools = 0;
    for (const m of msgs) {
      const text = m.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      tools += m.content.filter((b) => b.type === 'tool_use').length;
      if (!text) continue;
      if (m.role === 'user') {
        pushLine({ kind: 'user', text: `❯ ${text}`, color: C.green, bold: true, meta: 'you' });
      } else if (m.role === 'assistant') {
        const display = sanitizeAssistantText(text);
        if (display.trim()) pushLine({ kind: 'assistant', text: display, color: C.fg, meta: 'assistant' });
      }
    }
    if (tools > 0) {
      pushLine({ text: `  ⋮ ${tools} tool call${tools === 1 ? '' : 's'} in the restored context (output not replayed)`, dimColor: true });
    }
  }, [context, pushLine]);
  repaintFromContextRef.current = repaintFromContext;

  // F08-10: open the current draft in $VISUAL/$EDITOR (Ctrl-X Ctrl-E). Idle-only — spawnSync blocks
  // the whole event loop (including provider streaming), so this must never run mid-turn. Ink leaves
  // raw mode while the editor owns the tty, then re-enters; the edited text replaces the composer.
  const openExternalEditor = useCallback(() => {
    if (!setRawMode || !process.stdout.isTTY) {
      pushLine({ text: 'External editor needs an interactive terminal.', dimColor: true });
      return;
    }
    const editor = resolveEditor();
    const session = openEditorFile(inputRef.current);
    try {
      setRawMode(false);
      const r = spawnSync(`${editor} "${session.file}"`, { stdio: 'inherit', shell: true });
      if (r.error) {
        pushLine({ text: `Couldn't launch "${editor}": ${r.error.message}. Set $EDITOR.`, color: C.red });
      } else {
        const edited = session.read();
        setComposer(edited, edited.length); // caret at end of the edited draft
      }
    } catch (e) {
      pushLine({ text: `External editor failed: ${(e as Error).message}`, color: C.red });
    } finally {
      try { setRawMode(true); } catch { /* terminal may have gone away */ }
      setStaticEpoch((n) => n + 1); // editor likely used the alt-screen — force a repaint on return
      session.cleanup();
    }
  }, [setRawMode, pushLine, setComposer]);

  // F08-11: "While you were away" — a one-shot, non-streaming recap of the just-resumed conversation
  // via the CURRENT provider. Best-effort: bounded output, silent on error, and it NEVER starts a
  // real turn or touches the run lock (it's a read-only summary shown boxed).
  const showResumeRecap = useCallback(async () => {
    const provider = providerRef.current;
    if (!provider) return;
    try {
      const recent = context.messages().slice(-30);
      const transcript = recent
        .map((m) => {
          const text = m.content.map((b) => (b.type === 'text' ? b.text : b.type === 'tool_use' ? `[tool: ${b.name}]` : '')).join(' ').trim();
          return text ? `${m.role}: ${text.slice(0, 500)}` : '';
        })
        .filter(Boolean)
        .join('\n');
      if (!transcript) return;
      const req = {
        model: currentRef.current.model,
        system: 'You summarize a coding session so the user can pick up where they left off. Be concise.',
        messages: [{ role: 'user', content: [{ type: 'text', text: `Summarize where this session left off in 2-4 short bullet points (what was being worked on, current state, obvious next step). No preamble.\n\n${transcript}` }] }],
        tools: [],
        maxOutputTokens: 400,
        temperature: opts.cfg.temperature,
      } as Parameters<typeof provider.send>[0];
      let out = '';
      for await (const ev of provider.send(req)) {
        if (ev.type === 'text') out += ev.delta;
        else if (ev.type === 'error') return; // silent — a recap must never nag
      }
      out = out.trim();
      if (!out) return;
      pushLine({
        kind: 'system',
        text: 'recap',
        lines: [
          { text: 'While you were away', color: C.cyan, bold: true },
          ...out.split('\n').map((l) => ({ text: `  ${l}`, dimColor: true })),
        ],
      });
    } catch {
      /* a recap is a nicety — never surface its failure */
    }
  }, [context, pushLine, opts.cfg.temperature]);

  /** Push an inline-image item to the transcript and handle the display fallback. On a terminal
   *  that renders inline images, flatten paints the pixels + a durable placeholder. On any other
   *  terminal, the placeholder still shows AND we auto-open the OS viewer (Preview.app / xdg-open)
   *  — the grok-cli approach — so the image is always seen. */
  const pushImage = useCallback((bytes: string, mediaType: string, alt: string, source: string) => {
    if (Buffer.byteLength(bytes, 'base64') > MAX_IMAGE_BYTES) {
      pushLine({ kind: 'error', text: `Image skipped: ${alt} exceeds 20 MiB.`, color: C.yellow });
      return;
    }
    // `text` is the plain-text fallback (export / headless / stock Ink path); the styled flatten
    // render uses `image` for the placeholder + inline pixels.
    pushLine({ kind: 'image', text: `🖼 ${alt}`, image: { bytes, mediaType, alt, source } });
    // Save+open ONLY when there is an interactive terminal to open it on. The returned path is
    // discarded here, so on a non-TTY (piped, headless, CI, the test suite) the write had no
    // consumer at all — it just deposited fixtures in the user's real ~/.shadow/img-cache and,
    // before canOpenViewer existed, threw a Preview window over their screen for each one.
    if (!supportsInlineImages() && canOpenViewer()) {
      void saveAndOpen(Buffer.from(bytes, 'base64'), mediaType, alt);
    }
  }, [pushLine]);

  // Scan a committed assistant text for markdown images and render each. data: URIs decode locally
  // (no network); local paths read from disk; remote http(s) fetches ONLY when opted in — Shadow is
  // privacy-first and must not silently call out to arbitrary URLs a model emits.
  const enqueueMdImages = useCallback((text: string) => {
    const re = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const alt = m[1] || 'image';
      const url = m[2]!;
      const dataUri = url.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.*)$/i);
      if (dataUri) {
        if (Buffer.byteLength(dataUri[2]!, 'base64') > MAX_IMAGE_BYTES) continue;
        pushImage(dataUri[2]!, dataUri[1]!, alt, 'markdown');
        continue;
      }
      if (/^https?:\/\//i.test(url)) {
        if (process.env.SHADOW_FETCH_REMOTE_IMAGES !== '1') continue; // opt-in privacy gate
        void (async () => {
          try {
            const image = await fetchRemoteImage(url);
            pushImage(image.bytes.toString('base64'), image.mediaType, alt, 'markdown');
          } catch {
            /* network failure — skip silently */
          }
        })();
        continue;
      }
      // Local path (workspace-relative or absolute).
      void (async () => {
        try {
          const abs = isAbsolute(url) ? url : resolve(opts.workspaceRoot, url);
          const mt = imageMediaType(abs);
          if (!mt) return;
          if (statSync(abs).size > MAX_IMAGE_BYTES) return;
          pushImage(readFileSync(abs).toString('base64'), mt, alt, 'markdown');
        } catch {
          /* not found / unreadable — skip */
        }
      })();
    }
  }, [pushImage, opts.workspaceRoot]);
  enqueueMdImagesRef.current = enqueueMdImages;

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

  const setAutonomy = useCallback(
    (l: AutonomyLevel) => {
      autonomyRef.current = l;
      setAutonomyState(l);
      // Tell the process-level binding too: sub-agents and the fs-root grant read it, and both
      // were frozen at the startup value until now.
      opts.onAutonomyChange?.(l);
    },
    [opts],
  );

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
  // Ctrl-O: ALL collapsible blocks (thoughts + tool output) — matching Claude Code. Soft reflow
  // remounts Static so folds repaint without nuking scrollback (no 3J flashbang).
  useEffect(() => kbRegister('transcript:toggleFoldLatest', () => {
    setExpandedIds(new Set()); // per-item expands are superseded by the global toggle
    setShowAllExpanded((v) => !v);
    reflow('soft');
  }), [kbRegister, reflow]);
  // Alt/Option+O: expand/collapse only the MOST RECENT collapsible block (inspect one shell dump
  // without opening every earlier fold). Earlier folds stay reachable via Ctrl-O (all).
  useEffect(() => kbRegister('transcript:toggleFoldOne', () => {
    const items = committedRef.current;
    let latest: TranscriptItem | undefined;
    for (let i = items.length - 1; i >= 0; i--) {
      if (isCollapsible(items[i]!)) {
        latest = items[i];
        break;
      }
    }
    if (!latest) return;
    setShowAllExpanded(false);
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(latest!.id)) next.delete(latest!.id);
      else next.add(latest!.id);
      return next;
    });
    reflow('soft');
  }), [kbRegister, reflow]);
  // B6 — `app:redraw` is the action loader.ts uses as ITS DOCUMENTED EXAMPLE
  // (`{"ctrl+l": "app:redraw"}`), but Global was `{}` and nothing registered the id — so a user
  // copying the doc's own example got a binding that parsed, warned about nothing, and never
  // fired. Bound to the hard reflow — as of P3-03 reachable ONLY via this explicit action.
  useEffect(() => kbRegister('app:redraw', () => reflow('hard')), [kbRegister, reflow]);
  useEffect(() => kbRegister('transcript:toggleTaskList', () => {
    // Works idle AND mid-turn — users hit Ctrl-T to inspect the list while the agent runs.
    // (Key delivery for Ctrl+T is fixed in eventToKeystroke: C0 bytes map to letter+ctrl.)
    if (todoItemsRef.current.length === 0) {
      // Visible feedback so "does nothing" isn't silent when the model never wrote todos.
      pushLine({ text: '  no task list yet — the model creates one with todo_write', dimColor: true });
      return;
    }
    setTodoCollapsed((v) => !v);
    // Soft reflow: remount Static chrome without wiping scrollback (hard was a flashbang for a
    // pure live-height change).
    reflow('soft');
  }), [kbRegister, reflow, pushLine]);

  // Re-run the /statusline command (if any) and stash its output for the footer.
  const refreshStatusLine = useCallback(() => {
    const generation = ++statusLineGenerationRef.current;
    const cmd = statusLineRef.current;
    if (!cmd) {
      setCustomStatus('');
      return;
    }
    runStatusLine(
      cmd,
      { model: currentRef.current.model, provider: currentRef.current.provider, cwd: opts.workspaceRoot, autonomy: autonomyRef.current },
      (line) => {
        if (generation === statusLineGenerationRef.current) setCustomStatus(line);
      },
    );
  }, [opts.workspaceRoot]);

  // Refresh the custom status line on mount and whenever the turn settles or the
  // model/mode changes — never mid-turn (don't spawn a subprocess on every token).
  useEffect(() => {
    if (!running) refreshStatusLine();
  }, [running, current.model, current.provider, autonomy, refreshStatusLine]);

  /**
   * T1 toast: a transient one-line ack that never reaches the committed transcript. TTL ~3.2s;
   * a newer toast replaces the older one (the timer resets). Fallback: when the HUD's priority
   * ladder cannot spare a row (judged precisely against the last fitHud headroom), a dim
   * transcript line is pushed instead — the ack is NEVER silently swallowed.
   */
  const showToast = useCallback((text: string, kind: ToastKind = 'info') => {
    const fit = lastHudFitRef.current;
    const size = terminalSizeRef.current;
    // If a toast is ALREADY on screen, fitHud has already budgeted that row into fit.height —
    // replacing it costs zero extra rows. Otherwise it would cost exactly 1. Mirror fitHud's
    // grant rule precisely so showToast's fallback decision can never disagree with the HUD.
    const extraRows = toastRef.current ? 0 : 1;
    if (!fit || fit.height + extraRows > size.rows - 1) {
      pushLine({ text, color: kind === 'error' ? C.red : undefined, dimColor: kind !== 'error' });
      return;
    }
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    const view = { text: clampToastText(text, size.cols), kind };
    setToast(view);
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, TOAST_TTL_MS);
  }, [pushLine]);

  // Shift+Tab: plan-mode fast lane (1.2). `chat:cycleMode` is a default Chat binding, but until
  // this registration nothing handled it — the key fell through to the bare-Tab ring. Tab keeps
  // the full autonomy ring; this one key jumps straight in and out of plan mode. Terminals that
  // deliver Shift+Tab WITHOUT Ink's shift flag never match the binding — the composer owner's
  // raw-byte fallback catches those. Safe mid-turn: PlanModeState is shared with the running
  // loop, so the write gate engages on the next turn.
  useEffect(() => kbRegister('chat:cycleMode', () => {
    const pm = opts.planMode;
    if (!pm) return;
    if (pm.active) {
      pm.exit();
      setAutonomy('manual'); // leaving plan restarts at the cautious end of the ring
      loopRef.current?.setAutonomy('manual');
    } else {
      pm.enter();
    }
  }), [kbRegister, opts.planMode, setAutonomy]);

  // Ctrl+X M (leader chord): open the model picker — the one-key switch (1.3). Mirrors the
  // idle path of /model exactly (same guard, same active-row focus) so key and command can't
  // drift. Blocked mid-turn ON PURPOSE: while the picker has focus it captures EVERY key, so
  // an open picker would swallow the Esc that interrupts the running turn.
  useEffect(() => kbRegister('chat:openModelPicker', () => {
    if (runningRef.current) {
      pushLine({ text: 'Finish the current turn before switching models — Esc stops it.', dimColor: true });
      return;
    }
    const rows = modelRows(opts.cfg);
    if (rows.filter((r) => r.kind === 'model').length <= 1) {
      pushLine({
        kind: 'system',
        text: 'model',
        lines: [
          { text: `${currentRef.current.provider} / ${currentRef.current.model}`, color: C.cyan },
          { text: 'Use /model add <label> <provider> <model> [baseUrl] [--self-hosted] to add a preset.', dimColor: true },
        ],
      });
      return;
    }
    const active = rows.findIndex(
      (r) =>
        r.kind === 'model' &&
        r.entry.provider === currentRef.current.provider &&
        r.entry.model === currentRef.current.model,
    );
    setPickerIndex(active >= 0 ? active : firstSelectableRow(rows));
    setPickerOpen(true);
  }), [kbRegister, opts.cfg, pushLine]);

  // T2 Phase 3 — instruction-file autopilot (Claude Code / Codex parity): at LAUNCH, seed
  // SHADOW.md when no instruction file exists here, or acknowledge AGENTS.md/CLAUDE.md when
  // they do. Strictly additive (an existing file is NEVER touched), toast-only and silent
  // otherwise. The guard makes it run exactly once even if the host remounts; seed is
  // idempotent anyway (a second call reports alreadyPresent and stays silent).
  const autopilotRanRef = useRef(false);
  useEffect(() => {
    if (autopilotRanRef.current) return;
    autopilotRanRef.current = true;
    if (!autopilotEnabledForBoot()) return; // node:test render tests must not seed the workspace
    const decision = decideInstructionAutopilot(opts.workspaceRoot);
    if (decision.action === 'none') return;
    const seed = decision.action === 'seed' ? seedInstructionFile(opts.workspaceRoot) : undefined;
    const text = autopilotToastText(decision, seed);
    if (text) showToast(text, 'ok');
  }, [opts.workspaceRoot, showToast]);

  // Copy the last assistant answer — or just its last fenced code block — to the OS
  // clipboard. Shared by `/copy [code]` and the Alt+C keybinding. Secrets are redacted
  // first: the clipboard is a broader sink than the screen (macOS Universal Clipboard /
  // iCloud sync, clipboard managers, polling apps). Best-effort, but never copy raw.
  const copyLast = useCallback((what: 'answer' | 'code') => {
    if (!hasClipboard()) {
      pushLine({ text: 'No clipboard helper found — install pbcopy (macOS), xclip/wl-copy (Linux), or run on Windows.', color: C.yellow });
      return;
    }
    const last = [...committedRef.current].reverse().find((it) => it.kind === 'assistant' && it.text);
    if (!last) {
      pushLine({ text: 'No assistant answer to copy yet.', dimColor: true });
      return;
    }
    let raw = last.text!;
    let label = 'answer';
    if (what === 'code') {
      // Last fenced block wins — "copy the code you just gave me" is the ask 95% of the
      // time, and the last block is the final/complete version when a model iterates.
      const blocks = [...raw.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
      if (blocks.length === 0) {
        pushLine({ text: 'No fenced code block in the last answer — plain /copy takes the whole text.', dimColor: true });
        return;
      }
      raw = blocks[blocks.length - 1]!.replace(/\n$/, '');
      label = 'code block';
    }
    const safe = redactString(raw);
    const redacted = safe !== raw;
    void (async () => {
      const ok = await copyToClipboard(safe);
      showToast(
        ok
          ? `Copied last ${label} — ${safe.length} chars${redacted ? ' (secrets redacted)' : ''}`
          : 'Clipboard copy failed.',
        ok ? 'ok' : 'error',
      );
    })();
  }, [pushLine, showToast]);

  // Alt/Option+C — copy the last answer without reaching for /copy.
  useEffect(() => kbRegister('transcript:copyLastAnswer', () => copyLast('answer')), [kbRegister, copyLast]);

  // Ctrl+V — paste from the SYSTEM clipboard. Terminal-native paste (Cmd+V / Ctrl+Shift+V)
  // still works and now arrives bracketed; this covers terminals/keyboards where that is
  // awkward and guarantees a paste path that never depends on terminal support. Async and
  // soft-failing: a clipboard miss is a dim note, never a crash or a hang.
  const pasteFromClipboard = useCallback(() => {
    void (async () => {
      const text = await readClipboard();
      if (text === null) {
        showToast('Paste failed — no clipboard helper (pbpaste / wl-paste / xclip) or read error.', 'warn');
        return;
      }
      if (!text) return; // empty clipboard — nothing to do
      insertPastable(text.replace(/\r\n?/g, '\n'));
    })();
  }, [insertPastable, pushLine, showToast]);
  useEffect(() => kbRegister('chat:pasteClipboard', pasteFromClipboard), [kbRegister, pasteFromClipboard]);

  // ── Approval (Confirmation) + question-dialog (QuestionDialog) actions ──────────
  // Migrated onto the resolver so a user can rebind y/n/s/f/a and the question-dialog nav in
  // ~/.shadow/keybindings.json. Each handler reads live state from refs (the gate, the pending
  // request, autonomy, question cursor/selections) so a handler registered once always acts on
  // the current dialog. The legacy default keys remain as a fall-through (consume() returns false
  // for unbound/unregistered), so rebinding ADDS chords without ever stranding the defaults.
  // F07-09 guard on every rebindable confirm chord: an acknowledge-only dialog (catastrophic
  // denylist) must never mint a grant — not even the side-effect autonomy raise of confirm:always.
  useEffect(() => kbRegister('confirm:yes', () => {
    if (pendingRef.current?.acknowledgeOnly) { igateRef.current?.respond('deny'); return; }
    igateRef.current?.respond('approve');
  }), [kbRegister]);
  useEffect(() => kbRegister('confirm:no', () => { igateRef.current?.respond('deny'); }), [kbRegister]);
  useEffect(() => kbRegister('confirm:session', () => {
    const p = pendingRef.current;
    if (p?.acknowledgeOnly) { igateRef.current?.respond('deny'); return; }
    if (p?.kind === 'permission') igateRef.current?.respond({ approveForSession: true });
  }), [kbRegister]);
  useEffect(() => kbRegister('confirm:prefix', () => {
    const p = pendingRef.current;
    if (p?.acknowledgeOnly) { igateRef.current?.respond('deny'); return; }
    if (p?.kind === 'permission' && p.call.name === 'run_shell') {
      const cmd = shellCommandOf(p.call.input) ?? '';
      const prefix = cmd.split(/\s+/).slice(0, 2).join(' ');
      igateRef.current?.respond({ approveForPrefix: prefix || cmd.slice(0, 24) });
    }
  }), [kbRegister]);
  useEffect(() => kbRegister('confirm:always', () => {
    const p = pendingRef.current;
    if (p?.acknowledgeOnly) { igateRef.current?.respond('deny'); return; }
    if (p && p.kind !== 'plan_enter') {
      // raiseAutonomy, not cycleAutonomy — see the inline handler for why (full→manual wrap).
      const next = raiseAutonomy(autonomyRef.current);
      setAutonomy(next);
      igateRef.current?.respond({ setAutonomy: next });
    }
  }), [kbRegister, setAutonomy]);
  useEffect(() => kbRegister('question:skip', () => { igateRef.current?.respond('deny'); }), [kbRegister]);
  useEffect(() => kbRegister('question:confirm', confirmQuestion), [kbRegister, confirmQuestion]);
  useEffect(() => kbRegister('question:prev', () => {
    const qs = pendingRef.current?.questions;
    if (qs?.length) setQuestionIndex(Math.max(0, Math.min(questionIndexRef.current, qs.length - 1) - 1));
  }), [kbRegister, setQuestionIndex]);
  useEffect(() => kbRegister('question:next', () => {
    const qs = pendingRef.current?.questions;
    if (qs?.length) setQuestionIndex(Math.min(qs.length - 1, Math.min(questionIndexRef.current, qs.length - 1) + 1));
  }), [kbRegister, setQuestionIndex]);

  // Execute a slash command (not sent to the agent). The engine lives in src/tui/slash.ts
  // (P3-02 / F06-04): the command table, its helpers, and the full dispatch body. This bridge
  // re-assembles the live context on every render, so the engine reads the freshest state
  // through the ref while `runSlash` itself keeps a stable identity (onKey depends on it).
  const slashCtxRef = useRef<SlashCtx | null>(null);
  slashCtxRef.current = {
    setLine, setMenuIndex, setStreamNow, setThinkNow,
    // clearToolLine (shell refs drained + state nulled) — /clear only ever nulls, and a raw
    // setToolLine here would leave an armed flush timer able to resurrect the wiped preview.
    clearToolLine,
    dropStreamedUnits,
    setCommitted,
    setShowAllExpanded, setStaticEpoch, setTodoItems, setAttachCount, setStatus,
    setPlanMode, setPickerIndex, setPickerOpen, setAutonomy, setEffort,
    setStyle, setVimEnabled, setVimMode, setThemeTick, setCustomStatus, setComposer,
    pushLine, showToast, showBanner, exit, refreshStatusLine, copyLast, refreshRewindTurns,
    showResumeRecap, pushImage, loadCustomCommands,
    startTurnRef, kbLoadedRef, firstRef, answerOpenRef, committedRef, attachmentsRef,
    pastesRef, lastUsageRef, sessionCostRef, prevTurnCostRef, sessionInTokRef,
    sessionOutTokRef, prevTurnInTokRef, prevTurnOutTokRef, sessionTurnsRef,
    costWarnedRef, fileListLoadedRef, missionRef, startTableRef, currentRef,
    selectModelRef, asyncCommandRef, providerRef, activeTargetRef, styleRef,
    autonomyRef, loopRef, effortRef, runningRef, compactingRef, compactAbortRef,
    sessionLogRef, sessionApprovalsRef, rewindableTurnsRef, additionalRootsRef,
    statusLineRef, vimEnabledRef, vimPendingRef, vimFindRef, vimCountRef, vimRegRef,
    flushQueueRef, runOneRef, repaintFromContextRef,
    // /goal begin while a turn runs: queue the kickoff like a wakeup (never a second
    // concurrent turn on the shared Context).
    queueDeferred: (text: string) => {
      setQueued([...queuedTasksRef.current, { text, kind: 'deferred' }]);
    },
    context, opts, bus, subAgents, todoItems,
  };
  const runSlash = useCallback(
    (cmd: SlashCommand, rawLine?: string) => {
      runSlashCommand(slashCtxRef.current!, cmd, rawLine);
    },
    [],
  );

  // Apply a picked model: rebuild the provider, hot-swap it into the running loop
  // (there is none mid-pick — the picker can't open while a turn runs), point the
  // next turn's deps at it, mirror the change into the UI, and remember the choice.
  // PURE provider construction for a model entry: offline guard → local-server spawn → budget clamp →
  // createProvider. Returns the built client + resolved provider/model, or an {error} to show. It does
  // NOT touch providerRef/currentRef/saveGlobalConfig — so both the persistent /model switch AND the
  // (non-persistent) Collaboration Mode per-seat routing can build a provider through the same path.
  const buildProvider = useCallback(
    async (
      entry: ModelEntry,
      opts2: { clampBudget?: boolean; applyPolicy?: () => boolean } = {},
    ): Promise<
      | { ok: true; client: Provider; provider: ProviderName; model: string; baseUrl?: string; selfHosted: boolean }
      | { ok: false; error: string; fatal?: boolean }
    > => {
      let provider = entry.provider;
      let baseUrl = resolveBaseUrl(entry.provider, entry.baseUrl);
      let detectedWindow: number | undefined;
      const cred = resolveEntryCredential(entry, { vaultIsLocked: vaultExists() && !vaultUnlocked() });
      if (!cred.ok) {
        // Soft failure: the session survives on the current model rather than dying. Falling
        // through to the adapter key here would send it to this preset's baseUrl.
        return {
          ok: false,
          error: `"${entry.label}" needs the vault slot "${cred.slot}", which is ${
            cred.reason === 'locked' ? 'locked — unlock the vault to use it.' : 'empty — re-add its key.'
          }`,
          fatal: false,
        };
      }
      let apiKey = cred.apiKey;
      const mlxReadyOffline = entry.mlx ? mlxOfflineReady(entry.mlx) : false;
      if (opts.offline && !isLocalModelTarget({ gguf: entry.gguf, mlx: mlxReadyOffline ? entry.mlx : undefined, vllm: entry.vllm, baseUrl })) {
        // A soft refusal (yellow), with the actionable local-model hint preserved verbatim.
        return { ok: false, error: `Offline mode: "${entry.label}" is a cloud endpoint — switch refused. Local models only (see /local list, then /local use <name>).` };
      }
      if (isLocalServedEntry(entry)) {
        try {
          const r = await ensureLocalServer(entry, (m) => pushLine({ text: m, dimColor: true }), { offline: opts.offline });
          provider = 'openai';
          baseUrl = r.baseUrl;
          apiKey = entry.apiKey ?? 'sk-local';
          detectedWindow = await detectServerContextWindow(r.baseUrl);
        } catch (e) {
          // A hard failure (red) — the local server couldn't start, so nothing can route here.
          return { ok: false, error: `Local model failed: ${(e as Error).message}`, fatal: true };
        }
      }
      // Derive a complete policy for THIS provider/model. Query local servers after startup;
      // explicit contextWindow metadata covers cloud/custom presets. Resetting actual tokens is
      // essential because the old provider's usage is not a valid floor for the new request.
      if (opts2.clampBudget !== false && (opts2.applyPolicy?.() ?? true)) {
        const localish = isLocalBaseUrl(baseUrl);
        if (localish && baseUrl && !detectedWindow) detectedWindow = await detectServerContextWindow(baseUrl);
        // The local context-window probe is asynchronous. Recheck before touching shared config or
        // Context so a superseded fallback cannot partially switch policy after steering aborted it.
        if (opts2.applyPolicy?.() ?? true) {
          const hardWindow = detectedWindow ?? configuredContextWindow(entry);
          const base = baseContextPolicyRef.current;
          const nextBudget = hardWindow
            ? clampLocalContextBudget(base.contextBudget, hardWindow)
            : base.contextBudget;
          const nextPolicy = {
            contextBudget: nextBudget,
            triggerRatio: triggerRatioForBudget(nextBudget, base.triggerRatio),
            keepLastTurns: keepLastTurnsForBudget(nextBudget, base.keepLastTurns),
          };
          const previous = context.policy();
          opts.cfg.contextBudget = nextPolicy.contextBudget;
          opts.cfg.summarizeTriggerRatio = nextPolicy.triggerRatio;
          opts.cfg.keepLastTurns = nextPolicy.keepLastTurns;
          context.setPolicy(nextPolicy, true);
          if (
            previous.contextBudget !== nextPolicy.contextBudget ||
            previous.triggerRatio !== nextPolicy.triggerRatio ||
            previous.keepLastTurns !== nextPolicy.keepLastTurns
          ) {
            const source = hardWindow ? ` for ${hardWindow.toLocaleString()} server/model window` : '';
            pushLine({ text: `  context policy → ${nextBudget.toLocaleString()} tokens${source}`, dimColor: true });
          }
        }
      }
      const client = createProvider({
        // F10-01: a live /model switch or in-TUI fallback must carry the entry's P1A-04 stream
        // knobs + P1A-06 capability block exactly like bootstrap does — omitting them silently
        // reverted the idle watchdog to 120s and dropped the self-hosted contract mid-session.
        ...entryStreamContract(entry, opts.cfg.stream),
        provider,
        model: entry.model,
        apiKey,
        authToken: cred.authToken,
        baseUrl,
        selfHosted:
          provider === 'openai'
            ? entry.selfHosted === true ||
              isLocalModelTarget({ gguf: entry.gguf, mlx: entry.mlx, vllm: entry.vllm, baseUrl })
            : undefined,
        reasoningRoundtrip: opts.cfg.reasoningRoundtrip,
      });
      const selfHosted =
        provider === 'openai' &&
        (entry.selfHosted === true ||
          isLocalModelTarget({ gguf: entry.gguf, mlx: entry.mlx, vllm: entry.vllm, baseUrl }));
      return {
        ok: true,
        client,
        provider,
        model: entry.model,
        baseUrl,
        selfHosted,
      };
    },
    [pushLine, opts],
  );
  buildProviderRef.current = buildProvider;

  const selectModel = useCallback(
    async (entry: ModelEntry) => {
      setPickerOpen(false);
      if (runningRef.current) {
        pushLine({ text: 'Wait for the current turn to finish before switching models.', color: C.yellow });
        return;
      }
      const generation = ++modelSwitchSeqRef.current;
      modelSwitchingRef.current = true;
      // Context budget must track the ACTIVE model's window across mid-session switches: a session
      // started on a 128k cloud model that switches to a 32k llama-server would otherwise compact
      // at ~109k — long past the server window — and die on a 400. Switching back to a cloud model
      // restores the session's original budget. (Mirrors the startup clamp in index.ts.)
      try {
        const built = await buildProvider(entry, { applyPolicy: () => generation === modelSwitchSeqRef.current });
        if (generation !== modelSwitchSeqRef.current) return;
        if (!built.ok) {
          pushLine({ text: built.error, color: built.fatal ? C.red : C.yellow });
          return;
        }
        providerRef.current = built.client;
        currentRef.current = { provider: built.provider, model: built.model };
        activeTargetRef.current = { baseUrl: built.baseUrl, selfHosted: built.selfHosted };
        loopRef.current?.setProvider(built.client, built.model);
        opts.onModelSwitch?.(built.client, built.model); // keep the agent tool's sub-agents on the live model
        setCurrent({ provider: built.provider, model: built.model });
        try {
          saveGlobalConfig({ lastModel: entry.label });
        } catch {
          // best-effort persistence; the live switch already applies this session
        }
        pushLine({ text: `Model → ${entry.label} (${built.provider}/${built.model})`, color: C.cyan });
        const prof = familyProfile(entry.model);
        if (prof?.note) pushLine({ text: `  ${prof.family}: ${prof.note}`, dimColor: true });
      } finally {
        if (generation === modelSwitchSeqRef.current) {
          modelSwitchingRef.current = false;
          // A queued `/model use` is an asynchronous barrier. Resume FIFO only after the provider,
          // context policy, and footer all agree on the selected model.
          flushQueueRef.current?.();
        }
      }
    },
    [pushLine, buildProvider, opts],
  );
  selectModelRef.current = selectModel;

  // Welcome card + optional (OPT-IN) update notice.
  useEffect(() => {
    showBanner();
    // Only runs when the user set `updateCheck: true` (OFF by default). Payload-free, once/day, silent
    // on any error/offline — prints ONE system line if a newer release exists. Never sends user data.
    // Suppressed entirely in --offline mode: that contract is "nothing leaves the machine but the local
    // model", and the check is a web call, so opt-in or not it must not fire offline.
    void maybeNotifyUpdate(opts.version, !opts.offline && (opts.cfg.updateCheck ?? false), (line) =>
      pushLine({ kind: 'system', text: line, color: C.cyan }),
    );
  }, []);

  // Wire the interactive gate to React state.
  useEffect(() => {
    if (igateRef.current) {
      igateRef.current.show = (req) => {
        resetQuestionDialog();
        dialogTypeaheadRef.current = false;
        // P1A-14: a modal opening mid-paste must not strand paste state. The §0.8 transport now
        // buffers across the modal edge, but clear here too so a lost end-marker can never leave
        // the composer diverting every subsequent key into a phantom paste buffer.
        pastingRef.current = false;
        pasteBufRef.current = '';
        dialogShownAtRef.current = Date.now(); // arm the type-ahead guard — see onKey §1
        setPending(req);
        // P1B-04: if the user has stepped away, ping them when an approval sits unanswered. The
        // timer self-guards on the SAME request still being pending, so a prompt answer never fires
        // it and there is nothing to clear at the resolve sites. (req is null when CLEARING.)
        if (req) {
          const pendingId = req.id;
          setTimeout(() => {
            if (pendingRef.current?.id === pendingId) {
              emitNotification(opts.cfg.notify ?? 'auto', 'Shadow', 'Approval needed', { isTTY: !!process.stdout.isTTY });
            }
          }, NOTIFY_APPROVAL_WAIT_MS);
        }
      };
    }
    if (opts.wakeupHandler) {
      opts.wakeupHandler.fire = (task, reason) => {
        const line = `[wakeup: ${reason}] ${task}`;
        // A wakeup can fire MID-TURN. Calling runOne directly then started a second turn on the
        // shared Context while the first was still streaming: the two clobbered controllerRef and
        // `running`, so Ctrl-C/Esc aborted only whichever controller happened to be installed last
        // and the other turn became un-interruptible. Queue it instead — the same FIFO a typed
        // message uses — and it runs when the current turn ends.
        if (runningRef.current) {
          setQueued([...queuedTasksRef.current, { text: line, kind: 'deferred' }]); // keep the ref in step
          pushLine({ text: `  ⏰ wakeup queued (${reason}) — runs when this turn ends`, dimColor: true });
          return;
        }
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
    // Say what actually happened. buildAutoAnswers keeps any selection the user already made and
    // only fills the REST with the recommendation, so the flat "auto-selected the recommended
    // answer" line misreported a mixed submission as a wholly automatic one.
    const picked = Object.keys(questionSelectionsRef.current).length;
    const how =
      picked > 0
        ? `kept your ${picked} selection${picked > 1 ? 's' : ''} and filled the rest with the recommended answer`
        : `auto-selected the recommended answer${p.questions.length > 1 ? 's' : ''}`;
    pushLine({ text: `  ⏱ no response in ${AUTO_ANSWER_SECS}s — ${how}`, color: C.dim });
    g.respond({ answers });
  }, [pushLine]);

  useEffect(() => {
    if (!AUTO_ANSWER_ENABLED || pending?.kind !== 'user_question') {
      autoAnswerSecsRef.current = null;
      setAutoAnswerSecs(null);
      return;
    }
    autoAnswerEngagedRef.current = false; // a NEW dialog re-arms the idle timer
    autoAnswerSecsRef.current = AUTO_ANSWER_SECS;
    setAutoAnswerSecs(AUTO_ANSWER_SECS);
    const id = setInterval(() => {
      if (autoAnswerEngagedRef.current) {
        clearInterval(id); // the user showed up — this dialog is theirs now
        return;
      }
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
            // BOUNDED intent split (P1A-11): the held tool-intent suffix is capped, so this rescan —
            // and the extractCommittableUnits re-parse below — never sees more than the committed-away
            // remainder plus a bounded tail. A malformed model that opens a tool envelope and never
            // closes it can no longer grow the per-token work quadratically; committed blocks are
            // already gone to <Static>, so only the (bounded) live tail is ever re-examined.
            // Commit at LINE granularity so the live region stays ~1 line and the composer holds still
            // (the reference client feel); multi-line constructs stay grouped. Units carry `pad` — a source
            // blank line preceded them — which maps to a rendered gap, so the streamed answer keeps
            // the model's paragraph rhythm instead of gluing into a wall of text.
            const split = splitStreamToolIntentCapped(streamBufRef.current);
            const { units, rest, trailingBlank } = extractCommittableUnits(split.visible, padCarryRef.current);
            for (const u of units) {
              const display = sanitizeAssistantText(u.text);
              if (!display.trim()) continue;
              // Turn-scoped: suppress a verbatim re-emission of the answer (even a multi-block one),
              // but never legitimate new content and never an identical short answer in a later turn.
              if (absorbAssistant(display)) continue;
              pendingUnitsRef.current.push({ text: stripTrailingNewlines(display), tight: answerOpenRef.current && !u.pad });
              answerOpenRef.current = true;
            }
            padCarryRef.current = trailingBlank;
            // Second half of the P1A-11 bound: `rest` (an open construct extractCommittableUnits
            // keeps live) grows without limit on a never-closing NON-tool fence — the ```python
            // case the held-suffix cap above cannot see. Force-commit the oldest lines once it
            // exceeds the cap (fence-continuity preserved by clampLiveRest), so BOTH retained
            // buffers are bounded and the per-delta rescan can never go quadratic.
            let liveRest = rest;
            const clamped = clampLiveRest(liveRest);
            if (clamped.commit !== null) {
              const display = sanitizeAssistantText(clamped.commit);
              if (display.trim() && !absorbAssistant(display)) {
                pendingUnitsRef.current.push({ text: stripTrailingNewlines(display), tight: answerOpenRef.current });
                answerOpenRef.current = true;
              }
              liveRest = clamped.rest;
            }
            streamBufRef.current = liveRest + split.held;
            // `split.held` is capped (splitStreamToolIntentCapped / MAX_HELD_BYTES) and `liveRest`
            // is capped (clampLiveRest / MAX_LIVE_REST_BYTES), so the live buffer and the next
            // delta's rescan stay bounded even for a model that opens an envelope or fence and
            // never closes it — no quadratic TUI freeze. Only the safe remainder is painted live.
            pendingStreamRef.current = scrubForDisplay(liveRest);
            scheduleFlush();
          }
          break;
        case 'thinking':
          if (e.delta) {
            if (thinkStartedAtRef.current == null) thinkStartedAtRef.current = Date.now();
            thinkBufRef.current += e.delta;
            pendingThinkRef.current = thinkBufRef.current;
            scheduleFlush();
          }
          break;
        case 'reasoning_done': {
          // Through pushLine (the single choke point every transcript item flows through) so a
          // future hook on commit sees reasoning items too. durationMs drives `thought for Ns`.
          const durationMs =
            thinkStartedAtRef.current != null ? Math.max(0, Date.now() - thinkStartedAtRef.current) : 0;
          thinkStartedAtRef.current = null;
          pushLine({
            kind: 'reasoning',
            text: e.text.trimEnd(),
            dimColor: true,
            meta: 'reasoning',
            durationMs,
          });
          setThinkNow('');
          break;
        }
        case 'assistant_done': {
          // The streamed blocks are already in <Static>; commit only the leftover open
          // block. If the provider streamed nothing (no `text` deltas), fall back to the
          // full e.text. Gating on `streamed` avoids re-committing the whole answer when
          // the stream happened to end exactly on a block boundary (rest === '').
          const streamed = answerOpenRef.current || streamBufRef.current.length > 0;
          // Scrub the DISPLAY text. sniffToolCalls only strips a `<tool_call>` envelope when it
          // successfully RECOVERS a call, which requires the named tool to be registered — so a
          // weak local model naming a tool that doesn't exist, or emitting a malformed envelope,
          // left the raw XML in the committed answer, where markdown then mangled it further.
          const finalText = sanitizeAssistantText(streamed ? streamBufRef.current : (e.text ?? ''));
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
          if (e.subagent) {
            // A sub-agent started a tool → route it to the sub-agent panel, NEVER the parent's live
            // row. Tagged (forwarded) sub-agent tool_start used to clobber the parent's own
            // activeTool, so a busy child hid what the top-level agent was actually doing.
            setSubAgents((prev) => {
              const m = new Map(prev);
              const cur = m.get(e.subagent!);
              if (cur) m.set(e.subagent!, { ...cur, tool: e.call.name, argPreview: previewOf(e.call.input), toolUseCount: cur.toolUseCount + 1 });
              return m;
            });
            break;
          }
          // Live row (activeTool) already shows name(args) — don't also mirror it into toolLine
          // (that used to double-print `↳ run_shell …` in the status tail under the same call).
          {
            const name = e.call.name;
            const arg = previewOf(e.call.input);
            setActiveTool({ name, arg, agent: name === 'agent' ? agentAttr(e.call.input) : undefined });
            if (isCollapsibleTool(name)) {
              const kind = collapseKind(name);
              setLiveRecon((prev) => {
                const kinds = { ...(prev?.kinds ?? {}) };
                kinds[kind] = (kinds[kind] ?? 0) + 1;
                return { kinds, hint: arg || prev?.hint };
              });
            } else {
              // Signal tool (edit/shell/fetch/agent) breaks the recon burst.
              setLiveRecon(null);
            }
          }
          clearToolLine();
          break;
        case 'tool_end': {
          if (e.subagent) {
            // Sub-agent tool finished → clear its live current-tool line in the panel. Don't touch
            // the parent's activeTool/shell (the parent is still on its own call — possibly the very
            // `agent` call that launched this sub-agent), and don't spam the parent transcript with
            // one row per child tool: sub-agent internals are surfaced in the panel, and the
            // sub-agent's FINAL answer commits as the `agent` tool result body, not as N one-liners.
            setSubAgents((prev) => {
              const cur = prev.get(e.subagent!);
              if (!cur || !cur.tool) return prev;
              const m = new Map(prev);
              m.set(e.subagent!, { ...cur, tool: undefined, argPreview: undefined });
              return m;
            });
            break;
          }
          clearToolLine();
          setActiveTool(null);
          setShellPid(null);
          setShellWarn(null);
          // Nest shell stdout / edit diffs ON the tool header item so collapse is one unit:
          //   ⏺ run_shell($ npm test) — exit 0 (1.2s)
          //     ⌄ output 47 lines · ^O          ← default ( > TOOL_BODY_COLLAPSE_THRESHOLD )
          // Short bodies (≤ threshold) stay inline under ⎿. Cap huge bodies before commit so
          // React state + Static never hold multi-MB dumps.
          const sd = e.result.data as { stdout?: string; stderr?: string } | undefined;
          // F05-04: shell output is real terminal output — keep SGR color spans (colors are the
          // only escapes that can't move the cursor or flip modes) but strip everything else
          // before this text reaches <Text>. See sanitizeTerminalEscapes for the documented choice.
          const shellOut = sanitizeTerminalEscapes([sd?.stdout ?? '', sd?.stderr ?? ''].join('\n'), true).replace(/^\n+|\n+$/g, '');
          const diff = e.result.meta?.diff;
          let bodyLines: BannerLine[] | undefined;
          let bodyMeta: string | undefined;
          if (shellOut.trim()) {
            bodyMeta = 'output';
            bodyLines = capTranscriptBody(shellOut.split('\n')).map((l) => ({ text: l, color: C.dim }));
          } else if (diff && diff.length) {
            bodyMeta = 'diff';
            bodyLines = capTranscriptBody(diff.map((d) => `${d.tag} ${d.text}`)).map((text) => {
              const tag = text.startsWith('+') ? '+' : text.startsWith('-') ? '-' : ' ';
              return {
                text,
                color: tag === '+' ? C.green : tag === '-' ? C.red : undefined,
                dimColor: tag === ' ' || text.startsWith('…'),
              };
            });
          } else if (e.call.name === 'agent') {
            // The sub-agent's full answer IS its result. Surface it as a foldable body so the
            // delegated work is VISIBLE — the header's one-line preview is only a gist, and without
            // this a long exploration answer is truncated to ~90 chars with no way to read the rest.
            // Same cap+collapse rules as shell output, so a huge answer can't flood the transcript.
            const ans = (e.result.data as { answer?: string } | undefined)?.answer;
            if (ans && ans.trim()) {
              bodyMeta = 'answer';
              // Model text, not terminal output — no legitimate SGR source, so strip every
              // escape before render (F05-04).
              bodyLines = capTranscriptBody(sanitizeTerminalEscapes(ans, false).split('\n')).map((l) => ({ text: l, color: C.dim }));
            }
          }
          // Diff headers: just the calm `+N −M` stats (redesign: Update(path) — +12 −3). The
          // model-facing "Edited path — replaced N occurrence(s)" is redundant once the display
          // name + arg already name the file. Shell / other tools keep their one-line summary.
          let summary = oneLine(e.result.summary);
          if (bodyMeta === 'diff' && bodyLines) {
            const stats = formatDiffStats(bodyLines);
            if (stats && isWriteTool(e.call.name)) summary = stats;
            else if (stats) summary = summary ? `${summary} · ${stats}` : stats;
          }
          pushLine({
            kind: 'tool',
            text: `${e.result.ok ? '✓' : '✗'} ${e.call.name} ${Math.max(0, Math.round(e.result.meta.durationMs))}ms — ${summary}`,
            color: e.result.ok ? C.green : C.red,
            meta: bodyMeta ?? e.call.name,
            tool: {
              name: e.call.name,
              arg: previewOf(e.call.input) || undefined,
              ok: e.result.ok,
              durationMs: Math.max(0, e.result.meta.durationMs),
              summary,
              agent: e.call.name === 'agent' ? agentAttr(e.call.input) : undefined,
            },
            lines: bodyLines,
          });
          // view_image returns the image it loaded into model context — echo it inline so the user
          // can see what the model is looking at (the tool result alone is just a path string).
          if (e.call.name === 'view_image') {
            const im = (e.result as { images?: { mediaType: string; data: string }[] }).images?.[0];
            if (im) pushImage(im.data, im.mediaType, previewOf(e.call.input) || 'view_image', 'view_image');
          }
          // Rare: both shell capture AND a UI diff on the same call — nest shell above, keep
          // the diff as its own foldable sibling so neither body is dropped.
          if (shellOut.trim() && diff && diff.length) {
            const diffLines = capTranscriptBody(diff.map((d) => `${d.tag} ${d.text}`)).map((text) => {
              const tag = text.startsWith('+') ? '+' : text.startsWith('-') ? '-' : ' ';
              return {
                text,
                color: tag === '+' ? C.green : tag === '-' ? C.red : undefined,
                dimColor: tag === ' ' || text.startsWith('…'),
              };
            });
            const stats = formatDiffStats(diffLines);
            pushLine({
              kind: 'tool',
              text: stats ? `diff ${stats}` : '',
              meta: 'diff',
              lines: diffLines,
              tool: stats
                ? {
                    name: 'diff',
                    ok: e.result.ok,
                    durationMs: 0,
                    summary: stats,
                  }
                : undefined,
            });
          }
          break;
        }
        case 'tool_denied':
          if (e.subagent) {
            // Sub-agent tool denied → clear its current-tool line; never touch the parent's live row.
            setSubAgents((prev) => {
              const cur = prev.get(e.subagent!);
              if (!cur || !cur.tool) return prev;
              const m = new Map(prev);
              m.set(e.subagent!, { ...cur, tool: undefined, argPreview: undefined });
              return m;
            });
            break;
          }
          clearToolLine();
          setActiveTool(null);
          pushLine({ kind: 'blocked', text: `  blocked ${friendlyDeniedReason(e.reason)}`, color: C.yellow, meta: e.call.name });
          break;
        case 'retry':
          pushLine({
            text: `  retry ${e.attempt} in ${e.delayMs}ms (${oneLine(e.reason)})`,
            dimColor: true,
          });
          break;
        case 'error': {
          pushLine({ kind: 'error', text: `  ! ${e.message}`, color: C.red });
          // Actionable recovery hint under the raw error (dim ↳ line) — tells the user WHAT TO DO
          // (lower tokens / re-auth / check the endpoint / /model), not just what failed.
          const hint = providerErrorHint(e.message);
          if (hint) pushLine({ text: `  ↳ ${hint}`, dimColor: true });
          break;
        }
        case 'autonomy':
          setAutonomy(e.level);
          break;
        case 'compaction':
          pushLine(
            e.degraded
              ? {
                  text: '  ⟳ context reclaimed locally — summarizer unavailable, no summary written',
                  color: C.yellow,
                }
              : {
                  text: '  ⟳ context compacted — earlier turns summarized to free up room',
                  color: C.cyan,
                },
          );
          break;
        case 'usage':
          lastUsageRef.current = e;
          setStatus(formatUsage(e));
          // Accumulate SESSION cost AND tokens from per-turn usage deltas (the Budget resets
          // each turn, so summing raw events would double-count within a turn). P1B-03.
          {
            const dCost = e.costUSD - prevTurnCostRef.current;
            if (dCost > 0) sessionCostRef.current += dCost;
            prevTurnCostRef.current = e.costUSD;
            const dIn = e.inputTokens - prevTurnInTokRef.current;
            if (dIn > 0) sessionInTokRef.current += dIn;
            prevTurnInTokRef.current = e.inputTokens;
            const dOut = e.outputTokens - prevTurnOutTokRef.current;
            if (dOut > 0) sessionOutTokRef.current += dOut;
            prevTurnOutTokRef.current = e.outputTokens;
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
        case 'subagent_start':
          // A sub-agent came alive (sync or bg) — register it in the Running-N-agents panel (BUG 3)
          // with its counters seeded. `background` keeps it visible after the launching turn ends.
          // F06-10: an agent waiting on a concurrency slot arrives with `queued: true`; admission
          // RE-EMITS for the same taskId with queued cleared — re-registration is safe because the
          // loop hasn't run yet, so the seeded zero counters cannot clobber real activity.
          setSubAgents((prev) => {
            const m = new Map(prev);
            m.set(e.taskId, {
              taskId: e.taskId,
              subagentType: e.subagentType,
              description: e.description,
              background: e.background ?? false,
              queued: e.queued ?? false,
              toolUseCount: 0,
              inputTokens: 0,
              outputTokens: 0,
              startedAt: Date.now(),
            });
            return m;
          });
          break;
        case 'subagent_end':
          // The sub-agent finished. A SYNC agent's answer commits as the `agent` tool result, so its
          // panel row is removed. A BACKGROUND agent has no such transcript row yet (its result
          // arrives later as a task-notification), so mark it done and LINGER — F10-02: it must stay
          // visible through completion, and clears on the next user turn (see startTurn).
          // T1: a BACKGROUND sub-agent finishing has no transcript cue (its panel row just flips
          // to done) — ping over the same channel as long turns, so a user who tabbed away while
          // a delegated job ran is called back. Sync agents commit their result inline; no ping.
          {
            const bg = subAgentsRef.current.get(e.taskId);
            if (bg?.background) {
              emitNotification(opts.cfg.notify ?? 'auto', 'Shadow', `Sub-agent ${bg.subagentType} ${e.ok ? 'finished' : 'failed'}`, { isTTY: !!process.stdout.isTTY });
            }
          }
          setSubAgents((prev) => {
            const cur = prev.get(e.taskId);
            if (!cur) return prev;
            const m = new Map(prev);
            if (cur.background) m.set(e.taskId, { ...cur, done: true, ok: e.ok, tool: undefined, argPreview: undefined });
            else m.delete(e.taskId);
            return m;
          });
          break;
        case 'subagent_usage':
          // A finished sub-agent's TOTAL spend, reported once. Deliberately does NOT touch
          // `setStatus` or `prevTurnCostRef`: sub-agents run on their own Budget, and letting their
          // per-turn usage through was what overwrote the HUD with a foreign context % and made the
          // parent's next cost delta meaningless. Session cost still accrues, so /cost stays honest.
          if (e.costUSD > 0) sessionCostRef.current += e.costUSD;
          // Sub-agent tokens accrue to the SESSION totals too (they ran on the user's behalf).
          if (e.inputTokens) sessionInTokRef.current += e.inputTokens;
          if (e.outputTokens) sessionOutTokRef.current += e.outputTokens;
          // Attribute the tokens to the exact agent row (taskId) so the panel shows real scale.
          if (e.taskId && (e.inputTokens || e.outputTokens)) {
            setSubAgents((prev) => {
              const cur = prev.get(e.taskId!);
              if (!cur) return prev;
              const m = new Map(prev);
              m.set(e.taskId!, { ...cur, inputTokens: e.inputTokens ?? cur.inputTokens, outputTokens: e.outputTokens ?? cur.outputTokens });
              return m;
            });
          }
          break;
        case 'todo':
          setTodoItems(e.items);
          break;
        case 'plan_mode':
          setPlanMode(e.plan);
          break;
        case 'mission': {
          // Phase transitions toast once (a task-status update alone doesn't); the row
          // itself repaints via missionSnap on every event.
          const prev = missionRef.current;
          setMissionSnap(e.mission);
          if (prev?.active && e.mission.active && prev.phase !== e.mission.phase) {
            showToast(`mission → ${e.mission.phase}`, 'info');
          }
          break;
        }
        case 'shell_output':
          // Live shell preview = the LAST non-empty output line only, capped — the raw chunks used to
          // accumulate unbounded into this state, ballooning the live region (and the composer with it)
          // during chatty commands. Full output still lands in the transcript via tool_end. Merge
          // + flush semantics live in the shellRawRef block above (throttled, full-text sanitize).
          shellRawRef.current += e.chunk;
          if (shellTimerRef.current == null) {
            shellFlush();
            shellTimerRef.current = setTimeout(() => {
              shellTimerRef.current = null;
              if (shellDirtyRef.current) {
                shellDirtyRef.current = false;
                shellFlush();
              }
            }, SHELL_FLUSH_MS);
          } else {
            shellDirtyRef.current = true;
          }
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
          lastStopReasonRef.current = e.reason;
          // Keep the /rewind menu honest: a turn just produced (or failed to produce) a snapshot.
          refreshRewindTurns();
          // Interrupted mid-answer (Esc/Ctrl-C) before assistant_done? Commit whatever
          // streamed so the partial reply lands in scrollback instead of vanishing. On a
          // clean turn the buffer is already empty here, so this is a no-op.
          if (streamBufRef.current.trim()) {
            const display = sanitizeAssistantText(streamBufRef.current);
            if (display.trim()) pushLine({ kind: 'assistant', text: stripTrailingNewlines(display), color: C.fg, meta: 'assistant', tight: answerOpenRef.current && !padCarryRef.current && !leadsWithBlock(display) });
          }
          answerOpenRef.current = false;
          padCarryRef.current = false;
          // Full live-state cleanup: also clear the THINKING indicator + buffers. An Esc mid-reasoning
          // (or a provider throw) used to strand a stuck "✻ Thinking…" line because stop only cleared
          // the stream side; and stale buf/pending refs could leak a ghost flush into the next turn.
          streamBufRef.current = '';
          thinkBufRef.current = '';
          thinkStartedAtRef.current = null;
          pendingStreamRef.current = null;
          pendingThinkRef.current = null;
          setStreamNow('');
          setThinkNow('');
          clearToolLine();
          setActiveTool(null);
          setLiveRecon(null);
          setShellPid(null);
          setShellWarn(null);
          if (e.reason !== 'end_turn') pushLine({ text: `  · ${e.reason}`, dimColor: true });
          // P1B-04: ping when a LONG turn finishes, so the user can tab away during a slow
          // self-hosted run and be called back. Guarded to a TTY (never into a pipe) and to turns
          // past the threshold; `notify: off` silences it.
          if (Date.now() - runStartRef.current >= NOTIFY_MIN_TURN_MS) {
            emitNotification(
              opts.cfg.notify ?? 'auto',
              'Shadow',
              e.reason === 'end_turn' ? 'Turn complete' : `Turn ended · ${e.reason}`,
              { isTTY: !!process.stdout.isTTY },
            );
          }
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
          // This task may have come from the FIFO. A denied prompt must not strand whatever was
          // behind it merely because runOne returned before reaching its normal finally block.
          queueMicrotask(() => flushQueueRef.current?.());
          return;
        }
        // F08-09: an exit-0 hook may contribute additional context — it joins what the model sees
        // (the echoed prompt line stays clean, exactly like @-file inlining).
        if (h.context) task = `${task}\n\nAdditional context (user_prompt_submit hook):\n${h.context}`;
      }
      runningRef.current = true;
      setRunning(true);
      // Process-wide run lock: exactly one turn executes at a time across the TUI and every web
      // session (decision 1 — two agents in one repo corrupt each other). priority:true — the
      // operator at the terminal must never be starved behind browser sessions. The controller is
      // created HERE (was at the old :3836) so ESC cancels the queued wait too; its signal is
      // reused for the loop below. Acquire at the :3802/:3803 seam: `running` is the ONLY state
      // set so far, so the abort path is a clean early return that stays OUTSIDE the try below —
      // acquiring later (after context.pinTask/firstRef) would strand the TUI at running===true.
      const controller = new AbortController();
      controllerRef.current = controller;
      let releaseLock: (() => void) | null = null;
      try {
        releaseLock = await runLock.acquire(CLI_HOLDER, { priority: true, signal: controller.signal });
      } catch {
        // ESC while queued behind another session: nothing but `running` (and the controller) has
        // been touched. Re-enable the composer and drain type-ahead, exactly as a finished turn does.
        controllerRef.current = null;
        runningRef.current = false;
        setRunning(false);
        flushQueueRef.current?.();
        return;
      }
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

      // Fold any background sub-agent results into THIS user turn (index.ts parity — the
      // TUI never drained them, so a bg agent's answer never reached the model in TUI
      // sessions). Drained ONLY here at the turn-build seam via the named helper —
      // see src/tui/turnInput.ts for why this is never done anywhere else.
      const taskText = drainTurnInput(task, opts.pendingNotifications);
      // Prepend any queued /image attachments, then clear the buffer (one-shot per message).
      const imgs = attachmentsRef.current;
      // `taskText` (not `task`): an image-only send can still carry DRAINED background-agent
      // results — gating on `task` here silently dropped them (drain already emptied the queue).
      const content: ContentBlock[] = taskText ? [{ type: 'text', text: taskText }] : [];
      content.push(...imgs);
      if (imgs.length) {
        attachmentsRef.current = [];
        setAttachCount(0);
      }
      const userMsg: Message = { role: 'user', content: content.length ? content : [{ type: 'text', text: taskText }] };
      if (firstRef.current) {
        context.pinTask(userMsg);
        firstRef.current = false;
      } else {
        context.append(userMsg);
      }
      sessionLogRef.current.record({ kind: 'user', task });
      // For non-terminal subscribers (the `--web` mirror). The TUI has already echoed this
      // locally via pushLine, and its own bus switch has no case for 'user', so this cannot
      // double-render here.
      bus.emit({ type: 'user', text: task });

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
      const deps = buildLoopDeps({
        cfg: opts.cfg,
        provider: providerRef.current,
        registry: opts.registry,
        gate: gateRef.current!,
        bus,
        budget,
        context,
        signal: controller.signal,
        // LIVE model, resolved per turn — a /model switch changes the family mid-session
        // and parallelTools is derived from whatever is passed here.
        model: currentRef.current.model,
        // The mission block now comes from the LOOP (deps.mission → mission.block() pinned
        // into the system prompt each turn, plan/todo parity) — the TUI no longer injects a
        // standing-goal suffix here, so the two could never disagree mid-mission.
        system: opts.styleState?.systemForStyle?.(styleRef.current) ?? opts.system,
        workspaceRoot: opts.workspaceRoot,
        additionalRoots: additionalRootsRef.current,
        forceConfirm: opts.forceConfirm,
        todoList: opts.todoList,
        planMode: opts.planMode,
        mission: opts.mission,
        streamShell: true,
        // P2-11 (/fork): read through the ref so a turn that runs AFTER a /fork writes to the
        // forked session log, not the pre-fork one the app was mounted with.
        sessionLog: sessionLogRef.current,
        // One instance for the whole SESSION. A new AgentLoop is built for every user message, so
        // grants held on the loop itself expired as soon as the user typed again — "(s) approve for
        // session" re-prompted one message later.
        approvals: sessionApprovalsRef.current,
        priorStopReason: lastStopReasonRef.current,
        // mission continuity rides the loop's compaction continuity (deps.mission), not the TUI.
        resolveFallback: async (entry, fallbackSignal) => {
          fallbackSignal?.throwIfAborted();
          const build = buildProviderRef.current;
          if (!build) throw new Error('fallback provider builder is unavailable');
          const built = await build(entry, { applyPolicy: () => !fallbackSignal?.aborted });
          fallbackSignal?.throwIfAborted();
          if (!built.ok) throw new Error(built.error);
          providerRef.current = built.client;
          currentRef.current = { provider: built.provider, model: built.model };
          activeTargetRef.current = { baseUrl: built.baseUrl, selfHosted: built.selfHosted };
          opts.cfg.provider = built.provider;
          opts.cfg.model = built.model;
          setCurrent({ provider: built.provider, model: built.model });
          opts.onModelSwitch?.(built.client, built.model);
          return { provider: built.client, model: built.model };
        },
      });
      const loop = new AgentLoop(deps, autonomyRef.current);
      loopRef.current = loop;
      try {
        await loop.run();
      } catch (err) {
        pushLine({ text: `  ! ${(err as Error).message}`, color: C.red });
      } finally {
        // Release the run lock in the finally around the awaited loop — NEVER off a `stop` event:
        // sub-agents reuse the parent bus, so a sub-agent's `stop` is byte-identical on the wire and
        // would unlock mid-turn on the first sub-agent completion. Idempotent, so double-call is safe.
        releaseLock?.();
        loopRef.current = null;
        controllerRef.current = null;
        // Full live-state teardown, mirroring the 'stop' handler. A provider throw that never
        // reaches 'stop' (non-abort stream error with no fallback) used to strand non-empty
        // stream/think state — which keeps the Turn HUD mounted (its gate includes them) as a
        // stuck fixed-height box with a blank status row. Commit any streamed tail first so an
        // errored turn still leaves its partial answer in the transcript.
        if (streamBufRef.current.trim()) {
          const display = sanitizeAssistantText(streamBufRef.current);
          if (display.trim()) pushLine({ kind: 'assistant', text: stripTrailingNewlines(display), color: C.fg, meta: 'assistant', tight: answerOpenRef.current && !padCarryRef.current && !leadsWithBlock(display) });
        }
        answerOpenRef.current = false;
        padCarryRef.current = false;
        streamBufRef.current = '';
        thinkBufRef.current = '';
        pendingStreamRef.current = null;
        pendingThinkRef.current = null;
        setStreamNow('');
        setThinkNow('');
        clearToolLine();
        setActiveTool(null);
        setLiveRecon(null);
        runningRef.current = false;
        setRunning(false);
        // Per-task timer: total wall-clock the agent worked on this turn — paralleling the
        // per-tool `(2.3s)` and per-thought `thought for 9s`, but for the whole task. Only when
        // it took ≥1s; a sub-second turn is noise. Emitted here (the single turn-end choke
        // point) so success, error, and abort all report how long the agent spent.
        const turnSec = Math.max(0, Math.round((Date.now() - runStartRef.current) / 1000));
        if (turnSec >= 1) {
          pushLine({ text: `⏺ done · ${formatDuration(turnSec)}`, dimColor: true });
        }
        // Turn ended — drain any type-ahead the user queued while it ran. flushQueue
        // either starts the next queued turn (which re-enters this finally on its own
        // completion) or runs queued slash commands in order.
        flushQueueRef.current?.();
      }
    },
    // sessionLogRef (not sessionLog) — the ref is stable across the /fork swap, and the log is
    // read at call time through it, so a fork never needs to rebuild this callback.
    [opts, context, sessionLogRef, bus, pushLine],
  );
  runOneRef.current = (task: string) => {
    void runOne(task);
  };

  // Start a fresh turn exactly as an idle Enter would: print the `❯ task` user line, then
  // drive the loop. (The welcome banner is already committed to <Static> at startup, so there
  // is nothing to commit here.) Shared by the idle-submit path and the type-ahead queue flush.
  const startTurn = useCallback(
    (task: string) => {
      // P1A-15: every turn start (direct AND queued — flushQueue routes through here) returns the
      // composer to INSERT when vim is on. A turn launched from NORMAL mode otherwise stranded the
      // user there when it ended: the vim key block is gated on !runningRef, so during the turn keys
      // fell through, and after it the composer was still in NORMAL and swallowed typing as motions.
      if (vimEnabledRef.current && vimModeRef.current !== 'insert') setVimMode('insert');
      // F10-02: clear FINISHED background-agent rows that lingered from the previous turn (the user
      // has moved on). Still-running agents stay so a long bg job spans turns visibly.
      setSubAgents((prev) => {
        if (![...prev.values()].some((a) => a.done)) return prev;
        const m = new Map<string, SubAgentView>();
        for (const [id, a] of prev) if (!a.done) m.set(id, a);
        return m;
      });
      // T1: drop any stale transient toast — a "Theme → …" from the previous turn should not
      // linger while a new turn streams. (The expiry timer is a backstop; this is the guarantee.)
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
      setToast(null);
      // Commit the finished turn's cost into the session total baseline, then reset
      // the per-turn cursors so the next turn's usage deltas accumulate from 0 (P1B-03).
      prevTurnCostRef.current = 0;
      prevTurnInTokRef.current = 0;
      prevTurnOutTokRef.current = 0;
      sessionTurnsRef.current += 1;
      // New turn → the verbatim-repeat detector starts fresh (an identical short answer in this
      // turn is real, not a repeat of the last turn's).
      answerRunRef.current = [];
      repeatPosRef.current = 0;
      const nImg = attachmentsRef.current.length;
      const userText = task || `📎 ${nImg} image${nImg === 1 ? '' : 's'}`;
      pushLine({ kind: 'user', text: `❯ ${userText}`, color: C.green, bold: true, meta: 'you' });
      // F08-04: the echo above shows what the user typed (`@path` visible); the MODEL gets the
      // referenced files inlined so it doesn't need a read_file round-trip. Unresolved @tokens stay
      // literal text.
      void runOne(expandFileMentions(task, opts.workspaceRoot));
    },
    [pushLine, runOne, opts.workspaceRoot],
  );
  startTurnRef.current = startTurn;

  // ── Collaboration Mode (experimental round-table) ─────────────────────────────
  // A hand-off is a scoped, non-persistent selectModel: point the live provider at the seat, tag its
  // turns, run ONE turn against the shared Context, then clear the tag (baton returns to the human).
  // No saveGlobalConfig, no picker — the whole feature rides buildProvider + runOne + the shared Context.
  const routeToSeat = useCallback(
    async (seat: Seat, question: string) => {
      // Guard the whole route, including the buildProvider await (a local seat's server spawn does real
      // I/O): routeInFlightRef blocks a second Enter from starting a concurrent turn on the shared
      // Context before runOne flips `running`. Cleared in the finally so the baton always frees up.
      routeInFlightRef.current = true;
      try {
        const build = buildProviderRef.current;
        if (!build) return;
        const built = await build(seat.entry);
        if (!built.ok) {
          pushLine({ text: `  @${seat.handle}: ${built.error}`, color: built.fatal ? C.red : C.yellow });
          return;
        }
        providerRef.current = built.client;
        currentRef.current = { provider: built.provider, model: built.model }; // set imperatively BEFORE runOne captures it
        activeTargetRef.current = { baseUrl: built.baseUrl, selfHosted: built.selfHosted };
        setCurrent({ provider: built.provider, model: built.model }); // footer follows the active seat
        speakerRef.current = seatTag(seat);
        await runOne(question);
      } finally {
        speakerRef.current = null; // baton returns to the human
        routeInFlightRef.current = false;
        flushQueueRef.current?.();
      }
    },
    [pushLine, runOne],
  );

  const endTable = useCallback(() => {
    const pre = preTableRef.current;
    if (pre) {
      providerRef.current = pre.client;
      currentRef.current = { provider: pre.provider, model: pre.model };
      activeTargetRef.current = pre.target;
      loopRef.current?.setProvider(pre.client, pre.model);
      context.setPolicy(pre.policy, true);
      opts.cfg.contextBudget = pre.policy.contextBudget;
      opts.cfg.summarizeTriggerRatio = pre.policy.triggerRatio;
      opts.cfg.keepLastTurns = pre.policy.keepLastTurns;
      setCurrent({ provider: pre.provider, model: pre.model });
      preTableRef.current = null;
    }
    speakerRef.current = null;
    tableRef.current = null;
    setTable(null);
    pushLine({ text: 'Round-table ended — back to your single model.', color: C.cyan });
  }, [pushLine, context, opts.cfg]);

  const startTable = useCallback(
    (arg: string) => {
      if (tableRef.current) {
        pushLine({ text: 'A round-table is already active — /table done to end it first.', color: C.yellow });
        return;
      }
      const names = arg.split(/\s+/).filter(Boolean);
      const listModels = () =>
        pushLine({
          kind: 'system',
          text: 'table-help',
          lines: [
            { text: `Collaboration Mode (experimental) — a live round-table you steer.`, bold: true },
            { text: `  /table <model> <model> [model…]   — pick ${MIN_SEATS}–${MAX_SEATS} models, e.g. /table grok glm`, dimColor: true },
            { text: `  Then: @handle <question> routes a turn · /pass @handle forwards · /table done ends.`, dimColor: true },
            { text: `  Configured models:`, dimColor: true },
            ...opts.cfg.models
              .filter((m) => !m.disabled)
              .slice(0, 12)
              .map((m) => ({ text: `    ${m.label}  (${m.provider}/${m.model})`, dimColor: true })),
          ],
        });
      if (names.length < MIN_SEATS) {
        listModels();
        return;
      }
      const { entries, errors } = resolveTableEntries(names, opts.cfg.models);
      if (errors.length) {
        pushLine({ text: `No model matches: ${errors.join(', ')} — see /model list.`, color: C.yellow });
        return;
      }
      if (entries.length < MIN_SEATS) {
        pushLine({ text: `Pick at least ${MIN_SEATS} distinct models.`, color: C.yellow });
        return;
      }
      const seats = buildSeats(entries.slice(0, MAX_SEATS), [C.cyan, C.purple, C.yellow, C.red]);
      preTableRef.current = {
        client: providerRef.current,
        provider: currentRef.current.provider as ProviderName,
        model: currentRef.current.model,
        target: { ...activeTargetRef.current },
        policy: context.policy(),
      };
      const nextTable = { seats };
      tableRef.current = nextTable; // queue flushing reads the ref before React's state commit
      setTable(nextTable);
      pushLine({
        kind: 'system',
        text: 'table-open',
        lines: [
          { text: `◆ round-table · ${seats.length} seats · you hold the baton`, color: BATON_ORANGE, bold: true },
          ...seats.map((s) => ({ text: `  ⏺ @${s.handle}  ${s.provider}/${s.model}`, color: s.color })),
          { text: `  @${seats[0]!.handle} <question> to route · /pass @handle forwards · /table done ends`, dimColor: true },
        ],
      });
    },
    [pushLine, opts, context],
  );

  startTableRef.current = startTable;

  const handleTableInput = useCallback(
    (raw: string) => {
      const t = tableRef.current;
      if (!t) return;
      const cmd = parseTableInput(raw, t.seats.map((s) => s.handle));
      switch (cmd.kind) {
        case 'done':
          endTable();
          break;
        case 'note':
          pushLine({ text: `Address a model with @${t.seats[0]!.handle} <question>, or /table done to end.`, dimColor: true });
          break;
        case 'pausedSlash':
          // F02-06: the composer belongs to the table while it is active — name the pause instead
          // of answering an unrelated hint, which read as a swallowed keystroke.
          pushLine({
            text: `${cmd.command} is paused while the round-table is active — /table done ends it.`,
            color: C.yellow,
          });
          break;
        case 'unknownHandle':
          pushLine({ text: `No seat "@${cmd.handle}". Seats: ${t.seats.map((s) => '@' + s.handle).join(' ')}.`, color: C.yellow });
          break;
        case 'route': {
          const seat = t.seats.find((s) => s.handle === cmd.handle)!;
          pushLine({ kind: 'user', text: `❯ @${seat.handle} ${cmd.question || '(your take?)'}`, color: C.green, bold: true, meta: 'you' });
          void routeToSeat(seat, cmd.question || 'Please weigh in on the discussion above.');
          break;
        }
        case 'pass': {
          const seat = t.seats.find((s) => s.handle === cmd.handle)!;
          pushLine({ text: `↳ passed the floor to @${seat.handle}`, dimColor: true });
          void routeToSeat(seat, 'Please continue from the discussion above — your take?');
          break;
        }
      }
    },
    [pushLine, endTable, routeToSeat],
  );
  handleTableInputRef.current = handleTableInput;

  // Flush pending input in FIFO order. Most slash commands are synchronous, but compaction and
  // model activation are explicit barriers: their own finally blocks resume the drain only after
  // shared context/provider state is coherent. A plain message starts a turn and stops the drain.
  const flushQueue = useCallback(() => {
    while (queuedTasksRef.current.length > 0) {
      const [next, ...rest] = queuedTasksRef.current;
      setQueued(rest);
      const task = (next?.text ?? '').trim();
      if (!task) continue;
      if (tableRef.current) {
        handleTableInputRef.current?.(task);
        if (routeInFlightRef.current || runningRef.current) return;
        continue;
      }
      if (task.startsWith('/')) {
        const s = classifySlash(task, customCommandsRef.current);
        if (s.kind === 'command') {
          runSlash(s.cmd!, task);
          if (runningRef.current || compactingRef.current || modelSwitchingRef.current || asyncCommandRef.current) return;
          continue;
        }
        if (s.kind === 'typo') {
          pushLine({ text: `Unknown command: ${task.split(/\s+/)[0]} — type / for the list.`, color: C.red });
          continue;
        }
        // 'message' — a path — fall through to startTurn
      }
      // Chips STAY in the registry after submit (same rule as the composer owner's submit path):
      // a history entry recalled with ↑ re-renders its chip, so a re-run must still resolve it.
      // Starts a turn; its completion resumes the drain.
      startTurn(expandPastes(task, pastesRef.current));
      return;
    }
  }, [setQueued, runSlash, pushLine, startTurn]);
  flushQueueRef.current = flushQueue;

  // Key handling — P3-01 focus-owner router. The old ~900-line ordered if-chain is now an
  // explicit owner table (src/tui/keys/router.ts): exactly one owner per frame claims the
  // keystream (dialog → picker → search → vim → composer; table order = precedence, snapshot-
  // pinned), reserved chords (Ctrl-C/Ctrl-D exit arming, Ctrl-X editor arming) resolve BEFORE
  // routing, and mouse/DSR/bracketed-paste are transports ABOVE the owners (P1A-14). Each
  // owner module is a verbatim extraction of its old if-chain section — the byte-level TUI
  // suites are the acceptance witness for "no behavior change".
  const onKey = useCallback(
    (ch: string, key: import('ink').Key) => {
      // The env is the compile-checked bridge between the component and the key modules:
      // stable refs + useCallback actions, built per keystroke so every owner reads live
      // state exactly as the old inline chain did.
      const env: KeyEnv = {
        rawChunkRef,
        rawKeyRef,
        ctrlCArmedRef,
        ctrlXArmedRef,
        pastingRef,
        pasteBufRef,
        pendingRef,
        igateRef,
        dialogShownAtRef,
        dialogTypeaheadRef,
        autoAnswerEngagedRef,
        autoAnswerSecsRef,
        questionIndexRef,
        questionCursorRef,
        pickerOpenRef,
        pickerIndexRef,
        searchRef,
        vimEnabledRef,
        vimModeRef,
        vimPendingRef,
        vimCountRef,
        vimFindRef,
        vimRegRef,
        inputRef,
        cursorRef,
        goalColRef,
        historyRef,
        histIdxRef,
        draftRef,
        menuIndexRef,
        killRingRef,
        undoRef,
        pastesRef,
        attachmentsRef,
        autonomyRef,
        argCtxRef,
        customCommandsRef,
        tableRef,
        handleTableInputRef,
        runningRef,
        controllerRef,
        loopRef,
        queuedTasksRef,
        compactingRef,
        compactAbortRef,
        streamBufRef,
        thinkBufRef,
        thinkStartedAtRef,
        pendingStreamRef,
        pendingThinkRef,
        answerOpenRef,
        padCarryRef,
        routeInFlightRef,
        modelSwitchingRef,
        asyncCommandRef,
        cfg: opts.cfg,
        planMode: opts.planMode,
        autoAnswerEnabled: AUTO_ANSWER_ENABLED,
        composerInnerWidth: () => Math.max(8, (process.stdout.columns ?? 80) - COMPOSER_GUTTER - PAGE_MARGIN * 2),
        exit,
        pushLine,
        setQueued,
        setLine,
        setComposer,
        setCursor,
        setMenuIndex,
        setPickerOpen,
        setPickerIndex,
        setVimMode,
        setQuestionCursor,
        setQuestionIndex,
        setAutoAnswerSecs,
        setAutonomy,
        insertPastable,
        setStreamNow,
        setThinkNow,
        applyEdit,
        moveCaret,
        pushUndo,
        handleMouse,
        openExternalEditor,
        applySearch,
        kbConsume,
        chooseAtQuestion,
        confirmQuestion,
        selectModel,
        runSlash,
        startTurn,
        ensureFileList,
        slashMatches,
        findSlashCommand,
        classifySlash,
        slashDispatchName,
        modelRows,
        sanitizeAssistantText,
      };
      // F03-05 follow-up — text coalesced with its Enter in ONE stdin read. Ink hands the whole
      // chunk to a single keypress event (input = keypress.sequence), so `ch` arrives as
      // `hello\r` with NO key.return; the composer used to insert `hello\n` (a phantom newline)
      // and the submit was silently swallowed — worst on slash commands typed across a busy
      // frame or a batching transport (tmux/SSH). Sanitize and replay: the text, then a
      // synthetic Enter — exactly the two events the terminal would have delivered separately.
      // batchedTextReturn's printable-only match excludes ESC-led transports and multi-line
      // text, and only a BARE \r (a typed Enter) matches — trailing \n / \r\n are paste
      // signatures and insert as literal text; the pastingRef gate keeps bracketed-paste
      // bodies literal (see keys/common.ts).
      const rawChunk = rawChunkRef.current;
      const batchedText = rawChunk && !pastingRef.current ? batchedTextReturn(rawChunk) : null;
      if (
        batchedText !== null &&
        !key.return && !key.ctrl && !key.meta &&
        (ch === batchedText || ch === rawChunk)
      ) {
        dispatchKey(env, batchedText, key);
        dispatchKey(env, '\r', SYNTH_RETURN_KEY);
        return;
      }
      dispatchKey(env, ch, key);
    },
    [exit, pushLine, runSlash, selectModel, setAutonomy, setComposer, setLine, setQuestionIndex, opts, startTurn, setQueued, kbConsume, insertPastable, setStreamNow, setThinkNow, applyEdit, moveCaret, pushUndo, handleMouse, openExternalEditor, applySearch, chooseAtQuestion, confirmQuestion, setCursor, setMenuIndex, setPickerOpen, setPickerIndex, setVimMode, setQuestionCursor, setAutoAnswerSecs, ensureFileList],
  );

  useInput(onKey);

  // Bracketed paste (DECSET 2004) — default ON. Terminals that support it wrap every paste
  // in \x1b[200~ … \x1b[201~ so the key handler can insert it atomically (see step 2.8);
  // terminals that don't simply ignore the mode and pastes take the legacy per-chunk path.
  // Unlike mouse reporting this takes nothing away from the terminal, so it needs no opt-in.
  // Claimed through the terminal owner (tui/terminalState.ts) rather than written directly: a
  // React destructor does not run when the process dies on a signal, so `2004l` was never sent on
  // a kill/crash and the user's shell was left showing literal `200~` markers around every paste.
  useEffect(() => {
    if (!process.stdout.isTTY) return;
    claimMode('bracketed-paste', '\x1b[?2004h', '\x1b[?2004l');
    return () => releaseMode('bracketed-paste');
  }, []);

  // Mouse reporting (DECSET 1000 + SGR 1006) for click-to-place-caret. OPT-IN ONLY.
  //
  // Enabling it routes the WHEEL to the app, so the terminal stops scrolling its own scrollback.
  // That is a bad trade for this project and it shipped on by default in 3.6.0 — worse, mode 1000
  // is a TERMINAL-level mode that survives the process: a session killed before the cleanup
  // effect ran left the user's terminal stuck reporting mouse events with nothing listening.
  // The reset is now also bound to process exit and to the fatal signals, so no exit path can
  // strand a terminal again.
  useEffect(() => {
    if (!process.stdout.isTTY) return;
    if (!mouseEnabled) return;
    // The owner installs ONE re-raising signal handler for every mode. The version here used
    // `process.once(sig, off)`, which overrides Node's default disposition — so with mouse
    // reporting on, the process SURVIVED SIGINT and SIGHUP and orphaned itself when the terminal
    // closed. Cleaning up must not cost killability.
    claimMode('mouse', '\x1b[?1000h\x1b[?1006h', '\x1b[?1000l\x1b[?1006l');
    return () => releaseMode('mouse');
  }, [mouseEnabled]);

  const spinner = SPINNER[tick % SPINNER.length];
  // Elapsed seconds of the current turn — re-derived each spinner tick (~120ms) so a
  // slow/stalled model reads as "still waiting", not a frozen UI.
  const elapsedSec = running ? Math.floor((Date.now() - runStartRef.current) / 1000) : 0;
  const todoDone = todoItems.filter((item) => item.status === 'completed').length;
  // Task list chrome: visible while there are items, and when the user has expanded via Ctrl-T
  // (so a finished list can still be inspected). Auto-hides only when collapsed + all done + idle.
  const showTodo =
    todoItems.length > 0 &&
    (running || todoDone < todoItems.length || !todoCollapsed);
  const todoStatus = showTodo ? ` · todo ${todoDone}/${todoItems.length}` : '';
  const planStatus = planMode.mode === 'planning' ? ' · plan: planning' : '';
  const showPlan = !!planMode.title;

  // Layout is consulted only for `cols` (Banner + status-strip width). The transcript
  // is an Ink <Static> that owns the terminal's native scrollback, so the vertical
  // chrome math never clips it; todo/plan render as a pinned block above the composer.
  const layout = computeLayout(terminalSize.cols, terminalSize.rows);
  // Tool-call stacking: group consecutive committed tools into runs so a tool-heavy turn collapses
  // to one summary row instead of flooding scrollback. P3-02: memoized on the append-only committed
  // array via the appendable cache — a pure spinner tick (setTick, no new lines) re-renders but
  // scans ZERO transcript slots (deps unchanged → useMemo skips; the cache ref extends the previous
  // run-map on append and is invalidated wholesale by Ctrl-O / repaint). The flatten.ts counters
  // (toolRunsStats.itemsScanned) are the instrumented proof.
  const toolRunsCacheRef = useRef<ToolRunsCache | undefined>(undefined);
  const toolRuns = useMemo(() => {
    const { runs, cache } = computeToolRunsAppendable(committed, showAllExpanded, toolRunsCacheRef.current);
    toolRunsCacheRef.current = cache;
    return runs;
  }, [committed, showAllExpanded]);
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
  // Constant live-slot budget (redesign: chrome never moves). fitHud may still drop these rows
  // on a tiny terminal; when they fit they stay reserved idle AND running so the composer does
  // not jump when a turn starts/ends or when thinking ↔ streaming swaps.
  const LIVE_SLOT_ROWS = 2;
  // Strip INPUT only — the string is formatted per host row (status line / composer hint), each
  // with the width actually left beside it, so formatStatusStrip's shrink ladder can do its job.
  const stripInput = {
    provider: current.provider,
    model: current.model,
    autonomy,
    bypass: opts.bypass,
    planStatus,
    todoStatus,
    effortStatus: ` · ${effortSymbol(effort)} ${effort}`,
    status,
    // T1: context pressure rides on the same merged row as the usage text — the gauge appears
    // exactly when the first usage event lands (there is nothing to measure before then).
    contextPct: lastUsageRef.current ? Math.round(lastUsageRef.current.contextPct * 100) : undefined,
    triggerRatio: opts.cfg.summarizeTriggerRatio,
  };
  // Refresh what the dynamic argument menus see, before the menu is built below.
  argCtxRef.current = {
    cfg: opts.cfg,
    workspaceRoot: opts.workspaceRoot,
    sessions: resumableRef.current ?? [],
    // Snapshot turns, in the SAME unit rewindToTurn consumes — see ArgContext.turns.
    turns: rewindableTurnsRef.current,
    extraRoots: additionalRootsRef.current,
  };
  // The slash menu shows whenever "/word" has matches — including while a turn runs, so you can
  // still autocomplete a command to queue it (or run a live-safe one). Only an active overlay
  // (approval / model picker) suppresses it.
  // Live settings surfaced inside argument menus (the "✓ current" row) — a picker that shows
  // where you ARE doubles as a status readout.
  // F08-04: when an `@`-token is being edited, the menu becomes a file picker (fuzzy over the
  // cached workspace walk). Mutually exclusive with the slash menu — a `/` line and an `@` token
  // can't both be the active token.
  const mentionTok = !pending && !pickerOpen ? atMentionToken(input, cursorRef.current) : null;
  const mentionMenu: SlashMenuItem[] = mentionTok
    ? rankFileCandidates(ensureFileList(), mentionTok.partial, 8).map((p) => ({
        name: `@${p}`,
        desc: 'file',
        mention: { start: mentionTok.start, path: p },
      }))
    : [];
  const menu = mentionMenu.length
    ? mentionMenu
    : !pending && !pickerOpen
    ? slashMatches(
        input,
        {
          '/theme': normalizeThemeName(opts.cfg.lastTheme as string | undefined) ?? 'og',
          '/effort': effortRef.current,
          '/autonomy': autonomy,
          '/style': style,
          '/vim': vimEnabled ? 'on' : 'off',
          '/fast': opts.cfg.fastMode ? 'on' : 'off',
        },
        argCtxRef.current,
        customCommandsRef.current,
      )
    : [];
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
  // Live slot: LIVE_SLOT_ROWS whenever there is (or is about to be) something live to show — a
  // running turn, a thought, an in-flight tool, an uncommitted stream tail. ZERO when the screen is
  // genuinely idle. It used to be reserved unconditionally so the composer could not move mid-turn,
  // but nothing ever renders into it while idle, so the reserve was two permanently BLANK rows
  // between the transcript and the input on every idle screen. The no-jump property that actually
  // matters still holds: the height is constant for the whole of a turn. (The content flags — not
  // `running` alone — because live events can arrive without this TUI owning the turn.)
  // F10-02: a running (or just-finished, lingering) sub-agent keeps the live slot open even after the
  // launching turn ends — a background agent must not vanish the moment its parent turn completes.
  const liveActive = running || !!think || !!stream || !!activeTool || subAgents.size > 0;
  const liveWant = menuOpen || !liveActive ? 0 : LIVE_SLOT_ROWS;
  // Pinned agent state: ONE line by default. Ctrl-T expands the full list (idle OR mid-turn).
  const todoCurrent = todoItems.find((t) => t.status === 'in_progress')?.subject ?? '';
  // Full multi-row PinnedState when expanded on a tall enough terminal. A GOAL alone never
  // drives the full block — it always rides the one-line summary.
  const wantFullBlock = !todoCollapsed && !!(showPlan || showTodo);
  const showFullPinned = wantFullBlock && terminalSize.rows >= 16;
  const hudPinnedLine = [
    goal, // missionHudLine(missionSnap) — 🎯 mission · phase n/m, one row
    showPlan ? `${planMode.mode === 'planning' ? 'plan' : 'implement'}: ${planMode.title ?? ''}` : '',
    showTodo
      // The glyph mirrors what actually RENDERED: '▾' only when the full block is truly open —
      // a short terminal keeps showFullPinned false even after Ctrl-T, so don't claim otherwise.
      ? `${showFullPinned ? '▾' : '▸'} tasks ${todoDone}/${todoItems.length}${todoCurrent ? ` · ${todoCurrent}` : ''} · Ctrl-T`
      : '',
  ].filter(Boolean).join('   ·   ');
  // Frame budget: keep the live (non-Static) frame strictly under the terminal height so Ink never
  // trips its whole-screen wipe on a short/split-pane terminal. Drives which optional rows render.
  const wantPinnedLine = hudPinnedLine !== '' && !menuOpen && (running || !showFullPinned);
  // Multi-row composer: budget real input height so the live frame stays under Ink's wipe line.
  // The visible input is capped by what the WHOLE frame can hold, not just the composer's own 2
  // rules. The old `rows - 3` ignored the pinned task list and the status strip, so a tall draft
  // overflowed even when the task list had already shrunk itself to zero items.
  const composerInnerW = Math.max(8, terminalSize.cols - COMPOSER_GUTTER - PAGE_MARGIN * 2);
  // Charge the 5-row pinned-block chrome only when the block is actually EXPANDED (Ctrl-T): the
  // default-collapsed state renders the 1-line summary, which fitHud accounts separately —
  // charging it anyway shrank the composer window at the 15-16 row floor for a block that
  // wasn't on screen.
  const maxComposerRows = composerMaxRows(
    terminalSize.rows,
    !todoCollapsed && !!(showPlan || showTodo),
    !!goal,
    !!(showPlan && planMode.path),
    !!customStatus,
  );
  // What will actually paint (window + a borrowed caret-only row when the caret ends a full row),
  // so the frame budget and the Composer component can never disagree about the box height.
  const composerInputRows = composerPaintRows(input, cursor, composerInnerW, maxComposerRows);
  const hudFit = fitHud(terminalSize.rows, {
    liveWant,
    liveBlank: !running, // idle slot = blank reserve; the hint outranks it on short terminals
    pinned: wantPinnedLine,
    queued: queued.length > 0 && !menuOpen,
    custom: !!customStatus,
    toast: !!toast,
    strip: false, // Phase B: strip merged into composer hint (idle) / status line (running)
    composerInputRows,
  });
  // T1: snapshot the fit + size so showToast can judge ladder headroom precisely (see its defn).
  lastHudFitRef.current = hudFit;
  terminalSizeRef.current = terminalSize;
  // Rows below the composer input for click-to-caret: bottom rule (1) + hint (if shown) + custom
  // status (if shown). When the slash menu is open below the composer, mark -1 so a click isn't
  // misread as caret placement. Read live by the mouse handler via belowComposerRef.
  belowComposerRef.current = menuOpen ? -1 : 1 + (hudFit.hint ? 1 : 0) + (customStatus && hudFit.custom ? 1 : 0);
  // reference-client style activity line: an orange pulsing sparkle (rendered separately, below) + a playful
  // per-turn verb + a quiet metric tail. No 'working… 0s · Esc to interrupt' clutter — the elapsed
  // only appears after a beat, and the interrupt hint already lives in the composer footer.
  const statusVerb = running ? `${DEFAULT_STATUS_VERB}…` : '';
  // SAFETY MARKERS ride OUTSIDE the strip so its shrink ladder can never drop them: OFFLINE is the
  // privacy contract's always-visible signal, sandbox:off is the "guardrails are OFF" warning.
  // They render as bold color badges instead of disappearing into the same quiet gray as model
  // metadata. The composer owns them whenever its hint row fits; the running line is the fallback
  // on tiny terminals, so a normal frame never repeats the same warning twice.
  const safetyMarkers: ChromeMarker[] = [
    ...(opts.offline ? [{ text: 'OFFLINE', color: C.cyan, bold: true }] : []),
    ...(opts.bypass ? [{ text: '⚠ sandbox:off', color: C.red, bold: true }] : []),
    // Transient, quiet, and LAST: a status, not a safety contract — it must never shove OFFLINE
    // or sandbox:off off the hint row on narrow terminals.
    ...(mcpConnecting ? [{ text: 'mcp: connecting…', color: C.dim }] : []),
  ];
  const safetyText = safetyMarkers.map((m) => m.text).join(' · ');
  const safetyPrefixCols = safetyText ? displayWidth(safetyText) + 3 : 0; // trailing " · "
  const statusSafetyMarkers = hudFit.hint ? [] : safetyMarkers;
  const statusSafetyText = statusSafetyMarkers.map((m) => m.text).join(' · ');
  const statusSafetyPrefixCols = statusSafetyText ? displayWidth(statusSafetyText) + 3 : 0;
  // When the live slot can't render (tiny terminal / slash menu open) the activeTool row is
  // invisible — surface the running tool here instead so a long tool call is never unindicated.
  const toolTag = toolLine
    ? ` · ${toolLine.trim()}`
    : activeTool && hudFit.liveRows === 0
      ? liveRecon && reconCount(liveRecon.kinds) >= 2 && isCollapsibleTool(activeTool.name)
        ? ` · ${formatReconSummary(liveRecon.kinds, { live: true })}…`
        : ` · ${displayToolName(activeTool.name)}…`
      : '';
  // 'model slow to respond' means the MODEL is quiet — a tool executing (activeTool) is not the
  // model being slow, so an in-flight tool suppresses the heuristic.
  const statusPrefix = running
    ? `${elapsedSec >= 1 ? ` (${formatDuration(elapsedSec)})` : ''}${toolTag}${shellPid ? ` · shell ${shellPid}` : ''}${shellPid && shellWarn ? ' · ⚠ may survive Esc' : elapsedSec >= 25 && !toolLine && !activeTool ? ' · model slow to respond' : ''}`
    : '';
  // Phase B: status strip is merged — while running, model/mode/ctx ride this same status line.
  // On a tiny terminal where the composer hint cannot fit, its safety badges move here too. The strip is formatted against
  // the width actually REMAINING beside the verb/elapsed/tool prefix, so its ctx/cost tail shrinks
  // instead of being truncated off the row edge. Idle merge lives in the composer hint (below).
  const runningStrip = running
    ? formatStatusStrip(
        stripInput,
        Math.max(
          16,
          layout.cols - PAGE_MARGIN * 2 - displayWidth(statusVerb) - displayWidth(statusPrefix) - statusSafetyPrefixCols - 6,
        ),
        { warn: C.yellow, hot: C.red },
      )
    : '';
  const pickerRows = modelRows(opts.cfg);
  let pickerSel = Math.min(pickerIndex, Math.max(0, pickerRows.length - 1));
  if (pickerRows[pickerSel]?.kind !== 'model') pickerSel = firstSelectableRow(pickerRows);
  // The model picker is WINDOWED exactly like the slash menu (it used to render every row unclipped —
  // a long model list made the overlay taller than the screen).
  // Derived from terminal height, not a hardcoded 10: a fixed 10-row window plus the picker's own
  // chrome exceeded the frame budget on terminals of ~19 rows and below, tripping Ink's
  // clearTerminal fallback and wiping scrollback every time the picker repainted.
  const PICKER_MAX = Math.max(3, Math.min(10, terminalSize.rows - 9));
  const pickStart = Math.min(Math.max(0, pickerSel - PICKER_MAX + 1), Math.max(0, pickerRows.length - PICKER_MAX));
  const pendingQuestions = pending?.kind === 'user_question' ? (pending.questions ?? []) : [];
  const activeQuestionIndex = Math.min(questionIndex, Math.max(0, pendingQuestions.length - 1));
  const activeQuestion = pendingQuestions[activeQuestionIndex];
  const activeQuestionSelection = activeQuestion
    ? (questionSelections[activeQuestionIndex] ?? defaultQuestionSelection(activeQuestion))
    : [];
  const vimTag = vimEnabled ? (vimModeState === 'normal' ? '-- NORMAL -- · ' : '-- INSERT -- · ') : '';
  const attachTag = attachCount > 0 ? `📎 ${attachCount} · ` : '';
  // Phase B status merge: idle composer hint carries model · mode · ctx (and OFFLINE); running keeps
  // interrupt keys on the hint and rides usage on the status line above. No separate StatusStrip row.
  // The STRIP has priority over the discoverability tail: the strip (provider/model/mode/ctx — the
  // state the user reads at a glance) is laid out first at its own budget, then the keybinding tail
  // is appended ONLY if it still fits. So a narrow terminal drops the hints, never the strip — the
  // v2.9.0 regression where a longer tail silently pushed provider+mode off the row. 'Shift+Enter
  // newline' is not repeated here — it already lives in the empty-composer placeholder.
  const HINT_TAIL = ' · Shift+Tab mode · / commands';
  const idleFixed = displayWidth(attachTag + vimTag) + safetyPrefixCols;
  // The hint row renders inside paddingLeft={PAGE_MARGIN} under wrap="truncate", so its usable
  // width is cols − PAGE_MARGIN, not cols — budget the strip (and the tail fits-check) against
  // that or its ctx/cost tail gets clipped mid-token within 4 columns of the edge.
  const idleStrip = formatStatusStrip(stripInput, Math.max(16, layout.cols - PAGE_MARGIN - idleFixed - 1), { warn: C.yellow, hot: C.red });
  const idleTail =
    layout.cols - PAGE_MARGIN - idleFixed - displayWidth(idleStrip) - 1 >= displayWidth(HINT_TAIL) ? HINT_TAIL : '';
  // The RUNNING branch carries the safety tags too: while a mid-turn approval/question overlay is up
  // the HUD status row is suppressed and this hint is the only chrome left — OFFLINE/sandbox:off must
  // not vanish exactly then.
  // Collaboration Mode legend replaces the model strip on the idle hint: the baton + seat roster + how
  // to route. (Running keeps the interrupt hint; the working status line shows the active seat's model.)
  const tableLegend = table
    ? `◆ baton: you · ${table.seats.map((s) => '@' + s.handle).join(' ')} · @handle to route · /table done`
    : '';
  const composerHint =
    // A reverse search owns the hint row while it is open — that IS the search prompt, exactly
    // as readline shows it: (reverse-i-search)`que': the matching entry.
    searchLine !== null
      ? searchLine
      : attachTag +
    vimTag +
    (menu.length > 0
      ? `↑/↓ select · Tab complete · Enter ${running ? 'queues' : 'runs'} · Esc cancel`
      : running
        ? // Width ladder (same law as the composer placeholder): the full steering hint is ~86
          // columns and used to clip mid-token on narrow terminals. Each step keeps the two
          // things a running turn must tell you — you can steer, and Esc interrupts.
          layout.cols - PAGE_MARGIN - idleFixed >= 86
          ? `Type to steer · Enter steers · ${NEWLINE_HINT} newline · Esc interrupts · Ctrl-C ×2 quits`
          : layout.cols - PAGE_MARGIN - idleFixed >= 45
            ? 'Type to steer · Enter steers · Esc interrupts'
            : 'steer · Esc interrupts'
        : table
          ? tableLegend
          : `${idleStrip}${idleTail}`);

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
            // A system/error/blocked row is its own block and opens with a blank — but a RUN of
            // them (a multi-line /help echo, a burst of confirmations) is one block, so every row
            // after the first hugs. `kind` defaults to 'system' for untagged pushLine calls, which
            // is most of the small chatter, so without this the gap rule would double-space it.
            item={isChatter(item.kind) && isChatter(committed[index - 1]?.kind) ? { ...item, tight: true } : item}
            cols={terminalSize.cols}
            collapsed={isCollapsible(item) && !showAllExpanded && !expandedIds.has(item.id)}
            // ⏺ once per contiguous assistant run: continuation if the previous committed item was
            // also an assistant block — so a multi-line/multi-paragraph answer reads as ONE turn.
            continuation={item.kind === 'assistant' && index > 0 && committed[index - 1]?.kind === 'assistant'}
            // Ctrl-O expands large GFM tables too (same global fold as tools/reasoning).
            foldLargeTables={!showAllExpanded}
            // Tool-call stacking: the run descriptor for this item (undefined for lone tools).
            toolRun={toolRuns.get(index)}
          />
        )}
      </Static>

      {/* ── Constant-height Turn HUD ──
          (1) LIVE SLOT: always mounted at hudFit.liveRows (when the budget allows), idle or running.
              Content is bottom-aligned; idle leaves blank rows. Composer never jumps at turn
              boundaries or when thinking ↔ tool ↔ stream swaps (height is fixed).
          (2) STATUS: one row — spinner while running, blank spacer when idle (keeps the band).
          Overlays (question / approval / picker) replace both. Menu steals liveWant so the
          dropdown can open without breaching Ink's wipe threshold. */}
      {!pending && !pickerOpen ? (
        <>
          {!menuOpen && hudFit.liveRows > 0 ? (
            <Box flexDirection="column" height={hudFit.liveRows} overflow="hidden" justifyContent="flex-end">
            {(subAgents.size > 0 && !previewStream) ? (() => {
              // Running-N-agents panel (BUG 3): live delegated agents, each showing type · current
              // tool · tool-use count · tokens, mirroring Claude Code's AgentProgressLine. Bounded
              // to the live budget (renderSubAgentPanel degrades to one summary row when it can't
              // fit) and bottom-aligned, so it clips gracefully before the primary live row.
              // The parent's own activeTool row (usually the `agent` call itself) reserves 1 row.
              // Per-type colors, read from the live palette (C is a mutated singleton).
              const SUBAGENT_COLORS = [C.cyan, C.purple, C.green, C.yellow, C.accent];
              const reserved = (activeTool || stream || think) ? 1 : 0;
              const panelRows = Math.max(1, hudFit.liveRows - reserved);
              const lines = renderSubAgentPanel(Array.from(subAgents.values()), panelRows, SUBAGENT_COLORS.length);
              return (
                <Box flexDirection="column" paddingLeft={PAGE_MARGIN}>
                  {lines.map((l, i) => (
                    <Text key={`${l.kind}-${i}`} wrap="truncate">
                      <Text color={l.running ? C.cyan : C.dim}>{`${l.glyph} `}</Text>
                      {l.label ? <Text color={l.colorIndex >= 0 ? SUBAGENT_COLORS[l.colorIndex] : undefined} bold>{l.label}</Text> : null}
                      <Text color={C.dim}>{l.detail}</Text>
                    </Text>
                  ))}
                </Box>
              );
            })() : null}
            {activeTool && !previewStream ? (
                // Persistent live tool row: the ⏺ is orange while the call runs (matches the spinner),
                // then tool_end commits the resolved green/red ⏺ row to <Static> in its place.
                // Recon bursts (≥2 read/grep/…) show a progressive Claude-style group line so the
                // HUD doesn't flash every single Read — "Reading 3 files, Grepping 1 pattern · path".
                <Box paddingLeft={PAGE_MARGIN}>
                  <Text wrap="truncate">
                    <Text color={C.accent ?? CLAUDE_ORANGE}>{BLACK_CIRCLE} </Text>
                    {activeTool.name === 'agent' && activeTool.agent ? (
                      <>
                        <Text color={C.cyan}>▸ </Text>
                        <Text bold>{activeTool.agent.subagentType ?? 'subagent'}</Text>
                        <Text color={C.dim}>{` · ${activeTool.agent.description ?? activeTool.arg}`}</Text>
                      </>
                    ) : liveRecon && reconCount(liveRecon.kinds) >= 2 && isCollapsibleTool(activeTool.name) ? (
                      <>
                        <Text bold>{formatReconSummary(liveRecon.kinds, { live: true })}</Text>
                        {(liveRecon.hint || activeTool.arg) ? (
                          <Text color={C.dim}>{` · ${displayToolArg(liveRecon.hint || activeTool.arg, 40)}`}</Text>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <Text bold>{displayToolName(activeTool.name)}</Text>
                        {activeTool.arg ? (
                          <Text color={C.dim}>{`(${displayToolArg(activeTool.arg, 72)})`}</Text>
                        ) : null}
                      </>
                    )}
                  </Text>
                </Box>
              ) : null}
              {think && !previewStream ? (
                // While the model thinks, a single compact ∴ Thinking… indicator aligned under the
                // gutter — NEVER the raw multi-line thought (that was the ugly split). The full thought
                // still commits COLLAPSED to the transcript on reasoning_done.
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
                      // `tight` once the turn has committed a block: without it flattenItem opens
                      // the preview with a blank gap row, which split the in-progress paragraph
                      // down the middle AND ate one of the two live rows, so the tail could only
                      // ever show one line. At turn start (nothing committed) the gap is correct —
                      // it separates the answer from the user's prompt above.
                      item={{ id: -1, kind: 'assistant', text: clamped, color: C.fg, tight: answerOpenRef.current } as TranscriptItem}
                      cols={terminalSize.cols}
                      collapsed={false}
                      continuation={answerOpenRef.current}
                    />
                  );
                })()
              ) : null}
            </Box>
          ) : null}
          {hudFit.status && running ? (
            // Only while a turn runs. Idle, this used to paint a blank spacer row "to keep the
            // band" — which, stacked on the composer's own marginTop, put TWO empty rows above
            // the input on every idle screen. One (marginTop) is the breathing room; two is a gap.
            <Box paddingLeft={PAGE_MARGIN}>
              <Text wrap="truncate">
                <Text color={C.accent ?? CLAUDE_ORANGE}>{spinner}</Text>
                <Text> {statusVerb}</Text>
                <Text color={C.dim}>{`${statusPrefix} · `}</Text>
                <ChromeMarkers
                  markers={statusSafetyMarkers}
                  trailing={statusSafetyMarkers.length > 0 && runningStrip.length > 0}
                />
                <Text color={C.dim}>{runningStrip}</Text>
              </Text>
            </Box>
          ) : null}
        </>
      ) : null}

      {/* Overlays — extracted to tui/overlays.tsx (borderless shaded panels). */}
      {pending ? (
        <PendingOverlay
          pending={pending}
          cols={terminalSize.cols}
          rows={terminalSize.rows}
          pageMargin={PAGE_MARGIN}
          colors={C}
          activeQuestion={activeQuestion}
          activeQuestionIndex={activeQuestionIndex}
          pendingQuestionsLength={pendingQuestions.length}
          activeQuestionSelection={activeQuestionSelection}
          questionCursor={questionCursor}
          autoAnswerSecs={autoAnswerSecs}
        />
      ) : pickerOpen ? (
        <ModelPickerOverlay
          cols={terminalSize.cols}
          pageMargin={PAGE_MARGIN}
          colors={C}
          pickerRows={pickerRows}
          pickStart={pickStart}
          pickerMax={PICKER_MAX}
          pickerSel={pickerSel}
          currentProvider={current.provider}
          currentModel={current.model}
        />
      ) : null}
      {/* (The running spinner/working line lives INSIDE the Turn HUD's status row now — one
          always-mounted line, not a fourth independently-appearing block.) */}

      {/* Pinned agent state — while a turn RUNS (stock path) it is a single truncated summary line
          (goal · plan · tasks n/m · current subject), so the 3→14-row PinnedState accordion can't
          shove the composer around mid-turn. The full block still renders between turns, where the
          composer is stationary anyway. Cell path keeps the full block (fixed-height viewport). */}
      {menuOpen ? null : showFullPinned ? (
        <PinnedState
          goal={missionPinnedRow(missionSnap)}
          plan={planMode}
          todos={todoItems}
          showPlan={showPlan}
          showTodo={showTodo}
          collapsed={todoCollapsed}
          cols={layout.cols}
          maxItems={pinnedMaxItems(terminalSize.rows, !!goal, !!(showPlan && planMode.path), !!customStatus, composerInputRows)}
        />
      ) : hudFit.pinned ? (
        // Single-row summary — used while running, and idle on a terminal too short for the full block.
        // Dropped entirely (hudFit.pinned false) when even one row would breach Ink's wipe threshold.
        <Text wrap="truncate" color={C.green}>
          {MARGIN_PAD + hudPinnedLine}
        </Text>
      ) : null}

      <Box flexDirection="column" flexShrink={0} marginTop={hudFit.marginTop ? 1 : 0}>
        {hudFit.toast && toast ? (
          // T1 toast: transient ack (copy/paste/theme/style/autonomy) — a single tinted row at
          // the top of the chrome group that replaces itself and expires in ~3.2s. NEVER commits
          // to Static; fitHud budgets the row and drops it first-class on short terminals.
          <Text wrap="truncate" color={toastColor(toast.kind, C)}>
            {MARGIN_PAD + toast.text}
          </Text>
        ) : null}
        {/* Pending input — human messages steer at a safe boundary; commands/wakeups remain FIFO
            deferred. Visible so the user knows the input was accepted. */}
        {hudFit.queued ? (
          // wrap="truncate": 3+ queued items would wrap to a 2nd row and shift the composer mid-turn.
          // Hidden while the menu is open — those rows belong to the menu's frame budget. Inset to the
          // page margin in stock so it lines up with the composer/strip rather than sitting flush-left.
          <Box paddingLeft={PAGE_MARGIN}>
            <Text wrap="truncate" color={C.cyan}>
              {`${queued.some((q) => q.kind === 'steer') ? '↪ pending' : '⏳ queued'} (${queued.length}): ${queued
                .map((q) => (q.text.length > 40 ? q.text.slice(0, 39) + '…' : q.text))
                .join('  ·  ')}`}
            </Text>
          </Box>
        ) : null}
        <Box flexDirection="column">
          <Composer
            input={input}
            cursor={cursor}
            hint={composerHint}
            markers={safetyMarkers}
            cols={terminalSize.cols}
            maxRows={maxComposerRows}
            showHint={hudFit.hint}
            borderColor={running ? C.cyan : planMode.mode === 'planning' ? C.yellow : C.dim}
          />
        </Box>
        {/* Slash-command dropdown — BELOW the composer (the reference client style), so typing "/" never
            moves the input box: the menu grows downward, shifting only the status strip. `menuOpen`
            already accounts for the terminal being tall enough to hold the box under the wipe line. */}
        {menuOpen ? (
          // A borderless but SHADED command list: the palette's menu panel sits behind every row
          // so the menu reads as its own surface instead of blending into the transcript, and the
          // selected row gets a brighter bar (menuSelBg). Every row is padded to a common width so
          // the panel is a clean rectangle. (No box, no reverse-video — the contrast carries it.)
          (() => {
            const BAR_W = Math.max(8, Math.min(terminalSize.cols - PAGE_MARGIN * 2 - 1, 74));
            const bar = (s: string) => {
              const clipped = takeByWidth(s, BAR_W).head;
              return clipped + ' '.repeat(Math.max(0, BAR_W - displayWidth(clipped)));
            };
            return (
              <Box flexDirection="column" paddingLeft={PAGE_MARGIN}>
                <Text wrap="truncate" backgroundColor={C.menuBg} color={C.cyan} bold>
                  {bar(` ${menu[0]?.base ? `${menu[0].base} — pick an argument` : 'Commands'} (${selIndex + 1}/${menu.length})`)}
                </Text>
                {menuStart > 0 ? (
                  <Text wrap="truncate" backgroundColor={C.menuBg} color={C.dim} italic>{bar(`   ↑ ${menuStart} more`)}</Text>
                ) : null}
                {menu.slice(menuStart, menuStart + MENU_MAX).map((c, j) => {
                  const i = menuStart + j;
                  const cur = i === selIndex;
                  const bg = cur ? C.menuSelBg : C.menuBg;
                  // Only @-mention rows clip to SLASH_NAME_WIDTH: a path can run arbitrarily long
                  // and would overflow the shaded bar (descRoom ≤ 0, rectangle lost). Slash names —
                  // including argument rows like `/config get temperature` — are the thing the user
                  // is choosing and stay COMPLETE; pad-only, so descriptions align at the column.
                  const clippedName = c.mention && displayWidth(c.name) > SLASH_NAME_WIDTH
                    ? takeByWidth(c.name, Math.max(1, SLASH_NAME_WIDTH - 1)).head + '…'
                    : c.name;
                  const namePart = clippedName + ' '.repeat(Math.max(0, SLASH_NAME_WIDTH - displayWidth(clippedName)));
                  const descRoom = Math.max(0, BAR_W - 2 - displayWidth(namePart) - 1);
                  const clippedDesc = takeByWidth(c.desc, descRoom).head;
                  const desc = displayWidth(c.desc) > descRoom && descRoom > 0
                    ? takeByWidth(c.desc, Math.max(0, descRoom - 1)).head + '…'
                    : clippedDesc;
                  const used = 2 + displayWidth(namePart) + 1 + displayWidth(desc); // pointer + name + space + desc
                  const pad = used < BAR_W ? ' '.repeat(BAR_W - used) : '';
                  // wrap="truncate": a long row must never wrap to a 2nd line — it eats the frame budget.
                  return (
                    <Text key={c.name} wrap="truncate">
                      <Text backgroundColor={bg} color={cur ? C.green : C.dim} bold={cur}>{cur ? '❯ ' : '  '}</Text>
                      <Text backgroundColor={bg} color={C.fg} bold={cur}>{`${namePart} `}</Text>
                      <Text backgroundColor={bg} color={cur ? C.fg : C.dim}>{desc}</Text>
                      {pad ? <Text backgroundColor={bg}>{pad}</Text> : null}
                    </Text>
                  );
                })}
                {menuStart + MENU_MAX < menu.length ? (
                  <Text wrap="truncate" backgroundColor={C.menuBg} color={C.dim} italic>{bar(`   ↓ ${menu.length - menuStart - MENU_MAX} more`)}</Text>
                ) : null}
              </Box>
            );
          })()
        ) : null}
        {/* Main status strip is Phase-B merged into the composer hint (idle) / working line
            (running); the separate row is gone (the sole fitHud call passes strip:false, so a
            hudFit.strip branch here would be permanently dead code). Only a user /statusline
            custom row still renders in this slot. */}
        {customStatus && hudFit.custom ? (
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

/** Escape sequence for Static remount. Soft keeps scrollback; hard wipes it (resize/clear). */
export function reflowSequence(mode: 'soft' | 'hard'): string {
  return mode === 'hard' ? '\x1b[2J\x1b[3J\x1b[H' : '\x1b[2J\x1b[H';
}

// Re-export pure helpers (moved to modules) so existing test imports from tui.js keep working.
export {
  extractCompleteBlocks,
  extractCommittableUnits,
  clampTail,
  stripTrailingNewlines,
  dupKey,
  repeatStep,
  leadsWithBlock,
  type CommitUnit,
} from './tui/streamCommit.js';
export { fitHud, type HudFit } from './tui/layout.js';

export function runTui(opts: TuiOpts): Promise<void> {
  // Launch-time privacy: title → "Shadow" (hide cwd) + wipe scrollback (hide pre-launch shell
  // history from scroll-up). See startupSequence. Title is popped on exit via cleanup.
  const ownsTitle = !!process.stdout.isTTY;
  // Bind restore to exit AND to the fatal signals BEFORE anything is turned on, so even a crash
  // during startup cannot strand the terminal.
  if (ownsTitle) installRestoreHandlers();
  if (ownsTitle) {
    process.stdout.write(startupSequence(true));
    claimMode('title', '', '\x1b[23;2t'); // startupSequence already pushed with 22;2t
  }
  // A theme that asserts a background (currently only `shadow`) pushes it to the TERMINAL here,
  // before the first frame, so the session opens on the intended field instead of flashing the
  // user's own background first. Restored on exit beside the window title — same lifecycle, same
  // exposure if the process is hard-killed.
  const startBg = themeBackground(opts.cfg.lastTheme as string | undefined);
  if (startBg && ownsTitle) {
    claimMode('theme-bg', backgroundSequence(startBg, ownsTitle), backgroundSequence(null, ownsTitle));
  }
  // Only reset what we set — a user whose terminal is already black keeps it. `restoreTerminal` is
  // idempotent, so running it here AND from the exit/signal handlers is harmless.
  const cleanup = restoreTerminal;
  // Atomic frames (synchronized output, DEC mode 2026) — kills the tmux/terminal repaint flicker; a
  // silent no-op on terminals that don't support it. Only for a real TTY (piped/CI writes stay clean).
  const stdout = ownsTitle ? withSynchronizedOutput(process.stdout) : process.stdout;
  const { waitUntilExit } = render(<TuiApp opts={opts} />, { stdout, exitOnCtrlC: false });
  return waitUntilExit().finally(cleanup);
}


// Re-exported so existing importers (tests, scripts/demo-tui.ts) keep working after the
// theme table moved to tui/theme.ts.
export { THEMES, THEME_NAMES, applyTheme, paletteSnapshot, backgroundSequence, themeBackground };
export type { ThemeName, Palette };
export { formatDiffStats, shellCommandOf } from './tui/format.js'; // re-exported for existing importers
