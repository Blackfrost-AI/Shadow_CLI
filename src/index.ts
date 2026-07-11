#!/usr/bin/env node
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve, parse } from 'node:path';
import { stdout } from 'node:process';
import {
  loadConfig,
  resolveApiKey,
  resolveAuthToken,
  resolveBaseUrl,
  type ShadowConfig,
  type ModelEntry,
} from './config.js';
import { createProvider } from './provider/index.js';
import { ensureGgufServer, stopGgufServers, ggufServerUp } from './gguf.js';
import {
  addLocalModel,
  formatLocalList,
  listLocalModels,
  parseLocalAddArgs,
  removeLocalModel,
  testLocalModel,
  LLAMA_INSTALL_HINT,
} from './local/garage.js';
import { defaultModelPatch, findModelPreset } from './config/modelPresets.js';
import { resolveParallelTools } from './config/familyProfiles.js';
import type { Message } from './provider/provider.js';
import { ToolRegistry } from './tools/registry.js';
import { BgRegistry } from './tools/bgShell.js';
import { runWebOnboard } from './onboard/webOnboard.js';
import { ensureVaultReady } from './auth/unlock.js';
import {
  makeAgentTool,
  makeAskUserQuestionTool,
  makeEnterPlanModeTool,
  makeExitPlanModeTool,
  makePlanWriteTool,
  makeScheduleWakeupTool,
  makeSkillTool,
  makeToolSearch,
  registerBuiltinTools,
} from './tools/index.js';
import { registerMcpServers } from './mcp/client.js';
import {
  disableMcpServer,
  enableContextCooler,
  loadGlobalMcpServers,
  mcpListLines,
  saveGlobalMcpServers,
} from './mcp/manage.js';
import { discoverSkills, skillsIndexBlock } from './skills/loader.js';
import { WakeupScheduler } from './agent/wakeup.js';
import { attachBgAgentDelivery } from './agent/busListeners.js';
import { exportSessionFile } from './state/chatExport.js';
import { EventBus } from './agent/events.js';
import { Budget } from './agent/budget.js';
import { Context } from './agent/context.js';
import { AgentLoop, type LoopDeps } from './agent/loop.js';
import { raiseAutonomy, type AutonomyLevel } from './safety/permissions.js';
import { makeDenylist } from './safety/denylist.js';
import { osSandboxStatus } from './safety/sandbox.js';
import { evaluateOffline, isLocalBaseUrl, OFFLINE_BANNER } from './safety/offline.js';
import type { ToolCall } from './provider/provider.js';
import { Logger } from './util/logger.js';
import { registerSecret } from './util/redact.js';
import { createInterface } from 'node:readline/promises';
import { AutoApproveGate, AutoDenyGate, type ApprovalGate } from './agent/approval.js';
import { ReplGate } from './replGate.js';
import { ProjectMemory } from './state/memory.js';
import { SessionLog } from './state/session.js';
import { saveGlobalConfig, ensureShadowLayout } from './state/globalStore.js';
import { listResumableSessions, resumeSession } from './state/resume.js';
import { buildCodexAuthUrl } from './auth/oauth.js';
import { makeMemoryTool } from './tools/memory.js';
import { TodoList } from './agent/todo.js';
import { PlanModeState } from './agent/planMode.js';
import { buildStyledSystem } from './agent/system.js';
import { makeTodoTool } from './tools/todo.js';
import { type OutputStyle } from './styles.js';
import { runDoctor, formatDoctorReport } from './doctor.js';
import { runModelCheck, formatModelCheckReport } from './doctor/modelCheck.js';
import { buildPrivacyReport, gatherPrivacyEnv, formatPrivacyReport, type PrivacyConfigView } from './doctor/privacy.js';
import { DEV_UNRESTRICTED, resolveUnrestricted } from './buildProfile.js';
import { runTui, attachRenderer } from './tui.js';
import { runOnboard } from './onboard/onboard.js';
import { fileURLToPath } from 'node:url';
import { resolveSystem } from './system/resolveSystem.js';
import { runHookPhase } from './hooks/runner.js';
import { parseArgs } from './cli/flags.js';

/** The install dir (package root) — works whether running from dist/ or tsx on src/. */
const INSTALL_DIR = fileURLToPath(new URL('..', import.meta.url));
/** Single source of truth: the version comes from package.json, never hard-coded.
 * The compiled single-file binary has no package.json on disk, so the build injects
 * the version via `--define process.env.SHADOW_BUILD_VERSION=...` (see scripts/build-binary.sh). */
function readVersion(): string {
  if (process.env.SHADOW_BUILD_VERSION) return process.env.SHADOW_BUILD_VERSION;
  try {
    return (JSON.parse(readFileSync(resolve(INSTALL_DIR, 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}
const VERSION = readVersion();

/** Sentinel raced against rl.question so an interactive REPL exits cleanly on EOF. */
const CLOSED = Symbol('repl-closed');

async function runExport(args: string[], cwd: string): Promise<void> {
  let sessionPath: string | undefined;
  let outPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--session') sessionPath = resolve(cwd, args[++i] ?? '');
    else if (a === '--out') outPath = args[++i];
    else if (!a.startsWith('-') && !outPath) outPath = a;
  }
  const workspaceRoot = resolve(cwd);
  if (!sessionPath) {
    const sessions = (await import('./state/session.js')).SessionLog.list(workspaceRoot);
    sessionPath = sessions[0];
  }
  if (!sessionPath) {
    process.stderr.write('No session log found. Run shadow first or pass --session <file>.\n');
    process.exit(1);
  }
  const cfg = loadConfig(cwd, {});
  const { path, bytes } = exportSessionFile(sessionPath, workspaceRoot, {
    version: VERSION,
    workspaceRoot,
    provider: cfg.provider,
    model: cfg.model,
    style: cfg.lastStyle,
    autonomy: cfg.autonomy,
  }, outPath);
  stdout.write(`Exported ${bytes} bytes → ${path}\n`);
}

function helpText(): string {
  return [
    'shadow — agentic CLI runtime',
    '',
    'Usage: shadow [command] [options]',
    '',
    'Commands:',
    '  onboard              guided provider setup — pick a provider, key, model; tested + saved',
    '  onboard --web        secure setup in a local browser form → encrypted vault + master password',
    '  update               self-update: git checkout → pull+rebuild; binary install → re-fetch from host',
    '  export [path.md]     export session log to markdown (--session, --out)',
    '  mcp <list|enable|disable>  manage MCP servers (e.g. `mcp enable context-cooler`)',
    '  local <add|list|test|use|remove>  manage local .gguf models (no Ollama/LM Studio needed)',
    '  doctor               diagnose Node, ripgrep, credentials, provider, guardrails',
    '  doctor --privacy     prove this config\'s privacy posture: egress, keys-at-rest, offline (no network)',
    '  doctor model [name]  capability test: can this model code agentically? (active model or a preset)',
    '  resume [--session]   resume a prior session from its latest context snapshot',
    '  login codex|grok     OAuth login (codex only; grok uses API key)',
    '',
    'Options:',
    '  --system <path>      external system prompt markdown',
    '  --autonomy <level>   manual | auto-read | auto-edit | full   (default auto-edit)',
    '                       full = "full auto": auto-approve everything AND drop the filesystem jail + OS sandbox',
    '                       (catastrophic-command denylist stays on; use --yolo to drop that too).',
    '  --provider <name>    anthropic | openai | mock',
    '  --model <id>         model id (default claude-opus-4-8)',
    '  --style <name>       proactive | explanatory | learning | procedural',
    '  --base-url <url>     override provider base URL (also ANTHROPIC_BASE_URL / OPENAI_BASE_URL)',
    '  --effort <level>     reasoning depth on Claude 4.6+: low | medium | high | xhigh | max  (default high)',
    '  --fast               Anthropic fast mode (premium low-latency; disables extended thinking)',
    '  --max-output-tokens <n>  per-call output cap (raise for verbose "thinking" models)',
    '  --max-iterations <n>     loop iteration cap (default 25; raise for big multi-file tasks)',
    '  --context-budget <n>     token budget before summarization (default 100000)',
    '  --max-wall-sec <n>       wall-clock ceiling in seconds (safety stop for long autonomous runs)',
    '  --workspace <path>   workspace root (default cwd)',
    '  --add-dir <path>     grant read/write to a dir outside the workspace (repeatable; widens jail + sandbox)',
    '  --dry-run            write/exec tools become no-ops that report intent',
    '  --plan-mode          explore/read first, write a plan, then approve before implementing',
    '  --task "<text>"      run a single task non-interactively and exit',
    '  --repl               force the plain-text REPL (skip the Ink HUD)',
    '  --offline            hard no-cloud, no-web mode: requires a LOCAL model, drops web_fetch/',
    '                       web_search + MCP, and denies run_shell network. Nothing leaves the box',
    '                       except traffic to your local model server.',
    '  --no-sandbox         disable only the OS sandbox for run_shell — writes escape the workspace (prefer --yolo for full off)',
    '  --yolo               THE sandbox-off + guardrails-off flag: autonomy=full, auto-approve everything',
    '                       (incl. denylisted), never ask, drop filesystem jail (grant root), and OS sandbox off.',
    '                       (writes go anywhere the OS allows). Aliases: --nuke, --dangerously-skip-permissions.',
    '                       Use with care — this is "I know what I am doing" mode.',
    '  --log-level <l>      silent | error | info | debug',
    '  -v, --version        print version',
    '  -h, --help           show this help',
    '',
    'Examples:',
    '  shadow                                  interactive HUD in the current directory',
    '  shadow --task "fix the failing tests"   one-shot, scriptable',
    '  shadow --yolo --task "build the app"    fully autonomous, no prompts',
    '  shadow --provider mock --task hi        no API key needed',
  ].join('\n');
}

/**
 * The environment block injected into the system prompt each session. The model
 * is amnesiac — it knows nothing about the machine unless the harness tells it.
 * cwd/OS/shell/date (+ git branch, best-effort) so it acts with context.
 */
function buildEnvBlock(
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
      `Do not attempt to reach the internet — those tools do not exist here. Work entirely from local files and the local model.`
    );
  }

  return `## Environment\n${lines.join('\n')}`;
}

/**
 * Binary install (`curl install.sh`): no .git, and the repo may be private (so a git
 * pull can't authenticate). The prebuilt binaries are served from the PUBLIC install
 * host, so re-fetch by re-running the canonical installer in place. dir + URL are
 * passed through the environment (never string-interpolated into the shell) so a
 * crafted SHADOW_INSTALL_* value can't inject a command.
 */
function updateBinary(): never {
  const dir = parse(process.execPath).dir;
  const shUrl = process.env.SHADOW_INSTALL_URL || 'https://shadow.redpillreader.com/install.sh';
  stdout.write(`Updating Shadow binary in ${dir} (current v${VERSION})…\n`);
  try {
    if (process.platform === 'win32') {
      execFileSync('powershell', ['-NoProfile', '-Command', 'irm $env:SHADOW_INSTALL_URL | iex'], {
        stdio: 'inherit',
        env: { ...process.env, SHADOW_INSTALL_DIR: dir, SHADOW_INSTALL_URL: shUrl.replace(/install\.sh$/, 'install.ps1') },
      });
    } else {
      execFileSync('sh', ['-c', 'curl -fsSL "$1" | sh', 'sh', shUrl], {
        stdio: 'inherit',
        env: { ...process.env, SHADOW_INSTALL_DIR: dir },
      });
    }
  } catch (e) {
    process.stderr.write(`\nupdate failed: ${(e as Error).message}\n`);
    process.exit(1);
  }
  process.exit(0);
}

/**
 * `shadow update` — self-update this install.
 * - git/dev checkout: `git fetch` + hard-reset to origin + refresh deps, then rebuild dist/
 *   from the pulled source (`npm run build`). dist/ is a tracked artifact that a release can
 *   forget to recommit, leaving the pulled dist/ stale — recompiling guarantees the running
 *   code matches the source we just pulled. Refuses on the source box (unpushed local commits).
 * - binary install (no .git): re-fetch the binary from the public host (see updateBinary).
 */
function runUpdate(): void {
  if (!existsSync(resolve(INSTALL_DIR, '.git'))) {
    updateBinary(); // never returns
  }
  const before = VERSION;
  stdout.write(`Updating Shadow in ${INSTALL_DIR} (current v${before})…\n`);
  const git = (args: string[]): string => execFileSync('git', args, { cwd: INSTALL_DIR }).toString().trim();
  try {
    execFileSync('git', ['fetch', 'origin', '--prune'], { cwd: INSTALL_DIR, stdio: 'inherit' });
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';
    // Refuse to discard local commits the remote doesn't have — that's the source/master box, not a mirror.
    const ahead = git(['rev-list', '--count', `origin/${branch}..HEAD`]);
    if (ahead !== '0') {
      process.stderr.write(
        `\nThis checkout has ${ahead} local commit(s) not on origin/${branch} — refusing to discard them.\n` +
          `Looks like the source box rather than a pull-only mirror. Push your work first, or if this box\n` +
          `is meant to mirror the remote exactly, run:  git reset --hard origin/${branch}\n`,
      );
      process.exit(1);
    }
    // Pull-only mirror: hard-reset to the remote so a rebuilt dist/ or a re-resolved package-lock.json
    // (which makes `git pull --ff-only` refuse) never blocks the update.
    execFileSync('git', ['reset', '--hard', `origin/${branch}`], { cwd: INSTALL_DIR, stdio: 'inherit' });
    execFileSync('npm', ['install', '--no-fund', '--no-audit'], { cwd: INSTALL_DIR, stdio: 'inherit' });
    // Recompile: the pulled dist/ is a tracked artifact that can lag the source (a release may
    // forget to recommit it), which silently keeps `shadow update` running old code. Building
    // here guarantees the running artifact matches the code we just pulled.
    stdout.write('Rebuilding…\n');
    execFileSync('npm', ['run', 'build'], { cwd: INSTALL_DIR, stdio: 'inherit' });
  } catch (e) {
    process.stderr.write(`\nupdate failed: ${(e as Error).message}\n`);
    process.exit(1);
  }
  stdout.write(`\n✓ Shadow updated v${before} → v${readVersion()}. Run \`shadow\` to use it.\n`);
}



/** True when the chosen provider has no usable credentials/endpoint yet. */
function needsOnboarding(cfg: ShadowConfig): boolean {
  if (cfg.provider === 'mock') return false;
  // A model entry may carry its OWN apiKey/authToken/baseUrl (per-model creds in the
  // picker — see the activeModelEntry resolution below). If the active entry is
  // self-sufficient, we're already configured; don't force the onboarding wizard.
  const entry = cfg.models.find((m) => m.provider === cfg.provider && m.model === cfg.model);
  // A local .gguf model is self-sufficient by definition — Shadow serves it itself; there is no
  // key or endpoint to configure. Without this, a pure-local user (no cloud key anywhere) got
  // bounced into the onboarding wizard on EVERY launch.
  if (entry?.gguf) return false;
  if (entry?.apiKey || entry?.authToken || entry?.baseUrl) return false;
  if (resolveApiKey(cfg.provider) || resolveAuthToken(cfg.provider)) return false;
  if (resolveBaseUrl(cfg.provider, cfg.baseUrl)) return false;
  return true;
}

/**
 * `shadow mcp <list|enable|disable>` — manage MCP servers in ~/.shadow/config.json.
 * `enable context-cooler` wires the Context Cooler MCP server (token-efficient
 * "think in code" retrieval) so its ctx_* tools load on the next launch.
 */
function runMcp(args: string[]): void {
  const sub = args[0];
  const servers = loadGlobalMcpServers();

  if (sub === 'list') {
    stdout.write(`MCP servers (~/.shadow/config.json):\n${mcpListLines(servers).map((line) => `  ${line}`).join('\n')}\n`);
    return;
  }

  if (sub === 'disable') {
    const name = args[1];
    const change = disableMcpServer(servers, name ?? '');
    if (change.ok) saveGlobalMcpServers(change.servers);
    stdout.write(change.message + '\n');
    return;
  }

  if (sub === 'enable') {
    if (args[1] !== 'context-cooler') {
      return void stdout.write('usage: shadow mcp enable context-cooler [--path <dir|server.js>]\n');
    }
    const pIdx = args.indexOf('--path');
    const change = enableContextCooler(servers, pIdx >= 0 ? args[pIdx + 1] : undefined);
    if (change.ok) saveGlobalMcpServers(change.servers);
    stdout.write(change.message + '\n');
    if (change.ok) stdout.write('Restart shadow; its ctx_* tools (token-efficient retrieval) will load.\n');
    return;
  }

  stdout.write('usage: shadow mcp <list | enable context-cooler [--path <p>] | disable <name>>\n');
}

// Minimal ANSI helpers for `shadow local` output (matches the onboarding tone).
const lc = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
};

/** Locate the llama-server binary: explicit override, then PATH (command -v / where). */
function findLlamaServer(): string | undefined {
  const explicit = process.env.SHADOW_LLAMA_SERVER;
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  try {
    const out =
      process.platform === 'win32'
        ? execFileSync('where', ['llama-server'], { stdio: ['ignore', 'pipe', 'ignore'] })
        : execFileSync('sh', ['-c', 'command -v llama-server'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.toString().trim().split(/\r?\n/)[0];
    return first || undefined;
  } catch {
    return undefined;
  }
}

/** Is Homebrew available (the one-command install path for llama.cpp on macOS/Linux)? */
function hasBrew(): boolean {
  try {
    execFileSync('sh', ['-c', 'command -v brew'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure llama-server is available, OFFERING to `brew install llama.cpp` when it's missing and we're
 * on an interactive TTY with Homebrew. Returns the resolved binary path, or undefined (after printing
 * the manual install hint). Used by `local add`/`test` and the session pre-flight so a user setting up
 * a local GGUF gets a one-keypress fix instead of a dead end.
 */
async function ensureLlamaServer(stdout: NodeJS.WriteStream): Promise<string | undefined> {
  const found = findLlamaServer();
  if (found) return found;
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
  if (interactive && hasBrew()) {
    const rl = createInterface({ input: process.stdin, output: stdout });
    let ans = '';
    try {
      ans = (await rl.question(lc.yellow('llama-server (llama.cpp) is not installed. Install it now with `brew install llama.cpp`? [y/N] '))).trim().toLowerCase();
    } finally {
      rl.close();
    }
    if (ans === 'y' || ans === 'yes') {
      stdout.write(lc.gray('  running: brew install llama.cpp …') + '\n');
      try {
        execFileSync('brew', ['install', 'llama.cpp'], { stdio: 'inherit' });
      } catch {
        stdout.write(lc.red('  brew install failed.\n') + LLAMA_INSTALL_HINT + '\n');
        return undefined;
      }
      const now = findLlamaServer();
      if (now) {
        stdout.write(lc.green(`  ✓ llama.cpp installed → ${now}`) + '\n');
        return now;
      }
      stdout.write(lc.yellow('  installed, but llama-server is still not on your PATH.\n') + LLAMA_INSTALL_HINT + '\n');
      return undefined;
    }
  }
  stdout.write(lc.yellow('  ⚠ ' + LLAMA_INSTALL_HINT.split('\n').join('\n    ')) + '\n');
  return undefined;
}

function localUsage(): string {
  return [
    'usage: shadow local <command>',
    '',
    '  add <path-to.gguf> [--name <name>] [--ctx <n>] [--gpu-layers <n>]   register a local model',
    '  list                                                               list registered local models',
    '  test <name>                                                        start it + run a connection test',
    '  use <name>                                                         make it the default model',
    '  remove <name>                                                      remove a local model preset',
    '',
  ].join('\n');
}

/**
 * `shadow local <add|list|test|use|remove>` — manage local .gguf models with zero
 * external runtime. Shares all core logic with the `/local` TUI command (src/local/garage.ts).
 */
async function runLocal(args: string[]): Promise<void> {
  const sub = args[0];
  const cwd = process.cwd();

  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    stdout.write(localUsage());
    return;
  }

  if (sub === 'list') {
    const cfg = loadConfig(cwd, {});
    for (const line of formatLocalList(cfg.models)) stdout.write(`  ${line}\n`);
    return;
  }

  if (sub === 'add') {
    const parsed = parseLocalAddArgs(args.slice(1));
    if (!parsed.ok) {
      process.stderr.write(parsed.message + '\n');
      process.exitCode = 1;
      return;
    }
    const cfg = loadConfig(cwd, {});
    const res = addLocalModel(cfg.models, parsed.value);
    if (!res.ok) {
      process.stderr.write(res.message + '\n');
      process.exitCode = 1;
      return;
    }
    saveGlobalConfig({ models: res.value.models });
    const e = res.value.entry;
    stdout.write(lc.green(`✓ Added local model "${e.label}"`) + '\n');
    stdout.write(`    file:       ${e.gguf}\n`);
    stdout.write(`    ctx:        ${e.ctx}\n`);
    stdout.write(`    gpu-layers: ${e.gpuLayers}\n`);
    if (res.note) stdout.write(lc.yellow(`    ⚠ ${res.note}`) + '\n');
    if (!findLlamaServer()) {
      stdout.write(lc.gray('    Preset saved. To run it, llama.cpp (llama-server) is needed:') + '\n');
      await ensureLlamaServer(stdout); // offers `brew install llama.cpp` on an interactive TTY
    }
    stdout.write(lc.gray(`  Next: shadow local test ${e.label}`) + '\n');
    return;
  }

  if (sub === 'remove' || sub === 'delete') {
    const name = args[1] ?? '';
    const cfg = loadConfig(cwd, {});
    const res = removeLocalModel(cfg.models, name);
    if (!res.ok) {
      process.stderr.write(res.message + '\n');
      process.exitCode = 1;
      return;
    }
    saveGlobalConfig({ models: res.value });
    stdout.write(lc.green(`✓ Removed local model "${name}"`) + '\n');
    return;
  }

  if (sub === 'use') {
    const name = args[1] ?? '';
    const cfg = loadConfig(cwd, {});
    const entry = findModelPreset(listLocalModels(cfg.models), name);
    if (!entry) {
      process.stderr.write((name ? `No local model named "${name}".` : 'usage: shadow local use <name>') + '\n');
      process.exitCode = 1;
      return;
    }
    saveGlobalConfig(defaultModelPatch(entry));
    stdout.write(lc.green(`✓ Active model → ${entry.label}`) + lc.gray(` (local: ${entry.gguf})`) + '\n');
    stdout.write(lc.gray('  Run `shadow` to start a session with it.') + '\n');
    return;
  }

  if (sub === 'test') {
    const name = args[1] ?? '';
    const cfg = loadConfig(cwd, {});
    const entry = findModelPreset(listLocalModels(cfg.models), name);
    if (!entry) {
      process.stderr.write((name ? `No local model named "${name}".` : 'usage: shadow local test <name>') + '\n');
      process.exitCode = 1;
      return;
    }
    if (!entry.ggufServer && !(await ensureLlamaServer(stdout))) {
      process.exitCode = 1;
      return;
    }
    stdout.write(lc.gray(`Testing "${entry.label}" — starting local server…`) + '\n');
    const res = await testLocalModel(entry, (m) => stdout.write(lc.gray(`  ${m}`) + '\n'));
    stopGgufServers(); // tear down the server we started for the one-shot test
    if (res.ok) {
      stdout.write(lc.green(`✓ PASS — ${entry.label}`) + '\n');
      stdout.write(`    endpoint: ${res.endpoint}\n`);
      if (res.tokensPerSec)
        stdout.write(`    speed:    ~${res.tokensPerSec.toFixed(1)} tok/s (${res.outputTokens} tokens)\n`);
      if (res.reply) stdout.write(`    reply:    ${res.reply}\n`);
    } else {
      stdout.write(lc.red(`✗ FAIL — ${entry.label}`) + '\n');
      if (res.endpoint) stdout.write(`    endpoint: ${res.endpoint}\n`);
      stdout.write(lc.red(`    ${res.error}`) + '\n');
      process.exitCode = 1;
    }
    return;
  }

  process.stderr.write(`unknown subcommand: ${sub}\n` + localUsage());
  process.exitCode = 1;
}

/**
 * `shadow doctor model [<preset>]` — capability triage of the active model (or a named
 * preset): drive it through a few real agentic probes and print a verdict. Resolves the
 * provider the same way the main session does (per-model key, gguf auto-serve), then hands
 * a ready Provider to the shared core in src/doctor/modelCheck.ts.
 */
async function runDoctorModel(name: string | undefined, cwd: string): Promise<void> {
  const cfg = loadConfig(cwd, {});
  // Unlock/migrate the vault so resolveApiKey() below can read the encrypted key when probing.
  await ensureVaultReady((s) => stdout.write(s));
  let entry: ModelEntry | undefined;
  if (name) {
    entry = findModelPreset(cfg.models, name);
    if (!entry) {
      process.stderr.write(`No model preset named "${name}". Try \`shadow doctor model\` (active model) or add one with \`/model add\`.\n`);
      process.exitCode = 1;
      return;
    }
  } else {
    // Mirror main()'s active-model resolution: the last `/model` pick wins UNLESS an
    // explicit env override is set (loadConfig already folded SHADOW_MODEL/PROVIDER into
    // cfg.provider/cfg.model), in which case the env-selected model is the active one.
    const envPinned = Boolean(process.env.SHADOW_MODEL || process.env.SHADOW_PROVIDER);
    entry =
      (!envPinned && cfg.lastModel ? cfg.models.find((m) => m.label === cfg.lastModel) : undefined) ??
      cfg.models.find((m) => m.provider === cfg.provider && m.model === cfg.model);
  }

  const provider = entry?.provider ?? cfg.provider;
  const model = entry?.model ?? cfg.model;
  const label = entry?.label ?? `${provider}/${model}`;
  const isLocal = Boolean(entry?.gguf);
  const allowImport = process.env.SHADOW_ALLOW_IMPORT === '1';

  let startProvider = provider;
  let baseUrl = resolveBaseUrl(provider, entry?.baseUrl ?? (provider === cfg.provider ? cfg.baseUrl : undefined));
  let apiKey = entry?.apiKey ?? resolveApiKey(provider, { model, allowImport });
  const authToken = entry?.authToken ?? resolveAuthToken(provider);

  if (entry?.gguf) {
    if (!entry.ggufServer) await ensureLlamaServer(stdout); // offer `brew install llama.cpp` before we try to spawn it
    try {
      const r = await ensureGgufServer(entry, (m) => stdout.write(lc.gray(`  ${m}`) + '\n'));
      startProvider = 'openai';
      baseUrl = r.baseUrl;
      apiKey = entry.apiKey ?? 'sk-local';
    } catch (e) {
      process.stderr.write(lc.red(`✗ local model failed: ${(e as Error).message}`) + '\n');
      process.exitCode = 1;
      return;
    }
  }

  let probeProvider;
  try {
    probeProvider = createProvider({ provider: startProvider, model, apiKey, authToken, baseUrl });
  } catch (e) {
    process.stderr.write(lc.red(`✗ ${(e as Error).message}`) + '\n');
    process.exitCode = 1;
    return;
  }

  stdout.write(lc.gray(`Testing ${label} — running capability probes (this can take up to a minute)…`) + '\n');
  const result = await runModelCheck(probeProvider, {
    model,
    providerName: startProvider,
    isLocal,
    log: (m) => stdout.write(lc.gray(`  ${m}`) + '\n'),
  });
  if (entry?.gguf) stopGgufServers(); // tear down the server we spun up for the probe

  stdout.write(
    '\n' +
      formatModelCheckReport(result, { pass: lc.green, fail: lc.red, head: lc.bold, dim: lc.gray }) +
      '\n',
  );
  if (result.verdict === 'chat-only') process.exitCode = 1;
}

async function runLogin(args: string[]): Promise<void> {
  const provider = args[0];
  if (provider === 'codex') {
    const { url } = buildCodexAuthUrl();
    stdout.write(`Open this URL to sign in with ChatGPT/Codex:\n${url}\n`);
    stdout.write('After authorization, exchange the callback code with shadow import (when wired).\n');
    return;
  }
  if (provider === 'grok') {
    stdout.write('Grok consumer OAuth is not supported (ToS). Use an xAI API key via `shadow onboard`.\n');
    return;
  }
  process.stderr.write('usage: shadow login codex|grok\n');
  process.exit(1);
}

async function main(): Promise<void> {
  ensureShadowLayout();
  // Windows self-update renames the prior exe to shadow.exe.old (a running exe can
  // only be renamed, not deleted) — clean it up best-effort on the next launch.
  if (process.platform === 'win32') {
    try {
      unlinkSync(process.execPath + '.old');
    } catch {
      /* absent, or a prior shadow still running — ignore */
    }
  }
  let argv = process.argv.slice(2);
  let resumeSessionPath: string | undefined;

  if (argv[0] === 'login') {
    await runLogin(argv.slice(1));
    return;
  }
  if (argv[0] === 'resume') {
    const rest: string[] = [];
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i]!;
      if (a === '--session' && argv[i + 1]) {
        resumeSessionPath = resolve(process.cwd(), argv[++i]!);
      } else {
        rest.push(a);
      }
    }
    if (!resumeSessionPath) {
      const sessions = listResumableSessions(resolve(process.cwd()));
      resumeSessionPath = sessions[0]?.path;
    }
    if (!resumeSessionPath) {
      process.stderr.write('No resumable session found. Pass --session <path>.\n');
      process.exit(1);
    }
    argv = rest;
  }

  if (argv[0] === 'onboard') {
    // `--web` opens the browser-based SECURE onboarding (encrypted vault + master password); the plain
    // form stays the terminal flow. Keys go into ~/.shadow/vault.enc, not a plaintext file.
    if (argv.includes('--web')) {
      const r = await runWebOnboard((s) => stdout.write(s));
      if (r.ok) {
        const what = r.merged ? `Key added to your vault (${r.provider})` : `Vault created (${r.provider})`;
        stdout.write(lc.green(`✓ ${what}${r.cached ? ', unlocked via keychain' : ''}. Run \`shadow\` to start.`) + '\n');
      } else {
        stdout.write(lc.gray(`onboarding not completed${r.reason ? ` — ${r.reason}` : ''}.`) + '\n');
        process.exitCode = 1;
      }
      return;
    }
    await runOnboard();
    return;
  }
  if (argv[0] === 'update') {
    runUpdate();
    return;
  }
  if (argv[0] === 'export') {
    await runExport(argv.slice(1), process.cwd());
    return;
  }
  if (argv[0] === 'mcp') {
    runMcp(argv.slice(1));
    return;
  }
  if (argv[0] === 'local') {
    await runLocal(argv.slice(1));
    return;
  }
  if (argv[0] === 'doctor') {
    if (argv[1] === 'model') {
      await runDoctorModel(argv[2], process.cwd());
      return;
    }
    if (argv[1] === 'privacy' || argv.includes('--privacy')) {
      // Prove the active config's privacy posture. Makes NO network calls (and no vault unlock — it only
      // checks whether a vault exists, never reads it). `--offline` shows the offline posture.
      const cfg = loadConfig(process.cwd(), {});
      const report = buildPrivacyReport(cfg as unknown as PrivacyConfigView, gatherPrivacyEnv(argv.includes('--offline')));
      stdout.write(formatPrivacyReport(report, stdout.isTTY) + '\n');
      return;
    }
    const report = runDoctor(process.cwd());
    stdout.write(formatDoctorReport(report, VERSION) + '\n');
    if (!report.ok) process.exitCode = 1;
    return;
  }
  const flags = parseArgs(argv);
  if (flags.help) {
    stdout.write(helpText() + '\n');
    return;
  }
  if (flags.version) {
    stdout.write(`shadow ${VERSION}\n`);
    return;
  }

  const cwd = process.cwd();
  // ── Unrestricted mode (filesystem jail + OS sandbox dropped) ────────────────
  // A run is "unrestricted" when any of:
  //   • --yolo (and aliases --nuke / --dangerously-skip-permissions), OR
  //   • full autonomy (autonomy=full — "full auto"), OR
  //   • the internal dev build (buildProfile DEV_UNRESTRICTED=true) unless SHADOW_GUARDRAILS=on.
  // The sterile public build sets DEV_UNRESTRICTED=false, so there guardrails are ON by default
  // and only --yolo or full-auto remove them. `unrestricted` is resolved BELOW (after config load)
  // because it depends on the effective autonomy, which may come from the saved config default —
  // not just the --autonomy flag.

  const overrides: Record<string, unknown> = {
    provider: flags.provider,
    model: flags.model,
    autonomy: flags.autonomy,
    logLevel: flags.logLevel,
    dryRun: flags.dryRun,
    systemPromptPath: flags.system,
    effort: flags.effort,
    fastMode: flags.fast,
    additionalDirectories: flags.addDir,
    maxOutputTokens: flags.maxOutputTokens,
    maxIterations: flags.maxIterations,
    contextBudget: flags.contextBudget,
  };
  if (flags.maxWallSec != null) overrides.budget = { maxWallClockSec: flags.maxWallSec };
  let cfg = loadConfig(cwd, overrides);

  // Unlock the encrypted credential vault (or migrate a legacy plaintext credentials.json into it)
  // BEFORE any credential is resolved — needsOnboarding() below and the provider build later both
  // call getCredential(), which reads from the unlocked vault once this runs. No vault + no legacy
  // file → no-op, so env-var / fresh-install flows are unaffected.
  const vaultOk = await ensureVaultReady((s) => stdout.write(s));
  if (!vaultOk) {
    process.stderr.write('Could not unlock your credential vault. Set SHADOW_VAULT_PASSWORD or re-run to retry.\n');
    process.exit(1);
  }

  // Default to the last model picked via `/model`, unless the user explicitly
  // chose one this run (--model / SHADOW_MODEL always win) or the saved label no
  // longer matches a configured entry (ignore it gracefully).
  const lastPicked =
    !flags.model && !flags.provider && !process.env.SHADOW_MODEL && !process.env.SHADOW_PROVIDER && cfg.lastModel
      ? cfg.models.find((m) => m.label === cfg.lastModel)
      : undefined;
  if (lastPicked) cfg = { ...cfg, provider: lastPicked.provider, model: lastPicked.model, baseUrl: lastPicked.baseUrl };

  const log = new Logger(cfg.logLevel);

  // First run with no provider configured → guide the user through setup.
  if (needsOnboarding(cfg)) {
    if (flags.task || !process.stdin.isTTY || !process.stdout.isTTY) {
      process.stderr.write('No model provider configured. Run `shadow onboard` to set one up.\n');
      process.exit(1);
    }
    const ok = await runOnboard();
    if (!ok) return;
    cfg = loadConfig(cwd, overrides); // pick up the freshly-saved provider/model/credentials
  }

  // Resolve unrestricted now that cfg.autonomy is final (from --autonomy OR the saved config
  // default). Full autonomy drops the filesystem jail + OS sandbox, just like --yolo; the dev
  // build is always unrestricted unless SHADOW_GUARDRAILS=on. NOTE: the catastrophic-command
  // denylist is a SEPARATE guard — it stays active under full-auto and is disabled only by --yolo.
  const unrestricted = resolveUnrestricted({
    yolo: flags.yolo,
    autonomy: cfg.autonomy,
    guardrailsForced: process.env.SHADOW_GUARDRAILS === 'on',
  });
  if (flags.noSandbox || unrestricted) cfg = { ...cfg, sandbox: 'off' };

  const workspaceRoot = resolve(cwd, flags.workspace ?? '.');
  // Extra granted roots (config additionalDirectories / --add-dir), absolute + de-duped.
  // These widen BOTH the file-tool jail and the run_shell sandbox so an approved write
  // outside the workspace actually lands, instead of being blocked by the boundary.
  const additionalRoots = [...new Set((cfg.additionalDirectories ?? []).map((d) => resolve(cwd, d)))].filter(
    (d) => d !== workspaceRoot,
  );
  // Unrestricted (dev default, or --yolo): grant the filesystem root so the file-tool jail
  // confines nothing (the OS sandbox is dropped above). OS permissions still apply — writing
  // under / still needs root, so an absolute path like /pictures fails as EACCES, not a jail error.
  if (unrestricted) {
    const fsRoot = parse(workspaceRoot).root || '/';
    if (!additionalRoots.includes(fsRoot)) additionalRoots.push(fsRoot);
  }
  const activeStyle = flags.style ?? cfg.lastStyle;
  if (flags.style) saveGlobalConfig({ lastStyle: activeStyle });
  if (flags.planMode) saveGlobalConfig({ planMode: true });
  const skills = discoverSkills(workspaceRoot);
  const skillsBlock = skillsIndexBlock(skills);
  const baseSystem = [
    resolveSystem(cwd, {
      installDir: INSTALL_DIR,
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
    runHookPhase('session_start', cfg.hooks.session_start, { workspaceRoot, sessionId: 'main' });
  }

  const allowImport = process.env.SHADOW_ALLOW_IMPORT === '1';
  // Per-model credentials: a model entry may carry its own apiKey/authToken so each
  // cloud model in the picker uses its OWN key; fall back to provider-level resolution.
  const activeModelEntry =
    lastPicked ?? cfg.models.find((m) => m.provider === cfg.provider && m.model === cfg.model);
  const apiKey = activeModelEntry?.apiKey ?? resolveApiKey(cfg.provider, { model: cfg.model, allowImport });
  const authToken = activeModelEntry?.authToken ?? resolveAuthToken(cfg.provider);
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
      baseUrl: resolvedBaseUrl,
    });
    if (!decision.ok) {
      process.stderr.write(lc.red(decision.error!) + '\n');
      process.exit(1);
    }
    stdout.write(lc.bold(OFFLINE_BANNER) + '\n');
  }
  // Local/open-weights models (private LAN/localhost endpoint) degrade on long context
  // far sooner than a frontier API, so compact them earlier — summarize before they rot.
  // Frontier APIs keep the configured budget; an explicit --context-budget always wins.
  if (flags.contextBudget === undefined && isLocalBaseUrl(resolvedBaseUrl)) {
    cfg = { ...cfg, contextBudget: Math.min(cfg.contextBudget, 48_000) };
  }
  let startProvider = cfg.provider;
  let startBaseUrl = resolvedBaseUrl;
  let startApiKey = apiKey;
  // Local .gguf model: launch a llama.cpp server before connecting (ollama-style).
  if (activeModelEntry?.gguf) {
    // Session pre-flight: on an interactive TTY, a missing llama-server gets the one-keypress
    // brew offer HERE — previously only `local add`/`local test`/`doctor model` offered it, and a
    // fresh user launching `shadow` with a gguf active hit a raw spawn error instead.
    // Guards (reviewed): never in --task runs (they are non-interactive by design, even under a
    // PTY wrapper); never when the entry names its OWN binary or $SHADOW_LLAMA_SERVER is set
    // (PATH lookup would false-nag); never when a server is ALREADY answering on the entry's
    // port (nothing to install for).
    if (
      !flags.task &&
      process.stdin.isTTY &&
      process.stdout.isTTY &&
      !activeModelEntry.ggufServer &&
      !process.env.SHADOW_LLAMA_SERVER &&
      !(await ggufServerUp(activeModelEntry))
    ) {
      await ensureLlamaServer(process.stdout as NodeJS.WriteStream);
    }
    try {
      const r = await ensureGgufServer(activeModelEntry, (m) => console.error(`  ${m}`));
      startProvider = 'openai';
      startBaseUrl = r.baseUrl;
      startApiKey = activeModelEntry.apiKey ?? 'sk-local';
      // A local llama.cpp server is bounded by its -c: keep the context budget under BOTH the
      // historical 30k gguf clamp AND this entry's actual window MINUS real headroom (a --ctx
      // 8192 model must compact well before 8192, or long sessions die on a provider 400 instead
      // of compacting). The 2048 floor keeps a degenerate window functional rather than zero.
      const window = activeModelEntry.ctx ?? 32_768;
      cfg = { ...cfg, contextBudget: Math.min(cfg.contextBudget, 30_000, Math.max(2_048, window - 2_048)) };
    } catch (e) {
      console.error(`local gguf model failed: ${(e as Error).message}`);
      process.exit(1);
    }
  }
  const provider = createProvider({
    provider: startProvider,
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
  const fullSystemForStyle = (style: OutputStyle): string => buildStyledSystem(baseSystem, style, facts);
  const fullSystem = fullSystemForStyle(activeStyle);

  // M4: append-only, redacted session log for this process.
  const sessionLog = SessionLog.open(workspaceRoot);

  const bus = new EventBus();
  bus.on((e) => sessionLog.record({ kind: 'event', ...e }));
  // A todo_write call updates the list → emit a `todo` event the TUI renders.
  todoList.onUpdate((items) => bus.emit({ type: 'todo', items }));
  planMode.onUpdate((plan) => bus.emit({ type: 'plan_mode', plan }));
  bus.emit({ type: 'plan_mode', plan: planMode.snapshot() });

  // --yolo / --nuke / --dangerously-skip-permissions: bypass ALL gating.
  const yolo = flags.yolo ?? false;
  // --yolo is the canonical "turn off all guardrails + sandbox" flag.
  // It forces full autonomy, auto-approve, denylist bypass, fs root grant, and OS sandbox off.
  if (yolo) {
    flags.noSandbox = true; // ensure sandbox explicitly off
  }
  // Mutable so the REPL's "always" approval can raise it across turns.
  let autonomy: AutonomyLevel = yolo ? 'full' : cfg.autonomy;

  // M2: catastrophic-command guard. Forces confirmation for denylisted shell
  // commands regardless of autonomy level (even at `full`). Disabled under --yolo.
  const denylist = makeDenylist(cfg.denylistExtra);
  const forceConfirm = yolo
    ? undefined
    : (call: ToolCall): string | null => {
        if (call.name !== 'run_shell') return null;
        const input = call.input as { command?: unknown } | undefined;
        const command = typeof input?.command === 'string' ? input.command : '';
        const why = denylist(command);
        return why ? `denylisted: ${why}` : null;
      };

  if (yolo) {
    stdout.write(
      '\x1b[1;33m⚠  YOLO mode: all permission checks disabled (autonomy=full, auto-approve ' +
        'everything, denylist off). The agent will run anything without asking.\x1b[0m\n',
    );
  } else if (unrestricted && !DEV_UNRESTRICTED) {
    // Full autonomy dropped the jail + sandbox on a guardrails-on (sterile) build — say so,
    // since it's otherwise silent. (The denylist + gates per autonomy still apply.)
    stdout.write(
      '\x1b[1;33m⚠  Full autonomy: filesystem jail + OS sandbox disabled (writes can leave the ' +
        'workspace). Catastrophic-command denylist still active.\x1b[0m\n',
    );
  }

  // Only emit the structured "ready" line when output is piped/redirected (logs, CI).
  // In an interactive terminal it's just noise above the banner, which already shows this.
  if (!process.stdout.isTTY) {
    log.info('shadow ready', { provider: cfg.provider, model: cfg.model, autonomy });
  }

  const contextOpts = {
    contextBudget: cfg.contextBudget,
    triggerRatio: cfg.summarizeTriggerRatio,
    keepLastTurns: cfg.keepLastTurns,
  };
  let context: Context;
  if (resumeSessionPath) {
    ({ context } = resumeSession(resumeSessionPath, contextOpts));
    stdout.write(
      `Resumed session ${resumeSessionPath} (${context.messages().length} messages in context).\n`,
    );
    // Background sub-agent recovery note (tasks captured via extended snapshot)
    const recoveredTasks = (context as any)._subAgentTasks || [];
    if (recoveredTasks.length) {
      stdout.write(` (recovered ${recoveredTasks.length} sub-agent bg task record(s) from prior snapshot)\n`);
      const note = `Recovered bg sub-agent tasks from snapshot: ${JSON.stringify(recoveredTasks)}`;
      context.append({ role: 'user', content: [{ type: 'text', text: note }] });
    }
  } else {
    context = new Context(contextOpts);
  }

  // Deliver bg agent (and future) task results + record launches for snapshot/recovery to the *main* context (not throwaway sub ctxs).
  attachBgAgentDelivery(bus, context);

  // Capture piped stdin NOW, before any async startup work — MCP registration in particular — can
  // disturb fd 0. Otherwise the startup delay from connecting an MCP server drops the piped task
  // lines entirely (readline line-loss). Only reads when stdin is genuinely piped (never a TTY, so
  // it can't block) and no --task was given; the piped branch below consumes it.
  const pipedStdin = !process.stdin.isTTY && !flags.task ? readFileSync(0, 'utf8') : null;

  // Offline mode: skip MCP servers entirely — they are outbound connectors (another egress
  // vector), so an offline session keeps nothing but the local model.
  let mcpClients: Array<{ stop(): void }> = [];
  if (offline) {
    const mcpCount = Object.keys(cfg.mcpServers ?? {}).length;
    if (mcpCount > 0) stdout.write(lc.gray(`Offline: skipping ${mcpCount} MCP server(s).`) + '\n');
  } else {
    mcpClients = await registerMcpServers(registry, cfg.mcpServers, workspaceRoot);
  }

  // Shutdown cleanup: kill orphaned background shells + stdio MCP children + gguf servers on exit.
  // killAll() and client.stop() previously had no call sites, so every session leaked stray processes
  // holding ports/FDs across launches. All calls are synchronous (safe in an 'exit' handler). Registered
  // once and idempotent, so multiple exit paths (natural return, SIGINT-abort, SIGTERM) all clean up.
  let cleanedUp = false;
  const shutdownCleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      bg.killAll();
    } catch {
      /* best effort */
    }
    for (const c of mcpClients) {
      try {
        c.stop();
      } catch {
        /* best effort */
      }
    }
    stopGgufServers();
  };
  process.on('exit', shutdownCleanup);
  process.on('SIGTERM', () => {
    shutdownCleanup();
    process.exit(143);
  });

  // Expose send_notification path for 'notification' hook phase (Claude parity)
  const zNotif = (await import('zod')).z;
  registry.register({
    name: 'send_notification',
    description: 'Send notification (fires configured notification hooks with message).',
    risk: 'read' as any,
    inputSchema: zNotif.object({ message: zNotif.string().min(1) }),
    async run(input: any) {
      if (cfg.hooks?.notification?.length) {
        runHookPhase('notification', cfg.hooks.notification, { workspaceRoot, extra: { message: input.message } });
      }
      return { ok: true, summary: 'notification sent', data: { sent: true } } as any;
    },
  } as any);

  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
  const headless = !!flags.task || !!flags.repl || !interactive;

  const wakeupHandler = {
    fire: (_task: string, _reason: string) => {},
  };
  registry.register(
    makeScheduleWakeupTool(wakeup, (task, reason) => wakeupHandler.fire(task, reason)),
  );

  // The gate of the currently-running turn. A sub-agent (the `agent` tool) inherits
  // THIS gate so it's bound by the same permission posture as the main loop — never
  // a blanket auto-approve. Set by buildAndRun before each turn; AutoDeny until then.
  let currentGate: ApprovalGate = new AutoDenyGate();

  // A sub-agent (the `agent` tool) must run on the CURRENTLY-active model, not the one
  // resolved at startup — otherwise a /model switch in the HUD leaves sub-agents pointed at
  // the old endpoint, and on a single-model-at-a-time local box that port is no longer
  // serving, so the sub-agent dies with "Unable to connect". The TUI updates these on every
  // switch via opts.onModelSwitch; the headless path keeps the startup values.
  let activeAgentProvider = provider;
  let activeAgentModel = cfg.model;

  registry.register(
    makeAgentTool({
      makeLoopDeps: () => ({
        provider: activeAgentProvider,
        registry,
        gate: currentGate,
        bus,
        budget: new Budget({ maxIterations: Math.min(cfg.maxIterations, 15) }, activeAgentModel, cfg.priceTable, Date.now()),
        context: new Context({
          contextBudget: cfg.contextBudget,
          triggerRatio: cfg.summarizeTriggerRatio,
          keepLastTurns: cfg.keepLastTurns,
        }),
        signal: new AbortController().signal,
        model: activeAgentModel,
        system: fullSystem,
        maxOutputTokens: cfg.maxOutputTokens,
        effort: cfg.effort,
        cacheTtl: cfg.cacheTtl,
        fastMode: cfg.fastMode,
        workspaceRoot,
        additionalRoots,
        dryRun: cfg.dryRun,
        maxToolResultChars: cfg.maxToolResultChars,
        contextBudget: cfg.contextBudget,
        forceConfirm,
        todoList,
        planMode,
        permissionRules: cfg.permissionRules,
        autoClassifier: cfg.autoClassifier,
        hooks: cfg.hooks,
        models: cfg.models,
        fallbackModel: cfg.fallbackModel,
        // explicit config > family profile > global default (resolved on the LIVE sub-agent model)
        parallelTools: resolveParallelTools(cfg, activeAgentModel),
        streamShell: false,
      }),
      getAutonomy: () => autonomy,
      contextBudget: cfg.contextBudget,
      triggerRatio: cfg.summarizeTriggerRatio,
      keepLastTurns: cfg.keepLastTurns,
      maxIterations: cfg.maxIterations,
      priceTable: cfg.priceTable,
    }),
  );

  let first = context.messages().length === 0;
  const buildAndRun = async (task: string, gate: ApprovalGate, signal: AbortSignal): Promise<void> => {
    currentGate = gate; // so a sub-agent spawned this turn inherits the active gate, not auto-approve

    // user_prompt_submit hook (can deny the prompt before it enters context)
    let promptDenied = false;
    if (cfg.hooks?.user_prompt_submit?.length) {
      const h = runHookPhase('user_prompt_submit', cfg.hooks.user_prompt_submit, {
        prompt: task,
        workspaceRoot,
      });
      if (!h.ok) {
        bus.emit({ type: 'error', message: `user_prompt_submit hook denied: ${h.message}` });
        promptDenied = true;
      }
    }

    sessionLog.record({ kind: 'user', task });
    const userMsg: Message = { role: 'user', content: [{ type: 'text', text: task }] };
    if (first) {
      context.pinTask(userMsg);
      first = false;
    } else {
      context.append(userMsg);
    }

    if (promptDenied) {
      // Feed a denial back so the model can adapt (and headless paths see a result)
      context.append({
        role: 'user',
        content: [{ type: 'text', text: 'This prompt was blocked by the user_prompt_submit hook.' }],
      });
      return;
    }

    const budget = new Budget(
      {
        maxIterations: cfg.maxIterations,
        maxTotalTokens: cfg.budget.maxTotalTokens,
        maxCostUSD: cfg.budget.maxCostUSD,
        maxWallClockSec: cfg.budget.maxWallClockSec,
      },
      cfg.model,
      cfg.priceTable,
      Date.now(),
    );
    const deps: LoopDeps = {
      provider,
      registry,
      gate,
      bus,
      budget,
      context,
      signal,
      model: cfg.model,
      system: fullSystem,
      maxOutputTokens: cfg.maxOutputTokens,
      effort: cfg.effort,
      cacheTtl: cfg.cacheTtl,
      fastMode: cfg.fastMode,
      workspaceRoot,
      additionalRoots,
      dryRun: cfg.dryRun,
      maxToolResultChars: cfg.maxToolResultChars,
      contextBudget: cfg.contextBudget,
      forceConfirm,
      todoList,
      planMode,
      permissionRules: cfg.permissionRules,
      autoClassifier: cfg.autoClassifier,
      hooks: cfg.hooks,
      models: cfg.models,
      fallbackModel: cfg.fallbackModel,
      // explicit config > family profile > global default
      parallelTools: resolveParallelTools(cfg, cfg.model),
      streamShell: !headless,
      sessionLog,
    };
    const { stopReason, finalAnswer } = await new AgentLoop(deps, autonomy).run();
    // Headless: an error-class stop — OR a reasoning run that hit the output cap before
    // producing any answer — must exit non-zero so CI/scripts can't mistake a silent failure
    // for success (the "HTTP 200 but nothing happened" trap). (review #8)
    const emptyMaxTokens = stopReason === 'max_tokens' && !finalAnswer.trim();
    if (headless && (stopReason === 'provider_error' || stopReason === 'fatal_tool_error' || emptyMaxTokens)) {
      process.exitCode = 1;
    }
  };

  // Headless: one-shot --task, --repl, or piped/redirected stdio (no TTY for the raw-mode UI).
  if (headless) {
    wakeupHandler.fire = (task, reason) => {
      const gate: ApprovalGate = yolo ? new AutoApproveGate() : new AutoDenyGate();
      void buildAndRun(`[wakeup: ${reason}] ${task}`, gate, new AbortController().signal);
    };
    const detach = attachRenderer(bus, { animate: false });
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.on('SIGINT', onSigint);
    try {
      if (flags.task) {
        // One-shot automation: no human to ask, so gated calls are denied.
        const gate: ApprovalGate = yolo ? new AutoApproveGate() : new AutoDenyGate();
        await buildAndRun(flags.task, gate, controller.signal);
      } else if (interactive) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const onTurnError = (err: unknown): void => {
          // A failed turn must not tear down the session — report and continue.
          process.stderr.write(`\n\x1b[31m${(err as Error).message}\x1b[0m\n`);
        };
        try {
          // A human is at the keyboard: prompt + real y/n/a approvals. ReplGate
          // needs rl.question, so this path uses the question loop; a close
          // sentinel makes Ctrl-D (EOF) break cleanly so cleanup always runs.
          const gate: ApprovalGate = yolo
            ? new AutoApproveGate()
            : new ReplGate(rl, () => {
                autonomy = raiseAutonomy(autonomy);
                return autonomy;
              });
          const onClose = new Promise<typeof CLOSED>((res) => rl.once('close', () => res(CLOSED)));
          for (;;) {
            const raw = await Promise.race([rl.question('\n\x1b[1;32m❯\x1b[0m '), onClose]);
            if (raw === CLOSED) break;
            const task = raw.trim();
            if (task === 'exit' || task === 'quit') break;
            if (!task) continue;
            try {
              await buildAndRun(task, gate, controller.signal);
            } catch (err) {
              onTurnError(err);
            }
          }
        } finally {
          rl.close();
        }
      } else {
        // Piped / redirected stdin: nobody to approve, so deny. Use the copy captured at startup
        // (before MCP registration could disturb fd 0) so lines written before startup are not dropped.
        const gate: ApprovalGate = yolo ? new AutoApproveGate() : new AutoDenyGate();
        const input = pipedStdin ?? readFileSync(0, 'utf8');
        for (const line of input.split(/\r?\n/)) {
          const task = line.trim();
          if (task === 'exit' || task === 'quit') break;
          if (!task) continue;
          try {
            await buildAndRun(task, gate, controller.signal);
          } catch (err) {
            process.stderr.write(`\n\x1b[31m${(err as Error).message}\x1b[0m\n`);
          }
        }
      }
    } finally {
      detach();
      process.removeListener('SIGINT', onSigint);
      if (cfg.hooks?.session_end?.length) {
        runHookPhase('session_end', cfg.hooks.session_end, { workspaceRoot });
      }
    }
    return;
  }

  // Interactive terminal → the raw-mode TUI (ESC-interruptible, inline approvals).
  const styleState = {
    style: activeStyle,
    setStyle: (_next: OutputStyle) => {},
    systemForStyle: fullSystemForStyle,
  };
  try {
    await runTui({
      provider,
      registry,
      bus,
      context,
      sessionLog,
      forceConfirm,
      system: fullSystem,
      workspaceRoot,
      cfg,
      autonomy,
      bypass: yolo,
      offline,
      version: VERSION,
      styleState,
      todoList,
      planMode,
      wakeupHandler,
      additionalRoots,
      // Keep sub-agents (the `agent` tool) on the live model after a /model switch.
      onModelSwitch: (p, model) => {
        activeAgentProvider = p;
        activeAgentModel = model;
      },
    });
  } finally {
    if (cfg.hooks?.session_end?.length) {
      runHookPhase('session_end', cfg.hooks.session_end, { workspaceRoot });
    }
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
