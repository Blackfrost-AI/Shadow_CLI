import { GLYPHS } from '../tui/glyphs.js';
// src/app/app.ts — the pi-tui shell.
//
// What this file is: the terminal-owning half of Shadow. It subscribes to the loop's EventBus,
// keeps the transcript, drives the composer, and answers permission gates. The agent, the tools,
// the permission model, the run lock and the session log are all unchanged and untouched.
//
// Snowfall owns an alternate-screen viewport. The complete document lives in a ScrollView,
// while a vertical stack pins the composer and status beneath the full-width conversation.
// The shared row layer continues to serve Ink, exports, and the fullscreen transcript.

import { Container, ProcessTerminal, TuiAltScreen, matchesKey, isKeyRelease } from '@earendil-works/pi-tui';
import type { EditorTheme, OverlayHandle, SelectListTheme, Terminal } from '@earendil-works/pi-tui';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

import { AgentLoop } from '../agent/loop.js';
import { buildLoopDeps } from '../agent/loopDeps.js';
import { Budget } from '../agent/budget.js';
import { SessionApprovals, type ApprovalDecision, type ApprovalGate, type ApprovalRequest } from '../agent/approval.js';
import { runHookPhase } from '../hooks/runner.js';
import { drainTurnInput } from '../tui/turnInput.js';
import { CLI_HOLDER, runLock } from '../web/runLock.js';
import { openEditorFile, resolveEditor } from '../tui/externalEditor.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { cycleAutonomy, type AutonomyLevel } from '../safety/permissions.js';
import { applyPermissionCommand } from '../safety/permissionCmd.js';
import { persistPermissionRules, resolveBaseUrl, resolveEntryCredential, type ModelEntry } from '../config.js';
import {
  addModelPreset,
  defaultModelPatch,
  findModelPreset,
  parseModelAddArgs,
  removeModelPreset,
  setModelPresetEnabled,
  splitPresetArgs,
} from '../config/modelPresets.js';
import { SAFE_CONFIG_KEYS, formatTemperature, parseSafeConfig } from '../config/safeInteractiveConfig.js';
import { approvalText } from '../util/approvalText.js';
import { C, THEME_DESCRIPTIONS, THEME_NAMES, applyTheme, normalizeThemeName, backgroundSequence, themeBackground } from '../tui/theme.js';
import type { CanonicalThemeName } from '../tui/theme.js';
import { customStyleNames, type OutputStyle } from '../agent/styles.js';
import type { TodoItem } from '../agent/todo.js';
import { writeFileSync, statSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { discoverCustomCommands, expandCommandBody } from '../tui/customCommands.js';
import { PI_KEYS } from './keymap.js';
import { ChoicePicker } from './picker.js';
import { loadAgentDefs } from '../agent/defs.js';
import { cycleEffort, effortDescription, effortSymbol, normalizeEffort } from '../agent/effort.js';
import type { Effort } from '../provider/provider.js';
import { clearSubAuth, type SubProvider } from '../auth/index.js';
import { subscriptionAuthLines } from '../auth/status.js';

/** 'codex' | 'grok' — the subscription providers with importable credentials. */
function parseSubProvider(value: string | undefined): SubProvider | null {
  return value === 'codex' || value === 'grok' ? value : null;
}
import { egressSummary } from '../safety/egress.js';
import { discoverSkills } from '../skills/loader.js';
import { shortPath } from '../tui/format.js';
import { imageMediaType, MAX_IMAGE_BYTES } from '../util/image.js';
import { copyToClipboard, hasClipboard } from '../util/clipboard.js';
import { redactString } from '../util/redact.js';
import { GLOBAL_DIR, saveGlobalConfig, vaultUnlocked } from '../state/globalStore.js';
import { exportSession } from '../state/chatExport.js';
import { listResumableSessions, resumeSession } from '../state/resume.js';
import { listRewindableTurns, rewindToTurn } from '../state/rewind.js';
import { forkSession } from '../state/fork.js';
import { ProjectMemory } from '../state/memory.js';
import { SessionLog } from '../state/session.js';
import { normalizeSessionTitle, sessionTerminalTitle } from '../state/sessionTitle.js';
import { readLatestWorkCenterSnapshot, recordWorkCenterSnapshot } from '../state/workCenterPersistence.js';
import { sanitizeAssistantText } from '../tui/sanitize.js';
import type { ResumableSession } from '../state/resume.js';
import type { RewindableTurn } from '../state/rewind.js';
import {
  extractCommittableUnits,
  leadsWithBlock,
  stripTrailingNewlines,
} from '../tui/streamCommit.js';
import type { FlattenItem } from '../tui/flatten.js';
import type { ContentBlock, Message } from '../provider/provider.js';

import { RESET, fgAnsi, style } from './ansi.js';
import { BrandSplash, FlatCell, StreamCell, computeToolRuns } from './cells.js';
import { ActivityPanel, capBody, type ToolDetail } from './activity.js';
import { SHADOW_LOGOTYPE } from '../tui/brand.js';
import { missionHudLine, missionStatusLines } from '../tui/missionHud.js';
import type { MissionSnapshot } from '../agent/mission.js';
import { PendingDialog, dialogArmMs } from './dialogs.js';
import { ModelSwitcher } from './modelSwitch.js';
import { SnowfallEditor, snowfallLayout, type SnowfallState } from './snowfall.js';
import { emitNotification } from '../util/notify.js';
import type { SubAgentView } from '../tui/subagentPanel.js';
import { modelRows, type PickerRow } from '../util/modelGroups.js';
import { ShadowAutocompleteProvider, type SlashCommandSpec } from './autocomplete.js';
import type { TuiOpts } from '../tui.js';
import { commandHandler, findTerminalCommand, terminalCommandsFor } from '../tui/commandCatalog.js';
import { executeWorkCommand } from '../tui/workCommand.js';
import { createReadTracker } from '../tools/readTracker.js';
import { formatDoctorReport, runDoctor } from '../doctor.js';
import { runModelCheck } from '../doctor/modelCheck.js';
import { isLocalServedEntry } from '../gguf.js';
import { addLocalModel, formatLocalList, listLocalModels, parseLocalAddArgs, removeLocalModel } from '../local/garage.js';
import {
  disableMcpServer,
  enableContextCooler,
  enablePlaywrightBrowser,
  loadGlobalMcpServers,
  mcpListLines,
  mcpServerLines,
  saveGlobalMcpServers,
  type McpServers,
} from '../mcp/manage.js';
import { PLUGIN_CONTENT_DIRS, displaySafe, enabledPluginDirs, listPlugins, setPluginEnabled } from '../plugins/manager.js';
import { isSecretKey, maskSecret, redactConfig } from '../util/redact.js';
import { sandboxConfinement, sandboxToolAvailable } from '../safety/sandbox.js';
import { vaultExists } from '../auth/vault.js';

/** Keys that mean "stop the running turn", in the encodings terminals actually send. */
function isEscape(data: string): boolean {
  return matchesKey(data, 'escape');
}
function isCtrlC(data: string): boolean {
  return matchesKey(data, 'ctrl+c');
}
function isCtrlO(data: string): boolean {
  return matchesKey(data, 'ctrl+o');
}
function isCtrlT(data: string): boolean {
  return matchesKey(data, 'ctrl+t');
}

// ── status line ──────────────────────────────────────────────────────────────

interface HudState {
  running: boolean;
  startedAt: number;
  toolLine: string | null;
  queued: number;
  todos: TodoItem[];
  autonomy: string;
  providerModel: string;
  contextPct: number;
  costUSD: number;
  goal: string | null;
  missionLine: string;
  mcpConnecting: boolean;
  mcpFailed: boolean;
  planMode: boolean;
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return visibleWidth(flat) > max ? truncateToWidth(flat, Math.max(4, max), '…') : flat;
}

// ── the interactive gate ─────────────────────────────────────────────────────

/**
 * FIFO gate. A single `resolver` field could only hold one request — a second concurrent gated
 * call overwrote it and the first promise was orphaned, wedging the turn until Esc. Reachable
 * whenever two gated calls land in one turn (parallel tools, or ask_user_question racing a
 * permission prompt), so the queue is load-bearing rather than defensive.
 */
class PiGate implements ApprovalGate {
  private queue: Array<{ req: ApprovalRequest; resolve: (d: ApprovalDecision) => void }> = [];
  show: (req: ApprovalRequest | null) => void = () => {};

  request(req: ApprovalRequest): Promise<ApprovalDecision> {
    if (req.signal?.aborted) return Promise.resolve('deny');
    return new Promise<ApprovalDecision>((resolve) => {
      const entry = { req, resolve };
      this.queue.push(entry);
      req.signal?.addEventListener('abort', () => this.drop(entry), { once: true });
      if (this.queue.length === 1) this.show(req);
    });
  }

  respond(d: ApprovalDecision): void {
    const head = this.queue.shift();
    if (!head) return;
    this.show(this.queue[0]?.req ?? null);
    head.resolve(d);
  }

  private drop(entry: { req: ApprovalRequest }): void {
    const i = this.queue.findIndex((e) => e === entry);
    if (i < 0) return;
    const wasHead = i === 0;
    const removed = this.queue.splice(i, 1)[0];
    removed?.resolve('deny');
    if (wasHead) this.show(this.queue[0]?.req ?? null);
  }

  get awaiting(): boolean {
    return this.queue.length > 0;
  }

  cancel(): void {
    const pending = this.queue.splice(0);
    this.show(null);
    for (const entry of pending) entry.resolve('deny');
  }
}

// ── the app ──────────────────────────────────────────────────────────────────

export class ShadowApp {
  private terminal: Terminal;
  private tui: TuiAltScreen;
  private editor: SnowfallEditor;
  private transcript = new Container();
  /** Slot for the wordmark splash: mounted only while the transcript is empty. */
  private splashSlot = new Container();
  private document = new Container();

  private items: FlattenItem[] = [];
  private cellById = new Map<number | string, FlatCell>();
  private streamCell = new StreamCell();
  private lineId = 1;

  private streamBuf = '';
  private answerOpen = false;
  private padCarry = false;
  private pendingStream: string | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private running = false;
  private controller: AbortController | null = null;
  private compacting = false;
  private compactController: AbortController | null = null;
  private modelChecking = false;
  private loopRef: AgentLoop | null = null;
  private runStart = 0;
  private tick = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;
  /** The compact brand is committed once per conversation (again after /clear). */
  private brandCommitted = false;

  private queued: string[] = [];
  private showAllExpanded = false;
  private dialog: PendingDialog | null = null;
  private dialogHandle: OverlayHandle | null = null;
  private selectionState: Record<number, string[]> = {};
  private cursorState: Record<number, number> = {};
  private ctrlCArmed = false;
  /** Every tool call this session, for the /activity sub-window. */
  private details: ToolDetail[] = [];
  /** 1-based turn counter — /activity groups calls per turn. */
  private turnNo = 0;
  private activityHandle: OverlayHandle | null = null;
  /** The composer's completion provider — held so the index can be warmed at startup. */
  private autocomplete: ShadowAutocompleteProvider | null = null;
  /** Mid-session model switching (P1.1) — verbatim port of the Ink buildProvider/selectModel. */
  private switcher: ModelSwitcher;
  /** The session's ORIGINAL context budget — /model switches to a local model clamp under its
   *  window, and switching back to a cloud model restores this. Mirrors the Ink path. */
  private readonly baseContextPolicy: { contextBudget: number; triggerRatio: number; keepLastTurns: number };
  private pickerHandle: OverlayHandle | null = null;
  private rewindable: RewindableTurn[] = [];
  private rewindSeen: { path: string; size: number } | null = null;
  private resumable: ResumableSession[] = [];
  /** Extra granted roots (/add-dir) — mutable; runTurn passes the live array to the loop. */
  private readonly additionalRoots: string[];
  /** Image attachments queued for the next message (/image <path>). */
  private readonly imageAttachments: { mediaType: string; data: string }[] = [];
  private effort: Effort;
  /** MCP connection state — shown in the hint line while connecting, never the transcript. */
  private mcpConnecting = false;
  private mcpFailed = false;
  /** Live sub-agent registry (P1.2) — keyed by taskId, rendered by SubAgentsCell. */
  private subAgents = new Map<string, SubAgentView>();
  /** Mission-mode snapshot (P1.3) — replaces the raw goal row when a mission is active. */
  private mission: MissionSnapshot | null;

  private gate = new PiGate();
  private approvals = new SessionApprovals();
  private autonomy: AutonomyLevel;
  private first = true;
  private planMode = false;
  private goal: string | null = null;
  private todos: TodoItem[] = [];
  private contextPct = 0;
  /** Session totals. Loop usage frames are turn-cumulative, so these accrue deltas only. */
  private costUSD = 0;
  private sessionInputTokens = 0;
  private sessionOutputTokens = 0;
  private sessionTurns = 0;
  private previousTurnCostUSD = 0;
  private previousTurnInputTokens = 0;
  private previousTurnOutputTokens = 0;
  private lastUsage: { inputTokens: number; outputTokens: number; costUSD: number; contextPct: number } | null = null;
  private toolLine: string | null = null;
  private current: { provider: string; model: string };
  private provider;
  private activeTarget: { baseUrl?: string; selfHosted: boolean };
  /** Read/edit evidence spans turns and is cleared only at conversation/session boundaries. */
  private readonly readTracker = createReadTracker();
  private style: OutputStyle = 'proactive';
  private themeName: CanonicalThemeName = 'snowfall';
  private resolveExit!: () => void;
  private exiting = false;
  private rewindableTurns = 0;

  constructor(private opts: TuiOpts, terminal: Terminal = new ProcessTerminal()) {
    this.terminal = terminal;
    this.themeName = normalizeThemeName(opts.cfg.lastTheme) ?? 'snowfall';
    applyTheme(this.themeName);
    this.autonomy = opts.autonomy;
    this.current = { provider: String(opts.provider.name ?? ''), model: opts.cfg.model ?? '' };
    this.provider = opts.provider;
    this.activeTarget = { baseUrl: opts.activeBaseUrl, selfHosted: opts.activeSelfHosted === true };
    this.planMode = !!opts.planMode?.active;
    this.mission = opts.mission?.snapshot() ?? null;
    this.additionalRoots = [...(opts.additionalRoots ?? [])];
    this.effort = (opts.cfg.effort as Effort) ?? 'high';
    // Same default the Ink path uses: the session's STARTUP budget is the baseline a /model
    // switch clamps from and restores to.
    this.baseContextPolicy = opts.baseContextPolicy ?? {
      contextBudget: opts.cfg.contextBudget,
      triggerRatio: opts.cfg.summarizeTriggerRatio,
      keepLastTurns: opts.cfg.keepLastTurns,
    };
    // The switch host reads live state through closures, so a switch mutates the SAME provider/
    // current/loop the turn loop and HUD see — never a stale copy. The alias is required: the
    // host's getters/setters live on an object literal, which cannot use arrow `this`.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const app = this;
    this.switcher = new ModelSwitcher({
      cfg: opts.cfg,
      context: opts.context,
      offline: opts.offline,
      baseContextPolicy: this.baseContextPolicy,
      get provider() {
        return app.provider;
      },
      set provider(p) {
        app.provider = p;
      },
      get current() {
        return app.current;
      },
      set current(c) {
        app.current = c;
      },
      get loop() {
        return app.loopRef;
      },
      pushLine: (p) => {
        if (!app.exiting) app.pushLine(p);
      },
      isRunning: () => app.running || app.compacting || app.modelChecking,
      onModelSwitch: opts.onModelSwitch,
      onTargetChange: (target) => {
        app.activeTarget = target;
      },
    });
    this.tui = new TuiAltScreen(this.terminal, false, undefined, {
      searchMatchStyle: (text) => '\x1b[4m' + style.cyan(text),
      searchCurrentMatchStyle: (text) => '\x1b[1;7m' + text + RESET,
      searchNavigationButtonStyle: (text) => style.fg(C.accent, text),
      scrollToEndIndicator: () => style.fg(C.accent, ' ↓ Latest · End '),
    });
    this.editor = new SnowfallEditor(this.tui, editorTheme(), () => this.snowfallState(), () => this.terminal.rows);
  }

  /** All writers follow the shared holder after /fork; standalone mounts use opts.sessionLog. */
  private get sessionLog(): SessionLog {
    return this.opts.sessionLogBox?.current ?? this.opts.sessionLog;
  }

  private adoptSessionLog(log: SessionLog): void {
    this.opts.sessionLog = log;
    if (this.opts.sessionLogBox) this.opts.sessionLogBox.current = log;
    this.refreshSessionTitle();
  }

  private refreshSessionTitle(): void {
    this.terminal?.setTitle(sessionTerminalTitle(this.sessionLog.title));
  }

  /** The live state object the HUD components read. Rebuilt only when a scalar changes. */
  private hudRef: HudState | null = null;
  private hudState(): HudState {
    if (!this.hudRef) {
      this.hudRef = {
        running: false,
        startedAt: 0,
        toolLine: null,
        queued: 0,
        todos: [],
        autonomy: this.autonomy,
        providerModel: '',
        contextPct: 0,
        costUSD: 0,
        goal: null,
        missionLine: '',
        mcpConnecting: false,
        mcpFailed: false,
        planMode: false,
      };
    }
    const s = this.hudRef;
    s.running = this.running;
    s.startedAt = this.runStart;
    s.toolLine = this.toolLine;
    s.queued = this.queued.length;
    s.todos = this.todos;
    s.autonomy = this.autonomy;
    s.providerModel = `${this.current.provider}/${this.current.model}`;
    s.contextPct = this.contextPct;
    s.costUSD = this.costUSD;
    s.goal = this.goal;
    s.missionLine = missionHudLine(this.mission);
    s.mcpConnecting = this.mcpConnecting;
    s.mcpFailed = this.mcpFailed;
    s.planMode = this.planMode;
    return s;
  }

  private snowfallState(): SnowfallState {
    return {
      ...this.hudState(), version: this.opts.version, workspace: shortPath(this.opts.workspaceRoot),
      tick: this.tick, reducedMotion: !!this.opts.cfg.reducedMotion, bypass: !!this.opts.bypass,
      agents: [...this.subAgents.values()],
    };
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async run(): Promise<void> {
    this.document.addChild(this.transcript);
    this.document.addChild(this.splashSlot);
    this.document.addChild(this.streamCell);
    this.tui.setLayoutRoot(snowfallLayout(this.document, this.editor, () => this.snowfallState()).root);

    this.editor.onSubmit = (text: string) => this.submit(text);
    this.editor.onChange = () => {
      this.hudRef = this.hudState();
    };
    this.autocomplete = new ShadowAutocompleteProvider(this.commandSpecs(), this.opts.workspaceRoot);
    this.editor.setAutocompleteProvider(this.autocomplete);
    // Warm the file index in the background so the first `@` usually hits a warm cache instead
    // of paying the walk mid-keystroke.
    this.autocomplete.warm();

    this.gate.show = (req) => this.showDialog(req);
    // Publish the live abort controller so the `--web` mirror can interrupt this terminal's turn
    // — the same seam the Ink shell exposed. Without it the browser side can only watch.
    this.opts.setAbortGetter?.(() => this.controller);
    // Scheduled wakeups (the schedule_wakeup tool). Mid-turn they QUEUE like typed type-ahead —
    // starting a second turn on the shared Context mid-stream is how turns became un-abortable.
    if (this.opts.wakeupHandler) {
      this.opts.wakeupHandler.fire = (task: string, reason: string) => {
        const line = `[wakeup: ${reason}] ${task}`;
        if (this.running) {
          this.queued.push(line);
          this.pushLine({ text: `  ⏰ wakeup queued (${reason}) — runs when this turn ends`, dimColor: true });
          this.hudRef = this.hudState();
          return;
        }
        this.startTurn(line);
      };
    }
    this.installInputHandling();

    this.tui.setFocus(this.editor);
    this.refreshSessionTitle();
    this.tui.start();

    this.showSplash();
    if (this.opts.mcpPending) {
      // The MCP status is CHROME (the hint line), never a transcript line: a committed line is
      // real content, and committing one at boot hid the splash before the user saw a frame.
      this.mcpConnecting = true;
      void this.opts.mcpPending.then(
        () => {
          this.mcpConnecting = false;
          this.hudRef = this.hudState();
          this.tui.requestRender();
        },
        () => {
          this.mcpConnecting = false;
          this.mcpFailed = true;
          this.hudRef = this.hudState();
          this.tui.requestRender();
        },
      );
    }

    const off = this.opts.bus.on((e) => this.onBusEvent(e as Record<string, unknown>));

    await new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
    off();
    if (this.ticker) clearInterval(this.ticker);
  }

  /** Stop is idempotent; also used by the signal/fatal-exit lifecycle owner. */
  stop(): void {
    if (this.exiting) return;
    this.exiting = true;
    // Ink-unmount parity: abandon any in-flight turn (its loop can no longer render) and
    // release the process-wide run lock so an exiting shell can never starve the web mirror.
    this.controller?.abort();
    this.compactController?.abort();
    this.gate.cancel();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.ticker) clearInterval(this.ticker);
    if (this.pendingStream !== null) this.streamCell.setText(this.pendingStream, this.answerOpen);
    runLock.releaseFor(CLI_HOLDER);
    try {
      // Restore the complete conversation to the main buffer, without composer/status chrome.
      this.tui.setLayoutRoot(this.document);
      this.tui.stop();
    } catch {
      /* the terminal may already be gone */
    }
    this.resolveExit?.();
  }

  private exit(): void { this.stop(); }

  /** Brand information for the splash and the committed record. */
  private brandInfo(): {
    version: string;
    providerModel: string;
    workspace: string;
    help: string;
    yolo?: boolean;
  } {
    return {
      version: `${this.opts.version} · Snowfall`,
      providerModel: `${this.current.provider}/${this.current.model}`,
      workspace: this.opts.workspaceRoot,
      help: '/help · /model · Shift+Tab mode · @ file',
      yolo: this.opts.bypass,
    };
  }

  /**
   * Mount the wordmark splash. It lives in the LIVE frame, so every resize re-renders it at the
   * new width and the art reflows cleanly — the reason it is not committed to scrollback, where
   * the terminal would re-wrap fixed columns into garbage.
   *
   * The original solid-block banner comes from the shared brand module. Narrow screens
   * fall back to the icon or compact mark, and the splash unmounts on the first turn.
   */
  private showSplash(): void {
    this.splashSlot.clear();
    if (this.opts.cfg.showLogo !== false) this.splashSlot.addChild(new BrandSplash(this.brandInfo(), SHADOW_LOGOTYPE));
    this.tui.requestRender();
  }

  private hideSplash(): void {
    if (!this.splashSlot.children.length) return;
    this.splashSlot.clear();
    this.tui.requestRender();
  }

  /**
   * The durable record of the session start: the compact brand, committed once into scrollback
   * when the first turn begins. No art here — a fixed-width block of printed text cannot survive
   * a narrower window, which is exactly what the splash exists to avoid. Once per conversation —
   * without the guard this ran on EVERY turn and interleaved a brand block between each
   * user/answer pair (live-reproduced: two turns, two banners).
   */
  private commitBrandLine(): void {
    if (this.brandCommitted) return;
    this.brandCommitted = true;
    this.commit({
      id: this.lineId++,
      kind: 'banner',
      text: '',
      brand: this.brandInfo(),
    });
  }

  // ── transcript plumbing ──────────────────────────────────────────────────

  private pushLine(partial: Partial<FlattenItem> & { text: string }): void {
    const item = { ...partial, id: this.lineId++, kind: partial.kind ?? 'system' } as FlattenItem;
    this.commit(item);
  }

  private commit(item: FlattenItem): void {
    if (this.exiting) return;
    this.items.push(item);
    // The splash is the empty state — the moment real content lands, it goes.
    if (item.kind !== 'banner') this.hideSplash();
    this.rebuildRuns();
    this.tui.requestRender();
  }

  /**
   * Recompute tool-run stacking and sync the cell list to the item list.
   *
   * Cells are REUSED, not recreated: a new FlatCell has a cold cache, so recreating the list per
   * commit re-flattened (re-parsed markdown for) the whole transcript on every event. `update()`
   * diffs each cell's render state and no-ops when nothing changed, so a routine append costs one
   * new cell plus O(n) cheap comparisons — and Ctrl-O, which changes every cell's flags, still
   * lands because the diff sees it.
   */
  private rebuildRuns(): void {
    const runs = computeToolRuns(this.items, !this.showAllExpanded);
    const foldTables = !this.showAllExpanded;
    const cells: FlatCell[] = [];
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i]!;
      const collapsed = this.isCollapsed(it);
      const continuation = it.kind === 'assistant' && i > 0 && this.items[i - 1]!.kind === 'assistant';
      const run = runs.get(it.id);
      let cell = this.cellById.get(it.id);
      if (!cell) {
        cell = new FlatCell(it as never, collapsed, continuation, run, foldTables);
        this.cellById.set(it.id, cell);
      } else {
        cell.update({ collapsed, continuation, toolRun: run, foldTables });
      }
      cells.push(cell);
    }
    this.transcript.children = cells;
  }

  private isCollapsed(item: FlattenItem): boolean {
    if (this.showAllExpanded) return false;
    if (item.kind === 'reasoning') return true;
    if (item.kind === 'tool' && item.lines && item.lines.length > 3) return true;
    return false;
  }

  // ── streaming ────────────────────────────────────────────────────────────

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.pendingStream !== null) {
        // Keep the complete live block; ScrollView owns clipping and table headers remain
        // available while an unfinished table streams beyond the viewport.
        this.streamCell.setText(this.pendingStream, this.answerOpen);
        this.pendingStream = null;
        this.tui.requestRender();
      }
    }, 30);
  }

  private onTextDelta(delta: string): void {
    // Answer text is streaming — the "thinking…" activity label is stale from here on. It was
    // only cleared by tool_end/turn-end before, so a reasoning→answer turn showed "thinking…"
    // beside the spinner for the entire answer.
    if (this.toolLine) this.toolLine = null;
    this.streamBuf += delta;
    const { units, rest, trailingBlank } = extractCommittableUnits(this.streamBuf, this.padCarry);
    for (const u of units) {
      if (!u.text.trim()) continue;
      this.pushLine({
        kind: 'assistant',
        text: stripTrailingNewlines(u.text),
        color: undefined,
        meta: 'assistant',
        tight: this.answerOpen && !u.pad,
      });
      this.answerOpen = true;
    }
    this.padCarry = trailingBlank;
    this.streamBuf = rest;
    this.pendingStream = rest;
    this.scheduleFlush();
  }

  private flushStreamToTranscript(): void {
    const t = this.streamBuf;
    if (t.trim()) {
      this.pushLine({
        kind: 'assistant',
        text: stripTrailingNewlines(t),
        meta: 'assistant',
        tight: this.answerOpen && !this.padCarry && !leadsWithBlock(t),
      });
    }
    this.streamBuf = '';
    this.pendingStream = null;
    this.answerOpen = false;
    this.padCarry = false;
    this.streamCell.setText('', false);
  }

  // ── bus ──────────────────────────────────────────────────────────────────

  private onBusEvent(e: Record<string, unknown>): void {
    if (this.exiting) return;
    const type = String(e.type ?? '');
    const sub = e.subagent as string | undefined;
    switch (type) {
      case 'text':
        if (typeof e.delta === 'string') this.onTextDelta(e.delta);
        break;
      case 'assistant_done':
        this.flushStreamToTranscript();
        break;
      case 'thinking':
        // Extended reasoning streams into the status line, never the transcript: raw thought is
        // noise between you and the answer, and the committed block below is the record.
        if (this.running) this.toolLine = 'thinking…';
        break;
      case 'reasoning_done': {
        const text = String(e.text ?? '');
        if (text.trim()) {
          this.pushLine({ kind: 'reasoning', text, durationMs: e.durationMs as number | undefined });
        }
        break;
      }
      case 'tool_start': {
        if (sub) {
          // A sub-agent started a tool → the panel, NEVER the parent's live row: a tagged event
          // used to clobber the parent's activeTool in the Ink path, hiding the top-level agent.
          this.updateSubAgent(sub, (a) => ({
            ...a,
            tool: String((e.call as { name?: string }).name ?? ''),
            argPreview: previewOf((e.call as { input?: unknown }).input),
            toolUseCount: a.toolUseCount + 1,
          }));
          break;
        }
        const call = e.call as { name: string; input?: unknown };
        this.toolLine = `${call.name}: ${previewOf(call.input)}`;
        break;
      }
      case 'tool_end': {
        if (sub) {
          // Sub-agent tool finished → clear its current-tool line. The parent's transcript does
          // NOT get one row per child tool; the child's final answer commits as the agent-tool
          // result body.
          this.updateSubAgent(sub, (a) => ({ ...a, tool: undefined, argPreview: undefined }));
          break;
        }
        const call = e.call as { name: string; input?: unknown };
        const result = e.result as { ok: boolean; summary?: string; images?: { mediaType: string; data: string }[] } | undefined;
        this.toolLine = null;
        this.pushTool(call, result);
        for (const image of result?.images ?? []) {
          this.pushLine({ kind: 'image', text: '', image: { bytes: image.data, mediaType: image.mediaType, alt: previewOf(call.input) || call.name, source: previewOf(call.input) } });
        }
        break;
      }
      case 'tool_denied': {
        if (sub) {
          this.updateSubAgent(sub, (a) => ({ ...a, tool: undefined, argPreview: undefined }));
          break;
        }
        const call = e.call as { name: string; input?: unknown };
        this.pushLine({
          kind: 'blocked',
          text: `  ✗ ${call.name} blocked — ${String(e.reason ?? '')}`,
          color: C.yellow,
        });
        break;
      }
      case 'finding':
        this.pushLine({
          kind: 'finding',
          text: '',
          title: String(e.title ?? ''),
          severity: String(e.severity ?? 'info'),
          lines: [{ text: String(e.body ?? '') }],
        });
        break;
      case 'usage':
        {
          const usage = {
            inputTokens: Number(e.inputTokens ?? 0),
            outputTokens: Number(e.outputTokens ?? 0),
            costUSD: Number(e.costUSD ?? 0),
            contextPct: Number(e.contextPct ?? 0),
          };
          this.contextPct = usage.contextPct;
          // Usage frames are cumulative within one turn. Add only positive deltas so a
          // multi-request tool turn is not charged repeatedly in the session totals.
          this.sessionInputTokens += Math.max(0, usage.inputTokens - this.previousTurnInputTokens);
          this.sessionOutputTokens += Math.max(0, usage.outputTokens - this.previousTurnOutputTokens);
          this.costUSD += Math.max(0, usage.costUSD - this.previousTurnCostUSD);
          this.previousTurnInputTokens = usage.inputTokens;
          this.previousTurnOutputTokens = usage.outputTokens;
          this.previousTurnCostUSD = usage.costUSD;
          this.lastUsage = usage;
        }
        break;
      case 'compaction':
        this.pushLine({ text: '  ⟳ context compacted — earlier turns summarized', dimColor: true });
        break;
      case 'model_fallback':
        this.pushLine({ text: `  model fallback: ${e.from} → ${e.to}`, dimColor: true });
        break;
      case 'retry':
        this.pushLine({ text: `  retry ${e.attempt} in ${e.delayMs}ms (${oneLine(String(e.reason), 60)})`, dimColor: true });
        break;
      case 'autonomy':
        this.autonomy = e.level as AutonomyLevel;
        this.opts.onAutonomyChange?.(this.autonomy);
        break;
      case 'todo':
        this.todos = (e.items as TodoItem[]) ?? [];
        break;
      case 'plan_mode':
        this.planMode = (e.plan as { mode?: string } | undefined)?.mode === 'planning';
        break;
      case 'error':
        this.pushLine({ kind: 'error', text: `  ! ${String(e.message)}`, color: C.red });
        break;
      case 'subagent_start': {
        // Register in the live panel (P1.2). Re-registration for the same taskId is safe: an
        // admission re-announce clears `queued`, and the loop has not run, so zero counters
        // cannot clobber real activity.
        this.subAgents.set(String(e.taskId), {
          taskId: String(e.taskId),
          subagentType: String(e.subagentType ?? 'agent'),
          description: e.description ? String(e.description) : undefined,
          background: !!e.background,
          queued: !!e.queued,
          toolUseCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          startedAt: Date.now(),
        });
        break;
      }
      case 'subagent_end': {
        // A SYNC agent's answer commits as the agent-tool result, so its row goes. A BACKGROUND
        // agent has no transcript row yet — mark done and LINGER until the next user turn, with
        // a desktop ping so a user who tabbed away is called back (T1, ported from Ink).
        const id = String(e.taskId);
        const bg = this.subAgents.get(id);
        if (bg?.background) {
          emitNotification(
            this.opts.cfg.notify ?? 'auto',
            'Shadow',
            `Sub-agent ${bg.subagentType} ${e.ok ? 'finished' : 'failed'}`,
            { isTTY: !!process.stdout.isTTY },
          );
        }
        const cur = this.subAgents.get(id);
        if (cur) {
          if (cur.background) {
            this.subAgents.set(id, { ...cur, done: true, ok: !!e.ok, tool: undefined, argPreview: undefined });
          } else {
            this.subAgents.delete(id);
          }
        }
        break;
      }
      case 'subagent_usage': {
        // A finished sub-agent's TOTAL spend, once. Does NOT touch contextPct/cost deltas: sub-
        // agents run on their own Budget, and letting their usage through overwrote the HUD with
        // a foreign context % (the /cost nonsense bug). Tokens attribute to the exact agent row.
        this.costUSD += Number(e.costUSD ?? 0);
        this.sessionInputTokens += Number(e.inputTokens ?? 0);
        this.sessionOutputTokens += Number(e.outputTokens ?? 0);
        const tid = e.taskId ? String(e.taskId) : undefined;
        if (tid && (e.inputTokens || e.outputTokens)) {
          this.updateSubAgent(tid, (a) => ({
            ...a,
            inputTokens: Number(e.inputTokens ?? a.inputTokens),
            outputTokens: Number(e.outputTokens ?? a.outputTokens),
          }));
        }
        break;
      }
      case 'mission':
        // The row repaints from the snapshot; the LOOP owns the system-prompt mission block
        // (deps.mission), so UI and truth cannot disagree — same seam as the Ink shell.
        this.mission = e.mission as MissionSnapshot;
        break;
      case 'shell_output':
        break; // live shell output belongs in the tool body, not a firehose into the transcript
      case 'shell_pid':
        if (e.warn) this.pushLine({ text: `  ⚠ shell pid ${e.pid}: ${String(e.warn)}`, color: C.yellow });
        break;
      case 'stop':
        break; // handled by the turn's finally
      default:
        break;
    }
    this.tui.requestRender();
  }

  private pushTool(
    call: { name: string; input?: unknown },
    result: { ok: boolean; summary?: string; data?: unknown; meta?: { durationMs?: number; diff?: { tag: string; text: string }[] } } | undefined,
  ): void {
    const input = (call.input ?? {}) as Record<string, unknown>;
    const arg =
      typeof input.command === 'string'
        ? oneLine(input.command, 200)
        : typeof input.path === 'string'
          ? input.path
          : typeof input.pattern === 'string'
            ? input.pattern
            : typeof input.url === 'string'
              ? input.url
              : undefined;
    const summary = oneLine(String(result?.summary ?? (result?.ok ? 'ok' : 'failed')), 120);
    const durationMs = Number(result?.meta?.durationMs ?? 0);

    // Capture the body so a collapsed run is not a dead end: Ctrl-O expands it inline, and
    // /activity opens it in the sub-window. Without this, folding a run to one row would hide the
    // output with no way back to it.
    const sd = result?.data as { stdout?: string; stderr?: string; answer?: string } | undefined;
    const shellOut = [sd?.stdout ?? '', sd?.stderr ?? ''].join('\n').replace(/^\n+|\n+$/g, '');
    const diff = result?.meta?.diff;
    let body: string[] | undefined;
    let meta: string | undefined;
    if (shellOut.trim()) {
      meta = 'output';
      body = capBody(shellOut.split('\n'));
    } else if (diff?.length) {
      meta = 'diff';
      body = capBody(diff.map((d) => `${d.tag} ${d.text}`));
    } else if (call.name === 'agent' && sd?.answer?.trim()) {
      meta = 'answer';
      body = capBody(sd.answer.split('\n'));
    }

    // Input JSON for the panel (8.7's toolDetail carries it; capped to keep the doc bounded).
    let inputJson: string | undefined;
    try {
      const j = JSON.stringify(call.input ?? {}, null, 2);
      if (j && j !== '{}') inputJson = j.length > 400 ? j.slice(0, 400) + '…' : j;
    } catch {
      inputJson = undefined;
    }
    this.details.push({
      n: this.details.length + 1,
      turn: this.turnNo,
      name: call.name,
      arg,
      ok: !!result?.ok,
      durationMs,
      summary,
      inputJson,
      body,
      meta,
    });

    this.pushLine({
      kind: 'tool',
      text: '',
      tool: { name: call.name, arg, ok: !!result?.ok, durationMs, summary },
      lines: body?.map((l) => ({
        text: l,
        color: meta === 'diff' ? (l.startsWith('+') ? C.green : l.startsWith('-') ? C.red : undefined) : undefined,
        dimColor: meta !== 'diff' || !/^[+-]/.test(l),
      })),
      meta,
    });
  }

  // ── input ────────────────────────────────────────────────────────────────

  private installInputHandling(): void {
    this.tui.addInputListener((data: string) => {
      if (isKeyRelease(data)) return undefined;
      // 1. Ctrl+C is a RESERVED chord: it must be reachable even while a dialog owns the
      //    keyboard. pi-tui dispatches input listeners before the focused component, and this
      //    listener returns consume:true for every key under a dialog — so if this check sat
      //    BELOW the dialog branch, \x03 would never arrive and Ctrl-C ×2 would be a dead key
      //    while an approval waits (live-reproduced: the process ignored it entirely). While a
      //    gate holds, the turn is running, so the first press aborts the turn — and the
      //    controller's signal settles the gate with it.
      if (isCtrlC(data)) {
        if (this.running) {
          this.abortTurn();
          return { consume: true };
        }
        if (this.compacting) {
          this.abortCompaction();
          return { consume: true };
        }
        if (this.editor.getText().length > 0) {
          this.editor.setText('');
          this.ctrlCArmed = false;
          this.tui.requestRender();
          return { consume: true };
        }
        if (this.ctrlCArmed) {
          this.exit();
        } else {
          this.ctrlCArmed = true;
          this.pushLine({ text: '  press Ctrl-C again to exit', dimColor: true });
          setTimeout(() => {
            this.ctrlCArmed = false;
          }, 2000);
        }
        return { consume: true };
      }

      // 2. A dialog owns the keyboard — but only keys pressed AFTER it was visible.
      //    Type-ahead aimed at the composer is still in flight when a gate opens mid-sentence;
      //    routing it here is how "also fix the failing test" once approved `rm -rf` on the `f`
      //    key. Inside the arming window the key goes where it was aimed.
      if (this.dialog && !this.dialog.isDone && this.dialogHandle?.isFocused()) {
        if (Date.now() - this.dialog.shownAt < dialogArmMs()) {
          this.editor.handleInput(data);
          return { consume: true };
        }
        this.dialog.handleInput(data);
        this.tui.requestRender();
        return { consume: true };
      }

      // Search and pickers own input while focused; their keys must not become app actions.
      if (this.tui.hasOverlay()) return undefined;

      // 2.5 Ctrl-G opens the draft in $VISUAL/$EDITOR (F08-10). Idle-only: spawnSync blocks the
      //     whole event loop, so this must never run mid-turn. The TUI stops (raw mode off, the
      //     editor owns the tty) and restarts after; the engine's start() repaints the frame.
      if (matchesKey(data, 'ctrl+g') && !this.running && !this.compacting) {
        this.openExternalEditor();
        return { consume: true };
      }

      // Shift+Tab is the key form of /plan. pi-tui does not translate it for the editor, so the
      // shell owns CSI Z before focus dispatch.
      if (matchesKey(data, 'shift+tab')) {
        this.runSlash('/plan');
        return { consume: true };
      }

      // 3. Esc interrupts a running turn. It is deliberately NOT the editor's key: while the
      //    agent works, Esc means one thing and the composer is not listening.
      if (isEscape(data) && this.running) {
        this.abortTurn();
        return { consume: true };
      }
      if (isEscape(data) && this.compacting) {
        this.abortCompaction();
        return { consume: true };
      }

      // 4. Ctrl-O toggles folding for the whole transcript.
      if (isCtrlO(data)) {
        this.showAllExpanded = !this.showAllExpanded;
        this.rebuildRuns();
        this.tui.requestRender();
        return { consume: true };
      }

      // 5. Ctrl-T prints the full task list.
      if (isCtrlT(data)) {
        this.printTasks();
        return { consume: true };
      }

      // 6. Enter while a turn runs: the draft is a follow-up. Queue it rather than dropping the
      //    keystroke into a loop that cannot read it yet.
      if (matchesKey(data, 'enter') && !matchesKey(data, 'ctrl+j') && (this.running || this.compacting || this.modelChecking || this.switcher.isSwitching) && this.editor.getText().trim()) {
        const q = this.editor.getExpandedText().trim();
        this.editor.setText('');
        this.queue(q);
        return { consume: true };
      }

      return undefined;
    });
  }

  private abortTurn(): void {
    this.controller?.abort();
    this.pushLine({ text: '  ⏹ interrupted', dimColor: true });
  }

  private abortCompaction(): void {
    this.compactController?.abort();
    this.pushLine({ text: '  ⏹ cancelling compaction', dimColor: true });
  }

  // ── submit / turns ───────────────────────────────────────────────────────

  private submit(raw: string): void {
    const text = raw.trim();
    if (!text) return;
    this.editor.addToHistory(text);
    if (this.editor.getText().trim()) this.editor.setText('');
    if (this.compacting) {
      if (text === '/compact' || text === '/summary') this.runSlash(text);
      else this.queue(text);
      return;
    }
    if (this.modelChecking) {
      this.queue(text);
      return;
    }
    if (this.switcher.isSwitching) {
      this.queue(text);
      return;
    }
    if (text.startsWith('/')) {
      this.runSlash(text);
      return;
    }
    if (this.running) {
      this.queue(text);
      return;
    }
    this.startTurn(text);
  }

  private queue(task: string): void {
    this.queued.push(task);
    this.hudRef = this.hudState();
    this.pushLine({ text: `  ⏳ queued: ${oneLine(task, 70)}`, dimColor: true });
    this.tui.requestRender();
  }

  private flushQueue(): void {
    if (this.exiting) return;
    if (this.running || this.compacting || this.modelChecking || this.switcher.isSwitching) return;
    while (this.queued.length) {
      const next = this.queued.shift()!.trim();
      if (!next) continue;
      if (next.startsWith('/')) {
        this.runSlash(next);
        continue;
      }
      this.startTurn(next);
      return; // that turn re-enters this on completion
    }
    this.hudRef = this.hudState();
  }

  private startTurn(task: string): void {
    if (this.exiting) return;
    if (this.running || this.compacting || this.modelChecking || this.switcher.isSwitching) {
      this.queue(task);
      return;
    }
    // The splash has served its purpose; record the session's start in scrollback instead, then
    // the turn itself. Order matters: the compact brand line is the durable record.
    this.commitBrandLine();
    this.pushLine({ kind: 'user', text: `${GLYPHS.promptPrefix}${task}`, color: C.green, bold: true, meta: 'you' });
    void this.runTurn(task);
  }

  private async runTurn(task: string): Promise<void> {
    // user_prompt_submit hooks can deny the prompt outright.
    const promptHooks = this.opts.cfg.hooks?.user_prompt_submit ?? [];
    if (promptHooks.length) {
      const h = runHookPhase('user_prompt_submit', promptHooks, {
        prompt: task,
        workspaceRoot: this.opts.workspaceRoot,
      });
      if (!h.ok) {
        this.pushLine({ kind: 'error', text: `  ! ${h.message ?? 'hook denied this prompt'}`, color: C.red });
        return;
      }
    }

    this.running = true;
    this.turnNo++;
    this.sessionTurns++;
    this.previousTurnCostUSD = 0;
    this.previousTurnInputTokens = 0;
    this.previousTurnOutputTokens = 0;
    const controller = new AbortController();
    this.controller = controller;
    this.runStart = Date.now();
    this.answerOpen = false;
    this.padCarry = false;
    this.streamBuf = '';
    this.streamCell.setText('', false);
    this.hudRef = this.hudState();
    this.startTicker();

    // One turn at a time, process-wide: two agents in one repo corrupt each other. The acquire
    // sits inside the try so an abort while queued behind a browser session is a clean early
    // return rather than a stranded `running` flag.
    let release: (() => void) | null = null;
    try {
      try {
        release = await runLock.acquire(CLI_HOLDER, { priority: true, signal: controller.signal });
      } catch {
        this.endTurn();
        return;
      }

      // P1.7: drain queued background-agent results (task notifications that arrived while no
      // turn was running) INTO the outgoing message — the wire contract `drainTurnInput` has.
      // Gating on `task` alone silently dropped them (drain already emptied the queue).
      const taskText = drainTurnInput(task, this.opts.pendingNotifications);
      // /image attachments ride along once, then clear (one-shot per message, like Ink).
      const imgs = this.imageAttachments.splice(0);
      const content: ContentBlock[] = [];
      for (const im of imgs) content.push({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } } as unknown as ContentBlock);
      content.push({ type: 'text', text: taskText || task });
      const userMsg: Message = { role: 'user', content };
      if (this.first) {
        this.opts.context.pinTask(userMsg);
        this.first = false;
      } else {
        this.opts.context.append(userMsg);
      }
      const shown = taskText || task;
      this.sessionLog.record({ kind: 'user', task: shown });
      this.refreshSessionTitle();
      this.opts.bus.emit({ type: 'user', text: shown });

      const budget = new Budget(
        {
          maxIterations: this.opts.cfg.maxIterations,
          maxTotalTokens: this.opts.cfg.budget.maxTotalTokens,
          maxCostUSD: this.opts.cfg.budget.maxCostUSD,
          maxWallClockSec: this.opts.cfg.budget.maxWallClockSec,
        },
        this.current.model,
        this.opts.cfg.priceTable,
        Date.now(),
      );

      const deps = buildLoopDeps({
        cfg: this.opts.cfg,
        provider: this.provider,
        registry: this.opts.registry,
        gate: this.gate,
        bus: this.opts.bus,
        budget,
        context: this.opts.context,
        signal: controller.signal,
        model: this.current.model,
        system: this.opts.styleState?.systemForStyle?.(this.style) ?? this.opts.system,
        workspaceRoot: this.opts.workspaceRoot,
        additionalRoots: this.additionalRoots,
        forceConfirm: this.opts.forceConfirm,
        todoList: this.opts.todoList,
        planMode: this.opts.planMode,
        mission: this.opts.mission,
        streamShell: true,
        sessionLog: this.sessionLog,
        approvals: this.approvals,
        readTracker: this.readTracker,
        continuityState: this.mission?.active
          ? `Mission: ${this.mission.mission} (phase: ${this.mission.phase})`
          : this.goal
            ? `Standing goal:\n${this.goal}`
            : undefined,
      });
      const loop = new AgentLoop(deps, this.autonomy);
      this.loopRef = loop;
      try {
        await loop.run();
      } catch (err) {
        this.pushLine({ kind: 'error', text: `  ! ${(err as Error).message}`, color: C.red });
      } finally {
        this.loopRef = null;
      }
    } finally {
      // Never release off a `stop` event: sub-agents share the parent bus, so a sub-agent's stop is
      // byte-identical on the wire and would unlock mid-turn.
      release?.();
      this.flushStreamToTranscript();
      this.endTurn();
    }
  }

  /** Mutate one sub-agent's panel row in place (a fresh object, so the cell's signature sees it). */
  private updateSubAgent(taskId: string, fn: (a: SubAgentView) => SubAgentView): void {
    const cur = this.subAgents.get(taskId);
    if (!cur) return; // an unknown taskId (raced end) is not a parent event
    this.subAgents.set(taskId, fn(cur));
  }

  private endTurn(): void {
    // F10-02: clear FINISHED background-agent rows that lingered from the previous turn. Still-
    // running agents stay so a long bg job spans turns visibly.
    for (const [id, a] of this.subAgents) {
      if (a.done) this.subAgents.delete(id);
    }
    this.running = false;
    this.controller = null;
    this.toolLine = null;
    const secs = Math.max(0, Math.round((Date.now() - this.runStart) / 1000));
    if (secs >= 1) this.pushLine({ text: `${GLYPHS.tool} done · ${Math.round(secs)}s`, dimColor: true });
    this.stopTicker();
    this.hudRef = this.hudState();
    this.tui.requestRender();
    this.flushQueue();
  }

  private startTicker(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      this.tick++;
      this.tui.requestRender();
    }, this.opts.cfg.reducedMotion ? 1000 : 160);
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  // ── dialogs ──────────────────────────────────────────────────────────────

  private showDialog(req: ApprovalRequest | null): void {
    this.closeDialog();
    if (!req) return;
    this.selectionState = {};
    this.cursorState = {};
    const dlg = new PendingDialog(
      req,
      {
        decide: (d) => {
          this.closeDialog();
          this.gate.respond(d);
          if (!this.gate.awaiting) this.tui.setFocus(this.editor);
          this.tui.requestRender();
        },
        onQuestionIndexChange: () => {},
        repaint: () => this.tui.requestRender(),
        getAutonomy: () => this.autonomy,
        selections: this.selectionState,
        cursors: this.cursorState,
      },
      () => ({ cols: this.terminal.columns, rows: this.terminal.rows }),
    );
    this.dialog = dlg;
    this.dialogHandle = this.tui.showOverlay(dlg, { anchor: 'bottom-center', width: '100%' });
    this.tui.requestRender();
  }

  private closeDialog(): void {
    if (this.dialogHandle) {
      this.dialogHandle.hide();
      this.dialogHandle = null;
    }
    this.dialog = null;
  }

  /**
   * Open the activity sub-window: every tool call this session, scrollable, with the full command
   * and its output. This is the way back into a collapsed run — the transcript shows one row for a
   * burst, and this shows what was in it.
   */
  private openActivity(): void {
    if (this.activityHandle) {
      this.activityHandle.hide();
      this.activityHandle = null;
    }
    const panel = new ActivityPanel(
      this.details,
      () => {
        this.activityHandle?.hide();
        this.activityHandle = null;
        this.tui.setFocus(this.editor);
        this.tui.requestRender();
      },
      () => this.terminal.rows,
    );
    this.activityHandle = this.tui.showOverlay(panel, { anchor: 'bottom-center', width: '100%' });
    this.tui.requestRender();
  }

  // ── session continuity (P1.5) — ported from the Ink shell's repaint/resume/rewind ──

  /**
   * Repaint the visible transcript from the context actually in force. `/resume` and `/rewind`
   * replace the model's context; without this the screen kept showing the previous conversation —
   * the transcript and the model disagreeing about what was said. User and assistant text replay;
   * tool traffic summarizes (results are in context, but re-rendering full output floods the view
   * and is not what the user is checking).
   */
  private repaintFromContext(): void {
    this.items = [];
    this.cellById.clear();
    this.transcript.clear();
    this.lineId = 1;
    this.brandCommitted = true; // the restored conversation predates this shell — no banner inside it
    const msgs = this.opts.context.messages();
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
        this.pushLine({ kind: 'user', text: `${GLYPHS.promptPrefix}${text}`, color: C.green, bold: true, meta: 'you' });
      } else if (m.role === 'assistant') {
        const display = sanitizeAssistantText(text);
        if (display.trim()) {
          this.pushLine({ kind: 'assistant', text: display, color: C.fg, meta: 'assistant' });
        }
      }
    }
    if (tools > 0) {
      this.pushLine({
        text: `  ⋮ ${tools} tool call${tools === 1 ? '' : 's'} in the restored context (output not replayed)`,
        dimColor: true,
      });
    }
    this.tui.renderNow(true);
  }

  /** Size-keyed re-list of the log's rewindable turns (cheap when nothing was appended). */
  private refreshRewindTurns(): void {
    try {
      const path = this.sessionLog.path;
      if (!path) {
        this.rewindable = [];
        this.rewindSeen = null;
        return;
      }
      let size = -1;
      try {
        size = statSync(path).size;
      } catch {
        return; // unreadable — keep whatever list we had
      }
      const seen = this.rewindSeen;
      if (!seen || seen.path !== path || seen.size !== size) {
        this.rewindSeen = { path, size };
        this.rewindable = listRewindableTurns(path);
      }
    } catch {
      /* an unreadable log must never break the caller */
    }
  }

  private doResume(arg: string): void {
    if (this.running || this.compacting || this.modelChecking) {
      this.pushLine({ text: '  Finish the current operation before resuming.', dimColor: true });
      return;
    }
    const sessions = listResumableSessions(this.opts.workspaceRoot);
    if (!sessions.length) {
      this.pushLine({ text: '  No resumable sessions found.', dimColor: true });
      return;
    }
    // Auto-pick ONLY when there is exactly one; otherwise the pi picker makes the choice explicit
    // (the Ink shell pre-filled the composer for the same reason).
    if (!arg && sessions.length > 1) {
      this.openResumePicker(sessions);
      return;
    }
    const pick = arg
      ? sessions.find((x) => x.id === arg || x.path === arg || x.path.endsWith(arg))
      : sessions[0];
    if (!pick) {
      this.pushLine({ kind: 'error', text: `  No session matching "${approvalText(arg)}".`, color: C.red });
      return;
    }
    this.applyResume(pick);
  }

  private applyResume(pick: ResumableSession): void {
    try {
      const { context: resumed } = resumeSession(pick.path, {
        contextBudget: this.opts.cfg.contextBudget,
        triggerRatio: this.opts.cfg.summarizeTriggerRatio,
        keepLastTurns: this.opts.cfg.keepLastTurns,
      });
      const previous = this.sessionLog;
      const log = SessionLog.open(this.opts.workspaceRoot);
      log.setTitle(SessionLog.titleFor(pick.path));
      this.adoptSessionLog(log);
      previous.close?.();
      this.opts.context.loadState(resumed.exportState());
      this.opts.workCenter?.restore(readLatestWorkCenterSnapshot(pick.path));
      this.first = this.opts.context.messages().length === 0;
      // Repaint BEFORE the confirmation line so the notice sits at the bottom of the conversation
      // it describes.
      this.repaintFromContext();
      // Seed THIS session's log with the restored context: /export reads the CURRENT log, which
      // is brand new after a resume — without the seed it exported frontmatter only.
      try {
        this.sessionLog.recordSnapshot(this.opts.context, 0);
        this.sessionLog.record({ kind: 'resumed_from', sessionId: pick.id, path: pick.path });
      } catch {
        /* a log that cannot be written must not fail the resume itself */
      }
      this.refreshRewindTurns();
      this.pushLine({ text: `  Resumed ${approvalText(pick.title)} · ${approvalText(pick.id)} (${this.opts.context.messages().length} messages).`, color: C.cyan });
      // A different session is a different grant scope.
      this.approvals.clear();
      this.readTracker.clear();
    } catch (e) {
      this.pushLine({ kind: 'error', text: `  Resume failed: ${approvalText((e as Error).message)}`, color: C.red });
    }
  }

  private openResumePicker(sessions: ResumableSession[]): void {
    const picker = new ChoicePicker({
      title: 'Resume a session', items: sessions, label: (session) => `${oneLine(session.title, 34)} · ${session.id}`,
      choose: (session) => { this.closePicker(); this.applyResume(session); },
      close: () => this.closePicker(), repaint: () => this.tui.requestRender(), rows: () => this.terminal.rows,
    });
    this.pickerHandle?.hide();
    this.pickerHandle = this.tui.showOverlay(picker, { anchor: 'center', width: 76 });
    this.tui.requestRender();
  }

  private doRewind(arg: string): void {
    if (this.running || this.compacting || this.modelChecking) {
      this.pushLine({ text: '  Finish the current operation before rewinding.', dimColor: true });
      return;
    }
    const parts = (arg ?? '').split(/\s+/).filter(Boolean);
    const flags = parts.filter((p) => p.startsWith('--'));
    const badFlag = flags.find((f) => f !== '--code-only' && f !== '--chat-only');
    if (badFlag) {
      this.pushLine({ kind: 'error', text: `  Unknown flag ${badFlag}. Usage: /rewind <turn-index> [--code-only|--chat-only]`, color: C.red });
      return;
    }
    if (new Set(flags).size === 2) {
      this.pushLine({ kind: 'error', text: '  --code-only and --chat-only are mutually exclusive.', color: C.red });
      return;
    }
    const scope: 'code' | 'chat' | undefined = flags.includes('--code-only')
      ? 'code'
      : flags.includes('--chat-only')
        ? 'chat'
        : undefined;
    const turnArg = parts.find((p) => !p.startsWith('--'));
    this.refreshRewindTurns();
    const turns = this.rewindable;
    if (!turnArg) {
      if (!turns.length) {
        this.pushLine({ text: '  Nothing to rewind to yet — no turns this session.', dimColor: true });
        return;
      }
      // The list IS the picker: rows name each turn by the prompt that produced it.
      this.openRewindPicker(turns, scope);
      return;
    }
    const turnIndex = Number(turnArg);
    if (!Number.isInteger(turnIndex) || turnIndex < 0) {
      this.pushLine({ text: '  Usage: /rewind <turn-index> [--code-only|--chat-only]', dimColor: true });
      return;
    }
    if (!turns.some((t) => t.turn === turnIndex)) {
      const avail = turns.map((t) => t.turn).sort((a, b) => a - b).join(', ');
      this.pushLine({ kind: 'error', text: `  No snapshot for turn ${turnIndex}. Rewindable turns: ${avail || 'none yet'}.`, color: C.red });
      return;
    }
    this.applyRewind(turnIndex, scope);
  }

  private openRewindPicker(turns: RewindableTurn[], scope: 'code' | 'chat' | undefined): void {
    const picker = new ChoicePicker({
      title: `Rewind · ${scope ?? 'code+chat'}`, items: [...turns].sort((a, b) => b.turn - a.turn),
      label: (turn) => `turn ${turn.turn} · ${turn.label}`,
      choose: (turn) => { this.closePicker(); this.applyRewind(turn.turn, scope); },
      close: () => this.closePicker(), repaint: () => this.tui.requestRender(), rows: () => this.terminal.rows,
    });
    this.pickerHandle?.hide();
    this.pickerHandle = this.tui.showOverlay(picker, { anchor: 'center', width: 76 });
    this.tui.requestRender();
  }

  private applyRewind(turnIndex: number, scope: 'code' | 'chat' | undefined): void {
    try {
      const turnsBefore = [...this.rewindable];
      const { context: rewound, restoredFiles, deletedFiles, partialFiles, turn, snapshotOffset } = rewindToTurn(
        this.sessionLog.path,
        turnIndex,
        this.opts.workspaceRoot,
        {
          contextBudget: this.opts.cfg.contextBudget,
          triggerRatio: this.opts.cfg.summarizeTriggerRatio,
          keepLastTurns: this.opts.cfg.keepLastTurns,
          scope,
        },
      );
      // `context` is absent for a --code-only rewind: the conversation was deliberately left
      // untouched, so nothing to load or repaint — the file restoration IS the whole result.
      if (rewound) {
        this.opts.context.loadState(rewound.exportState());
        this.first = false; // a rewound session is mid-conversation by definition
        this.repaintFromContext();
        // Append a durable snapshot, then a lineage marker linking it to the ORIGINAL selected
        // snapshot. Export can now discard only the undone suffix while preserving prior audit
        // events (reasoning, denials, retries) that Context itself does not store.
        try {
          const durableSnapshotOffset = statSync(this.sessionLog.path).size;
          this.sessionLog.recordSnapshot(this.opts.context, turn);
          if (statSync(this.sessionLog.path).size > durableSnapshotOffset) {
            this.sessionLog.record({
              kind: 'rewound_to',
              turn,
              sourceSnapshotOffset: snapshotOffset,
              durableSnapshotOffset,
            });
          }
        } catch {
          /* rewind succeeded; a log write failure is already tracked by SessionLog */
        }
        // Read-before-edit evidence belongs to the conversation lineage. A chat rewind can
        // remove the read that justified a later edit, so that evidence must rewind too.
        this.readTracker.clear();
      }
      this.pushLine({
        text: scope === 'code'
          ? `  Rewound workspace files to turn ${turn} (conversation untouched).`
          : scope === 'chat'
            ? `  Rewound conversation to turn ${turn} (${this.opts.context.messages().length} messages; files untouched).`
            : `  Rewound to turn ${turn} — ${restoredFiles.length} file${restoredFiles.length === 1 ? '' : 's'} restored, ${deletedFiles.length} deleted${partialFiles.length ? `, ${partialFiles.length} partial` : ''}.`,
        color: C.cyan,
      });
      if (scope !== 'chat') {
        this.pushLine({ text: '  (workspace files were restored to that turn — /diff to inspect)', dimColor: true });
      }
      if (scope !== 'code') {
        const redo = turnsBefore.filter((candidate) => candidate.turn > turn).sort((a, b) => a.turn - b.turn)[0];
        if (redo?.prompt) this.editor.setText(redo.prompt);
      }
      this.refreshRewindTurns();
    } catch (e) {
      this.pushLine({ kind: 'error', text: `  Rewind failed: ${(e as Error).message}`, color: C.red });
    }
  }

  private doSession(): void {
    const logPath = this.sessionLog.path ?? '(no log)';
    this.refreshRewindTurns();
    const sessionId = this.sessionLog.path ? SessionLog.sessionIdFromPath(this.sessionLog.path) : '(unknown)';
    this.pushLine({
      kind: 'system',
      text: '',
      lines: [
        { text: approvalText(`session name ${this.sessionLog.title || 'New session'}`), color: C.cyan },
        { text: approvalText(`session id   ${sessionId}`) },
        { text: approvalText(`session log  ${logPath}`) },
        { text: `messages     ${this.opts.context.messages().length}` },
        { text: `turns logged ${this.rewindable.length}`, dimColor: true },
      ],
    });
  }

  /**
   * Ctrl-G (P1.8): open the composer draft in the user's editor. The TUI fully stops around the
   * spawn — the editor gets the real tty, the way git does it — and restarts after; the engine's
   * start() repaints from scratch, so an alt-screen-hogging editor cannot leave the frame torn.
   */
  private openExternalEditor(): void {
    if (this.running || this.compacting || this.modelChecking) {
      this.pushLine({ text: '  Finish the current operation before opening the external editor.', dimColor: true });
      return;
    }
    if (!process.stdout.isTTY) {
      this.pushLine({ text: '  External editor needs an interactive terminal.', dimColor: true });
      return;
    }
    const editor = resolveEditor();
    const session = openEditorFile(this.editor.getText());
    try {
      this.tui.stop({ preserveScreen: true });
      const r = spawnSync(`${editor} "${session.file}"`, { stdio: 'inherit', shell: true });
      if (r.error) {
        this.pushLine({ kind: 'error', text: `  Couldn't launch "${editor}": ${r.error.message}. Set $EDITOR.`, color: C.red });
      } else {
        const edited = session.read();
        this.editor.setText(edited);
        this.pushLine({ text: `  Draft loaded from ${editor} (${edited.split('\n').length} lines) — Enter to send.`, dimColor: true });
      }
    } catch (e) {
      this.pushLine({ kind: 'error', text: `  External editor failed: ${(e as Error).message}`, color: C.red });
    } finally {
      try {
        this.tui.start();
        this.tui.setFocus(this.editor);
        this.tui.renderNow(true);
      } catch {
        /* the terminal may have gone away */
      }
      session.cleanup();
    }
  }

  /** /copy — the last assistant answer (or its last fenced block) to the system clipboard. */
  private copyLast(what: 'answer' | 'code'): void {
    if (!hasClipboard()) {
      this.pushLine({ text: '  No clipboard helper found — install pbcopy (macOS), xclip/wl-copy (Linux), or run on Windows.', color: C.yellow });
      return;
    }
    const last = [...this.items].reverse().find((it) => it.kind === 'assistant' && it.text);
    if (!last) {
      this.pushLine({ text: '  No assistant answer to copy yet.', dimColor: true });
      return;
    }
    let raw = last.text!;
    let label = 'answer';
    if (what === 'code') {
      // Last fenced block wins — "copy the code you just gave me" is the ask 95% of the time,
      // and the last block is the final/complete version when a model iterates.
      const blocks = [...raw.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
      if (!blocks.length) {
        this.pushLine({ text: '  No fenced code block in the last answer — plain /copy takes the whole text.', dimColor: true });
        return;
      }
      raw = blocks[blocks.length - 1]!.replace(/\n$/, '');
      label = 'code block';
    }
    const safe = redactString(raw);
    void copyToClipboard(safe).then((ok) => {
      this.pushLine({
        text: ok
          ? `  Copied the last ${label}${safe !== raw ? ' (credentials redacted)' : ''}.`
          : '  Copy failed — no clipboard helper available.',
        color: ok ? C.green : C.yellow,
      });
    });
  }

  private printTasks(): void {
    if (!this.todos.length) {
      this.pushLine({ text: '  no tasks', dimColor: true });
      return;
    }
    this.pushLine({
      kind: 'system',
      text: '',
      lines: this.todos.map((t) => ({
        text: `  ${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'} ${t.subject}`,
      })),
    });
  }

  // ── commands ─────────────────────────────────────────────────────────────

  private discoverCommands() {
    return discoverCustomCommands(this.opts.workspaceRoot, homedir())
      .filter((command) => !findTerminalCommand(`/${command.name}`));
  }

  private commandSpecs(): SlashCommandSpec[] {
    return [...SLASH, ...this.discoverCommands().map((c) => ({ name: `/${c.name}`, desc: approvalText(c.description) }))].map((c: SlashSpec) => ({
      name: c.name,
      desc: c.desc,
      args:
        c.name === '/model'
          ? (p: string) =>
              (this.opts.cfg.models ?? [])
                .filter((m) => !m.disabled && m.label.toLowerCase().startsWith(p.toLowerCase()))
                .slice(0, 8)
                .map((m) => ({ value: m.label, label: m.label, description: `${m.provider}/${m.model}` }))
          : c.name === '/resume'
            ? (prefix: string) => listResumableSessions(this.opts.workspaceRoot)
                .filter((session) => `${session.title} ${session.id}`.toLowerCase().includes(prefix.toLowerCase()))
                .slice(0, 20)
                .map((session) => ({ value: session.id, label: session.title, description: session.id }))
            : c.args,
    }));
  }

  private runSlash(raw: string): void {
    const [typedName, ...rest] = raw.trim().split(/\s+/);
    const arg = rest.join(' ').trim();
    const command = findTerminalCommand(typedName ?? '');
    if (!command) {
      const custom = this.discoverCommands().find((c) => `/${c.name.toLowerCase()}` === typedName?.toLowerCase());
      if (custom) {
        const prompt = expandCommandBody(custom.body, raw.trim().slice((typedName ?? '').length).trim());
        if (this.running || this.compacting || this.modelChecking || this.switcher.isSwitching) this.queue(prompt);
        else this.startTurn(prompt);
        return;
      }
      this.pushLine({ kind: 'error', text: `  Unknown command: ${typedName} — type / for the list.`, color: C.red });
      return;
    }
    const handler = commandHandler(command, 'pi');
    if (!handler) {
      this.pushLine({
        text: `  ${command.name} is unavailable in Snowfall: ${command.renderers.pi.unavailable ?? 'Use SHADOW_TUI=ink shadow.'}`,
        color: C.yellow,
      });
      return;
    }
    // The capability's handler id is the dispatch contract. Aliases point at the same id, so a
    // new catalog row cannot become an unreachable switch case through a second name lookup.
    const name = `/${handler}`;
    switch (name) {
      case '/quit':
      case '/exit':
        this.exit();
        return;
      case '/clear':
      case '/new':
        if (this.running || this.compacting || this.modelChecking || this.switcher.isSwitching) {
          this.pushLine({ text: '  Finish the current operation before clearing the conversation.', dimColor: true });
          return;
        }
        try {
          const previous = this.sessionLog;
          this.adoptSessionLog(SessionLog.open(this.opts.workspaceRoot));
          previous.close?.();
          this.refreshRewindTurns();
        } catch (error) {
          this.pushLine({ kind: 'error', text: `  Could not start a new session: ${approvalText((error as Error).message)}`, color: C.red });
          return;
        }
        this.items = [];
        this.cellById.clear();
        this.transcript.clear();
        this.details = [];
        this.lineId = 1;
        this.brandCommitted = false; // the fresh conversation records its own brand on first turn
        this.opts.context.reset?.();
        this.approvals.clear();
        this.readTracker.clear();
        this.queued = [];
        this.imageAttachments.length = 0;
        this.todos = [];
        this.opts.todoList?.write([]);
        this.opts.workCenter?.clear();
        this.contextPct = 0;
        this.costUSD = 0;
        this.sessionInputTokens = 0;
        this.sessionOutputTokens = 0;
        this.sessionTurns = 0;
        this.previousTurnCostUSD = 0;
        this.previousTurnInputTokens = 0;
        this.previousTurnOutputTokens = 0;
        this.lastUsage = null;
        this.opts.planMode?.exit();
        this.planMode = false;
        this.first = true;
        this.showSplash();
        this.tui.renderNow(true);
        return;
      case '/help':
        this.pushLine({
          kind: 'system',
          text: '',
          lines: [
            { text: 'Commands', bold: true },
            ...this.commandSpecs().map((c) => ({ text: `  ${c.name.padEnd(14)} ${c.desc}`, dimColor: true as boolean })),
            { text: '', dimColor: true },
            { text: 'Keys', bold: true },
            ...PI_KEYS.map(({ key, action }) => ({ text: `  ${key.padEnd(20)} ${action}`, dimColor: true })),

          ],
        });
        return;
      case '/theme':
        this.doTheme(arg);
        return;
      case '/autonomy':
        this.doAutonomy(arg);
        return;
      case '/cost':
      case '/usage':
      case '/stats':
        if (!this.lastUsage && this.sessionInputTokens === 0 && this.sessionOutputTokens === 0) {
          this.pushLine({ text: '  No usage recorded yet this session.', dimColor: true });
          return;
        }
        this.pushLine({
          kind: 'system',
          text: 'cost',
          lines: [
            {
              text: `Session (${this.sessionTurns} turn${this.sessionTurns === 1 ? '' : 's'}): ${this.sessionInputTokens.toLocaleString()} in · ${this.sessionOutputTokens.toLocaleString()} out · ${(this.sessionInputTokens + this.sessionOutputTokens).toLocaleString()} total`,
              bold: true,
            },
            this.costUSD > 0
              ? { text: `Session cost: $${this.costUSD.toFixed(4)}`, color: C.cyan }
              : { text: 'Session cost: none — local/unpriced model', dimColor: true },
            ...(this.lastUsage
              ? [{
                  text: `Last turn: ${this.lastUsage.inputTokens.toLocaleString()} in · ${this.lastUsage.outputTokens.toLocaleString()} out${this.lastUsage.costUSD > 0 ? ` · $${this.lastUsage.costUSD.toFixed(4)}` : ''}`,
                  dimColor: true,
                }]
              : []),
          ],
        });
        return;
      case '/context':
        this.pushLine({
          kind: 'system',
          text: '',
          lines: [
            { text: `context window: ${Math.round(this.contextPct * 100)}% used`, bold: true },
            { text: `model: ${this.current.provider}/${this.current.model}`, dimColor: true },
          ],
        });
        return;
      case '/model':
        this.doModel(arg);
        return;
      case '/activity':
      case '/act':
        this.openActivity();
        return;
      case '/tasks':
        if (arg === 'clear') {
          this.opts.todoList?.write([]);
          this.todos = [];
          this.pushLine({ text: '  tasks cleared', dimColor: true });
        } else this.printTasks();
        return;
      case '/goal': {
        // Mission mode (8.4), ported from slash.ts: /goal <text> starts a REAL mission — plan
        // mode engages, a kickoff turn runs, and the harness pins the mission in front of the
        // model every turn until done/failed or /goal clear. No arg = status, 'clear' = end.
        if (!arg) {
          for (const line of missionStatusLines(this.mission)) {
            this.pushLine({ text: line, dimColor: !this.mission?.active });
          }
          return;
        }
        if (arg.toLowerCase() === 'clear') {
          if (!this.opts.mission) {
            this.pushLine({ kind: 'error', text: '  Mission state unavailable in this session.', color: C.red });
            return;
          }
          const had = this.mission?.active === true;
          this.mission = this.opts.mission.clear();
          this.pushLine({ text: had ? '  Mission cleared.' : '  No mission active.', dimColor: true });
          return;
        }
        if (!this.opts.mission) {
          this.pushLine({ kind: 'error', text: '  Mission state unavailable in this session.', color: C.red });
          return;
        }
        this.mission = this.opts.mission.begin(arg);
        // Missions start with an approved plan; drive the state object (the bus event updates
        // the HUD, so UI and truth cannot disagree — the /plan lesson).
        this.opts.planMode?.enter();
        this.pushLine({ text: `Mission started: ${arg}`, color: C.purple });
        this.pushLine({
          text: '  Plan mode on — write the plan (plan_write, include tasks), then exit_plan_mode for approval.',
          dimColor: true,
        });
        const kickoff = `[mission] ${arg}\nBegin the planning phase: explore as needed, write the plan with plan_write (include a tasks array), then call exit_plan_mode for approval.`;
        if (this.running) {
          this.queued.push(kickoff);
          this.hudRef = this.hudState();
          this.pushLine({ text: '  ⏳ mission kickoff queued — runs when this turn ends', dimColor: true });
        } else {
          this.startTurn(kickoff);
        }
        return;
      }
      case '/status':
        {
          const profileEntries = Object.entries(this.opts.cfg.profile ?? {});
        this.pushLine({
          kind: 'system',
          text: '',
          lines: [
            { text: approvalText(`model      ${this.current.provider}/${this.current.model}`) },
            { text: approvalText(`endpoint   ${this.activeTarget.baseUrl ?? '(provider default)'}`), dimColor: true },
            ...(this.opts.cfg.activeProfile
              ? [{
                  text: approvalText(`profile    ${this.opts.cfg.activeProfile}${profileEntries.length ? ` (${profileEntries.map(([key, value]) => `${key}=${String(value)}`).join(', ')})` : ''}`),
                  color: C.cyan,
                }]
              : []),
            { text: `autonomy   ${this.autonomy}` },
            { text: `context    ${Math.round(this.contextPct * 100)}% of ${this.opts.cfg.contextBudget.toLocaleString()} · ${(this.sessionInputTokens + this.sessionOutputTokens).toLocaleString()} tokens` },
            { text: `cost       $${this.costUSD.toFixed(4)}` },
            ...(this.mission?.active
              ? [{ text: approvalText(`mission    ${this.mission.mission} (${this.mission.phase})`), color: C.purple }]
              : [{ text: approvalText(`goal       ${this.goal ?? '(none)'}`) }]),
            { text: `plan mode  ${this.planMode ? 'on' : 'off'}` },
            { text: `renderer   Snowfall (pi fullscreen)`, color: C.cyan },
            { text: approvalText(`workspace  ${this.opts.workspaceRoot}`), dimColor: true },
            { text: `sandbox    ${sandboxConfinement(this.opts.cfg.sandbox)}`, dimColor: true },
          ],
        });
        return;
        }
      case '/export':
        this.doExport(arg);
        return;
      case '/compact':
        if (this.running || this.modelChecking) {
          this.pushLine({ text: '  Finish the current operation before compacting.', dimColor: true });
          return;
        }
        if (this.compacting) {
          this.pushLine({ text: '  Already compacting — Esc to cancel.', dimColor: true });
          return;
        }
        this.pushLine({ text: '  Compacting context… (Esc cancels)', dimColor: true });
        this.compacting = true;
        this.compactController = new AbortController();
        void this.compactContext(this.compactController);
        return;
      case '/version':
        this.pushLine({ text: `  shadow ${this.opts.version} · Snowfall`, dimColor: true });
        return;
      case '/diff':
      case '/files':
      case '/branch': {
        const git = (...args: string[]): string => execFileSync(
          'git', ['-C', this.opts.workspaceRoot, '--no-pager', ...args],
          { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] },
        ).trimEnd();
        try {
          let lines: string[];
          if (name === '/diff') {
            const out = git('diff', '--no-ext-diff', '--no-textconv', '--stat', '--no-color');
            lines = out ? out.split('\n') : ['No uncommitted changes.'];
          } else if (name === '/files') {
            const out = git('status', '--short');
            lines = out ? out.split('\n').slice(0, 40) : ['No changed files.'];
          } else {
            const branch = git('branch', '--show-current');
            const status = git('status', '--short', '--branch');
            lines = [`branch: ${branch || 'detached HEAD'}`, ...status.split('\n').slice(0, 20)];
          }
          this.pushLine({
            kind: 'system', text: name.slice(1),
            lines: lines.map((text) => ({ text: approvalText(text), dimColor: true })),
          });
        } catch (error) {
          this.pushLine({ kind: 'error', text: `${name} failed: ${approvalText((error as Error).message.split('\n')[0]!)}`, color: C.red });
        }
        return;
      }
      case '/permissions': {
        const result = applyPermissionCommand(this.opts.cfg.permissionRules ?? [], arg);
        if (!result.ok) {
          this.pushLine({ kind: 'error', text: approvalText(result.message), color: C.red });
          return;
        }
        // Listing is read-only. Persist mutations before changing the running session, so a
        // failed save cannot claim a rule was installed when it will disappear on restart.
        if (result.rules !== this.opts.cfg.permissionRules && arg && arg.toLowerCase() !== 'list') {
          try {
            persistPermissionRules(this.opts.workspaceRoot, result.rules);
            this.opts.cfg.permissionRules = result.rules;
            this.loopRef?.setPermissionRules(result.rules);
          } catch (error) {
            this.pushLine({ kind: 'error', text: `Could not save permissions: ${approvalText((error as Error).message)}`, color: C.red });
            return;
          }
        }
        this.pushLine({
          kind: 'system', text: 'permissions',
          lines: result.message.split('\n').map((text) => ({ text: `  ${approvalText(text)}`, dimColor: true })),
        });
        return;
      }
      case '/resume':
        this.doResume(arg);
        return;
      case '/rename': {
        const title = normalizeSessionTitle(arg);
        if (!title) {
          this.pushLine({ text: '  Usage: /rename <session name>', dimColor: true });
          return;
        }
        if (!this.sessionLog.setTitle(title)) {
          this.pushLine({ kind: 'error', text: '  Could not save the session name.', color: C.red });
          return;
        }
        this.refreshSessionTitle();
        this.pushLine({ text: `  Session named ${title}`, color: C.cyan });
        return;
      }
      case '/rewind':
        this.doRewind(arg);
        return;
      case '/session':
        this.doSession();
        return;
      case '/doctor':
        this.doDoctor(arg);
        return;
      case '/memory':
        this.doMemory();
        return;
      case '/config':
        this.doConfig(arg);
        return;
      case '/local':
        this.doLocal(arg);
        return;
      case '/mcp':
        this.doMcp(arg);
        return;
      case '/fork':
        this.doFork();
        return;
      case '/keybindings':
        this.showPiKeybindings(arg);
        return;
      case '/plugins':
        this.doPlugins(arg);
        return;
      case '/provider':
        this.doProvider();
        return;
      case '/color':
        this.doTheme(arg);
        return;
      case '/output-style':
      case '/style': {
        const styles: OutputStyle[] = [
          'proactive',
          'explanatory',
          'learning',
          'procedural',
          ...(customStyleNames() as OutputStyle[]),
        ];
        const req = arg.toLowerCase() as OutputStyle;
        if (arg && !(styles as readonly string[]).includes(req)) {
          this.pushLine({ kind: 'error', text: `  Unknown style "${arg}". Styles: ${styles.join(', ')}.`, color: C.red });
          return;
        }
        const next = arg ? req : styles[(styles.indexOf(this.style) + 1) % styles.length]!;
        this.style = next;
        this.opts.styleState?.setStyle(next);
        void saveGlobalConfig({ lastStyle: next });
        this.pushLine({ text: `  Style → ${next}`, color: C.green });
        return;
      }
      case '/effort': {
        // Only a bare /effort cycles — a garbage argument once fell through to the CYCLE and
        // silently set an unrelated level (carried from the Ink handler's fix).
        const parsed = normalizeEffort(arg);
        if (arg && !parsed) {
          this.pushLine({ kind: 'error', text: `  Unknown effort "${arg}". Use: low, medium, high, xhigh, max — or /effort alone to cycle.`, color: C.red });
          return;
        }
        this.effort = parsed ?? cycleEffort(this.effort);
        this.opts.cfg.effort = this.effort;
        this.loopRef?.setEffort(this.effort);
        void saveGlobalConfig({ effort: this.effort });
        this.pushLine({ text: `  Effort → ${this.effort} ${effortSymbol(this.effort)} — ${effortDescription(this.effort)} (applies next turn)`, color: C.green });
        return;
      }
      case '/fast': {
        const want = arg.toLowerCase();
        if (want && want !== 'on' && want !== 'off') {
          this.pushLine({ text: '  Usage: /fast [on|off] — no argument toggles.', dimColor: true });
          return;
        }
        const next = want === 'on' ? true : want === 'off' ? false : !this.opts.cfg.fastMode;
        this.opts.cfg.fastMode = next;
        void saveGlobalConfig({ fastMode: next });
        this.pushLine({ text: `  Fast mode → ${next ? 'on' : 'off'} (applies on the next model turn)`, color: C.green });
        return;
      }
      case '/copy':
        this.copyLast(arg.toLowerCase() === 'code' ? 'code' : 'answer');
        return;
      case '/logo':
        if (arg !== 'on' && arg !== 'off') {
          this.pushLine({ text: '  Use /logo on|off.', color: C.yellow });
          return;
        }
        this.opts.cfg.showLogo = arg === 'on';
        void saveGlobalConfig({ showLogo: this.opts.cfg.showLogo });
        this.pushLine({ text: `  Welcome logo ${arg}; applies to the next launch.`, color: C.green });
        return;
      case '/add-dir': {
        if (!arg) {
          this.pushLine({
            kind: 'system',
            text: '',
            lines: this.additionalRoots.length
              ? this.additionalRoots.map((d) => ({ text: `  ${d}`, dimColor: true }))
              : [{ text: 'No extra directories granted. Use /add-dir <path> to grant one.', dimColor: true }],
          });
          return;
        }
        const abs = isAbsolute(arg) ? arg : resolve(this.opts.workspaceRoot, arg);
        try {
          if (!statSync(abs).isDirectory()) {
            this.pushLine({ kind: 'error', text: `  Not a directory: ${abs}`, color: C.red });
            return;
          }
        } catch {
          this.pushLine({ kind: 'error', text: `  No such directory: ${abs}`, color: C.red });
          return;
        }
        if (abs === this.opts.workspaceRoot || this.additionalRoots.includes(abs)) {
          this.pushLine({ text: `  Already accessible: ${abs}`, dimColor: true });
          return;
        }
        this.additionalRoots.push(abs);
        this.pushLine({ text: `  Granted (this session): ${abs}`, color: C.green });
        return;
      }
      case '/image': {
        if (!arg) {
          const n = this.imageAttachments.length;
          this.pushLine({
            text: n
              ? `  ${n} image(s) queued for the next message. /image clear to drop them.`
              : '  Usage: /image <path> — attaches an image to your next message (png/jpg/gif/webp).',
            dimColor: true,
          });
          return;
        }
        if (/^(clear|none|off)$/i.test(arg)) {
          this.imageAttachments.length = 0;
          this.pushLine({ text: '  Image attachments cleared.', dimColor: true });
          return;
        }
        const absImg = isAbsolute(arg) ? arg : resolve(this.opts.workspaceRoot, arg);
        const mediaType = imageMediaType(absImg);
        if (!mediaType) {
          this.pushLine({ kind: 'error', text: `  Unsupported image type: ${arg} (use png/jpg/gif/webp).`, color: C.red });
          return;
        }
        try {
          const info = statSync(absImg);
          if (!info.isFile()) {
            this.pushLine({ kind: 'error', text: `  Not a file: ${absImg}`, color: C.red });
            return;
          }
          if (info.size > MAX_IMAGE_BYTES) {
            this.pushLine({ kind: 'error', text: `  Image is too large: ${arg} (${(info.size / 1024 / 1024).toFixed(1)} MiB; max 20 MiB).`, color: C.red });
            return;
          }
          const data = readFileSync(absImg).toString('base64');
          this.imageAttachments.push({ mediaType, data });
          this.pushLine({ kind: 'image', text: '', image: { bytes: data, mediaType, alt: basename(absImg), source: absImg } });
          this.pushLine({ text: `  Attached ${basename(absImg)} (${mediaType}) — sends with your next message.`, color: C.cyan });
        } catch (e) {
          this.pushLine({ kind: 'error', text: `  Could not read ${arg}: ${(e as Error).message}`, color: C.red });
        }
        return;
      }
      case '/init': {
        const target = join(this.opts.workspaceRoot, 'SHADOW.md');
        if (existsSync(target)) {
          this.pushLine({ text: '  SHADOW.md already exists — not overwritten.', dimColor: true });
          return;
        }
        const seed =
          'You are Shadow working in this project.\n\n' +
          'Add project-specific conventions, build commands, and hard rules here.\n';
        try {
          writeFileSync(target, seed, 'utf8');
          this.pushLine({ text: `  Created ${target}`, color: C.cyan });
        } catch (e) {
          this.pushLine({ kind: 'error', text: `  Could not write ${target}: ${(e as Error).message}`, color: C.red });
        }
        return;
      }
      case '/review':
        if (this.running) {
          this.pushLine({ text: '  Finish the current turn before /review.', dimColor: true });
          return;
        }
        this.startTurn(
          'Review the current uncommitted changes for bugs, regressions, and issues. Run git diff yourself to see them, then report concrete findings (file:line) and any fixes you recommend.',
        );
        return;
      case '/plan': {
        const pm = this.opts.planMode;
        if (!pm) {
          this.pushLine({ text: '  Plan mode is not available in this session.', dimColor: true });
          return;
        }
        const req = arg.toLowerCase();
        if (req && req !== 'on' && req !== 'off' && req !== 'status') {
          this.pushLine({ text: '  Usage: /plan [on|off|status] — no argument toggles.', dimColor: true });
          return;
        }
        if (req === 'status') {
          const snap = pm.snapshot();
          this.pushLine({
            text:
              snap.mode === 'planning'
                ? `  Plan mode ON${snap.title ? ` — ${snap.title}` : ''} · reads free, writes held · /plan off to resume`
                : '  Plan mode off · writes allowed · /plan on to start planning',
            dimColor: true,
          });
          return;
        }
        const want = req === 'on' ? true : req === 'off' ? false : !pm.active;
        if (want === pm.active) {
          this.pushLine({ text: want ? '  Plan mode is already on.' : '  Plan mode is already off.', dimColor: true });
          return;
        }
        if (want) {
          pm.enter();
          this.planMode = true;
          this.pushLine({ text: '  Plan mode on — reads free, writes held (/plan off to resume)', color: C.yellow });
        } else {
          pm.exit();
          this.planMode = false;
          // Leaving plan restarts at the cautious end of the ring — same rule as Ink.
          this.autonomy = 'manual';
          this.loopRef?.setAutonomy('manual');
          this.opts.onAutonomyChange?.('manual');
          this.pushLine({ text: '  Plan mode off — writes allowed, autonomy → manual', color: C.green });
        }
        return;
      }
      case '/expand':
        this.showAllExpanded = !this.showAllExpanded;
        this.rebuildRuns();
        this.tui.requestRender();
        this.pushLine({ text: `  ${this.showAllExpanded ? 'expanded — everything unfolded' : 'collapsed — folds back in'}`, dimColor: true });
        return;
      case '/sessions': {
        // The /resume INVENTORY — what /resume can load, without opening the picker.
        const sessions = listResumableSessions(this.opts.workspaceRoot);
        if (!sessions.length) {
          this.pushLine({ text: '  No resumable sessions in this workspace yet.', dimColor: true });
          return;
        }
        const currentId = SessionLog.sessionIdFromPath(this.sessionLog.path);
        this.pushLine({
          kind: 'system',
          text: '',
          lines: [
            { text: `Resumable sessions (${sessions.length})`, bold: true },
            ...sessions.slice(0, 50).map((x) => ({
              text: approvalText(`  ${x.id === currentId ? '▸ ' : '  '}${x.title} · ${x.id}`),
              color: x.id === currentId ? C.cyan : undefined,
              dimColor: x.id !== currentId,
            })),
            { text: '  /resume <id> to load one', dimColor: true },
          ],
        });
        return;
      }
      case '/agents': {
        const parts = arg.split(/\s+/).filter(Boolean);
        if (parts[0] === 'kill') {
          const target = parts[1];
          const live = [...this.subAgents.values()].filter((a) => a.background && !a.done);
          if (!live.length) {
            this.pushLine({ text: '  No background agents are running.', dimColor: true });
            return;
          }
          if (!target) {
            this.pushLine({ text: `  Usage: /agents kill <id|all>. Running: ${live.map((a) => a.taskId).join(', ')}`, dimColor: true });
            return;
          }
          if (target === 'all') {
            this.opts.bus.emit({ type: 'cancel_subagent', taskId: '*' });
            this.pushLine({ text: `  Cancelling ${live.length} background agent${live.length === 1 ? '' : 's'}…`, color: C.yellow });
            return;
          }
          const match = live.find((a) => a.taskId === target || a.taskId.endsWith(target));
          if (!match) {
            this.pushLine({ kind: 'error', text: `  No running background agent matches "${target}".`, color: C.red });
            return;
          }
          this.opts.bus.emit({ type: 'cancel_subagent', taskId: match.taskId });
          this.pushLine({ text: `  Cancelling ${match.subagentType} (${match.taskId})…`, color: C.yellow });
          return;
        }
        const live = [...this.subAgents.values()];
        const defs = loadAgentDefs(this.opts.workspaceRoot);
        const lines: { text: string; color?: string; dimColor?: boolean; bold?: boolean }[] = [];
        if (live.length) {
          lines.push({ text: 'Running now:', color: C.cyan });
          for (const a of live) {
            const state = a.done ? (a.ok === false ? 'failed' : 'done') : a.queued ? 'queued' : 'running';
            lines.push({ text: `  ${a.taskId}  ${a.subagentType} — ${state}`, dimColor: true });
          }
        }
        lines.push({ text: `Agent definitions (${defs.length})`, bold: true });
        for (const d of defs.slice(0, 20)) lines.push({ text: `  ${d.name}`, dimColor: true });
        this.pushLine({ kind: 'system', text: '', lines });
        return;
      }
      case '/work': {
        if (!this.opts.workCenter || !this.opts.bgRegistry) {
          this.pushLine({ kind: 'error', text: '  Work Center is unavailable in this session.', color: C.red });
          return;
        }
        const result = executeWorkCommand(arg, {
          workCenter: this.opts.workCenter,
          bus: this.opts.bus,
          bgRegistry: this.opts.bgRegistry,
          workHistory: this.opts.workHistory,
        });
        if (result.error) {
          this.pushLine({ kind: 'error', text: `  ${result.error}`, color: C.red });
        } else {
          this.pushLine({
            kind: 'system',
            text: '',
            lines: result.lines.map((text) => ({ text, dimColor: true })),
          });
        }
        return;
      }
      case '/skills': {
        const skills = discoverSkills(this.opts.workspaceRoot);
        this.pushLine({
          kind: 'system',
          text: '',
          lines: skills.length
            ? skills.slice(0, 30).map((x) => ({ text: `  ${x.name.padEnd(18)} ${shortPath(x.path)} — ${x.description}`, dimColor: true }))
            : [{ text: 'No skills discovered (workspace .shadow/skills or ~/.shadow/skills).', dimColor: true }],
        });
        return;
      }
      case '/workflows': {
        const roots = [
          { label: 'workspace', dir: join(this.opts.workspaceRoot, '.shadow', 'workflows') },
          ...enabledPluginDirs('workflows').map((dir) => ({ label: `plugin:${basename(dirname(dir))}`, dir })),
          { label: 'global', dir: join(GLOBAL_DIR, 'workflows') },
        ];
        const wlines: { text: string; dimColor?: boolean }[] = [];
        for (const root of roots) {
          try {
            const entries = readdirSync(root.dir, { withFileTypes: true })
              .filter((entry) => !entry.name.startsWith('.'))
              .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`)
              .sort((a, b) => a.localeCompare(b));
            if (!entries.length) continue;
            wlines.push({ text: approvalText(`${root.label}: ${shortPath(root.dir)}`), dimColor: true });
            for (const entry of entries.slice(0, 20)) wlines.push({ text: approvalText(`  ${entry}`), dimColor: true });
            if (entries.length > 20) wlines.push({ text: `  ... ${entries.length - 20} more`, dimColor: true });
          } catch {
            /* a missing root just contributes nothing */
          }
        }
        this.pushLine({
          kind: 'system',
          text: '',
          lines: wlines.length ? wlines : [{ text: 'No workflow files found under .shadow/workflows or ~/.shadow/workflows.', dimColor: true }],
        });
        return;
      }
      case '/hooks': {
        const hooks = (this.opts.cfg.hooks ?? {}) as Record<string, unknown[]>;
        const phases = Object.keys(hooks).filter((k) => Array.isArray(hooks[k]) && hooks[k]!.length > 0);
        this.pushLine({
          kind: 'system',
          text: '',
          lines: phases.length
            ? phases.map((x) => ({ text: `  ${x}: ${hooks[x]!.length} hook(s)`, dimColor: true }))
            : [{ text: 'No hooks configured (set "hooks" in ~/.shadow/config.json).', dimColor: true }],
        });
        return;
      }
      case '/connections': {
        const rows = egressSummary();
        if (!rows.length) {
          this.pushLine({ text: '  No egress recorded yet this session — nothing has left the box.', dimColor: true });
          return;
        }
        this.pushLine({
          kind: 'system',
          text: '',
          lines: [
            { text: `Connections this session (${rows.length} host${rows.length === 1 ? '' : 's'}) — full receipt: \`shadow egress\``, bold: true },
            ...rows.slice(0, 20).map((r) => {
              const counts = [
                r.allowed > 0 ? `${r.allowed} allowed` : '',
                r.denied > 0 ? `${r.denied} denied` : '',
                r.flagged > 0 ? `${r.flagged} ⚑ outside allowlist` : '',
              ].filter(Boolean).join(' · ');
              const seen = new Date(r.lastSeen).toLocaleTimeString();
              return {
                text: approvalText(`  ${r.host} — ${counts} · ${[...r.purposes].sort().join(', ')} · ${seen}`),
                color: r.denied > 0 || r.flagged > 0 ? C.yellow : undefined,
                dimColor: r.denied === 0 && r.flagged === 0,
              };
            }),
            { text: 'Every outbound request flows the egress broker; --offline denies all non-local egress.', dimColor: true },
          ],
        });
        return;
      }
      case '/login': {
        // Pi keeps credential mutation in the dedicated CLI for v9, but reports the same real
        // store/gate/expiry state as Ink. No status line contains a token.
        const parts2 = arg.split(/\s+/).filter(Boolean);
        if (parts2[0] && parts2[0] !== 'status' && parts2[0] !== 'show') {
          this.pushLine({ text: '  Credential import runs outside the shell: `shadow login`.', dimColor: true });
          return;
        }
        this.pushLine({
          kind: 'system',
          text: '',
          lines: [
            { text: 'API keys: run `shadow onboard` to save provider credentials.', color: C.cyan },
            ...subscriptionAuthLines(Math.floor(Date.now() / 1000)).map((text) => ({ text: approvalText(text), dimColor: true })),
            { text: '  import / refresh: `shadow login` (outside the shell)', dimColor: true },
            { text: '  clear: /logout codex|grok|all', dimColor: true },
            { text: '  vault keys: managed per-model preset (/model add)', dimColor: true },
          ],
        });
        return;
      }
      case '/logout': {
        const target = arg.trim();
        if (!target) {
          this.pushLine({ text: '  Usage: /logout codex|grok|all', dimColor: true });
          return;
        }
        const providers: SubProvider[] = target === 'all' ? ['codex', 'grok'] : parseSubProvider(target) ? [parseSubProvider(target)!] : [];
        if (!providers.length) {
          this.pushLine({ text: '  Usage: /logout codex|grok|all', dimColor: true });
          return;
        }
        for (const provider of providers) clearSubAuth(provider);
        this.pushLine({ text: `  Cleared subscription credentials: ${providers.join(', ')}`, color: C.cyan });
        return;
      }
      case '/onboard':
        this.pushLine({
          kind: 'system',
          text: '',
          lines: [
            { text: '  Run `shadow onboard` outside the TUI to edit provider credentials.', color: C.cyan },
            { text: '  Model presets can be managed live: /model add|remove|enable|disable.', dimColor: true },
          ],
        });
        return;
      case '/editor':
        this.openExternalEditor();
        return;
      case '/terminal-setup':
        this.pushLine({
          kind: 'system',
          text: '',
          lines: [
            { text: 'Shift+Enter newline', bold: true },
            { text: '  This shell reads CSI-u and modifyOtherKeys Shift+Enter natively (kitty, WezTerm,', dimColor: true },
            { text: '  Ghostty, foot; iTerm2/VS Code after their "send ESC[13;2u" keybinding).', dimColor: true },
            { text: '  Terminal.app cannot send it — use Option+Enter there.', dimColor: true },
          ],
        });
        return;
      case '/accessibility': {
        if (arg === 'motion off' || arg === 'motion on') {
          this.opts.cfg.reducedMotion = arg === 'motion off';
          void saveGlobalConfig({ reducedMotion: this.opts.cfg.reducedMotion });
          this.pushLine({ text: `  Animation ${this.opts.cfg.reducedMotion ? 'off' : 'on'}.`, color: C.green });
        } else {
          this.pushLine({
            kind: 'system',
            text: '',
            lines: [
              { text: `Animation: ${this.opts.cfg.reducedMotion ? 'off' : 'on'}. Use /accessibility motion off|on.`, dimColor: true },
              { text: 'Themes: /theme high-contrast, /theme light, /theme mono.', dimColor: true },
              { text: 'User turns are banded; model output is not — distinguishable without color.', dimColor: true },
            ],
          });
        }
        return;
      }
      case '/summary':
        this.runSlash('/compact');
        return;
      default:
        this.pushLine({
          text: `  Command routing error: ${command.name} declares pi handler "${handler}" without an implementation.`,
          color: C.red,
        });
        return;
    }
  }

  private async compactContext(controller: AbortController): Promise<void> {
    try {
      const result = await this.opts.context.maybeSummarize(
        this.provider,
        this.current.model,
        true,
        controller.signal,
        { temperature: this.opts.cfg.temperature },
      );
      if (controller.signal.aborted) {
        this.pushLine({ text: '  Compaction cancelled — context unchanged.', dimColor: true });
      } else if (result === 'summarized') {
        this.pushLine({ text: '  Context compacted — earlier turns summarized.', color: C.cyan });
      } else if (result === 'truncated') {
        this.sessionLog.record({ kind: 'compaction_degraded', mode: 'truncated', source: 'manual' });
        this.pushLine({
          text: '  Summarizer unavailable — context reclaimed by dropping the oldest tool results (re-read any file you still need).',
          color: C.yellow,
        });
      } else if (result === 'failed') {
        this.sessionLog.record({ kind: 'compaction_degraded', mode: 'failed', source: 'manual' });
        this.pushLine({
          text: '  Compaction failed — summarizer unavailable and nothing left to reclaim. Try /clear, or /model to a larger window.',
          color: C.red,
        });
      } else {
        this.pushLine({ text: '  Nothing to compact yet.', dimColor: true });
      }
    } catch (error) {
      this.pushLine(
        controller.signal.aborted
          ? { text: '  Compaction cancelled — context unchanged.', dimColor: true }
          : { kind: 'error', text: `  Compact failed: ${approvalText((error as Error).message)}`, color: C.red },
      );
    } finally {
      if (this.compactController === controller) {
        this.compacting = false;
        this.compactController = null;
        this.flushQueue();
      }
    }
  }

  private doProvider(): void {
    const baseUrl = this.activeTarget.baseUrl;
    const matches = (entry: ModelEntry): boolean =>
      entry.provider === this.current.provider && entry.model === this.opts.cfg.model;
    const entry = this.opts.cfg.models?.find((candidate) => matches(candidate) && candidate.label === this.opts.cfg.lastModel)
      ?? this.opts.cfg.models?.find(
        (candidate) => matches(candidate) && resolveBaseUrl(candidate.provider, candidate.baseUrl) === baseUrl,
      );
    const credential = resolveEntryCredential(entry ?? { provider: this.current.provider }, {
      vaultIsLocked: vaultExists() && !vaultUnlocked(),
    });
    const hasApiKey = credential.ok && Boolean(credential.apiKey);
    const hasAuthToken = credential.ok && Boolean(credential.authToken);
    const envName = this.current.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
    const source = !credential.ok
      ? `model credential ${credential.reason}`
      : credential.source === 'credRef'
        ? `model vault slot: ${entry?.credRef}`
        : credential.source === 'inline'
          ? 'model-specific key'
          : process.env[envName]
            ? envName
            : `shared provider slot: ${this.current.provider}`;
    const authLines = this.current.provider === 'mock'
      ? [
        { text: 'auth: not required (mock provider)', dimColor: true },
        { text: 'configured credential source: built-in mock provider', dimColor: true },
      ]
      : [
        { text: `auth: api key ${hasApiKey ? 'present' : 'missing'} · bearer ${hasAuthToken ? 'present' : 'missing'}`, dimColor: true },
        { text: approvalText(`configured credential source: ${source}`), dimColor: true },
      ];
    const total = this.opts.cfg.models?.length ?? 0;
    const disabled = this.opts.cfg.models?.filter((candidate) => candidate.disabled).length ?? 0;
    this.pushLine({
      kind: 'system',
      text: 'provider',
      lines: [
        { text: approvalText(`${this.current.provider}/${this.current.model}`), color: C.cyan },
        { text: approvalText(`endpoint: ${baseUrl || '(provider default)'}`), dimColor: true },
        ...(this.activeTarget.selfHosted
          ? [{ text: `temperature: ${formatTemperature(this.opts.cfg.temperature ?? 1)} · self-hosted sampling`, dimColor: true }]
          : []),
        ...authLines,
        { text: `presets: ${total} configured${disabled ? ` · ${disabled} disabled` : ''}`, dimColor: true },
        { text: 'Commands: /model list · /model add · /model use <label> · /model default <label>', dimColor: true },
      ],
    });
  }

  private doConfig(arg: string): void {
    const parts = arg.split(/\s+/).filter(Boolean);
    if (parts[0] === 'set') {
      const key = parts[1] ?? '';
      const raw = parts[2] ?? '';
      if (!key || !raw) {
        this.pushLine({ text: `  Usage: /config set <${SAFE_CONFIG_KEYS.join('|')}> <value>`, dimColor: true });
        return;
      }
      const parsed = parseSafeConfig(key, raw);
      if (!parsed.ok) {
        this.pushLine({ kind: 'error', text: `  ${parsed.message}`, color: C.red });
        return;
      }
      try {
        // Persist first: a failed disk write must not leave the live process claiming success.
        saveGlobalConfig({ [parsed.key]: parsed.value });
        (this.opts.cfg as unknown as Record<string, unknown>)[parsed.key] = parsed.value;
        if (parsed.key === 'effort') {
          this.effort = parsed.value as Effort;
          this.loopRef?.setEffort(this.effort);
        }
        this.pushLine({
          text: `  Config saved: ${parsed.key} = ${parsed.key === 'temperature' ? formatTemperature(parsed.value as number) : String(parsed.value)}${parsed.key === 'temperature' ? ' (self-hosted models only)' : ''}`,
          color: C.cyan,
        });
      } catch (error) {
        this.pushLine({ kind: 'error', text: `  Config save failed: ${approvalText((error as Error).message)}`, color: C.red });
      }
      return;
    }
    if (parts[0] === 'get') {
      const key = parts[1] ?? '';
      if (!key) {
        this.pushLine({ text: '  Usage: /config get <key>', dimColor: true });
        return;
      }
      const value = (this.opts.cfg as unknown as Record<string, unknown>)[key];
      const shown = isSecretKey(key) && value != null && value !== ''
        ? maskSecret(value)
        : JSON.stringify(redactConfig(value));
      this.pushLine({
        text: approvalText(`  ${key}: ${value === undefined ? '(unset)' : shown}`),
        dimColor: true,
      });
      return;
    }
    if (parts.length && parts[0] !== 'show' && parts[0] !== 'list') {
      this.pushLine({ text: '  Usage: /config [show|get <key>|set <safe-key> <value>]', dimColor: true });
      return;
    }
    const cfg = this.opts.cfg;
    this.pushLine({
      kind: 'system',
      text: 'config',
      lines: [
        { text: approvalText(`provider/model: ${cfg.provider}/${cfg.model}`), color: C.cyan },
        { text: `autonomy ${this.autonomy} · autoClassifier ${cfg.autoClassifier ? 'on' : 'off'} · fastMode ${cfg.fastMode ? 'on' : 'off'}`, dimColor: true },
        { text: `effort ${cfg.effort} · cacheTtl ${cfg.cacheTtl} · parallelTools ${cfg.parallelTools ? 'on' : 'off'}${cfg.costWarnUSD != null ? ` · costWarn $${cfg.costWarnUSD}` : ''}`, dimColor: true },
        { text: `temperature ${formatTemperature(cfg.temperature ?? 1)} · self-hosted models only`, dimColor: true },
        { text: `maxIterations ${cfg.maxIterations || 'unlimited'} · contextBudget ${cfg.contextBudget.toLocaleString()}`, dimColor: true },
        { text: `${cfg.models?.length ?? 0} models configured · API keys hidden`, dimColor: true },
        { text: `Editable here: ${SAFE_CONFIG_KEYS.join(', ')}`, dimColor: true },
      ],
    });
  }

  private doLocal(arg: string): void {
    const parsed = splitPresetArgs(arg);
    if (!parsed.ok) {
      this.pushLine({ kind: 'error', text: `  ${parsed.message}`, color: C.red });
      return;
    }
    const [action = '', ...rest] = parsed.value;
    const models = this.opts.cfg.models ?? [];
    if (!action || action === 'list' || action === 'show') {
      this.pushLine({
        kind: 'system',
        text: 'local',
        lines: formatLocalList(models).map((text) => ({
          text: approvalText(text.replaceAll('local add', '/local add')),
          dimColor: true,
        })),
      });
      return;
    }
    if (action === 'test') {
      this.doModel(`test ${rest.map((part) => JSON.stringify(part)).join(' ')}`.trim());
      return;
    }
    if (action === 'add') {
      const add = parseLocalAddArgs(rest);
      if (!add.ok) {
        this.pushLine({ kind: 'error', text: `  ${add.message}`, color: C.red });
        return;
      }
      const result = addLocalModel(models, add.value);
      if (!result.ok) {
        this.pushLine({ kind: 'error', text: `  ${result.message}`, color: C.red });
        return;
      }
      try {
        saveGlobalConfig({ models: result.value.models });
        this.opts.cfg.models = result.value.models;
        this.pushLine({ text: approvalText(`  Added local model: ${result.value.entry.label}`), color: C.cyan });
      } catch (error) {
        this.pushLine({ kind: 'error', text: `  Local model save failed: ${approvalText((error as Error).message)}`, color: C.red });
      }
      return;
    }
    if (action === 'remove' || action === 'delete') {
      const result = removeLocalModel(models, rest[0] ?? '');
      if (!result.ok) {
        this.pushLine({ kind: 'error', text: `  ${result.message}`, color: C.red });
        return;
      }
      try {
        saveGlobalConfig({ models: result.value });
        this.opts.cfg.models = result.value;
        this.pushLine({ text: approvalText(`  Removed local model: ${rest[0] ?? ''}`), color: C.cyan });
      } catch (error) {
        this.pushLine({ kind: 'error', text: `  Local model save failed: ${approvalText((error as Error).message)}`, color: C.red });
      }
      return;
    }
    if (action === 'use' || action === 'switch') {
      const entry = findModelPreset(listLocalModels(models).filter((model) => !model.disabled), rest[0] ?? '');
      if (!entry) {
        this.pushLine({ kind: 'error', text: rest[0] ? `  No local model named "${approvalText(rest[0])}".` : '  Usage: /local use <name>', color: C.red });
        return;
      }
      this.selectModel(entry);
      return;
    }
    this.pushLine({
      text: '  Usage: /local [list|add <path-or-endpoint> [options]|use <name>|test <name>|remove <name>]',
      dimColor: true,
    });
  }

  private doMcp(arg: string): void {
    const parts = arg.split(/\s+/).filter(Boolean);
    const action = parts[0] ?? 'list';
    const effective = (this.opts.cfg.mcpServers ?? {}) as McpServers;
    if (action === 'get') {
      const name = parts[1] ?? '';
      const server = effective[name];
      if (!name || !server) {
        this.pushLine({ text: name ? `  No MCP server "${approvalText(name)}" configured.` : '  Usage: /mcp get <name>', dimColor: true });
        return;
      }
      this.pushLine({
        kind: 'system',
        text: 'mcp',
        lines: mcpServerLines(name, server, {
          requested: (this.opts.cfg.sandbox ?? 'auto') !== 'off',
          toolAvailable: sandboxToolAvailable(),
        }).map((text, index) => ({ text: approvalText(text), color: index === 0 ? C.cyan : undefined, dimColor: index !== 0 })),
      });
      return;
    }
    if (action === 'enable') {
      const preset = parts[1];
      if (preset !== 'browser' && preset !== 'context-cooler') {
        this.pushLine({ text: '  Usage: /mcp enable <browser|context-cooler [--path <dir|server.js>]>', dimColor: true });
        return;
      }
      const servers = loadGlobalMcpServers();
      const pathIndex = parts.indexOf('--path');
      const pathArg = pathIndex >= 0 ? parts[pathIndex + 1] : undefined;
      const change = preset === 'browser' ? enablePlaywrightBrowser(servers) : enableContextCooler(servers, pathArg);
      if (change.ok) {
        try {
          saveGlobalMcpServers(change.servers);
          this.opts.cfg.mcpServers = change.servers;
        } catch (error) {
          this.pushLine({ kind: 'error', text: `  MCP save failed: ${approvalText((error as Error).message)}`, color: C.red });
          return;
        }
      }
      this.pushLine({
        text: approvalText(`  ${change.message}${change.ok ? ' Restart Shadow to load the new MCP tools.' : ''}`),
        color: change.ok ? C.cyan : C.red,
      });
      return;
    }
    if (action === 'disable') {
      const change = disableMcpServer(loadGlobalMcpServers(), parts[1] ?? '');
      if (change.ok) {
        try {
          saveGlobalMcpServers(change.servers);
          this.opts.cfg.mcpServers = change.servers;
        } catch (error) {
          this.pushLine({ kind: 'error', text: `  MCP save failed: ${approvalText((error as Error).message)}`, color: C.red });
          return;
        }
      }
      this.pushLine({ text: approvalText(`  ${change.message}`), color: change.ok ? C.cyan : C.red });
      return;
    }
    if (action !== 'list' && action !== 'show') {
      this.pushLine({ text: '  Usage: /mcp [list|get <name>|enable browser|enable context-cooler [--path <path>]|disable <name>]', dimColor: true });
      return;
    }
    this.pushLine({
      kind: 'system',
      text: 'mcp',
      lines: mcpListLines(effective).map((text) => ({ text: approvalText(text), dimColor: true })),
    });
  }

  private doPlugins(arg: string): void {
    const parts = arg.trim().split(/\s+/).filter(Boolean);
    if (parts[0] === 'enable' || parts[0] === 'disable') {
      const name = parts[1] ?? '';
      if (!name) {
        this.pushLine({ text: `  Usage: /plugins ${parts[0]} <name>`, dimColor: true });
        return;
      }
      try {
        const info = setPluginEnabled(name, parts[0] === 'enable');
        this.pushLine({
          text: approvalText(`  ${parts[0] === 'enable' ? 'Enabled' : 'Disabled'} plugin "${info.name}" — restart or start a new session to apply.`),
          color: parts[0] === 'enable' ? C.green : C.yellow,
        });
      } catch (error) {
        this.pushLine({ kind: 'error', text: `  ${approvalText((error as Error).message)}`, color: C.red });
      }
      return;
    }
    if (parts.length && parts[0] !== 'list' && parts[0] !== 'show') {
      this.pushLine({ text: '  Usage: /plugins [list|enable <name>|disable <name>]', dimColor: true });
      return;
    }
    const lines: Array<{ text: string; color?: string; dimColor?: boolean }> = [];
    const plugins = listPlugins();
    if (!plugins.length) lines.push({ text: 'No plugins installed. `shadow plugin add <git-url | path>` installs one disabled.', dimColor: true });
    for (const plugin of plugins) {
      const counts = PLUGIN_CONTENT_DIRS.filter((kind) => plugin.counts[kind] > 0)
        .map((kind) => `${plugin.counts[kind]} ${kind}`)
        .join(' · ') || 'no content';
      const provenance = plugin.meta.source.kind === 'git'
        ? `${plugin.meta.source.url}${plugin.meta.source.commit ? ` @ ${plugin.meta.source.commit.slice(0, 12)}` : ''}`
        : plugin.meta.source.path;
      lines.push({
        text: `${plugin.meta.enabled ? '●' : '○'} ${displaySafe(plugin.name, 64)} v${displaySafe(plugin.manifest.version, 64)} [${plugin.meta.enabled ? 'enabled' : 'disabled'}] — ${displaySafe(plugin.manifest.description, 300)}`,
        color: plugin.meta.enabled ? C.green : C.yellow,
      });
      lines.push({ text: `    ${counts} · from ${displaySafe(provenance, 320)}`, dimColor: true });
    }
    lines.push({ text: 'Plugins are data-only: commands, output styles, skills, agents, and workflows.', dimColor: true });
    this.pushLine({ kind: 'system', text: 'plugins', lines });
  }

  private doMemory(): void {
    const index = ProjectMemory.load(this.opts.workspaceRoot).asIndex(Number.MAX_SAFE_INTEGER);
    if (!index) {
      this.pushLine({ text: '  No memory facts stored yet.', dimColor: true });
      return;
    }
    this.pushLine({
      kind: 'system',
      text: 'memory',
      lines: index.split('\n').map((text) => ({ text: approvalText(text), dimColor: true })),
    });
  }

  private doDoctor(arg: string): void {
    if (arg.trim().toLowerCase() === 'model') {
      this.doModel('test');
      return;
    }
    if (arg.trim()) {
      this.pushLine({ kind: 'error', text: `  Unknown /doctor argument "${approvalText(arg.trim())}". Use /doctor or /doctor model.`, color: C.red });
      return;
    }
    const report = formatDoctorReport(runDoctor(this.opts.workspaceRoot), this.opts.version);
    this.pushLine({
      kind: 'system',
      text: 'doctor',
      lines: report.split('\n').map((text) => ({
        text: approvalText(text),
        dimColor: !text.startsWith('  ✗') && !text.includes('failed'),
      })),
    });
  }

  private doFork(): void {
    if (this.running || this.compacting || this.modelChecking) {
      this.pushLine({ text: '  Finish the current operation before forking.', dimColor: true });
      return;
    }
    try {
      const source = this.sessionLog;
      const sourceId = SessionLog.sessionIdFromPath(source.path);
      const { log, forkId } = forkSession(source, this.opts.workspaceRoot);
      this.adoptSessionLog(log);
      if (this.opts.workCenter) recordWorkCenterSnapshot(log, this.opts.workCenter.snapshot());
      this.approvals.clear();
      this.readTracker.clear();
      this.refreshRewindTurns();
      this.pushLine({
        kind: 'system',
        text: 'fork',
        lines: [
          { text: `Forked → session ${approvalText(forkId)} (source ${approvalText(sourceId)} left untouched).`, color: C.cyan },
          { text: 'New turns and /rewind now live in the fork.', dimColor: true },
        ],
      });
    } catch (error) {
      this.pushLine({ kind: 'error', text: `  Fork failed: ${approvalText((error as Error).message)}`, color: C.red });
    }
  }

  private showPiKeybindings(arg: string): void {
    if (arg && arg !== 'show' && arg !== 'list') {
      this.pushLine({
        text: '  Snowfall uses fixed bindings. Custom key maps and /keybindings init: SHADOW_TUI=ink shadow.',
        color: C.yellow,
      });
      return;
    }
    this.pushLine({
      kind: 'system',
      text: 'pi keybindings',
      lines: [
        ...PI_KEYS.map(({ key, action }) => ({ text: `  ${key.padEnd(20)} ${action}`, dimColor: true })),
        { text: '~/.shadow/keybindings.json is Ink-only. Use SHADOW_TUI=ink shadow for custom maps.', color: C.yellow },
      ],
    });
  }

  private doTheme(arg: string): void {
    const name = arg ? normalizeThemeName(arg) : THEME_NAMES[(THEME_NAMES.indexOf(this.themeName) + 1) % THEME_NAMES.length];
    if (!name) {
      this.pushLine({ kind: 'error', text: `  unknown theme: ${arg} — ${THEME_NAMES.join(', ')}`, color: C.red });
      return;
    }
    try {
      saveGlobalConfig({ lastTheme: name });
    } catch (error) {
      this.pushLine({ kind: 'error', text: `  Theme save failed: ${approvalText((error as Error).message)}`, color: C.red });
      return;
    }
    applyTheme(name);
    this.themeName = name;
    this.opts.cfg.lastTheme = name;
    this.terminal.write(backgroundSequence(themeBackground(name), !!process.stdout.isTTY));
    this.invalidateAll();
    this.tui.flash(`Theme: ${name}`);
  }

  private invalidateAll(): void {
    for (const cell of this.cellById.values()) cell.invalidate();
    this.streamCell.invalidate();
    this.tui.invalidate();
    this.tui.requestRender();
  }

  private doAutonomy(arg: string): void {
    const want = arg.trim().toLowerCase();
    const valid: AutonomyLevel[] = ['manual', 'auto-read', 'auto-edit', 'full'];
    if (want && !valid.includes(want as AutonomyLevel)) {
      this.pushLine({ kind: 'error', text: `  autonomy must be one of: ${valid.join(', ')}`, color: C.red });
      return;
    }
    // The same rule the dialog's "(a)lways" follows: cycleAutonomy can move DOWN the ring, which
    // is exactly what a confirmation prompt must never do. /autonomy is an explicit instruction,
    // so cycling is correct here; raiseAutonomy is for the dialog.
    this.autonomy = want ? (want as AutonomyLevel) : cycleAutonomy(this.autonomy);
    this.loopRef?.setAutonomy(this.autonomy);
    this.opts.onAutonomyChange?.(this.autonomy);
    this.hudRef = this.hudState();
    this.pushLine({ text: `  autonomy: ${this.autonomy}`, dimColor: true });
  }

  private doModel(arg: string): void {
    const parsed = splitPresetArgs(arg);
    if (!parsed.ok) {
      this.pushLine({ kind: 'error', text: `  ${parsed.message}`, color: C.red });
      return;
    }
    const parts = parsed.value;
    const action = parts[0] ?? '';
    const models = this.opts.cfg.models ?? [];
    if (!action) {
      this.openPicker();
      return;
    }
    if (action === 'list' || action === 'show') {
      this.pushLine({
        kind: 'system',
        text: 'model',
        lines: [
          { text: 'Configured models', bold: true },
          ...models.map((model) => ({
            text: approvalText(
              `${model.provider === this.current.provider && model.model === this.opts.cfg.model ? '  ●' : '   '} ${model.label}${model.disabled ? ' [disabled]' : ''}  (${model.provider}/${model.model})${model.baseUrl ? ` · ${model.baseUrl}` : ''}`,
            ),
            dimColor:
              model.provider !== this.current.provider || model.model !== this.opts.cfg.model || model.disabled === true,
          })),
          ...(models.length ? [] : [{ text: '  No model presets configured.', dimColor: true }]),
          { text: '  /model use <label> to switch · /model opens the picker', dimColor: true },
        ],
      });
      return;
    }
    if (action === 'picker') {
      this.openPicker();
      return;
    }
    if (action === 'add') {
      const add = parseModelAddArgs(parts);
      if (!add.ok) {
        this.pushLine({ kind: 'error', text: `  ${add.message}`, color: C.red });
        return;
      }
      const result = addModelPreset(models, add.value);
      if (!result.ok) {
        this.pushLine({ kind: 'error', text: `  ${result.message}`, color: C.red });
        return;
      }
      this.persistModels(result.value, `Added model preset: ${add.value.label}`);
      return;
    }
    if (action === 'remove' || action === 'delete') {
      const result = removeModelPreset(models, parts[1] ?? '');
      if (!result.ok) {
        this.pushLine({ kind: 'error', text: `  ${result.message}`, color: C.red });
        return;
      }
      this.persistModels(result.value, `Removed model preset: ${parts[1] ?? ''}`);
      return;
    }
    if (action === 'enable' || action === 'disable') {
      const result = setModelPresetEnabled(models, parts[1] ?? '', action === 'enable');
      if (!result.ok) {
        this.pushLine({ kind: 'error', text: `  ${result.message}`, color: C.red });
        return;
      }
      this.persistModels(result.value, `${action === 'enable' ? 'Enabled' : 'Disabled'} model preset: ${parts[1] ?? ''}`);
      return;
    }
    if (action === 'default' || action === 'set-default') {
      const entry = findModelPreset(models, parts[1] ?? '');
      if (!entry) {
        this.pushLine({ kind: 'error', text: parts[1] ? `  No model preset named "${approvalText(parts[1])}".` : '  Usage: /model default <label>', color: C.red });
        return;
      }
      if (entry.disabled) {
        this.pushLine({ kind: 'error', text: `  Cannot make disabled preset "${approvalText(entry.label)}" the default.`, color: C.red });
        return;
      }
      try {
        saveGlobalConfig(defaultModelPatch(entry));
        // `/model default` controls the next launch. Keep the live session identity untouched;
        // `/model use` is the explicit path that rebuilds and swaps the active provider.
        this.pushLine({ text: approvalText(`  Default model saved for next launch: ${entry.label}`), color: C.cyan });
      } catch (error) {
        this.pushLine({ kind: 'error', text: `  Model save failed: ${approvalText((error as Error).message)}`, color: C.red });
      }
      return;
    }
    if (action === 'test') {
      const target = parts.slice(1).join(' ');
      const entry = target ? findModelPreset(models, target) : undefined;
      if (target && !entry) {
        this.pushLine({ kind: 'error', text: `  No model preset named "${approvalText(target)}".`, color: C.red });
        return;
      }
      if (this.running || this.compacting || this.modelChecking) {
        this.pushLine({ text: '  Finish the current operation before testing a model.', dimColor: true });
        return;
      }
      this.modelChecking = true;
      void this.runModelCapabilityCheck(entry);
      return;
    }

    const requested = (action === 'use' || action === 'switch') ? parts.slice(1).join(' ') : parts.join(' ');
    if (!requested) {
      this.pushLine({ text: '  Usage: /model use <label>', dimColor: true });
      return;
    }
    // Preserve `/model <label>` while resolving exact labels before unique prefixes.
    const enabled = models.filter((model) => !model.disabled);
    const exact = enabled.find((model) => model.label.toLowerCase() === requested.toLowerCase());
    const prefix = exact ? [] : enabled.filter((model) => model.label.toLowerCase().startsWith(requested.toLowerCase()));
    const entry = exact ?? (prefix.length === 1 ? prefix[0] : undefined);
    if (!entry) {
      this.pushLine({
        kind: 'error',
        text: prefix.length
          ? `  Ambiguous model "${approvalText(requested)}" — ${prefix.map((model) => approvalText(model.label)).join(', ')}`
          : `  No enabled model labeled "${approvalText(requested)}" — /model list`,
        color: C.red,
      });
      return;
    }
    this.selectModel(entry);
  }

  /** A provider build is asynchronous. Keep queued input behind that barrier and release it only
   * after ModelSwitcher has cleared its in-flight state, regardless of success or failure. */
  private selectModel(entry: ModelEntry): void {
    void this.switcher.selectModel(entry).finally(() => {
      if (this.exiting) return;
      this.hudRef = this.hudState();
      this.tui.requestRender();
      this.flushQueue();
    });
  }

  private persistModels(models: ModelEntry[], message: string): void {
    try {
      saveGlobalConfig({ models });
      this.opts.cfg.models = models;
      this.pushLine({ text: approvalText(`  ${message}`), color: C.cyan });
    } catch (error) {
      this.pushLine({ kind: 'error', text: `  Model save failed: ${approvalText((error as Error).message)}`, color: C.red });
    }
  }

  private async runModelCapabilityCheck(entry?: ModelEntry): Promise<void> {
    try {
      let provider = this.provider;
      let model = this.current.model;
      let providerName = this.current.provider;
      let local = this.activeTarget.selfHosted;
      let label = `${this.current.provider}/${this.current.model}`;
      if (entry) {
        const built = await this.switcher.buildProvider(entry, { clampBudget: false });
        if (!built.ok) {
          this.pushLine({ kind: 'error', text: `  ${approvalText(built.error)}`, color: built.fatal ? C.red : C.yellow });
          return;
        }
        provider = built.client;
        model = built.model;
        providerName = built.provider;
        local = built.selfHosted || isLocalServedEntry(entry);
        label = entry.label;
      }
      this.pushLine({ text: approvalText(`  Testing ${label} — capability probes can take up to a minute…`), dimColor: true });
      const result = await runModelCheck(provider, {
        model,
        providerName,
        isLocal: local,
        temperature: this.opts.cfg.temperature,
        log: (message) => this.pushLine({ text: approvalText(`  ${message}`), dimColor: true }),
      });
      this.pushLine({
        kind: 'system',
        text: 'model test',
        lines: [
          ...result.probes.map((probe) => ({
            text: approvalText(`${probe.status === 'pass' ? '✓' : '✗'} [${probe.status}] ${probe.label}: ${probe.detail}`),
            color: probe.status === 'pass' ? C.green : C.red,
          })),
          { text: `Verdict: ${result.verdict.toUpperCase()}`, color: result.verdict === 'agentic' ? C.green : result.verdict === 'limited' ? C.cyan : C.red },
          { text: approvalText(`  ${result.recommendation}`), dimColor: true },
        ],
      });
    } catch (error) {
      this.pushLine({ kind: 'error', text: `  Model test failed: ${approvalText((error as Error).message)}`, color: C.red });
    } finally {
      this.modelChecking = false;
      this.flushQueue();
    }
  }

  /**
   * The model picker uses the shared model catalog order and names each entry's provider.
   * Esc cancels; arrows or a number select; Enter switches and closes.
   */
  private openPicker(): void {
    if (this.pickerHandle) return;
    const rows = modelRows(this.opts.cfg);
    const entries = rows
      .filter((r): r is Extract<PickerRow, { kind: 'model' }> => r.kind === 'model')
      .map((r) => r.entry);
    if (!entries.length) {
      this.pushLine({ kind: 'error', text: '  no models configured — /onboard', color: C.yellow });
      return;
    }
    const activeEntry = entries.find(
      (entry) => entry.provider === this.current.provider && entry.model === this.opts.cfg.model,
    );
    const picker = new ChoicePicker({
      title: 'Select a model', items: entries,
      selected: Math.max(0, entries.findIndex((entry) => entry === activeEntry)),
      label: (entry) => `${entry === activeEntry ? '● ' : ''}${entry.label} (${entry.provider}/${entry.model})`,
      choose: (entry) => { this.closePicker(); this.selectModel(entry); },
      close: () => this.closePicker(), repaint: () => this.tui.requestRender(), rows: () => this.terminal.rows,
    });
    this.pickerHandle = this.tui.showOverlay(picker, { anchor: 'center', width: 70 });
    this.tui.requestRender();
  }

  private closePicker(): void {
    this.pickerHandle?.hide();
    this.pickerHandle = null;
    this.tui.setFocus(this.editor);
    this.tui.requestRender();
  }

  private doExport(arg: string): void {
    // `/export [path]` → Markdown; `/export html [path]` → standalone HTML. Reuse the
    // renderer-neutral exporter so paths stay inside the workspace and files are owner-only.
    const [first, ...rest] = arg.split(/\s+/);
    const html = first?.toLowerCase() === 'html';
    const outArg = html ? rest.join(' ') : arg;
    try {
      const { path, bytes } = exportSession({
        sessionPath: this.sessionLog.path,
        workspaceRoot: this.opts.workspaceRoot,
        outPath: outArg || undefined,
        format: html ? 'html' : 'markdown',
        meta: {
          version: this.opts.version,
          workspaceRoot: this.opts.workspaceRoot,
          provider: this.current.provider,
          model: this.current.model,
          style: this.style,
          autonomy: this.autonomy,
          sessionPath: this.sessionLog.path,
          exportedAt: new Date().toISOString(),
        },
      });
      this.pushLine({ text: approvalText(`  Exported ${bytes} bytes → ${shortPath(path)}`), color: C.cyan });
    } catch (error) {
      this.pushLine({ kind: 'error', text: `  Export failed: ${approvalText((error as Error).message)}`, color: C.red });
    }
  }
}

// ── slash catalog ────────────────────────────────────────────────────────────

interface SlashSpec {
  name: string;
  desc: string;
  args?: (prefix: string) => { value: string; label: string; description?: string }[];
}

const SLASH: SlashSpec[] = terminalCommandsFor('pi').map(({ name, desc }) => ({
  name,
  desc,
  ...(name === '/theme'
    ? {
        args: (p: string) =>
          THEME_NAMES.filter((theme) => theme.startsWith(p))
            .map((theme) => ({ value: theme, label: theme, description: THEME_DESCRIPTIONS[theme] })),
      }
    : name === '/autonomy'
      ? {
          args: (p: string) =>
            ['manual', 'auto-read', 'auto-edit', 'full']
              .filter((level) => level.startsWith(p))
              .map((level) => ({ value: level, label: level })),
        }
      : {}),
}));

// ── themes for the editor ────────────────────────────────────────────────────

function selectListTheme(): SelectListTheme {
  return {
    selectedPrefix: (t) => fgAnsi(C.cyan) + t + RESET,
    selectedText: (t) => '\x1b[1m' + fgAnsi(C.fg) + t + RESET,
    description: (t) => fgAnsi(C.dim) + t + RESET,
    scrollInfo: (t) => fgAnsi(C.dim) + t + RESET,
    noMatch: (t) => fgAnsi(C.dim) + t + RESET,
  };
}

function editorTheme(): EditorTheme {
  return {
    // Dim border, bright accent when the composer holds a draft — the one border in the app.
    borderColor: (s: string) => fgAnsi(C.border ?? C.dim) + s + RESET,
    selectList: selectListTheme(),
  };
}

/** Preview of a tool call's argument, collapsed to one line. */
function previewOf(input: unknown): string {
  const o = input as Record<string, unknown> | undefined;
  if (o && typeof o === 'object') {
    if (typeof o.command === 'string') return `$ ${oneLine(o.command, 80)}`;
    if (typeof o.path === 'string') return o.path;
    if (typeof o.url === 'string') return o.url;
    if (typeof o.pattern === 'string') return o.pattern;
  }
  return '';
}
