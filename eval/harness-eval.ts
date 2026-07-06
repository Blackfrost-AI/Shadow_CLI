/**
 * Harness-capability eval runner.
 *
 *   npm run eval -- --mock                 # self-test the harness (no model)
 *   npm run eval -- --config eval/models.json
 *   npm run eval -- --config eval/models.json --only edit-config,compaction-sum
 *
 * For each model × task it spins up a fresh temp workspace, runs the REAL shadow
 * binary non-interactively (--task --yolo) pointed at the model, then scores the
 * run by the workspace end-state + telemetry from the session log. Output is a
 * markdown scorecard (stdout + eval/results/<stamp>.md).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionLog } from '../src/state/session.js';
import { TASKS, DIALECT_TASKS } from './tasks.js';
import type { EvalTask, ModelCfg, RunResult } from './types.js';

const SRC_INDEX = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const RESULTS_DIR = fileURLToPath(new URL('./results/', import.meta.url));
const DEFAULT_WALL_SEC = 240;

interface Args {
  config?: string;
  mock: boolean;
  keep: boolean;
  only?: string[];
  maxWallSec: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { mock: false, keep: false, maxWallSec: DEFAULT_WALL_SEC };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--mock') a.mock = true;
    else if (v === '--keep') a.keep = true;
    else if (v === '--config') a.config = argv[++i];
    else if (v === '--only') a.only = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (v === '--max-wall-sec') a.maxWallSec = Number(argv[++i]);
  }
  return a;
}

function loadModels(args: Args): ModelCfg[] {
  if (args.mock) return [{ label: 'mock', provider: 'mock', mock: true }];
  if (!args.config) {
    throw new Error('provide --config <file> (see eval/models.example.json) or --mock');
  }
  const cfg = JSON.parse(readFileSync(args.config, 'utf8')) as {
    baseUrl?: string;
    provider?: ModelCfg['provider'];
    apiKey?: string;
    models: ModelCfg[];
  };
  if (!Array.isArray(cfg.models) || cfg.models.length === 0) {
    throw new Error(`${args.config}: "models" must be a non-empty array`);
  }
  // Fold top-level defaults into each model entry.
  return cfg.models.map((m) => ({
    provider: m.provider ?? cfg.provider ?? 'openai',
    baseUrl: m.baseUrl ?? cfg.baseUrl,
    apiKey: m.apiKey ?? cfg.apiKey,
    ...m,
  }));
}

/** Aggregate the redacted session log the run wrote. The log is relocated OUT of the graded
 *  workspace (SHADOW_SESSION_DIR) so a model's own `grep -r` / `find` can't match it. */
function parseTelemetry(sessionParent: string): Omit<RunResult, 'exitCode' | 'timedOut' | 'wallMs' | 'stdout' | 'stderr'> {
  const dir = join(sessionParent, 'sessions');
  let paths: string[] = [];
  try {
    paths = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort((a, b) => b.localeCompare(a))
      .map((f) => join(dir, f));
  } catch {
    /* no session log written */
  }
  const events = (paths.length ? SessionLog.load(paths[0]!) : []) as Record<string, unknown>[];
  const t = { toolCalls: [] as { name: string; ok: boolean }[], badJson: 0, errors: 0, iterations: 0, stopReason: '', inputTokens: 0, outputTokens: 0, compactions: 0 };
  for (const e of events) {
    switch (e.type) {
      case 'tool_end': {
        const call = e.call as { name?: string } | undefined;
        const result = e.result as { ok?: boolean } | undefined;
        t.toolCalls.push({ name: call?.name ?? '?', ok: !!result?.ok });
        break;
      }
      case 'error':
        t.errors++;
        if (String(e.message ?? '').includes('bad_tool_json')) t.badJson++;
        break;
      case 'assistant_done':
        t.iterations++;
        break;
      case 'compaction':
        t.compactions++;
        break;
      case 'usage':
        t.inputTokens = (e.inputTokens as number) ?? t.inputTokens;
        t.outputTokens = (e.outputTokens as number) ?? t.outputTokens;
        break;
      case 'stop':
        t.stopReason = (e.reason as string) ?? t.stopReason;
        break;
    }
  }
  return t;
}

function runShadow(task: EvalTask, ws: string, model: ModelCfg, maxWallSec: number): Promise<RunResult> {
  const wall = task.maxWallSec ?? maxWallSec;
  const flags = [
    '--import', 'tsx/esm', SRC_INDEX,
    '--task', task.prompt,
    '--workspace', ws,
    '--yolo',
    '--log-level', 'silent',
    '--max-iterations', String(task.maxIterations ?? 15),
    '--max-wall-sec', String(wall),
  ];
  if (task.contextBudget) flags.push('--context-budget', String(task.contextBudget));
  if (model.mock) {
    flags.push('--provider', 'mock');
  } else {
    flags.push('--provider', model.provider ?? 'openai', '--model', model.model ?? '');
  }

  // Credentials go via ENV so shadow's needsOnboarding() check is satisfied (it
  // reads env/credentials, not the --base-url flag). Ollama ignores the key.
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (task.capability === 'dialect') env.SHADOW_MOCK_DIALECT = '1';
  if (!model.mock) {
    const key = model.apiKey ?? 'shadow-eval-local';
    if ((model.provider ?? 'openai') === 'anthropic') {
      env.ANTHROPIC_AUTH_TOKEN = key;
      if (model.baseUrl) env.ANTHROPIC_BASE_URL = model.baseUrl;
    } else {
      env.OPENAI_API_KEY = key;
      if (model.baseUrl) env.OPENAI_BASE_URL = model.baseUrl;
    }
  }

  // Keep the session transcript OUT of the graded workspace so a model's own
  // `grep -r` / `find` can't match the harness's own log (that inflated count-todos
  // to 16/23 for every model). The workspace now holds ONLY the fixture + what the
  // model itself writes; telemetry is read back from this sibling dir.
  const sessionParent = mkdtempSync(join(tmpdir(), `shadow-eval-sess-${task.id}-`));
  env.SHADOW_SESSION_DIR = sessionParent;

  return new Promise<RunResult>((resolve) => {
    const startedAt = Date.now();
    // Spawn from the repo root (so `--import tsx/esm` resolves against the repo's
    // node_modules); the absolute --workspace flag is what scopes the agent to ws.
    const child = spawn(process.execPath, flags, { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, wall * 1000 + 5000);
    child.on('close', (code) => {
      clearTimeout(killer);
      const telemetry = parseTelemetry(sessionParent);
      try { rmSync(sessionParent, { recursive: true, force: true }); } catch { /* best-effort */ }
      resolve({ exitCode: code ?? -1, timedOut, wallMs: Date.now() - startedAt, stdout, stderr, ...telemetry });
    });
    child.on('error', (err) => {
      clearTimeout(killer);
      try { rmSync(sessionParent, { recursive: true, force: true }); } catch { /* best-effort */ }
      resolve({ exitCode: -1, timedOut, wallMs: Date.now() - startedAt, stdout, stderr: stderr + String(err), toolCalls: [], badJson: 0, errors: 1, iterations: 0, stopReason: 'spawn_error', inputTokens: 0, outputTokens: 0, compactions: 0 });
    });
  });
}

interface Row {
  task: EvalTask;
  run: RunResult;
  pass: boolean;
  detail: string;
}

function scorecard(model: ModelCfg, rows: Row[]): string {
  const passed = rows.filter((r) => r.pass).length;
  const totalCalls = rows.reduce((n, r) => n + r.run.toolCalls.length, 0);
  const totalBad = rows.reduce((n, r) => n + r.run.badJson, 0);
  const validity = totalCalls + totalBad > 0 ? Math.round((totalCalls / (totalCalls + totalBad)) * 100) : null;
  const tokens = rows.reduce((n, r) => n + r.run.inputTokens + r.run.outputTokens, 0);
  const secs = Math.round(rows.reduce((n, r) => n + r.run.wallMs, 0) / 1000);
  const head = `### ${model.label}${model.mock ? '' : ` — ${model.provider}/${model.model}`}\n\n` +
    `**${passed}/${rows.length} passed** · tool-call JSON validity ${validity === null ? 'n/a' : validity + '%'} · ` +
    `bad-JSON ${totalBad} · ${tokens.toLocaleString()} tok · ${secs}s\n\n`;
  const header = '| Task | Capability | Result | tools | badJSON | iters | stop | s | Detail |\n|---|---|---|--:|--:|--:|---|--:|---|\n';
  const body = rows
    .map((r) => {
      const okTools = r.run.toolCalls.filter((t) => t.ok).length;
      const res = r.pass ? '✅ pass' : (r.run.timedOut ? '⏱ timeout' : '❌ fail');
      return `| ${r.task.id} | ${r.task.capability} | ${res} | ${okTools}/${r.run.toolCalls.length} | ${r.run.badJson} | ${r.run.iterations} | ${r.run.stopReason || '—'} | ${Math.round(r.run.wallMs / 1000)} | ${r.detail.replace(/\|/g, '/').slice(0, 70)} |`;
    })
    .join('\n');
  return head + header + body + '\n';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const models = loadModels(args);
  const allTasks = [...TASKS, ...DIALECT_TASKS];
  const tasks = args.only ? allTasks.filter((t) => args.only!.includes(t.id)) : allTasks;
  if (tasks.length === 0) throw new Error('no tasks selected (check --only ids)');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sections: string[] = [`# Shadow harness-capability eval — ${stamp}\n`];
  process.stdout.write(sections[0]! + '\n');

  for (const model of models) {
    process.stdout.write(`\n▶ ${model.label} (${model.mock ? 'mock' : `${model.provider}/${model.model}`})\n`);
    const rows: Row[] = [];
    for (const task of tasks) {
      const ws = mkdtempSync(join(tmpdir(), `shadow-eval-${task.id}-`));
      try {
        task.setup(ws);
        const run = await runShadow(task, ws, model, args.maxWallSec);
        const { pass, detail } = task.check(ws, run);
        rows.push({ task, run, pass, detail });
        process.stdout.write(`  ${pass ? '✅' : run.timedOut ? '⏱' : '❌'} ${task.id.padEnd(18)} ${detail}\n`);
      } finally {
        if (!args.keep) rmSync(ws, { recursive: true, force: true });
      }
    }
    sections.push(scorecard(model, rows));
  }

  const report = sections.join('\n');
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = join(RESULTS_DIR, `${stamp}.md`);
  writeFileSync(outPath, report, 'utf8');
  process.stdout.write(`\n${'─'.repeat(60)}\n${report}\n`);
  process.stdout.write(`\nScorecard written to ${outPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`eval failed: ${(err as Error).message}\n`);
  process.exit(1);
});
