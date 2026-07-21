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
import { createProvider } from '../provider/index.js';
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
import { mlxOfflineReady } from '../gguf.js';
import { discoverSkills, skillsIndexBlock, type SkillEntry } from '../skills/loader.js';
import { WakeupScheduler } from './wakeup.js';
import { Context } from './context.js';
import { evaluateOffline, isLocalBaseUrl, OFFLINE_BANNER } from '../safety/offline.js';
import { osSandboxStatus } from '../safety/sandbox.js';
import { registerSecret } from '../util/redact.js';
import { lc } from '../util/lc.js';
import { ProjectMemory } from '../state/memory.js';
import { SessionLog } from '../state/session.js';
import { resumeSession } from '../state/resume.js';
import { makeMemoryTool } from '../tools/memory.js';
import { TodoList } from './todo.js';
import { PlanModeState } from './planMode.js';
import { buildStyledSystem } from './system.js';
import { makeTodoTool } from '../tools/todo.js';
import { type OutputStyle } from '../styles.js';
import { resolveSystem } from '../system/resolveSystem.js';
import { runHookPhase } from '../hooks/runner.js';
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
}

/**
 * The environment block injected into the system prompt each session. The model
 * is amnesiac — it knows nothing about the machine unless the harness tells it.
 * cwd/OS/shell/date (+ git branch, best-effort) so it acts with context.
 */
export function buildEnvBlock(
  workspaceRoot: string,
  additionalRoots: string[] = [],
  guard: { yolo?: boolean; noSandbox?: boolean; unrestricted?: boolean; offline?: boolean } = {},
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
    lines.push(
      `- Offline Shadow Mode: ACTIVE. No provider network beyond the local model server. ` +
      `web_fetch, web_search, and MCP tools are NOT registered this session, and run_shell network egress is denied. ` +
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

  // session_start hook (init)
  if (cfg.hooks?.session_start?.length) {
    runHookPhase('session_start', cfg.hooks.session_start, { workspaceRoot, sessionId: opts.sessionId ?? 'main' });
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
  }
  // Local/open-weights models (private LAN/localhost endpoint) degrade on long context
  // far sooner than a frontier API, so compact them earlier — summarize before they rot.
  // Frontier APIs keep the configured budget; an explicit --context-budget always wins.
  if (flags.contextBudget === undefined && isLocalBaseUrl(resolvedBaseUrl)) {
    cfg = { ...cfg, contextBudget: Math.min(cfg.contextBudget, 48_000) };
  }
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
    // A local llama.cpp server is bounded by its -c: keep the context budget under BOTH the
    // historical 30k gguf clamp AND this entry's actual window MINUS real headroom (a --ctx
    // 8192 model must compact well before 8192, or long sessions die on a provider 400 instead
    // of compacting). The 2048 floor keeps a degenerate window functional rather than zero.
    cfg = { ...cfg, contextBudget: Math.min(cfg.contextBudget, 30_000, Math.max(2_048, local.ctxWindow - 2_048)) };
  }

  const provider = createProvider({
    provider: startProvider as 'anthropic' | 'openai' | 'mock',
    model: cfg.model,
    apiKey: startApiKey,
    authToken,
    baseUrl: startBaseUrl,
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

  // Shadow's "eyes": register describe_media only when the user configured a vision backend (~/.shadow) —
  // an OpenAI-compatible vision endpoint (preferred) or a ComfyUI. Absent config → the tool isn't offered.
  // Gated off when offline (it's a network call to the user's own endpoint).
  if ((cfg.vision?.baseUrl || cfg.comfy?.baseUrl) && !offline) {
    registry.register(makeDescribeMediaTool({ vision: cfg.vision, comfy: cfg.comfy }));
  }

  // M4: project memory (known facts) — load, expose as a tool, inject into the prompt.
  const memory = ProjectMemory.load(workspaceRoot);
  registry.register(makeMemoryTool(memory));
  const facts = memory.asContext();

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
  const systemForStyle = (style: OutputStyle): string => buildStyledSystem(baseSystem, style, facts);
  const system = systemForStyle(activeStyle);

  // M4: append-only, redacted session log for this process.
  const sessionLog = SessionLog.open(workspaceRoot);

  const contextOpts = {
    contextBudget: cfg.contextBudget,
    triggerRatio: cfg.summarizeTriggerRatio,
    keepLastTurns: cfg.keepLastTurns,
  };
  let context: Context;
  if (opts.resumeSessionPath) {
    ({ context } = resumeSession(opts.resumeSessionPath, contextOpts));
    write(`Resumed session ${opts.resumeSessionPath} (${context.messages().length} messages in context).\n`);
    // Background sub-agent recovery note (tasks captured via extended snapshot)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    return await registerMcpServers(registry, cfg.mcpServers, workspaceRoot);
  };

  return {
    cfg,
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
    workspaceRoot,
    additionalRoots,
    connectMcp,
  };
}
