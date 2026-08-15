/**
 * `shadow doctor --privacy` — the trust-you-can-verify report.
 *
 * Enumerates EVERY way the ACTIVE config could originate outbound traffic, plus where your keys live and
 * whether offline mode is usable — so the zero-telemetry / provider-neutral claims are checkable, not just
 * asserted. It makes NO network calls itself (pure inspection of config + local state), and it errs toward
 * OVER-reporting: a path that *could* leak is always listed, even if it's off by default.
 *
 * The only things that can send traffic in a session are: (a) the model provider, (b) the explicit
 * web_fetch / web_search tools, (c) configured MCP servers — including the npm-registry package resolve
 * an npx-launched one performs on first connect, (d) the opt-in update check, (d2) the opt-in plugin-index
 * lookup (off unless `pluginIndexUrl` is set) plus the user-run `shadow plugin add <git-url>` clone,
 * (e) a configured vision endpoint (describe_media uploads the image bytes there), (f) the one-time
 * HuggingFace weight download when a repo-id model preset is first served, and (g) user-configured
 * hooks / statusLine shell commands, which can run arbitrary shell including network. The plugin clone is
 * a git child process, so it bypasses the fetch broker and is journaled separately (purpose 'plugin-clone').
 * There is no telemetry path (a source guard +
 * pinned remote-host snapshot, test/no-telemetry.test.ts, keep it that way), and every deliberate
 * egress path flows the broker in src/safety/egress.ts, which journals each request to a local
 * receipt (~/.shadow/egress.log → `shadow egress`).
 */
import { isLocalBaseUrl } from '../safety/offline.js';
import { sandboxConfinement } from '../safety/sandbox.js';
import { mlxOfflineReady, isMlxDir } from '../gguf.js';
import { vaultExists } from '../auth/vault.js';
import { legacyCredentialsExist } from '../state/globalStore.js';
import { available as keychainAvailable } from '../auth/keychain.js';

const UPDATE_HOST = 'raw.githubusercontent.com';
const PROVIDER_DEFAULT_BASE: Record<string, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
};

export type EgressScope = 'always' | 'on-tool-use' | 'on-connect' | 'opt-in';

export interface EgressPath {
  name: string;
  target: string;
  /** Can traffic actually leave for this path under the current config? */
  active: boolean;
  scope: EgressScope;
  note?: string;
}

export interface PrivacyReport {
  provider: string;
  model: string;
  offline: boolean;
  effectiveBaseUrl: string;
  providerIsLocal: boolean;
  egress: EgressPath[];
  credentials: { store: 'vault' | 'plaintext' | 'env-only' | 'none'; keychainAvailable: boolean; detail: string };
  offlineEligible: { eligible: boolean; reason: string };
  telemetry: string;
  /** Things that WIDEN exposure — surfaced so the report never reads cleaner than reality. */
  warnings: string[];
}

/** Minimal shape of the loaded config the report needs. */
export interface PrivacyConfigView {
  provider: string;
  model?: string;
  baseUrl?: string;
  updateCheck?: boolean;
  pluginIndexUrl?: string;
  pluginIndexKey?: string;
  mcpServers?: Record<string, { url?: string; command?: string; args?: string[] }>;
  models?: Array<{ label?: string; baseUrl?: string; gguf?: string; mlx?: string; vllm?: string }>;
  vision?: { baseUrl: string };
  hooks?: Record<string, string[] | undefined>;
  statusLine?: string;
  sandbox?: 'auto' | 'off';
  sandboxFailurePolicy?: 'auto' | 'fail-closed' | 'warn';
}

export interface PrivacyEnv {
  offline: boolean;
  credStore: 'vault' | 'plaintext' | 'env-only' | 'none';
  keychainAvailable: boolean;
}

function hostOf(url: string): string {
  return (url.match(/^[a-z]+:\/\/([^/]+)/i)?.[1] ?? url).toLowerCase();
}

/** Read the real local state (no network). Injectable via buildPrivacyReport for tests. */
export function gatherPrivacyEnv(offline: boolean): PrivacyEnv {
  const hasEnvKey = Boolean(
    process.env.ANTHROPIC_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.ANTHROPIC_AUTH_TOKEN,
  );
  const credStore: PrivacyEnv['credStore'] = vaultExists()
    ? 'vault'
    : legacyCredentialsExist()
      ? 'plaintext'
      : hasEnvKey
        ? 'env-only'
        : 'none';
  return { offline, credStore, keychainAvailable: keychainAvailable() };
}

/** Build the report — pure. `env` carries the observed local state so it stays no-network and testable. */
export function buildPrivacyReport(cfg: PrivacyConfigView, env: PrivacyEnv): PrivacyReport {
  const provider = cfg.provider;
  const model = cfg.model ?? '(unset)';
  const offline = env.offline;
  const effectiveBaseUrl = cfg.baseUrl || PROVIDER_DEFAULT_BASE[provider] || '(provider default)';
  const providerIsLocal = isLocalBaseUrl(effectiveBaseUrl);

  const egress: EgressPath[] = [];
  const warnings: string[] = [];

  // (a) The model provider — the one egress that always happens on a turn.
  egress.push({
    name: 'Model provider',
    target: hostOf(effectiveBaseUrl),
    active: !offline || providerIsLocal,
    scope: 'always',
    note: offline && !providerIsLocal ? 'blocked in offline mode (cloud endpoint)' : providerIsLocal ? 'local endpoint' : undefined,
  });
  if (!providerIsLocal && !offline) {
    // Only warn when this path is actually live — an offline run with a cloud endpoint sends nothing
    // (it's refused before any request).
    warnings.push(`Your prompts, code, and tool output go to ${hostOf(effectiveBaseUrl)} (your chosen model provider).`);
  }

  // (b) Web tools — arbitrary hosts, only when the agent invokes them, dropped when offline.
  egress.push({
    name: 'Web tools (web_fetch / web_search)',
    target: 'any host the agent is asked to fetch/search',
    active: !offline,
    scope: 'on-tool-use',
    note: offline ? 'dropped in offline mode' : 'only when the agent invokes them; fetched content is treated as untrusted data',
  });
  if (!offline) warnings.push('web_fetch / web_search can reach arbitrary hosts when the agent invokes them.');

  // (c) MCP servers — http `url` servers are direct egress; `command` servers are local processes.
  const mcp = cfg.mcpServers ?? {};
  for (const [name, s] of Object.entries(mcp)) {
    if (s.url) {
      egress.push({
        name: `MCP server "${name}"`,
        target: hostOf(s.url),
        active: !offline,
        scope: 'on-connect',
        note: offline ? 'skipped in offline mode' : 'outbound connector',
      });
      if (!offline) warnings.push(`MCP server "${name}" is an outbound connector to ${hostOf(s.url)}.`);
    } else if (s.command) {
      egress.push({
        name: `MCP server "${name}"`,
        target: `local process: ${s.command}${s.args?.length ? ' ' + s.args.join(' ') : ''}`,
        active: !offline,
        scope: 'on-connect',
        note: offline ? 'skipped in offline mode' : 'local subprocess — may make its own network calls',
      });
      // An npx-launched server (e.g. the pinned Playwright browser preset) resolves its package
      // from the npm registry on FIRST connect — that resolution is egress in its own right.
      if (s.command === 'npx') {
        egress.push({
          name: `npm registry (MCP "${name}")`,
          target: 'registry.npmjs.org',
          active: !offline,
          scope: 'on-connect',
          note: offline ? 'skipped in offline mode' : 'npx resolves the pinned package on first connect; cached afterwards',
        });
        if (!offline) warnings.push(`MCP server "${name}" is launched via npx — first connect resolves its package from the npm registry.`);
      }
    }
  }

  // (d) Opt-in update check — off by default, dropped when offline.
  const updateOn = Boolean(cfg.updateCheck);
  egress.push({
    name: 'Update check',
    target: UPDATE_HOST,
    active: updateOn && !offline,
    scope: 'opt-in',
    note: !updateOn ? 'off (default) — makes zero calls' : offline ? 'suppressed in offline mode' : 'payload-free version GET, at most once/day',
  });
  if (updateOn && !offline) warnings.push(`Opt-in update check will contact ${UPDATE_HOST} at most once a day (no identifiers sent).`);

  // (d2) Plugin index (P3-07) — Shadow ships with NO central catalog; this path exists only if the
  // user set `pluginIndexUrl` themselves (global-only key — a project file cannot set it). When a
  // `pluginIndexKey` is configured the index body is refused unless its detached signature verifies.
  if (cfg.pluginIndexUrl?.trim()) {
    const signed = Boolean(cfg.pluginIndexKey?.trim());
    egress.push({
      name: 'Plugin index lookup',
      target: hostOf(cfg.pluginIndexUrl),
      active: !offline,
      scope: 'opt-in',
      note: offline
        ? 'suppressed in offline mode'
        : `only on \`shadow plugin search\` / \`add <name>\` — entries are untrusted listings; \`add <name>\` resolves a name to its clone URL (still scheme-allowlisted)${signed ? '; signature-verified (fail-closed)' : '; UNSIGNED — configure pluginIndexKey to require a signature'}`,
    });
    if (!offline) {
      warnings.push(`Plugin index lookups contact ${hostOf(cfg.pluginIndexUrl)} (your configured pluginIndexUrl).`);
      if (!signed) warnings.push('pluginIndexUrl is set WITHOUT pluginIndexKey — index responses are not signature-verified.');
    }
  }

  // (d3) Plugin install (P3-07) — `shadow plugin add <git-url>` clones the remote. This is a git
  // CHILD PROCESS, so it never touches shadowFetch/the offline fetch wall; the manager enforces the
  // offline refusal itself and journals a receipt (purpose 'plugin-clone'). Disclosed here because
  // the capability exists in every install, config or not — it only sends bytes when YOU run it.
  egress.push({
    name: 'Plugin install (git clone)',
    target: 'the git remote you pass to `shadow plugin add` (scheme-allowlisted: https/ssh/file/scp)',
    active: !offline,
    scope: 'opt-in',
    note: offline
      ? 'refused in offline mode (local file:// sources still work)'
      : 'only when you run `shadow plugin add <git-url>` — scrubbed env, receipt journaled (purpose plugin-clone)',
  });

  // (e) Vision endpoint — describe_media POSTs the image bytes (base64) to YOUR configured vision
  // model. Not registered at all in offline mode.
  if (cfg.vision?.baseUrl) {
    const visionLocal = isLocalBaseUrl(cfg.vision.baseUrl);
    egress.push({
      name: 'Vision endpoint (describe_media)',
      target: hostOf(cfg.vision.baseUrl),
      active: !offline,
      scope: 'on-tool-use',
      note: offline ? 'not registered in offline mode' : visionLocal ? 'local endpoint — image bytes stay on your network' : 'uploads image bytes (base64) when the agent describes media',
    });
    if (!offline && !visionLocal) warnings.push(`Images passed to describe_media go to ${hostOf(cfg.vision.baseUrl)} (your configured vision endpoint).`);
  }

  // (f) Repo-id model presets — the FIRST serve downloads the weights from huggingface.co (cached
  // thereafter). A directory target, or a repo id already in the HF cache, never touches the network.
  for (const m of cfg.models ?? []) {
    const repoId = m.mlx && !isMlxDir(m.mlx) ? m.mlx : m.vllm && !isMlxDir(m.vllm) ? m.vllm : undefined;
    if (!repoId || mlxOfflineReady(repoId)) continue;
    egress.push({
      name: `Model weights "${m.label ?? repoId}"`,
      target: 'huggingface.co',
      active: !offline,
      scope: 'on-connect',
      note: offline ? 'refused in offline mode' : 'first serve only — weights download once into the HuggingFace cache',
    });
    if (!offline) warnings.push(`Preset "${m.label ?? repoId}" will download its weights from huggingface.co on first serve (not cached yet).`);
  }

  // (g) Hooks + statusLine — user-configured shell, run OUTSIDE the sandbox, so it can make its own
  // network calls and offline mode cannot stop it. Listed rather than silently trusted.
  const hookCount = Object.values(cfg.hooks ?? {}).reduce((n, a) => n + (a?.length ?? 0), 0);
  if (hookCount > 0) {
    egress.push({
      name: 'Hooks',
      target: `local shell: ${hookCount} configured hook script${hookCount === 1 ? '' : 's'}`,
      active: true,
      scope: 'always',
      note: 'user-configured shell — can run arbitrary commands, including network; runs even in offline mode',
    });
  }
  if (cfg.statusLine) {
    egress.push({
      name: 'Status line',
      target: `local shell: ${cfg.statusLine}`,
      active: true,
      scope: 'always',
      note: 'user-configured shell — can run arbitrary commands, including network; runs even in offline mode',
    });
  }

  // Credentials at rest.
  const credential = ((): PrivacyReport['credentials'] => {
    switch (env.credStore) {
      case 'vault':
        return { store: 'vault', keychainAvailable: env.keychainAvailable, detail: `~/.shadow/vault.enc — encrypted (scrypt → AES-256-GCM)${env.keychainAvailable ? '; OS keychain available for silent unlock' : '; no keychain — unlocks by password each session'}` };
      case 'plaintext':
        return { store: 'plaintext', keychainAvailable: env.keychainAvailable, detail: '~/.shadow/credentials.json — PLAINTEXT (chmod 600). Run `shadow onboard --web` to encrypt.' };
      case 'env-only':
        return { store: 'env-only', keychainAvailable: env.keychainAvailable, detail: 'key comes from an environment variable; nothing stored on disk' };
      default:
        return { store: 'none', keychainAvailable: env.keychainAvailable, detail: 'no credentials configured' };
    }
  })();
  if (env.credStore === 'plaintext') warnings.push('API keys are stored in plaintext (~/.shadow/credentials.json). Encrypt them with `shadow onboard --web`.');

  // P2-12 — confinement state widens exposure exactly like the entries above: an unconfined
  // run_shell means the agent's commands touch this machine with YOUR user permissions.
  if (sandboxConfinement(cfg.sandbox ?? 'auto') === 'unconfined') {
    const policy = cfg.sandboxFailurePolicy ?? 'auto';
    warnings.push(
      `run_shell runs UNCONFINED on this host — the OS sandbox was requested but no tool enforces it here. ` +
        (policy === 'warn'
          ? 'Failure policy is warn: unconfined commands run with a warning folded into the result only.'
          : `Failure policy is ${policy}: unconfined commands stop at the approval gate${policy === 'fail-closed' ? ' every time (the gate never bends)' : ''}.`),
    );
  }

  // Offline eligibility.
  // An mlx REPO-ID preset counts only once its weights are cached — an eligibility claim that
  // would trigger a HuggingFace download on first serve would falsify this report.
  const hasLocalPreset = (cfg.models ?? []).some((m) => m.gguf || (m.mlx && mlxOfflineReady(m.mlx)) || isLocalBaseUrl(m.baseUrl));
  const offlineEligible = providerIsLocal
    ? { eligible: true, reason: 'the active model is a local endpoint — offline mode fully usable' }
    : hasLocalPreset
      ? { eligible: true, reason: 'switch to one of your local model presets (`/model`), then run with `--offline`' }
      : { eligible: false, reason: 'no local model configured — add a local/gguf preset to use offline mode' };

  return {
    provider,
    model,
    offline,
    effectiveBaseUrl,
    providerIsLocal,
    egress,
    credentials: credential,
    offlineEligible,
    telemetry:
      'none — no analytics, crash-reporting, or phone-home; enforced by a source guard + pinned host snapshot (test/no-telemetry.test.ts). Every outbound request flows through a single egress broker and is journaled to a local receipt — `shadow egress` / ~/.shadow/egress.log',
    warnings,
  };
}

// ── formatting ────────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[38;2;74;222;128m',
  yellow: '\x1b[38;2;234;179;8m',
  red: '\x1b[38;2;239;68;68m',
  cyan: '\x1b[38;2;56;219;245m',
};

function dot(active: boolean): string {
  return active ? `${C.yellow}●${C.reset}` : `${C.dim}○${C.reset}`;
}

/** Render the report for the terminal. `color` off → plain (scriptable). */
export function formatPrivacyReport(r: PrivacyReport, color = true): string {
  const c = color ? C : (Object.fromEntries(Object.keys(C).map((k) => [k, ''])) as typeof C);
  const L: string[] = [];
  L.push(`${c.bold}Privacy posture — ${r.provider}/${r.model}${r.offline ? ' (offline mode)' : ''}${c.reset}`);
  L.push('');
  L.push(`${c.bold}Outbound egress${c.reset} ${c.dim}(● = can send under this config · ○ = cannot)${c.reset}`);
  for (const e of r.egress) {
    const scope = `${c.dim}[${e.scope}]${c.reset}`;
    L.push(`  ${dot(e.active)} ${e.name} ${c.dim}→${c.reset} ${e.target} ${scope}`);
    if (e.note) L.push(`      ${c.dim}${e.note}${c.reset}`);
  }
  L.push('');
  const credColor = r.credentials.store === 'plaintext' ? c.red : r.credentials.store === 'vault' ? c.green : c.dim;
  L.push(`${c.bold}Credentials at rest${c.reset}  ${credColor}${r.credentials.store}${c.reset}`);
  L.push(`  ${c.dim}${r.credentials.detail}${c.reset}`);
  L.push('');
  L.push(`${c.bold}Offline mode${c.reset}  ${r.offlineEligible.eligible ? c.green + 'eligible' : c.yellow + 'not yet eligible'}${c.reset}`);
  L.push(`  ${c.dim}${r.offlineEligible.reason}${c.reset}`);
  L.push('');
  L.push(`${c.bold}Telemetry${c.reset}  ${c.green}none${c.reset}`);
  L.push(`  ${c.dim}${r.telemetry}${c.reset}`);
  if (r.warnings.length) {
    L.push('');
    L.push(`${c.bold}${c.yellow}What leaves this machine${c.reset}`);
    for (const w of r.warnings) L.push(`  ${c.yellow}!${c.reset} ${w}`);
  }
  L.push('');
  L.push(`${c.dim}This report made no network calls — it inspected your config and local state only.${c.reset}`);
  return L.join('\n');
}
