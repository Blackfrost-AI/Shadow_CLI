import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolveApiKey, resolveAuthToken } from './config.js';
import { DEV_UNRESTRICTED } from './buildProfile.js';
import { GLOBAL_DIR } from './state/globalStore.js';

export type DoctorSeverity = 'error' | 'warn' | 'info';

export interface DoctorCheck {
  id: string;
  ok: boolean;
  severity: DoctorSeverity;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

/** Run environment diagnostics (Claude `/doctor` parity baseline). */
export function runDoctor(cwd: string): DoctorReport {
  const checks: DoctorCheck[] = [];

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({
    id: 'node',
    ok: nodeMajor >= 20,
    severity: 'error',
    detail: `Node ${process.versions.node} (require ≥20)`,
  });

  let rgOk = false;
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' });
    rgOk = true;
  } catch {
    /* fallback grep in tools */
  }
  checks.push({
    id: 'rg',
    ok: rgOk,
    severity: 'warn',
    detail: rgOk ? 'ripgrep available' : 'ripgrep not in PATH — grep tool uses slower Node fallback',
  });

  const plat = platform();
  if (plat === 'darwin') {
    const present = existsSync('/usr/bin/sandbox-exec');
    checks.push({
      id: 'sandbox-tool',
      ok: present,
      severity: 'info',
      detail: present ? 'sandbox-exec present (ready when guardrails on)' : 'sandbox-exec missing — OS sandbox unavailable',
    });
  } else if (plat === 'linux') {
    let present = false;
    try {
      execFileSync('bwrap', ['--version'], { stdio: 'ignore' });
      present = true;
    } catch {
      /* no bwrap */
    }
    checks.push({
      id: 'sandbox-tool',
      ok: present,
      severity: 'info',
      detail: present ? 'bubblewrap present (ready when guardrails on)' : 'bwrap not installed — OS sandbox unavailable on Linux',
    });
  } else {
    checks.push({
      id: 'sandbox-tool',
      ok: true,
      severity: 'info',
      detail: 'Windows: no OS sandbox (expected)',
    });
  }

  if (existsSync(GLOBAL_DIR)) {
    const mode = statSync(GLOBAL_DIR).mode & 0o777;
    checks.push({
      id: 'global-dir',
      ok: mode <= 0o700,
      severity: 'error',
      detail:
        mode <= 0o700
          ? `~/.shadow permissions ok (0${mode.toString(8)})`
          : `~/.shadow too permissive (0${mode.toString(8)}); want ≤0700`,
    });
  } else {
    checks.push({
      id: 'global-dir',
      ok: true,
      severity: 'info',
      detail: '~/.shadow not created yet (appears after first onboard)',
    });
  }

  const credsPath = join(GLOBAL_DIR, 'credentials.json');
  if (existsSync(credsPath)) {
    const mode = statSync(credsPath).mode & 0o777;
    checks.push({
      id: 'credentials',
      ok: mode <= 0o600,
      severity: 'error',
      detail:
        mode <= 0o600
          ? `credentials.json permissions ok (0${mode.toString(8)})`
          : `credentials.json too permissive (0${mode.toString(8)}); want ≤0600`,
    });
  } else {
    checks.push({
      id: 'credentials',
      ok: true,
      severity: 'info',
      detail: 'no credentials.json yet — run `shadow onboard`',
    });
  }

  let cfg;
  try {
    cfg = loadConfig(cwd);
  } catch (e) {
    checks.push({
      id: 'config',
      ok: false,
      severity: 'error',
      detail: `config invalid: ${(e as Error).message}`,
    });
    return finalize(checks);
  }

  const hasProvider =
    cfg.provider === 'mock' || Boolean(resolveApiKey(cfg.provider) || resolveAuthToken(cfg.provider));
  checks.push({
    id: 'provider',
    ok: hasProvider,
    severity: hasProvider ? 'info' : 'warn',
    detail: hasProvider ? `provider ${cfg.provider} / ${cfg.model}` : 'no API credentials — run `shadow onboard`',
  });

  const mcpNames = Object.keys(cfg.mcpServers ?? {});
  checks.push({
    id: 'mcp',
    ok: true,
    severity: 'info',
    detail: mcpNames.length ? `MCP: ${mcpNames.join(', ')}` : 'no MCP servers configured (optional)',
  });

  const guardrailsOn = process.env.SHADOW_GUARDRAILS === 'on';
  const yoloActive = process.argv.includes('--yolo') || process.argv.includes('--nuke') || process.argv.includes('--dangerously-skip-permissions');
  checks.push({
    id: 'guardrails',
    ok: true,
    severity: 'info',
    detail: yoloActive
      ? ' --yolo active: jail + OS sandbox + most guards OFF (full unrestricted). --yolo is the sandbox-off flag.'
      : guardrailsOn
        ? 'SHADOW_GUARDRAILS=on — jail + OS sandbox enabled for this run'
        : DEV_UNRESTRICTED
          ? 'dev default: jail + OS sandbox OFF (buildProfile DEV_UNRESTRICTED=true). Use SHADOW_GUARDRAILS=on to test hardened mode'
          : 'buildProfile DEV_UNRESTRICTED=false — guardrails enabled by default',
  });

  return finalize(checks);
}

function finalize(checks: DoctorCheck[]): DoctorReport {
  const ok = checks.filter((c) => c.severity === 'error').every((c) => c.ok);
  return { ok, checks };
}

export function formatDoctorReport(report: DoctorReport, version: string): string {
  const lines = [`shadow doctor ${version}`, ''];
  for (const c of report.checks) {
    const mark = c.ok ? '✓' : c.severity === 'warn' ? '⚠' : '✗';
    const label = c.ok ? 'ok' : c.severity === 'warn' ? 'warn' : 'fail';
    lines.push(`  ${mark} [${label}] ${c.id}: ${c.detail}`);
  }
  lines.push('');
  lines.push(report.ok ? 'All critical checks passed.' : 'One or more critical checks failed.');
  return lines.join('\n');
}