// sast_scan — a privacy-first static-analysis bridge to semgrep.
//
// Gives vuln hunters and reviewers a first-pass SAST sweep without leaving the
// local-first posture: semgrep runs with telemetry FORCED OFF (--metrics=off +
// SEMGREP_SEND_METRICS=off + SEMGREP_ENABLE_VERSION_CHECK=0), rules default to a
// LOCAL path (registry rules that phone home to semgrep.dev require an explicit
// allowRegistry opt-in), and results land as a SARIF artifact under .shadow/sast/
// that can be imported into the security_findings evidence store. No shell string
// interpolation: fixed argv, scrubbed env, bounded timeout. The scanner binary is
// probed on PATH once and cached; absence is an honest failure, never a silent skip.
//
// Risk tier 'write': it spawns an external scanner and writes a SARIF artifact (and
// optionally mutates the evidence store). It never edits source files.

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { resolveWithin } from '../safety/workspaceJail.js';
import { scrubbedEnv } from '../util/safeEnv.js';
import { EvidenceStore } from '../security/evidence.js';
import { clamp } from './util.js';
import { fail, ok, type Tool, type ToolResult } from './types.js';

const MAX_TIMEOUT_SEC = 600;
const DEFAULT_TIMEOUT_SEC = 300;
const MAX_OUTPUT_CHARS = 14_000;
const MAX_SARIF_BYTES = 16 * 1024 * 1024;

const schema = z.object({
  action: z.enum(['check', 'scan']).describe("'check' probes semgrep availability/version; 'scan' runs a sweep."),
  config: z
    .string()
    .min(1)
    .optional()
    .describe("Rule source. Default 'auto' is NOT used (it fetches the registry). Provide a LOCAL path to a rules file/dir; registry ids (p/..., r/...) require allowRegistry:true."),
  allowRegistry: z
    .boolean()
    .optional()
    .describe('Explicit opt-in to fetch rules from the semgrep registry (semgrep.dev). Off by default — that is network egress outside the broker. Only set when the operator authorizes it.'),
  target: z.string().min(1).optional().describe('File or directory to scan (workspace-relative). Default: the workspace root.'),
  importFindings: z.boolean().optional().describe('Import the SARIF results into the security_findings evidence store (default false).'),
  timeoutSec: z.number().int().min(1).max(MAX_TIMEOUT_SEC).optional().describe(`Scanner timeout in seconds (default ${DEFAULT_TIMEOUT_SEC}, max ${MAX_TIMEOUT_SEC}).`),
  severity: z.enum(['INFO', 'WARNING', 'ERROR']).optional().describe('Minimum severity to report (semgrep --severity).'),
});
export type SastScanInput = z.input<typeof schema>;

export interface SastScanData {
  action: 'check' | 'scan';
  semgrep: { available: boolean; path?: string; version?: string };
  sarifPath?: string;
  counts?: { error: number; warning: number; note: number; total: number };
  imported?: { imported: number; duplicates: number; ids: string[] } | null;
  registryUsed?: boolean;
  metricsOff?: boolean;
  truncated?: boolean;
}

let cachedSemgrep: { path: string | null; version: string | null } | undefined;

function probeSemgrep(): { path: string | null; version: string | null } {
  if (cachedSemgrep) return cachedSemgrep;
  const env = scrubbedEnv();
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['semgrep'], {
    timeout: 5000,
    windowsHide: true,
    env,
  });
  const path = which.status === 0 ? which.stdout.toString('utf8').trim().split('\n')[0]!.trim() : null;
  let version: string | null = null;
  if (path) {
    const v = spawnSync(path, ['--version'], { timeout: 10_000, windowsHide: true, env });
    if (v.status === 0) version = v.stdout.toString('utf8').trim().split('\n')[0]!.trim();
  }
  cachedSemgrep = { path: path || null, version };
  return cachedSemgrep;
}

/** Reset the probe cache (tests inject a fake semgrep on PATH). */
export function __resetSemgrepProbeForTests(): void {
  cachedSemgrep = undefined;
}

/** A registry config id (p/..., r/..., s/...) fetches remote rules; a path does not. */
function isRegistryConfig(config: string): boolean {
  return /^(p|r|s)\//.test(config) || config === 'auto';
}

function countByLevel(sarif: unknown): { error: number; warning: number; note: number; total: number } {
  const counts = { error: 0, warning: 0, note: 0, total: 0 };
  const runs = (sarif as { runs?: unknown[] })?.runs;
  if (!Array.isArray(runs)) return counts;
  for (const run of runs) {
    const results = (run as { results?: unknown[] })?.results;
    if (!Array.isArray(results)) continue;
    for (const r of results) {
      counts.total++;
      const level = (r as { level?: string })?.level ?? 'warning';
      if (level === 'error') counts.error++;
      else if (level === 'note' || level === 'none') counts.note++;
      else counts.warning++;
    }
  }
  return counts;
}

export const sastScan: Tool<SastScanInput, SastScanData> = {
  name: 'sast_scan',
  risk: 'write',
  deferred: true,
  searchAliases: [
    'sast', 'semgrep', 'static-analysis', 'code-scan', 'lint-security', 'sarif', 'codeql',
    'bandit', 'gosec', 'eslint-security', 'vulnerability-scan', 'pattern', 'taint', 'owasp',
    'injection-scan', 'secure-code',
  ],
  inputSchema: schema,
  description:
    'Privacy-first static-analysis sweep via semgrep. Telemetry is forced OFF (--metrics=off + env); rules ' +
    "default to a LOCAL path (registry rules need explicit allowRegistry:true because they fetch from semgrep.dev). " +
    "Results are written as a SARIF artifact under .shadow/sast/ and can be imported into security_findings. " +
    "action 'check' probes availability; 'scan' runs the sweep. Never edits source. Requires semgrep on PATH; " +
    'absence is reported honestly. Fixed argv, scrubbed env, bounded timeout.',
  async run(input: SastScanInput, ctx): Promise<ToolResult<SastScanData>> {
    const start = Date.now();
    const failNow = (code: string, message: string) => fail('sast_scan', 'write', Date.now() - start, code, message);
    try {
      const probe = probeSemgrep();
      if (input.action === 'check') {
        const data: SastScanData = {
          action: 'check',
          semgrep: { available: !!probe.path, ...(probe.path ? { path: probe.path } : {}), ...(probe.version ? { version: probe.version } : {}) },
        };
        return ok('sast_scan', 'write', Date.now() - start, JSON.stringify(data), data);
      }

      if (!probe.path) {
        return failNow('semgrep_missing', 'semgrep is not on PATH. Install it (e.g. `pip install semgrep` or `brew install semgrep`) and retry. No scan was run.');
      }

      // Resolve the scan target through the jail.
      let target: string;
      try {
        target = resolveWithin([ctx.workspaceRoot, ...(ctx.additionalRoots ?? [])], input.target ?? '.');
      } catch {
        return failNow('jail_escape', `Target "${input.target ?? '.'}" resolves outside the workspace jail.`);
      }

      // Resolve the rule config. Default: a local generic ruleset is NOT bundled, so
      // require an explicit config; registry configs need opt-in.
      const config = input.config;
      if (!config) {
        return failNow('config_required', "Provide a local rules path via config (e.g. a semgrep rules YAML/dir). Registry rules (p/...) require allowRegistry:true. 'auto' is intentionally not the default.");
      }
      const registry = isRegistryConfig(config);
      if (registry && !input.allowRegistry) {
        return failNow('registry_denied', `Config "${config}" fetches rules from the semgrep registry (network egress). Set allowRegistry:true only with operator authorization, or use a local rules path.`);
      }
      let configArg: string;
      if (registry) {
        configArg = config; // remote id, passed verbatim to semgrep
      } else {
        try {
          configArg = resolveWithin([ctx.workspaceRoot, ...(ctx.additionalRoots ?? [])], config);
        } catch {
          return failNow('jail_escape', `Rules path "${config}" resolves outside the workspace jail.`);
        }
        if (!existsSync(configArg)) {
          return failNow('rules_missing', `Local rules path "${config}" does not exist.`);
        }
      }

      // Prepare the SARIF artifact path (owner-only).
      const dir = resolveWithin(ctx.workspaceRoot, '.shadow/sast');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        chmodSync(dir, 0o700);
      } catch {
        /* best-effort on platforms without chmod */
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const sarifPath = join(dir, `${stamp}-${randomUUID().slice(0, 8)}.sarif`);

      // Fixed argv — no shell, no interpolation. Telemetry forced off.
      const argv = [
        'scan',
        '--metrics=off',
        '--disable-version-check',
        '--sarif',
        '--output',
        sarifPath,
        '--config',
        configArg,
        '--quiet',
        '--no-git-ignore',
      ];
      if (input.severity) argv.push('--severity', input.severity);
      argv.push(target);

      const env = scrubbedEnv(undefined, {
        SEMGREP_SEND_METRICS: 'off',
        SEMGREP_ENABLE_VERSION_CHECK: '0',
      });
      const timeoutMs = (input.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
      const res = spawnSync(probe.path, argv, {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: MAX_SARIF_BYTES,
        env,
        cwd: ctx.workspaceRoot,
        signal: ctx.signal,
      });
      if (res.error) {
        return failNow('spawn_error', `semgrep failed to start: ${(res.error as Error).message}`);
      }
      // semgrep exits 1 when findings are present (still a successful scan); >1 is an error.
      if (res.status !== null && res.status > 1) {
        const stderr = res.stderr?.toString('utf8').slice(0, 500) ?? '';
        return failNow('scan_failed', `semgrep exited ${res.status}. ${stderr}`);
      }
      if (!existsSync(sarifPath)) {
        return failNow('no_output', 'semgrep produced no SARIF output.');
      }
      // Size-precheck before reading: maxBuffer bounds captured stdout/stderr, not the
      // on-disk SARIF artifact, so guard the file itself before JSON.parse.
      if (statSync(sarifPath).size > MAX_SARIF_BYTES) {
        return failNow('too_large', 'semgrep SARIF output exceeded the size cap.');
      }
      let sarif: unknown;
      try {
        sarif = JSON.parse(readFileSync(sarifPath, 'utf8'));
      } catch {
        return failNow('bad_sarif', 'semgrep output was not valid SARIF JSON.');
      }
      const counts = countByLevel(sarif);

      let imported: SastScanData['imported'] = null;
      if (input.importFindings) {
        let store: EvidenceStore | undefined;
        try {
          store = new EvidenceStore(ctx.workspaceRoot);
          const result = store.importFile(sarifPath);
          imported = { imported: result.added, duplicates: result.duplicates, ids: result.ids };
        } catch {
          // Import failure is non-fatal: the SARIF artifact is still durable.
          imported = null;
        } finally {
          store?.close();
        }
      }

      const data: SastScanData = {
        action: 'scan',
        semgrep: { available: true, path: probe.path, ...(probe.version ? { version: probe.version } : {}) },
        sarifPath: relative(ctx.workspaceRoot, sarifPath),
        counts,
        imported,
        registryUsed: registry,
        metricsOff: true,
      };
      const summary = clamp(JSON.stringify(data), MAX_OUTPUT_CHARS);
      return ok('sast_scan', 'write', Date.now() - start, summary, data);
    } catch (e) {
      return failNow('scan_error', (e as Error).message);
    }
  },
};