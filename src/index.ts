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
  resolveEntryCredential,
  type ShadowConfig,
  type ModelEntry,
} from './config.js';
import { vaultExists } from './auth/vault.js';
import { vaultUnlocked } from './state/globalStore.js';
import { createProvider } from './provider/index.js';
import { ensureLocalServer, stopGgufServers, ggufServerUp, isLocalServedEntry, MLX_INSTALL_HINT, mlxOfflineReady } from './gguf.js';
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
import type { Message } from './provider/provider.js';
import { ToolRegistry } from './tools/registry.js';
import { BgRegistry } from './tools/bgShell.js';
import { runWebOnboard } from './onboard/webOnboard.js';
import { runWeb, parseWebArgs } from './web/cli.js';
import { runLock, CLI_HOLDER } from './web/runLock.js';
import { windowsPowerShell } from './update/winShell.js';
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
  makeDescribeMediaTool,
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
import { AgentLoop } from './agent/loop.js';
import { buildLoopDeps } from './agent/loopDeps.js';
import { createAgentSession } from './agent/bootstrap.js';
import { raiseAutonomy, type AutonomyLevel } from './safety/permissions.js';
import { makeDenylist } from './safety/denylist.js';
import { osSandboxStatus } from './safety/sandbox.js';
import { evaluateOffline, isLocalBaseUrl, OFFLINE_BANNER } from './safety/offline.js';
import type { ToolCall } from './provider/provider.js';
import { Logger } from './util/logger.js';
import { registerSecret } from './util/redact.js';
import { lc } from './util/lc.js';
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
import { INSTALL_DIR } from './installDir.js';
import { resolveSystem } from './system/resolveSystem.js';
import { runHookPhase } from './hooks/runner.js';
import { parseArgs } from './cli/flags.js';

// INSTALL_DIR (package root) is imported from ./installDir.js at the top — its own module so
// src/web/* can share it without pulling in this file's top-level main().
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
    '  local <add|list|test|use|remove>  manage local models — .gguf or MLX (no Ollama/LM Studio needed)',
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
      execFileSync(windowsPowerShell(), ['-NoProfile', '-Command', 'irm $env:SHADOW_INSTALL_URL | iex'], {
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
  if (entry?.gguf || entry?.mlx || entry?.vllm) return false;
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


/** Locate the llama-server binary: explicit override, then PATH (command -v / where). */
/** Locate mlx_lm.server: $SHADOW_MLX_SERVER, else PATH. (Apple Silicon backend.) */
function findMlxServer(): string | undefined {
  const explicit = process.env.SHADOW_MLX_SERVER;
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  try {
    const out = execFileSync('sh', ['-c', 'command -v mlx_lm.server'], { stdio: ['ignore', 'pipe', 'ignore'] });
    return out.toString().trim().split(/\r?\n/)[0] || undefined;
  } catch {
    return undefined;
  }
}

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
    '  add <path-to.gguf | mlx-folder | mlx-community/model> [--name <n>] [--ctx <n>] [--gpu-layers <n>]   register a local model',
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
    if (e.mlx) {
      stdout.write(`    target:     ${e.mlx}  (mlx)\n`);
    } else {
      stdout.write(`    file:       ${e.gguf}\n`);
      stdout.write(`    ctx:        ${e.ctx}\n`);
      stdout.write(`    gpu-layers: ${e.gpuLayers}\n`);
    }
    if (res.note) stdout.write(lc.yellow(`    ⚠ ${res.note}`) + '\n');
    if (e.mlx) {
      // MLX backend: no brew formula — print the pip/uv hint when mlx_lm.server is missing.
      if (!findMlxServer()) stdout.write(lc.yellow('    ⚠ ' + MLX_INSTALL_HINT.split('\n').join('\n      ')) + '\n');
    } else if (!findLlamaServer()) {
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
    stdout.write(lc.green(`✓ Active model → ${entry.label}`) + lc.gray(` (local: ${entry.gguf ?? entry.mlx ?? entry.vllm})`) + '\n');
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
    if (entry.gguf && !entry.ggufServer && !(await ensureLlamaServer(stdout))) {
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
  const isLocal = isLocalServedEntry(entry);
  const allowImport = process.env.SHADOW_ALLOW_IMPORT === '1';

  let startProvider = provider;
  let baseUrl = resolveBaseUrl(provider, entry?.baseUrl ?? (provider === cfg.provider ? cfg.baseUrl : undefined));
  const cred = resolveEntryCredential(entry, { vaultIsLocked: vaultExists() && !vaultUnlocked() });
  if (!cred.ok) {
    process.stderr.write(
      lc.red(
        `✗ "${entry?.label ?? model}" needs the vault slot "${cred.slot}", which is ` +
          (cred.reason === 'locked' ? 'locked. Unlock it, or set SHADOW_VAULT_PASSWORD.' : 'empty. Re-add the key.'),
      ) + '\n',
    );
    process.exit(1);
  }
  // Slot resolution never falls back to the adapter key, so a miss above cannot leak your
  // OpenAI key to this preset's baseUrl. allowImport only applies to the provider-level path.
  let apiKey = cred.source === 'provider' ? resolveApiKey(provider, { model, allowImport }) : cred.apiKey;
  const authToken = cred.authToken;

  if (entry && isLocalServedEntry(entry)) {
    if (entry.gguf && !entry.ggufServer) await ensureLlamaServer(stdout); // offer `brew install llama.cpp` before we try to spawn it
    if (entry.mlx && !findMlxServer()) stdout.write(lc.yellow('  ⚠ ' + MLX_INSTALL_HINT.split('\n').join('\n    ')) + '\n');
    try {
      const r = await ensureLocalServer(entry, (m) => stdout.write(lc.gray(`  ${m}`) + '\n'));
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
  if (argv[0] === 'web') {
    const { port, open } = parseWebArgs(argv.slice(1));
    await runWeb({ write: (s) => stdout.write(s), port, open });
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
  const session = await createAgentSession({
    cfg,
    flags,
    installDir: INSTALL_DIR,
    cwd,
    workspaceRoot,
    additionalRoots,
    activeStyle,
    unrestricted,
    lastPicked,
    resumeSessionPath,
    write: (s) => stdout.write(s),
    fail: (message) => {
      process.stderr.write(message);
      process.exit(1);
    },
    // The gguf/MLX launch stays here: it offers an interactive `brew install` and its helpers
    // (ensureLlamaServer, findMlxServer) have call sites elsewhere in this file.
    launchLocalServer: async (activeModelEntry, offline) => {
      if (!isLocalServedEntry(activeModelEntry)) return null;
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
        activeModelEntry!.gguf &&
        !activeModelEntry!.ggufServer &&
        !process.env.SHADOW_LLAMA_SERVER &&
        !(await ggufServerUp(activeModelEntry!))
      ) {
        await ensureLlamaServer(process.stdout as NodeJS.WriteStream);
      }
      if (activeModelEntry?.mlx && !findMlxServer() && !(await ggufServerUp(activeModelEntry))) {
        process.stderr.write(lc.yellow('  ⚠ ' + MLX_INSTALL_HINT.split('\n').join('\n    ')) + '\n');
      }
      try {
        const r = await ensureLocalServer(activeModelEntry!, (m) => console.error(`  ${m}`), { offline });
        return {
          provider: 'openai',
          baseUrl: r.baseUrl,
          apiKey: activeModelEntry!.apiKey ?? 'sk-local',
          ctxWindow: activeModelEntry!.ctx ?? 32_768,
        };
      } catch (e) {
        console.error(`local model failed: ${(e as Error).message}`);
        process.exit(1);
      }
    },
  });

  // Destructured so the rest of main() reads exactly as it did before the extraction.
  cfg = session.cfg;
  const { provider, registry, bg, memory, todoList, planMode, wakeup, skills, facts, sessionLog, offline, context } =
    session;
  const fullSystemForStyle = session.systemForStyle;
  const fullSystem = session.system;
  void memory;
  void skills;
  void facts;
  void wakeup;

  const bus = new EventBus();
  bus.on((e) => sessionLog.record({ kind: 'event', ...e }));

  // Hoisted above the --web mirror below: its model()/autonomy() getters close over these live
  // bindings, and a GET /api/sessions can call them while main() is still awaiting MCP startup
  // (openBrowser fires first) — a TDZ ReferenceError otherwise. Reassignments stay at their
  // original sites (autonomy: raiseAutonomy at the "always" approval; model: onModelSwitch).
  let autonomy: AutonomyLevel = (flags.yolo ?? false) ? 'full' : cfg.autonomy;
  let activeAgentModel = cfg.model;

  // --web: mirror this session to a loopback browser console. The bus is already
  // multi-subscriber, so this is additive — the TUI/headless renderer still gets every event
  // and the loop is unaware. Strictly READ-ONLY: approvals are still answered in the
  // terminal, so there is no window where a browser can drive a privileged session without
  // an approval gate. Attached here, before the plan_mode emit below, so the mirror does not
  // miss the initial snapshot.
  let webMirror: { url: string; close: () => Promise<void> } | null = null;
  // Shared box the TUI populates at mount (runTui.setAbortGetter, below) with a getter for its live
  // turn controller. Created here — before startWebServer — so the mirror's getAbort can close over
  // it; until the TUI mounts it returns null (no turn is running yet anyway). This is what lets the
  // browser interrupt the terminal's turn (canInterrupt) without being able to drive it.
  const cliAbort: { get: () => AbortController | null } = { get: () => null };
  if (flags.web) {
    try {
      const { startWebServer } = await import('./web/server.js');
      const handle = await startWebServer({
        bus,
        port: flags.webPort,
        // Pass the workspace so the mirror reports the right path under `--workspace sub/`
        // (it was defaulting to process.cwd()). The reserved session bypasses the allowlist —
        // this is the user's own terminal, in a directory they chose.
        workspaceRoot,
        // A live TERMINAL mirror: model/autonomy are read live (they track /model and the
        // always-approval); getAbort exposes the terminal's turn controller so the browser can
        // interrupt (but not prompt — canPrompt stays false).
        mirror: {
          model: () => activeAgentModel,
          autonomy: () => autonomy,
          getAbort: () => cliAbort.get(),
        },
      });
      webMirror = handle;
      stdout.write(`\nMirroring this session at ${handle.url}\n`);
      stdout.write('Read-only: approvals are answered here in the terminal.\n\n');
      const { openBrowser } = await import('./web/browser.js');
      openBrowser(handle.url);
    } catch (e) {
      // A mirror that fails to start must never take the agent run down with it.
      stdout.write(`\nCould not start the web mirror: ${e instanceof Error ? e.message : String(e)}\n\n`);
    }
  }

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
  // `autonomy` (mutable — the REPL's "always" approval raises it across turns) is declared above,
  // hoisted over the --web mirror so its live getter is TDZ-safe.

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
  // activeAgentModel is declared above (hoisted over the --web mirror for a TDZ-safe live getter).

  registry.register(
    makeAgentTool({
      makeLoopDeps: () =>
        buildLoopDeps({
          cfg,
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
          // LIVE sub-agent model — parallelTools resolves against this, not cfg.model
          model: activeAgentModel,
          system: fullSystem,
          workspaceRoot,
          additionalRoots,
          forceConfirm,
          todoList,
          planMode,
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
  const runTurnBody = async (task: string, gate: ApprovalGate, signal: AbortSignal): Promise<void> => {
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
    // See the matching emit in tui.tsx: this is for non-terminal subscribers (the `--web`
    // mirror). attachRenderer's switch has `default: break`, so the headless path ignores it.
    bus.emit({ type: 'user', text: task });
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
    const deps = buildLoopDeps({
      cfg,
      provider,
      registry,
      gate,
      bus,
      budget,
      context,
      signal,
      model: cfg.model,
      system: fullSystem,
      workspaceRoot,
      additionalRoots,
      forceConfirm,
      todoList,
      planMode,
      streamShell: !headless,
      sessionLog,
    });
    const { stopReason, finalAnswer } = await new AgentLoop(deps, autonomy).run();
    // Headless: an error-class stop — OR a reasoning run that hit the output cap before
    // producing any answer — must exit non-zero so CI/scripts can't mistake a silent failure
    // for success (the "HTTP 200 but nothing happened" trap). (review #8)
    const emptyMaxTokens = stopReason === 'max_tokens' && !finalAnswer.trim();
    if (headless && (stopReason === 'provider_error' || stopReason === 'fatal_tool_error' || emptyMaxTokens)) {
      process.exitCode = 1;
    }
  };

  /**
   * Serialize every headless turn through the process-wide run lock — one turn at a time across
   * the TUI and every web session (decision 1). priority:true because a CLI-initiated turn is the
   * operator. This independently fixes a pre-existing collision: two `void buildAndRun(...)` wakeup
   * calls used to run concurrently on the shared Context/currentGate; they now queue. `currentGate`
   * is set inside runTurnBody, i.e. AFTER the lock is held, so a queued turn can't overwrite a
   * running one. An abort while queued returns cleanly; release is always in the finally, never off
   * a `stop` event (a sub-agent's stop is byte-identical on the shared bus).
   */
  const buildAndRun = async (task: string, gate: ApprovalGate, signal: AbortSignal): Promise<void> => {
    let release: (() => void) | null = null;
    try {
      release = await runLock.acquire(CLI_HOLDER, { priority: true, signal });
    } catch {
      return; // aborted while queued behind another turn
    }
    try {
      await runTurnBody(task, gate, signal);
    } finally {
      release();
    }
  };

  // Headless: one-shot --task, --repl, or piped/redirected stdio (no TTY for the raw-mode UI).
  if (headless) {
    wakeupHandler.fire = (task, reason) => {
      const gate: ApprovalGate = yolo ? new AutoApproveGate() : new AutoDenyGate();
      // Fire-and-forget: the run lock now serializes it behind any in-flight turn, so this both
      // needs a .catch (the queued/abort path is a new rejection surface — an unhandled rejection
      // would exit the process under Node's default) and no longer races a concurrent wakeup.
      void buildAndRun(`[wakeup: ${reason}] ${task}`, gate, new AbortController().signal).catch(() => {});
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
      // Publish the TUI's live turn-abort getter into the shared box, so `shadow --web` can
      // interrupt the terminal's turn from the browser (mirror.getAbort reads this).
      setAbortGetter: (fn) => {
        cliAbort.get = fn;
      },
    });
  } finally {
    // The mirror holds an open listener; without closing it the process would not exit.
    if (webMirror) await webMirror.close().catch(() => {});
    if (cfg.hooks?.session_end?.length) {
      runHookPhase('session_end', cfg.hooks.session_end, { workspaceRoot });
    }
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
