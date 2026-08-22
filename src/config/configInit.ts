// ─────────────────────────────────────────────────────────────────────────────
// `shadow config init` — the self-documenting config layer (T2 Phase 2).
//
// The blank-config problem: a fresh install ships an EMPTY ~/.shadow/config.json
// (loadGlobalConfig falls back to {}) with zero documentation of the knobs that
// exist, and onboarding MERGES into it silently — so the founder's Windows box
// read as "overwrote my file with nothing" and had no knob for the 120s idle
// kills (that's what the Phase 1 stream block fixed — but nobody can DISCOVER it).
//
// Two artifacts, both strictly additive (never overwrite non-empty content):
//   1. config.template.md — a documented reference for EVERY knob (JSON can't
//      hold comments; the template is the reference beside the live file).
//   2. safe seed defaults into the LIVE config.json, only when it is absent or
//      empty: notify + contextBudget + the stream block. Never touches a config
//      that already carries content.
//
// Pure module: paths are PARAMETERS and globalStore is INJECTED — the store's
// GLOBAL_DIR is computed at import time from homedir(), so importing it at the
// top level would pin the real home for tests that isolate later. Unit tests
// pass temp paths + an in-memory fake store; the CLI passes the real ones.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The minimal store surface this module needs — inject the real globalStore in the CLI. */
export interface ConfigStore {
  saveGlobalConfig(patch: Record<string, unknown>): void;
  loadGlobalConfig(): Record<string, unknown>;
}

/**
 * Safe defaults seeded into an EMPTY config.json. Conservative values that work
 * everywhere (self-hosted included) and document themselves in the template.
 */
export const SAFE_SEED: Record<string, unknown> = {
  notify: 'auto',
  contextBudget: 128_000,
  stream: {
    idleTimeoutMs: 300_000,
    firstByteTimeoutMs: 600_000,
    retries: 5,
  },
};

/** The documented reference written beside the live config. */
export const CONFIG_TEMPLATE_MD = `# Shadow configuration reference

The LIVE file is \`~/.shadow/config.json\` — plain JSON (no comments allowed),
merged BELOW the project \`shadow.config.json\`. This template documents every knob.
Recreate it any time with \`shadow config init\` (never overwrites an existing one).

## Layout of ~/.shadow

| file               | purpose                                                        |
|--------------------|----------------------------------------------------------------|
| config.json        | settings + endpoint registry — NO secrets, safe to sync/paste  |
| config.template.md | this reference                                                 |
| vault.enc          | encrypted secrets (keys/tokens) — AES-256-GCM, master password |
| vault.key.dpapi    | Windows keychain-backed vault key cache                        |
| credentials.json   | LEGACY plaintext secrets — migration is offered, then removed  |
| SHADOW.md          | global persona/instructions                                    |
| prompts/           | global instruction modules                                     |
| keybindings.json   | keymap overrides                                               |

Keys LIVE in the vault, never in config.json — model entries carry a \`credRef\`
pointer instead, so a migrated config.json is safe to share.

## Full example (copy what you need)

\`\`\`json
{
  "provider": "openai",
  "model": "gpt-4.1",
  "notify": "auto",
  "effort": "high",
  "contextBudget": 128000,
  "stream": {
    "idleTimeoutMs": 300000,
    "firstByteTimeoutMs": 600000,
    "retries": 5
  },
  "models": [
    {
      "label": "local-serve",
      "provider": "openai",
      "model": "my-model",
      "baseUrl": "http://127.0.0.1:8000/v1/chat/completions",
      "selfHosted": true,
      "credRef": "vault:openai",
      "idleTimeoutMs": 300000,
      "firstByteTimeoutMs": 600000,
      "streamRetries": 8
    }
  ]
}
\`\`\`

## The knobs that matter for slow/self-hosted serves

- \`stream.idleTimeoutMs\` — session-wide SSE silence budget (ms). Self-hosted servers
  (vLLM/SGLang/llama.cpp, MLX) stay silent for tens of seconds during long prefill —
  raise this there. Public endpoints default to 120s; local/LAN/self-hosted to 300s.
- \`stream.firstByteTimeoutMs\` — how long the first SSE byte may take.
- \`stream.retries\` — attempts per request before giving up.
- Per-model overrides live on each \`models[]\` entry: \`idleTimeoutMs\`,
  \`firstByteTimeoutMs\`, \`streamRetries\` — they beat the session-wide block.
- \`SHADOW_IDLE_MS\` (env) beats everything — the emergency override.

Resolution order: env > per-model entry > stream block > self-hosted-aware default
> built-in default.

## Other common knobs

- \`notify\` — "auto" | "iterm2" | "kitty" | "ghostty" | "bell" | "off".
- \`contextBudget\` — soft context ceiling in tokens (default 128000).
- \`sandbox\` — "auto" | "off"; \`sandboxFailurePolicy\` — what happens when no sandbox tool exists.
- \`egress\` — \`{ "mode": "observe" | "enforce", "allow": ["host", ...] }\` quarantine allowlist.
- \`sessionRetentionDays\` / \`sessionRetentionKeep\` — archive old session logs (never deletes).
- \`autonomy\` — "ask" | "auto-edit" | "full"; \`--yolo\` still drops the sandbox entirely.

See \`shadow doctor\` for the live state of all of this (the layout panel shows every
file above with its status).
`;

/** True when a raw global config counts as "empty" (absent, {}, or whitespace-only JSON). */
export function configIsEmpty(raw: Record<string, unknown>): boolean {
  return Object.keys(raw).length === 0;
}

export interface ConfigInitResult {
  /** The template was written (or already existed). */
  template: { written: string } | { alreadyPresent: string } | { error: string };
  /** The live config was seeded (or was already non-empty). */
  seed: { seeded: Record<string, unknown> } | { alreadyPresent: string } | { error: string };
}

/**
 * Write the template + seed safe defaults. Strictly additive on both artifacts:
 * an existing template is left alone, and a non-empty config is never touched.
 * `configPath` is a parameter so tests can aim at a temp dir; the CLI passes
 * join(GLOBAL_DIR, 'config.json').
 */
export function configInit(
  globalDir: string,
  configPath: string,
  store: ConfigStore,
  templateText: string = CONFIG_TEMPLATE_MD,
): ConfigInitResult {
  mkdirSync(globalDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(globalDir, 0o700);
  } catch {
    /* best-effort */
  }

  const templatePath = join(globalDir, 'config.template.md');
  let template: ConfigInitResult['template'];
  if (existsSync(templatePath)) {
    template = { alreadyPresent: templatePath };
  } else {
    try {
      writeFileSync(templatePath, templateText, 'utf8');
      template = { written: templatePath };
    } catch (e) {
      template = { error: (e as Error).message };
    }
  }

  let seed: ConfigInitResult['seed'];
  const exists = existsSync(configPath);
  let rawNonEmpty = false;
  if (exists) {
    try {
      rawNonEmpty = readFileSync(configPath, 'utf8').trim().length > 0;
    } catch {
      rawNonEmpty = false; // unreadable — treat as empty and let saveGlobalConfig's rescue logic guard
    }
  }
  if (rawNonEmpty) {
    seed = { alreadyPresent: configPath };
  } else {
    try {
      store.saveGlobalConfig({ ...SAFE_SEED });
      seed = { seeded: { ...SAFE_SEED } };
    } catch (e) {
      seed = { error: (e as Error).message };
    }
  }

  return { template, seed };
}

/** Format the `shadow config init` output. */
export function formatConfigInit(r: ConfigInitResult, configPath: string): string {
  const lines: string[] = [];
  if ('written' in r.template) lines.push(`✓ wrote ${r.template.written} — every knob documented`);
  else if ('alreadyPresent' in r.template) lines.push(`· template already present: ${r.template.alreadyPresent} (not overwritten)`);
  else lines.push(`✗ template: ${r.template.error}`);

  if ('seeded' in r.seed) {
    lines.push(`✓ seeded safe defaults into ${configPath}`);
    lines.push(`    ${JSON.stringify(r.seed.seeded)}`);
  } else if ('alreadyPresent' in r.seed) {
    lines.push(`· config.json already has content — left untouched`);
  } else {
    lines.push(`✗ seed: ${r.seed.error}`);
  }
  lines.push('');
  lines.push('Layout: settings live in config.json (no secrets); keys live in the vault (/lock, shadow onboard).');
  return lines.join('\n');
}

/** True when the file at `p` is absent or holds no JSON content — for the first-run hint. */
export function globalConfigLooksEmpty(p: string): boolean {
  try {
    const raw = readFileSync(p, 'utf8');
    if (!raw.trim()) return true;
    const parsed = JSON.parse(raw) as unknown;
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
  } catch {
    return true; // absent/unreadable/invalid → hint is harmless either way
  }
}

/** The first-run one-liner (stderr) when config.json is {} — one time, not nagging. */
export const FIRST_RUN_HINT =
  'Tip: ~/.shadow/config.json is empty — run `shadow config init` for a documented ' +
  'template + safe defaults (stream timeouts, notify). Keys live in the vault: `shadow onboard`.';

/** The file-size guard used by the doctor layout panel. */
export function fileSizeBytes(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return -1;
  }
}

// ── /doctor layout panel ─────────────────────────────────────────────────────
// The blank-config problem was really a "where is anything" problem: nobody could
// see the ~/.shadow layout at a glance — which file is settings, which holds
// secrets, which is legacy. The layout panel makes the directory self-describing.

export interface LayoutRow {
  /** Display name (relative to ~/.shadow). */
  file: string;
  /** Absolute path. */
  path: string;
  status: 'present' | 'empty' | 'missing';
  /** Human size, e.g. "1.2 kB" / "—". */
  size: string;
  /** Permission bits, e.g. "0600" / "—". */
  mode: string;
  /** One-line guidance. */
  note: string;
}

function fmtSize(bytes: number): string {
  if (bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} kB`;
}

function fmtMode(p: string): string {
  try {
    return '0' + (statSync(p).mode & 0o777).toString(8);
  } catch {
    return '—';
  }
}

/** Build the layout panel for a global dir. Pure fs inspection — no writes. */
export function buildLayoutPanel(globalDir: string): LayoutRow[] {
  const row = (file: string, noteFor: (st: LayoutRow['status'], bytes: number) => string): LayoutRow => {
    const path = join(globalDir, file);
    const bytes = fileSizeBytes(path);
    const status: LayoutRow['status'] = bytes < 0 ? 'missing' : bytes === 0 ? 'empty' : 'present';
    return { file, path, status, size: fmtSize(bytes), mode: fmtMode(path), note: noteFor(status, bytes) };
  };

  return [
    row('config.json', (st) =>
      st === 'present'
        ? 'settings + model registry — NO secrets, safe to share'
        : 'empty/absent — `shadow config init` seeds safe defaults',
    ),
    row('config.template.md', (st) =>
      st === 'present'
        ? 'documented knob reference — beside the live config'
        : 'reference not written — `shadow config init` creates it',
    ),
    row('vault.enc', (st) =>
      st === 'present'
        ? 'encrypted secrets (AES-256-GCM) — unlock: /lock or shadow onboard'
        : 'no vault yet — keys land here via `shadow onboard`',
    ),
    row('credentials.json', (st) =>
      st === 'present'
        ? '⚠ LEGACY plaintext secrets — Shadow offers migration, then removes it'
        : 'good — no legacy plaintext secrets file',
    ),
    row('SHADOW.md', (st) =>
      st === 'present'
        ? 'global persona/instructions — read at every session start'
        : 'no global persona (fine — project SHADOW.md/AGENTS.md still read)',
    ),
    row('keybindings.json', (st) =>
      st === 'present' ? 'keymap overrides active' : 'default keymap (customize: see docs)',
    ),
    row('egress.log', (st) =>
      st === 'present'
        ? 'outbound-connection receipt — full table: `shadow egress`'
        : 'no outbound journaled yet',
    ),
    row('prompts', (st) =>
      st === 'present' ? 'global instruction modules' : 'no global instruction modules',
    ),
  ];
}

/** Render the layout panel as aligned plain text (TUI-friendly). */
export function formatLayoutPanel(globalDir: string, rows: LayoutRow[]): string {
  const w = Math.max(...rows.map((r) => r.file.length)) + 2;
  const lines = [`${globalDir} layout:`];
  for (const r of rows) {
    const flag = r.status === 'present' ? '✓' : '·';
    lines.push(`  ${flag} ${r.file.padEnd(w)} ${r.status.padEnd(7)} ${r.size.padStart(8)}  ${r.mode.padEnd(4)}  ${r.note}`);
  }
  return lines.join('\n');
}
