import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import {
  resolveApiKey,
  resolveBaseUrl,
  resolveEntryCredential,
  type ShadowConfig,
  type ModelEntry,
} from '../config.js';
import { vaultExists } from '../auth/vault.js';
import { vaultUnlocked } from '../state/globalStore.js';
import { createProvider, entryStreamContract } from '../provider/index.js';
import { ToolRegistry } from '../tools/registry.js';
import { BgRegistry } from '../tools/bgShell.js';
import {
  makeAskUserQuestionTool,
  makeEnterPlanModeTool,
  makeExitPlanModeTool,
  makePlanWriteTool,
  makeSkillTool,
  makeToolSearch,
  makeDescribeMediaTool,
  registerBuiltinTools,
} from '../tools/index.js';
import { registerMcpServers } from '../mcp/client.js';
import { configuredContextWindow, detectServerContextWindow, mlxOfflineReady } from '../gguf.js';
import { discoverSkills, skillsIndexBlock, type SkillEntry } from '../skills/loader.js';
import { WakeupScheduler } from './wakeup.js';
import { Context } from './context.js';
import {
  evaluateOffline,
  isLocalBaseUrl,
  OFFLINE_BANNER,
  OFFLINE_UNENFORCED_WARNING,
  offlineEgressClaim,
  offlineEgressEnforced,
} from '../safety/offline.js';
import { osSandboxStatus, sandboxToolAvailable } from '../safety/sandbox.js';
import { setOfflineMode, setEgressPolicy } from '../safety/egress.js';
import { registerSecret } from '../util/redact.js';
import { lc } from '../util/lc.js';
import { ProjectMemory } from '../state/memory.js';
import { SessionLog } from '../state/session.js';
import { resumeSession } from '../state/resume.js';
import { applyRetention } from '../state/retention.js';
import { makeMemoryTool } from '../tools/memory.js';
import { TodoList } from './todo.js';
import { PlanModeState } from './planMode.js';
import { buildStyledSystem } from './system.js';
import { setCustomStyles } from './styles.js';
import { discoverCustomStyles } from './outputStyles.js';
import {
  clampLocalContextBudget,
  keepLastTurnsForBudget,
  triggerRatioForBudget,
} from '../util/contextBudget.js';
import { makeTodoTool } from '../tools/todo.js';
import { type OutputStyle } from '../styles.js';
import { resolveSystem } from '../system/resolveSystem.js';
import { runHookPhaseDetached } from '../hooks/runner.js';
import type { Flags } from '../cli/flags.js';

/**
 * Assembling an agent session: provider, tools, memory, prompt, context, session log.
 *
 * Lifted verbatim out of `main()` in index.ts, where it was trapped between argv parsing and
 * the TUI launch — which meant no HTTP handler could construct a `LoopDeps` even though
 * `buildLoopDeps()` and `AgentLoop` were already clean and transport-agnostic. `main()` is now
 * a caller of this, and so is the web server.
 *
 * This was moved with deliberately ZERO behaviour changes — including preserving a latent
 * inconsistency: `buildEnvBlock` reads `flags.noSandbox` before index.ts forces it true under
 * `--yolo`, so the env block can describe the sandbox as on while it is off. Fixing that here
 * would have made the move unverifiable. It is worth fixing separately.
 *
 * Two things stay with the caller on purpose:
 *  - `launchLocalServer`, because the gguf/MLX path offers an interactive `brew install` and
 *    its helpers have call sites elsewhere in the CLI;
 *  - `fail`, so the CLI can `process.exit` while a server caller throws instead. Today every
 *    caller passes an exiting implementation, which is exactly the old behaviour.
 */

export interface CreateAgentSessionOptions {
  cfg: ShadowConfig;
  flags: Flags;
  /** Package root, resolved by the entrypoint — never recomputed here, since this file sits
   *  at a different depth than index.ts and would resolve to `src/`. */
  installDir: string;
  cwd: string;
  workspaceRoot: string;
  additionalRoots: string[];
  activeStyle: OutputStyle;
  unrestricted: boolean;
  /** The model entry chosen by a prior `/model` pick, if any. */
  lastPicked?: ModelEntry;
  resumeSessionPath?: string;
  write: (s: string) => void;
  /** Fatal startup failure. The CLI exits; a server caller can throw. */
  fail: (message: string) => never;
  /** Hook session id passed to session_start. Defaults to 'main'; the web server passes the
   *  WebSession id so a browser session's hooks aren't all fired under the same literal. */
  sessionId?: string;
  /**
   * Start a local gguf/MLX server for `entry` and return the connection overrides. Returns
   * null when the entry is not locally served. Supplied by the caller because the CLI path
   * offers an interactive install prompt.
   */
  launchLocalServer: (
    entry: ModelEntry | undefined,
    offline: boolean,
  ) => Promise<{ provider: 'openai'; baseUrl: string; apiKey: string; ctxWindow: number } | null>;
}

export interface AgentSession {
  /** Possibly adjusted from the input — the local-model and gguf paths lower contextBudget. */
  cfg: ShadowConfig;
  /** Unclamped user policy, retained so switching models can derive a fresh per-model policy. */
  baseContextPolicy: { contextBudget: number; triggerRatio: number; keepLastTurns: number };
  provider: ReturnType<typeof createProvider>;
  registry: ToolRegistry;
  bg: BgRegistry;
  memory: ProjectMemory;
  todoList: TodoList;
  planMode: PlanModeState;
  wakeup: WakeupScheduler;
  skills: SkillEntry[];
  facts: string;
  system: string;
  systemForStyle: (style: OutputStyle) => string;
  sessionLog: SessionLog;
  context: Context;
  offline: boolean;
  activeModelEntry: ModelEntry | undefined;
  startProvider: string;
  startBaseUrl: string | undefined;
  /** Authoritative sampling classification for the provider created at startup. */
  startSelfHosted: boolean;
  /**
   * The jail this session was built for — the SAME value that must reach buildLoopDeps. Added so
   * "one source of truth for the jail" is typecheckable rather than conventional: a web turn reads
   * these off the built AgentSession instead of re-deriving from a display path.
   */
  workspaceRoot: string;
  additionalRoots: string[];
  /**
   * Connect configured MCP servers and register their tools. Separate from construction
   * because the CLI must capture piped stdin BEFORE this runs — MCP startup disturbs fd 0 and
   * swallows piped task lines. Returns the clients so the caller can stop them on shutdown.
   */
  connectMcp: () => Promise<Array<{ stop(): void }>>;
  /** Build and activate a complete model entry for automatic fallback. */
  activateModel: (entry: ModelEntry, signal?: AbortSignal) => Promise<{ provider: ReturnType<typeof createProvider>; model: string }>;
}

/**
 * Classify the endpoint that will back the startup provider. Local/LAN URLs prove themselves.
 * Public endpoints require a trusted config marker, and a one-run --base-url override deliberately
 * discards that marker because it refers to a different endpoint. An explicit preset `false`
 * clears a stale top-level `true`; an omitted preset marker inherits the top-level declaration.
 */
export function resolveStartSelfHosted(input: {
  provider: string;
  baseUrl?: string;
  baseUrlOverridden?: boolean;
  entrySelfHosted?: boolean;
  entryBaseUrl?: string;
  entrySelected?: boolean;
  configSelfHosted?: boolean;
}): boolean {
  if (input.provider !== 'openai') return false;
  if (isLocalBaseUrl(input.baseUrl)) return true;
  if (input.baseUrlOverridden) return false;

  // A remembered/picked preset is authoritative, including an omitted marker clearing a stale
  // top-level true. An automatically matched provider/model entry may contribute its marker only
  // when its endpoint is the endpoint being used; matching on names alone is not enough because
  // duplicate presets routinely share both names while targeting cloud and self-hosted servers.
  let scopedEntryMarker: boolean | undefined;
  if (input.entrySelected) {
    scopedEntryMarker = input.entrySelfHosted === true;
  } else if (sameBaseUrl(input.entryBaseUrl, input.baseUrl)) {
    scopedEntryMarker = input.entrySelfHosted;
  }
  return (scopedEntryMarker ?? input.configSelfHosted) === true;
}

function sameBaseUrl(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  try {
    const normalize = (value: string): string => {
      const url = new URL(value);
      url.hash = '';
      // Query parameters can select a tenant/backend on an OpenAI-compatible gateway, so they
      // are part of endpoint identity. Only fragments are safe to ignore (they are never sent).
      url.pathname = url.pathname.replace(/\/+$/, '') || '/';
      return url.toString();
    };
    return normalize(a) === normalize(b);
  } catch {
    return false;
  }
}

/**
 * The environment block injected into the system prompt each session. The model
 * is amnesiac — it knows nothing about the machine unless the harness tells it.
 * cwd/OS/shell/date (+ git branch, best-effort) so it acts with context.
 */
export function buildEnvBlock(
  workspaceRoot: string,
  additionalRoots: string[] = [],
  guard: {
    yolo?: boolean;
    noSandbox?: boolean;
    unrestricted?: boolean;
    offline?: boolean;
    /** Injectable OS-sandbox tool presence so both offline prompt states are testable. */
    sandboxToolPresent?: boolean;
  } = {},
): string {
  const lines = [
    `- **working directory (cwd): ${workspaceRoot}** — run_shell runs here, relative paths resolve here, and scratch/output files belong here (NOT /tmp).`,
    `- os: ${process.platform} (${process.arch})`,
    process.platform === 'win32'
      ? `- shell: PowerShell — use PowerShell syntax.`
      : `- shell: ${process.env.SHELL ?? '/bin/sh'} — a POSIX shell. Use bash/sh syntax (ls, cat, grep), NOT PowerShell/pwsh or cmdlets. Quote any path that contains spaces.`,
    `- date: ${new Date().toISOString()}`,
  ];
  if (additionalRoots.length) lines.push(`- also readable/writable (outside cwd): ${additionalRoots.join(', ')}`);
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: workspaceRoot,
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (branch) lines.push(`- git branch: ${branch}`);
  } catch {
    // not a git repo, or git not installed — fine.
  }
  lines.push(`- paths: the cwd above is your filesystem scope (plus any "also readable/writable" path). Before reading or writing any path you have NOT seen this session, confirm it exists with glob or run_shell ls/find — never guess a path or invent a /tmp location.`);
  // TUI renders GFM tables as a real grid and folds large ones; charts only look good as fenced ASCII.
  lines.push(
    `- Tables & charts (terminal): prefer GFM tables (\`| col | … |\` + separator) with ≤4 short columns; for trends use a fenced ASCII/Unicode bar chart (≤72 cols) or sparklines — not wide tab-separated walls or Mermaid/SVG.`,
  );

  // Shadow harness capabilities — tell the model how to drive the full system
  lines.push(`- Shadow harness features: Use 'agent' tool with isolation:"worktree" for safe/parallel sub-work (auto-cleaned). Set run_in_background:true for long tasks; receive <task-notification> results. Externalize with todo_write (pinned fresh every turn in system) + plans/*.md + research/*.md. Call reviewer (agent type "reviewer") before major changes, when stuck, or before declaring done. Harness manages hooks (pre/post tool, compact, subagent_stop, notifications, session), permissions/classifier, compaction, and state. Follow disciplines in your profile to drive reliably.`);

  // Guardrails / sandbox status — model must know the boundaries. The filesystem jail + OS
  // sandbox are dropped under --yolo (and aliases) OR full autonomy; --yolo additionally bypasses
  // the catastrophic-command denylist + all permission gating.
  const yoloOn = !!guard.yolo;
  const sandboxOff = !!guard.noSandbox || yoloOn || !!guard.unrestricted;
  const jailOff = !!guard.unrestricted;
  lines.push(
    `- Guardrails: filesystem jail ${jailOff ? 'OFF (root granted via --yolo or full autonomy)' : 'ON'}. ` +
    `OS sandbox for run_shell: ${osSandboxStatus(!sandboxOff)}. ` +
    `Classifier and permission gates apply per autonomy level; the catastrophic-command denylist is active unless --yolo. The filesystem jail + OS sandbox are dropped under --yolo or full autonomy — outside either, writes stay inside the workspace.`
  );

  if (guard.offline) {
    // F07-04: the egress denial rides on the OS sandbox, which fails open when bwrap/seatbelt
    // are missing (and is dropped under --yolo / --no-sandbox / full autonomy) — never claim a
    // boundary the host cannot bind.
    const egress = offlineEgressClaim(
      offlineEgressEnforced(guard, guard.sandboxToolPresent ?? sandboxToolAvailable()),
    );
    lines.push(
      `- Offline Shadow Mode: ACTIVE. No provider network beyond the local model server. ` +
      `web_fetch, web_search, and MCP tools are NOT registered this session, and ${egress} ` +
      `Do not attempt to reach the internet — those tools do not exist here. Work entirely from local files and the local model.`,
    );
  }

  return `## Environment\n${lines.join('\n')}`;
}

export async function createAgentSession(opts: CreateAgentSessionOptions): Promise<AgentSession> {
  const { flags, cwd, workspaceRoot, additionalRoots, activeStyle, unrestricted, write } = opts;
  // Explicitly annotated: TypeScript only narrows past a never-returning call when the
  // callee's type is written out, which destructuring loses.
  const fail: (message: string) => never = opts.fail;
  let cfg = opts.cfg;
  const baseContextPolicy = {
    contextBudget: cfg.contextBudget,
    triggerRatio: cfg.summarizeTriggerRatio,
    keepLastTurns: cfg.keepLastTurns,
  };

  const skills = discoverSkills(workspaceRoot);
  const skillsBlock = skillsIndexBlock(skills);
  const baseSystem = [
    resolveSystem(cwd, {
      installDir: opts.installDir,
      homedir: homedir(),
      systemPromptPath: cfg.systemPromptPath,
      model: cfg.model,
    }),
    buildEnvBlock(workspaceRoot, additionalRoots, {
      yolo: !!flags.yolo,
      noSandbox: !!flags.noSandbox,
      unrestricted,
      offline: !!flags.offline,
    }),
    skillsBlock,
  ]
    .filter(Boolean)
    .join('\n\n');

  // session_start hook (init). F06-09: detached fire-and-forget — session_start is not a DENY
  // phase (nothing reads its verdict), so it must not gate first paint behind init scripts.
  if (cfg.hooks?.session_start?.length) {
    runHookPhaseDetached('session_start', cfg.hooks.session_start, { workspaceRoot, sessionId: opts.sessionId ?? 'main' });
  }

  const allowImport = process.env.SHADOW_ALLOW_IMPORT === '1';
  // Per-model credentials: a model entry may carry its own apiKey/authToken so each
  // cloud model in the picker uses its OWN key; fall back to provider-level resolution.
  const activeModelEntry =
    opts.lastPicked ?? cfg.models.find((m) => m.provider === cfg.provider && m.model === cfg.model);
  const activeCred = resolveEntryCredential(activeModelEntry, {
    vaultIsLocked: vaultExists() && !vaultUnlocked(),
  });
  if (!activeCred.ok) {
    fail(
      lc.red(
        `✗ "${activeModelEntry?.label ?? cfg.model}" needs the vault slot "${activeCred.slot}", which is ` +
          (activeCred.reason === 'locked'
            ? 'locked. Unlock it, or set SHADOW_VAULT_PASSWORD.'
            : 'empty. Re-add the key with `shadow onboard --web`.'),
      ) + '\n',
    );
  }
  const apiKey =
    activeCred.source === 'provider' ? resolveApiKey(cfg.provider, { model: cfg.model, allowImport }) : activeCred.apiKey;
  const authToken = activeCred.authToken;
  registerSecret(apiKey); // mask the resolved key/token in all logs + surfaced errors
  registerSecret(authToken);
  const resolvedBaseUrl = resolveBaseUrl(cfg.provider, flags.baseUrl ?? cfg.baseUrl);
  // ── Offline Shadow Mode: hard no-cloud, no-web. Requires a LOCAL model (a gguf
  // preset, or a baseUrl whose host is localhost/LAN). Fail fast + friendly when the
  // active model is a cloud provider — before we spin up anything or touch the network.
  const offline = flags.offline ?? false;
  // P2-01: arm the egress broker's offline wall (and the dispatcher-layer backstop behind it)
  // BEFORE anything can touch the network — the wall is a hard invariant, not a banner promise.
  setOfflineMode(offline);
  // P3-08 Phase 2: arm the tool-fetch quarantine (observe/enforce + allowlist) from the GLOBAL
  // config — alongside the wall, before the first fetch.
  setEgressPolicy(cfg.egress ?? { mode: 'observe', allow: [] });
  if (offline) {
    const decision = evaluateOffline({
      label: activeModelEntry?.label ?? `${cfg.provider}/${cfg.model}`,
      gguf: activeModelEntry?.gguf,
      // A repo-id MLX target only counts as local once its weights are CACHED — otherwise the
      // first serve would download from huggingface.co mid-"offline" session.
      mlx: activeModelEntry?.mlx && mlxOfflineReady(activeModelEntry.mlx) ? activeModelEntry.mlx : undefined,
      baseUrl: resolvedBaseUrl,
    });
    if (!decision.ok) fail(lc.red(decision.error!) + '\n');
    write(lc.bold(OFFLINE_BANNER) + '\n');
    // F07-04: say out loud when the "no run_shell egress" half of the banner is not actually
    // enforceable here — same predicate the env block uses, so prompt and banner agree.
    if (!offlineEgressEnforced({ yolo: flags.yolo, noSandbox: flags.noSandbox, unrestricted }, sandboxToolAvailable())) {
      write(lc.yellow('⚠ ' + OFFLINE_UNENFORCED_WARNING) + '\n');
    }
  }
  // Local endpoints: ALWAYS clamp soft budget to the real server window (or a 32k default).
  // Config contextBudget:128000 on a 32k llama.cpp is a no-op for capacity — without this clamp
  // auto-compact never fires and the server 400s ("request exceeds available context size").
  // Explicit --context-budget still wins as a *ceiling*, but never above the server window.
  let startProvider: string = cfg.provider;
  let startBaseUrl = resolvedBaseUrl;
  let startApiKey = apiKey;

  // Local .gguf/MLX model: the caller launches the server (the CLI path offers an interactive
  // `brew install`), then we connect to it.
  const local = await opts.launchLocalServer(activeModelEntry, offline);
  if (local) {
    startProvider = local.provider;
    startBaseUrl = local.baseUrl;
    startApiKey = local.apiKey;
    const budget = clampLocalContextBudget(cfg.contextBudget, local.ctxWindow);
    cfg = {
      ...cfg,
      contextBudget: budget,
      keepLastTurns: keepLastTurnsForBudget(budget, cfg.keepLastTurns),
      summarizeTriggerRatio: triggerRatioForBudget(budget, cfg.summarizeTriggerRatio),
    };
  } else if (isLocalBaseUrl(resolvedBaseUrl)) {
    // OpenAI-compatible local URL without a managed launcher: ask the running server instead of
    // making every model share an invented window. Explicit preset metadata is the fallback.
    const ctxWindow =
      (await detectServerContextWindow(resolvedBaseUrl!)) ?? configuredContextWindow(activeModelEntry);
    cfg = {
      ...cfg,
      contextBudget: clampLocalContextBudget(cfg.contextBudget, ctxWindow),
    };
    cfg.keepLastTurns = keepLastTurnsForBudget(cfg.contextBudget, cfg.keepLastTurns);
    cfg.summarizeTriggerRatio = triggerRatioForBudget(cfg.contextBudget, cfg.summarizeTriggerRatio);
  } else if (activeModelEntry?.contextWindow) {
    const budget = clampLocalContextBudget(cfg.contextBudget, activeModelEntry.contextWindow);
    cfg = {
      ...cfg,
      contextBudget: budget,
      keepLastTurns: keepLastTurnsForBudget(budget, cfg.keepLastTurns),
      summarizeTriggerRatio: triggerRatioForBudget(budget, cfg.summarizeTriggerRatio),
    };
  }

  const startSelfHosted = resolveStartSelfHosted({
    provider: startProvider,
    baseUrl: startBaseUrl,
    baseUrlOverridden: flags.baseUrl != null,
    entrySelfHosted: activeModelEntry?.selfHosted,
    entryBaseUrl: activeModelEntry?.baseUrl,
    entrySelected: opts.lastPicked != null,
    configSelfHosted: cfg.selfHosted,
  });
  // P1A-04: the operator escape hatch beats any per-entry config — a rescue env must apply
  // to a live wedged session without editing config.json. Strict positive-int only; a bogus
  // value is ignored so a typo cannot silently disable the watchdog.
  const provider = createProvider({
    // P1A-04 knobs + P1A-06 capability block, SHADOW_IDLE_MS env override included (F10-01:
    // one shared helper with the TUI rebuild sites so the contract can't drift between them).
    ...entryStreamContract(activeModelEntry ?? undefined),
    provider: startProvider as 'anthropic' | 'openai' | 'mock',
    model: cfg.model,
    apiKey: startApiKey,
    authToken,
    baseUrl: startBaseUrl,
    selfHosted: startSelfHosted,
    reasoningRoundtrip: cfg.reasoningRoundtrip,
  });

  const registry = new ToolRegistry();
  // Own the background-shell registry so we can kill orphaned children on shutdown (killAll had no
  // call site — quitting left dev servers holding their ports across sessions).
  const bg = new BgRegistry();
  registerBuiltinTools(registry, {
    bg,
    shellEnvAllowlist: cfg.shellEnvAllowlist,
    shellTimeoutMs: cfg.shellTimeoutMs,
    sandbox: cfg.sandbox,
    // Offline mode: deny run_shell network egress (when the OS sandbox is active) so the
    // only outbound traffic is to the local model server.
    sandboxNetwork: offline ? false : cfg.sandboxNetwork,
    // Offline mode: do NOT register the web tools (web_fetch / web_search). They are simply
    // absent from the registry — the model can't choose what it doesn't have.
    network: !offline,
  }); // M1 tools + M5 web tools (web tools gated off when offline)

  // Shadow's "eyes": register describe_media only when the user configured an OpenAI-compatible
  // vision endpoint in ~/.shadow. Absent config → the tool isn't offered.
  // Gated off when offline (it's a network call to the user's own endpoint).
  if (cfg.vision?.baseUrl && !offline) {
    registry.register(makeDescribeMediaTool(cfg.vision));
  }

  // M4: project memory (known facts) — load, expose as a tool, inject into the prompt.
  // F08-05: inject the one-line-per-fact INDEX, not full values — the model recalls full values
  // on demand via the memory tool, so prompt cost stays flat as facts accumulate.
  const memory = ProjectMemory.load(workspaceRoot);
  registry.register(makeMemoryTool(memory));
  const facts = memory.asIndex();

  // Agent-maintained todo list — externalizes "what's done / what's next" into a
  // tool. The loop renders the live list into the system prompt each turn (pinned,
  // summarization-proof) so a weak model never loses the plot. The bus event lets
  // the TUI render live progress.
  const todoList = new TodoList();
  registry.register(makeTodoTool(todoList));
  const planMode = new PlanModeState(flags.planMode || cfg.planMode || activeStyle === 'procedural');
  registry.register(makePlanWriteTool(planMode));
  registry.register(makeExitPlanModeTool(planMode));
  registry.register(makeEnterPlanModeTool(planMode));
  registry.register(makeAskUserQuestionTool());
  if (skills.length) registry.register(makeSkillTool(skills));
  registry.register(makeToolSearch(registry));

  const wakeup = new WakeupScheduler();
  // F08-12: register user-defined output styles so buildStyledSystem + the /style picker resolve
  // them by name. Jailed loader; failures are non-fatal (a bad styles dir must not break startup).
  try {
    setCustomStyles(discoverCustomStyles(opts.workspaceRoot, homedir()));
  } catch {
    setCustomStyles([]);
  }
  const systemForStyle = (style: OutputStyle): string => buildStyledSystem(baseSystem, style, facts);
  const system = systemForStyle(activeStyle);

  // P2-13: opt-in retention sweep — runs BEFORE this session's log is opened so a sweep can
  // never archive the very session that is starting (even with sessionRetentionKeep: 0), and
  // the explicit --resume target is excluded by id so hydration never reads a moved file.
  // ARCHIVE only (never delete), one-line notice so the move is visible where it happens.
  // Best-effort: a retention failure must never block startup. The dry-run twin lives in
  // `/doctor` (see doctor.ts), surfaced BEFORE any pruning.
  try {
    const ret = applyRetention(workspaceRoot, cfg, {
      excludeIds: opts.resumeSessionPath ? [SessionLog.sessionIdFromPath(opts.resumeSessionPath)] : undefined,
    });
    if (ret.archived.length) {
      write(lc.gray(`Retention: archived ${ret.archived.length} session log(s) to ${ret.archiveDir} (recoverable — never deleted).`) + '\n');
    }
  } catch {
    /* best-effort */
  }

  // M4: append-only, redacted session log for this process.
  const sessionLog = SessionLog.open(workspaceRoot);

  const contextOpts = {
    contextBudget: cfg.contextBudget,
    triggerRatio: cfg.summarizeTriggerRatio,
    keepLastTurns: cfg.keepLastTurns,
    // P1B-02: microcompaction (clear stale tool-result bodies before the summarizer fires). ON by
    // default; this wires the disable switch so `microcompact: false` actually takes effect.
    microcompact: cfg.microcompact,
    microcompactRatio: cfg.microcompactTriggerRatio,
  };
  let context: Context;
  if (opts.resumeSessionPath) {
    ({ context } = resumeSession(opts.resumeSessionPath, contextOpts));
    write(`Resumed session ${opts.resumeSessionPath} (${context.messages().length} messages in context).\n`);
    // Background sub-agent recovery note (tasks captured via extended snapshot)
    const recoveredTasks = (context as any)._subAgentTasks || [];
    if (recoveredTasks.length) {
      write(` (recovered ${recoveredTasks.length} sub-agent bg task record(s) from prior snapshot)\n`);
      const note = `Recovered bg sub-agent tasks from snapshot: ${JSON.stringify(recoveredTasks)}`;
      context.append({ role: 'user', content: [{ type: 'text', text: note }] });
    }
  } else {
    context = new Context(contextOpts);
  }

  const connectMcp = async (): Promise<Array<{ stop(): void }>> => {
    // Offline mode: skip MCP servers entirely — they are outbound connectors (another egress
    // vector), so an offline session keeps nothing but the local model.
    if (offline) {
      const mcpCount = Object.keys(cfg.mcpServers ?? {}).length;
      if (mcpCount > 0) write(lc.gray(`Offline: skipping ${mcpCount} MCP server(s).`) + '\n');
      return [];
    }
    // P3-08 Phase 3: stdio children get the OS jail (network off unless granted per server).
    return await registerMcpServers(registry, cfg.mcpServers, workspaceRoot, undefined, {
      // The session's RESOLVED granted roots — same list run_shell receives (jails agree).
      additionalRoots,
      enabled: (cfg.sandbox ?? 'auto') !== 'off',
      failurePolicy: cfg.sandboxFailurePolicy ?? 'auto',
    });
  };

  const activateModel = async (
    entry: ModelEntry,
    signal?: AbortSignal,
  ): Promise<{ provider: ReturnType<typeof createProvider>; model: string }> => {
    signal?.throwIfAborted();
    let nextProvider = entry.provider;
    let baseUrl = resolveBaseUrl(entry.provider, entry.baseUrl);
    const cred = resolveEntryCredential(entry, { vaultIsLocked: vaultExists() && !vaultUnlocked() });
    if (!cred.ok) {
      throw new Error(
        `fallback "${entry.label}" needs vault slot "${cred.slot}", which is ${cred.reason === 'locked' ? 'locked' : 'empty'}`,
      );
    }
    let apiKey = cred.apiKey;
    let hardWindow = configuredContextWindow(entry);
    const local = await opts.launchLocalServer(entry, offline);
    signal?.throwIfAborted();
    if (local) {
      nextProvider = local.provider;
      baseUrl = local.baseUrl;
      apiKey = local.apiKey;
      hardWindow = local.ctxWindow;
    } else if (offline && !isLocalBaseUrl(baseUrl)) {
      throw new Error(`offline mode refused cloud fallback "${entry.label}"`);
    } else if (isLocalBaseUrl(baseUrl) && baseUrl) {
      hardWindow = (await detectServerContextWindow(baseUrl)) ?? hardWindow;
      signal?.throwIfAborted();
    }

    const budget = hardWindow
      ? clampLocalContextBudget(baseContextPolicy.contextBudget, hardWindow)
      : baseContextPolicy.contextBudget;
    const policy = {
      contextBudget: budget,
      triggerRatio: triggerRatioForBudget(budget, baseContextPolicy.triggerRatio),
      keepLastTurns: keepLastTurnsForBudget(budget, baseContextPolicy.keepLastTurns),
    };
    // All awaited construction/probing is complete. Keep activation atomic: an obsolete turn may
    // have warmed a local server, but it must not switch the live model, config, or context policy.
    signal?.throwIfAborted();
    context.setPolicy(policy, true);
    cfg.provider = nextProvider;
    cfg.model = entry.model;
    cfg.baseUrl = baseUrl;
    cfg.contextBudget = policy.contextBudget;
    cfg.summarizeTriggerRatio = policy.triggerRatio;
    cfg.keepLastTurns = policy.keepLastTurns;
    const next = createProvider({
      // P1A-04 knobs + P1A-06 capability block (F10-01 shared helper — see entryStreamContract).
      ...entryStreamContract(entry),
      provider: nextProvider,
      model: entry.model,
      apiKey,
      authToken: cred.authToken,
      baseUrl,
      selfHosted: entry.selfHosted,
      reasoningRoundtrip: cfg.reasoningRoundtrip,
    });
    return { provider: next, model: entry.model };
  };

  return {
    cfg,
    baseContextPolicy,
    provider,
    registry,
    bg,
    memory,
    todoList,
    planMode,
    wakeup,
    skills,
    facts,
    system,
    systemForStyle,
    sessionLog,
    context,
    offline,
    activeModelEntry,
    startProvider,
    startBaseUrl,
    startSelfHosted,
    workspaceRoot,
    additionalRoots,
    connectMcp,
    activateModel,
  };
}
