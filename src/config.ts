import { outputStyles } from './styles.js';
import { readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { loadGlobalConfig, saveGlobalConfig, getCredential } from './state/globalStore.js';
import type { PermissionRule } from './safety/rules.js';
import { resolveSubscriptionAuth } from './auth/index.js';
import { subProviderFor } from './auth/spec.js';

const ModelPriceSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheReadMult: z.number().optional(),
  cacheWriteMult: z.number().optional(),
});

const PermissionRuleSchema = z.object({
  tool: z.string(),
  pattern: z.string().optional(),
  action: z.enum(['deny', 'ask', 'allow']),
});

const HooksSchema = z.object({
  pre_tool_use: z.array(z.string()).default([]),
  post_tool_use: z.array(z.string()).default([]),
  session_start: z.array(z.string()).default([]),
  session_end: z.array(z.string()).default([]),
  user_prompt_submit: z.array(z.string()).default([]),
  pre_compact: z.array(z.string()).default([]),
  post_compact: z.array(z.string()).default([]),
  stop: z.array(z.string()).default([]),
  subagent_stop: z.array(z.string()).default([]),
  notification: z.array(z.string()).default([]),
});

// An MCP server is reached over stdio (`command`) OR HTTP (`url`, Streamable HTTP).
const McpServerSchema = z
  .object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string()).optional(),
  })
  .refine((s) => Boolean(s.command) || Boolean(s.url), {
    message: 'mcp server needs a `command` (stdio) or a `url` (http)',
  });

/**
 * Sanitize a base URL before it is used or persisted. The onboarding prompt shows the
 * default wrapped in [brackets] — "Base URL [http://host:8813/v1]" — and a user who
 * types/pastes that literal hint saves "[http://host:8813/v1]". Because resolveBaseUrl
 * returns the configured value FIRST, that malformed top-level baseUrl silently
 * overrode every model and every request died with "Failed to parse URL" (interactive
 * use dodged it via the picker; flag/eval/sub-agent paths didn't). Strip one or more
 * layers of wrapping []/<>/quotes + whitespace, then require a valid http(s) URL;
 * return undefined if it can't parse, so resolution falls through to the per-model /
 * env / default instead of a poisoned value. Applied as a schema transform (an already
 * poisoned config self-heals on load + is re-saved clean) AND inside resolveBaseUrl.
 */
export function normalizeBaseUrl(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let s = raw.trim();
  const wrappers: ReadonlyArray<readonly [string, string]> = [
    ['[', ']'],
    ['<', '>'],
    ['"', '"'],
    ["'", "'"],
    ['`', '`'],
  ];
  for (let changed = true; changed; ) {
    changed = false;
    for (const [open, close] of wrappers) {
      if (s.length > open.length + close.length && s.startsWith(open) && s.endsWith(close)) {
        s = s.slice(open.length, s.length - close.length).trim();
        changed = true;
      }
    }
  }
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? s : undefined;
  } catch {
    return undefined;
  }
}

/** One selectable model in the `/model` picker. */
const ModelEntrySchema = z.object({
  label: z.string(),
  provider: z.enum(['anthropic', 'openai', 'mock']),
  model: z.string(),
  baseUrl: z
    .string()
    .optional()
    .transform((v) => normalizeBaseUrl(v)),
  apiKey: z.string().optional(),
  authToken: z.string().optional(),
  /**
   * Pointer into the encrypted vault: the slot id holding this preset's secret. Opaque and
   * non-secret, so a migrated config.json is safe to sync or paste. Takes precedence over a
   * co-present `apiKey` (which is then legacy residue). `apiKey`/`authToken` stay in the
   * schema permanently — that is the backward-compatibility contract for unmigrated configs.
   */
  credRef: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
    .optional(),
  fallback: z.string().optional(),
  disabled: z.boolean().optional(),
  // Optional /model-picker category override. When unset, the group is derived:
  // a local endpoint → "Local", otherwise the model's company (Anthropic/OpenAI/xAI/…).
  group: z.string().optional(),
  // Local .gguf auto-serve (ollama-style): when set, shadow launches a llama.cpp server
  // for this file on activation and talks to it over the OpenAI endpoint (see src/gguf.ts).
  gguf: z.string().optional(),
  // Local MLX auto-serve (Apple Silicon): a model DIRECTORY or an mlx-community/... repo id;
  // shadow launches `mlx_lm.server` for it on activation (see src/gguf.ts ensureMlxServer).
  mlx: z.string().optional(),
  // Local vLLM auto-serve (Linux + CUDA): a model DIRECTORY or a HuggingFace repo id — shadow launches
  // vLLM (native `vllm serve`, else the vllm/vllm-openai Docker image) and talks to its OpenAI endpoint.
  // The engine that covers the common GPU formats: safetensors, FP8, AWQ, GPTQ, and NVFP4 on Blackwell.
  vllm: z.string().optional(),
  vllmArgs: z.array(z.string()).optional(), // extra `vllm serve` args (--tensor-parallel-size, --quantization, …)
  vllmImage: z.string().optional(), // docker image for the container path (default: vllm/vllm-openai:latest)
  ggufPort: z.number().optional(), // fixed port (default: deterministic per path)
  ggufArgs: z.array(z.string()).optional(), // extra llama-server args (overrides ctx/gpuLayers below when set)
  ggufServer: z.string().optional(), // llama-server binary path (default: PATH or $SHADOW_LLAMA_SERVER)
  // Local Model Garage knobs threaded into the llama-server spawn (see src/gguf.ts).
  // Ignored when `ggufArgs` is set explicitly (that wins). Defaults applied at spawn.
  ctx: z.number().int().positive().optional(), // context window (-c); default 32768 when unset
  gpuLayers: z.number().int().nonnegative().optional(), // GPU offload layers (-ngl); 999 = all (llama clamps)
});

const ConfigSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'mock']).default('anthropic'),
  model: z.string().default('claude-opus-4-8'),
  baseUrl: z
    .string()
    .optional()
    .transform((v) => normalizeBaseUrl(v)), // openai-compatible base (sanitized); keys come from env only
  // Extra dirs (beyond the workspace) the file tools + sandbox may read/write. Trusted
  // source only (global/env/CLI) — a cloned project must not widen your jail. See --add-dir.
  additionalDirectories: z.array(z.string()).default([]),
  models: z.array(ModelEntrySchema).default([]), // selectable presets for the `/model` picker
  fallbackModel: z.string().optional(), // global fallback when primary model fails
  lastModel: z.string().optional(), // label of the last model chosen via the picker
  permissionRules: z.array(PermissionRuleSchema).default([]),
  hooks: HooksSchema.default({ pre_tool_use: [], post_tool_use: [] }),
  mcpServers: z.record(McpServerSchema).default({}),
  // Shadow's pluggable "eyes" — describe an image via a vision model YOU run, so any driving model
  // (even a text-only one) can reason about pictures. The endpoint lives in ~/.shadow or env ONLY
  // (both are in PROJECT_UNTRUSTED_KEYS), so a cloned repo can never redirect where your media uploads.
  //
  // `vision` (RECOMMENDED): any OpenAI-compatible vision endpoint — Ollama, vLLM, llama.cpp, etc.
  // serving a VLM (Qwen-VL, LLaVA, …). This is the reproducible path; describe_media prefers it.
  vision: z
    .object({
      baseUrl: z.string(), // your endpoint, e.g. http://<host>:8001/v1 — user-provided, never hardcoded
      model: z.string(), // served model name, e.g. a qwen3-vl
      prompt: z.string().default('Describe this image in detail. What is shown?'),
    })
    .optional(),
  // `comfy` (alternative): a local ComfyUI, for describe via a caption node and (later) generation.
  comfy: z
    .object({
      baseUrl: z.string(), // e.g. http://<your-comfyui-host>:8188 — user-provided, never hardcoded
      visionModel: z.string().optional(),
      visionType: z.string().default('qwen_image'),
      describePrompt: z.string().default('Describe this image in detail. What is shown?'),
    })
    .optional(),
  parallelTools: z.boolean().default(true),
  lastStyle: z.enum(outputStyles).default('proactive'),
  lastTheme: z
    .enum(['og', 'dark', 'light', 'matrix', 'mono', 'pipboy', 'cyberpunk', 'coder-chick', 'colorblind', 'high-contrast'])
    .default('og'),
  statusLine: z.string().optional(), // shell command whose stdout renders in the footer (/statusline)
  vimMode: z.boolean().default(false), // modal (NORMAL/INSERT) editing in the composer (/vim)
  planMode: z.boolean().default(false),
  systemPromptPath: z.string().optional(),
  style: z.enum(outputStyles).default('proactive'),
  autonomy: z.enum(['manual', 'auto-read', 'auto-edit', 'full']).default('auto-edit'),
  /** Rule-based permission classifier stub (NOT LLM). Extends auto-read with finer gating. */
  autoClassifier: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  // OPT-IN update discovery. OFF by default (zero-telemetry stance): when true, at most once a day on
  // launch Shadow does a plain payload-free GET of the PUBLIC version and prints one line if a newer
  // release exists. Never sends anything about the user. See src/update/checkUpdate.ts.
  updateCheck: z.boolean().default(false),

  maxIterations: z.number().int().nonnegative().default(200), // 0 = unlimited (dead-drop / long engagements); real backstop = tokens/cost/wall-clock
  // Generous default so reasoning models (incl. custom LOCAL reasoners that isReasoningModel
  // can't detect by name) don't burn the whole budget on hidden thinking and hit the cap before
  // answering. Local servers just cap generation; a cloud model with a smaller hard limit gets a
  // 400 that the stream layer catches and shrinks-and-retries (see looksLikeTokenOverflow).
  // Override per-machine in ~/.shadow/config.json or with --max-output-tokens (see USER_GUIDE.md).
  maxOutputTokens: z.number().int().positive().default(65536),
  // Reasoning depth for adaptive-thinking models (Claude 4.6+/Fable 5). The primary
  // intelligence/latency/cost dial; ignored by models/providers without it.
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
  // Soft cost warning: when session spend crosses this USD amount, the TUI prints a
  // one-time notice (distinct from budget.maxCostUSD, which hard-stops the loop).
  costWarnUSD: z.number().positive().optional(),
  // Anthropic prompt-cache TTL for the stable prefix (system + tools). 1h helps long
  // sessions with gaps > 5min; costs a pricier cache write. Default 5m (current behavior).
  cacheTtl: z.enum(['5m', '1h']).default('5m'),
  // Anthropic "fast mode" (premium low-latency). Disables extended thinking when on.
  fastMode: z.boolean().default(false),
  // Context window the agent budgets against (override per-model in config). 128k = the modern
  // floor; compaction fires at contextBudget * summarizeTriggerRatio. Was 100k/0.75 (compact at
  // 75k) which fired far too early on large-window models mid-research — now 128k/0.85 → ~109k,
  // safe for a 128k model (leaves headroom for the reply) and much less frequent.
  contextBudget: z.number().int().positive().default(128_000),
  summarizeTriggerRatio: z.number().positive().max(1).default(0.85),
  keepLastTurns: z.number().int().positive().default(6),
  maxToolResultChars: z.number().int().positive().default(16_384),

  sandbox: z.enum(['auto', 'off']).default('auto'), // OS sandbox for run_shell (auto = on where supported)
  sandboxNetwork: z.boolean().default(true), // allow network inside the sandbox (installs/fetches need it)
  shellTimeoutMs: z.number().int().positive().default(60_000),
  shellEnvAllowlist: z
    .array(z.string())
    .default(['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'SHELL']),
  denylistExtra: z.array(z.string()).default([]),

  budget: z
    .object({
      maxTotalTokens: z.number().int().positive().optional(),
      maxCostUSD: z.number().positive().optional(),
      maxWallClockSec: z.number().positive().optional(),
    })
    .default({}),

  priceTable: z.record(z.string(), ModelPriceSchema).default({
    'claude-opus-4-8': { input: 5, output: 25, cacheReadMult: 0.1, cacheWriteMult: 1.25 },
    'claude-sonnet-4-6': { input: 3, output: 15, cacheReadMult: 0.1, cacheWriteMult: 1.25 },
    'claude-haiku-4-5': { input: 1, output: 5, cacheReadMult: 0.1, cacheWriteMult: 1.25 },
    // Common cloud non-Claude models (approximate $/1M; prices drift — override in config).
    'gpt-5': { input: 1.25, output: 10, cacheReadMult: 0.1 },
    'gpt-5.1': { input: 1.25, output: 10, cacheReadMult: 0.1 },
    'o3': { input: 2, output: 8, cacheReadMult: 0.25 },
    'o4-mini': { input: 1.1, output: 4.4, cacheReadMult: 0.25 },
    'grok-4': { input: 3, output: 15 },
    'gemini-flash-latest': { input: 0.3, output: 2.5 },
  }),

  logLevel: z.enum(['silent', 'error', 'info', 'debug']).default('info'),
});

export type ShadowConfig = z.infer<typeof ConfigSchema> & {
  /** Top-level keys the user explicitly wrote (any source) — recorded by loadConfig BEFORE zod
   *  defaults erase the distinction. Family profiles defer to explicit settings (familyProfiles.ts). */
  explicitKeys?: string[];
};
export type ModelEntry = z.infer<typeof ModelEntrySchema>;

const CONFIG_FILE = 'shadow.config.json';

/**
 * Fields a project-local `shadow.config.json` must NOT be able to set. The project
 * file is UNTRUSTED — you may run shadow inside a cloned repo — so it cannot redirect
 * your API key to another host (`baseUrl`), re-add secrets to the shell env
 * (`shellEnvAllowlist`), silently grant autonomy, weaken the catastrophic-command
 * guard (`denylistExtra`), swap in an attacker-controlled system prompt
 * (`systemPromptPath`), or widen the filesystem jail (`additionalDirectories`).
 *
 * Critically, it also cannot run arbitrary shell at startup before any LLM call:
 * `hooks` (e.g. session_start → spawnSync shell:true), `mcpServers` (`.command` →
 * spawn), `statusLine` (shell command on TUI mount), and a model preset's
 * `gguf`/`ggufServer`/`ggufArgs` (ensureGgufServer → spawn) are all zero-interaction
 * drive-by-RCE vectors, so they are stripped too (preset fields below).
 * These come only from ~/.shadow (global), env, or CLI flags.
 */
const PROJECT_UNTRUSTED_KEYS = ['baseUrl', 'shellEnvAllowlist', 'autonomy', 'denylistExtra', 'systemPromptPath', 'sandbox', 'sandboxNetwork', 'additionalDirectories', 'hooks', 'statusLine', 'comfy', 'vision'];

/** Layered precedence: CLI flags > env > project config file (de-fanged) > global > defaults. */
export function loadConfig(cwd: string, cliOverrides: Record<string, unknown> = {}): ShadowConfig {
  let fromFile: Record<string, unknown> = {};
  const path = resolve(cwd, CONFIG_FILE);
  if (existsSync(path)) {
    try {
      fromFile = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`failed to parse ${CONFIG_FILE}: ${(err as Error).message}`);
    }
  }
  // Strip security-critical keys from the untrusted project file (see above).
  const dropped = PROJECT_UNTRUSTED_KEYS.filter((k) => k in fromFile);
  for (const k of dropped) delete fromFile[k];
  if (dropped.length > 0) {
    process.stderr.write(
      `shadow: ignored untrusted ${CONFIG_FILE} key(s): ${dropped.join(', ')} — ` +
        `set these in ~/.shadow, env, or CLI flags instead.\n`,
    );
  }

  // mcpServers from an untrusted project file are dropped ENTIRELY. A `.command` entry spawns a process
  // at startup (RCE); a `.url` entry auto-connects an outbound HTTP MCP server at startup (unapproved
  // egress + SSRF, since the HTTP MCP path is not netguarded, and its tools auto-approve on the server's
  // self-declared readOnlyHint). Neither is safe to take from a cloned repo — configure MCP servers in
  // ~/.shadow (global), env, or `shadow mcp enable`.
  if (fromFile.mcpServers && typeof fromFile.mcpServers === 'object') {
    const names = Object.keys(fromFile.mcpServers as object);
    if (names.length > 0) {
      process.stderr.write(
        `shadow: ignored untrusted ${CONFIG_FILE} mcpServers (${names.join(', ')}) — ` +
          `declare MCP servers in ~/.shadow or via 'shadow mcp enable', not a project file.\n`,
      );
    }
    delete fromFile.mcpServers;
  }

  // Project-declared model presets are UNTRUSTED for every field that can (a) redirect your key/traffic
  // or (b) run arbitrary shell at STARTUP. `baseUrl`/`apiKey`/`authToken` could point your provider +
  // credential at an attacker host (bypassing the top-level `baseUrl` strip above). Critically, a
  // `gguf`/`ggufServer`/`ggufArgs`/`ggufPort` preset is `spawn()`'d by ensureGgufServer BEFORE any LLM
  // call — so a merely-cloned repo with a crafted preset would get ZERO-INTERACTION RCE. Drop all of
  // these from every project-file preset; only the benign label/model/group survive, so a repo can still
  // SUGGEST a model without hijacking your credentials or executing code.
  // `credRef` is in this list for the same reason as `apiKey`: a project file that could name a
  // vault slot would let a cloned repo aim YOUR sealed credential at ITS `baseUrl`. The pointer is
  // not secret, but the ability to choose which secret gets sent is exactly the capability we deny.
  const PRESET_UNTRUSTED_FIELDS = ['baseUrl', 'apiKey', 'authToken', 'credRef', 'gguf', 'ggufServer', 'ggufArgs', 'ggufPort', 'mlx', 'vllm', 'vllmArgs', 'vllmImage'];
  if (Array.isArray(fromFile.models)) {
    let redacted = 0;
    for (const m of fromFile.models as Array<Record<string, unknown>>) {
      if (m && typeof m === 'object') {
        let hit = false;
        for (const k of PRESET_UNTRUSTED_FIELDS) {
          if (k in m) {
            delete m[k];
            hit = true;
          }
        }
        if (hit) redacted++;
      }
    }
    if (redacted > 0) {
      process.stderr.write(
        `shadow: stripped credential/exec fields (${PRESET_UNTRUSTED_FIELDS.join('/')}) from ${redacted} untrusted ${CONFIG_FILE} model preset(s) — ` +
          `a project file cannot redirect your key or run shell.\n`,
      );
    }
  }

  // Global config (~/.shadow/config.json) is the user's OWN file — the same trust level as env/CLI on a
  // single-user machine. It is 0700 and is exactly where onboarding, `shadow mcp enable`, `/statusline`,
  // and the effort/autonomy prefs persist. We deliberately do NOT strip command-bearing MCP servers,
  // hooks, statusLine, baseUrl, autonomy, etc. from it: stripping silently disabled the user's OWN
  // configured features (e.g. an enabled stdio MCP server never ran) while providing no real protection —
  // an attacker who can write ~/.shadow already owns the account, and the per-model `models[]` presets
  // carry baseUrl+apiKey unstripped regardless. ONLY the project file above is untrusted.
  const fromGlobal = loadGlobalConfig();

  const fromEnv = readEnvOverrides();
  // Precedence (low → high): defaults < ~/.shadow/config.json (onboarding) < project
  // shadow.config.json < env < CLI flags.
  const merged = deepMerge(
    deepMerge(deepMerge(fromGlobal, fromFile), fromEnv),
    prune(cliOverrides),
  );

  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    const msg = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`invalid configuration:\n${msg}`);
  }
  const cfg = result.data;
  // Record which keys the user ACTUALLY wrote — from TRUSTED sources only (global file, env,
  // CLI), before zod's .default() erased the distinction. Family profiles use this for
  // precedence: an explicit setting beats a profile default (config/familyProfiles.ts).
  // The UNTRUSTED project file is deliberately excluded: a cloned repo must not be able to
  // mark a safety-relevant default (e.g. parallelTools) as "explicit" and thereby out-rank a
  // family profile. Its VALUES still apply per normal precedence; it just can't claim intent.
  (cfg as ShadowConfig).explicitKeys = Object.keys(
    deepMerge(deepMerge(fromGlobal, fromEnv), prune(cliOverrides)),
  );
  // Safety backstop: `maxIterations: 0` ("unlimited") is only safe while SOME budget cap exists. If the
  // user opted into 0 with no token/cost/wall-clock limit, a model looping on slightly-varying tool args
  // (dodging the consecutive-identical loop guard) would run forever on paid requests. Inject a wall-clock
  // ceiling so "unlimited iterations" can never silently mean "no backstop at all".
  if (
    cfg.maxIterations === 0 &&
    cfg.budget.maxTotalTokens == null &&
    cfg.budget.maxCostUSD == null &&
    cfg.budget.maxWallClockSec == null
  ) {
    cfg.budget.maxWallClockSec = 6 * 60 * 60; // 6h default ceiling
    process.stderr.write(
      'shadow: maxIterations:0 with no budget backstop — applied a 6h wall-clock ceiling ' +
        '(set budget.maxWallClockSec / maxCostUSD / maxTotalTokens to override).\n',
    );
  }
  return cfg;
}

/**
 * Persist permission rules to the effective config layer: project `shadow.config.json`
 * when present (it overrides global on reload), otherwise `~/.shadow/config.json`.
 */
export function persistPermissionRules(cwd: string, rules: PermissionRule[]): void {
  const path = resolve(cwd, CONFIG_FILE);
  if (existsSync(path)) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`failed to parse ${CONFIG_FILE}: ${(err as Error).message}`);
    }
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...raw, permissionRules: rules }, null, 2) + '\n', 'utf8');
    renameSync(tmp, path);
  } else {
    saveGlobalConfig({ permissionRules: rules });
  }
}

function readEnvOverrides(): Record<string, unknown> {
  const e = process.env;
  const out: Record<string, unknown> = {};
  if (e.SHADOW_PROVIDER) out.provider = e.SHADOW_PROVIDER;
  if (e.SHADOW_MODEL) out.model = e.SHADOW_MODEL;
  if (e.SHADOW_EFFORT) out.effort = e.SHADOW_EFFORT;
  if (e.SHADOW_FAST) out.fastMode = e.SHADOW_FAST === '1' || e.SHADOW_FAST === 'true';
  if (e.SHADOW_CACHE_TTL) out.cacheTtl = e.SHADOW_CACHE_TTL;
  if (e.SHADOW_BASE_URL) out.baseUrl = e.SHADOW_BASE_URL;
  if (e.SHADOW_AUTONOMY) out.autonomy = e.SHADOW_AUTONOMY;
  if (e.SHADOW_LOG_LEVEL) out.logLevel = e.SHADOW_LOG_LEVEL;
  return out;
}

export interface ResolveKeyOpts {
  model?: string;
  allowImport?: boolean;
  /**
   * An explicit vault slot (a preset's `credRef`). When set, the lookup is vault-ONLY: no env
   * fallback, no adapter-slot fallback. See `resolveEntryCredential` for why.
   */
  slot?: string;
}

/** API key: env first, then store; with allowImport, subscription/OAuth import may supply a bearer. */
export function resolveApiKey(provider: string, opts: ResolveKeyOpts = {}): string | undefined {
  // Slot lookups never fall back. Every custom preset (z.ai, Gemini, Together, local vLLM) shares
  // the single 'openai' adapter, so a fallback here would hand OPENAI_API_KEY to whatever host the
  // preset's baseUrl names — disclosing the key to a third party. A miss must stay a miss.
  if (opts.slot) return getCredential(opts.slot)?.apiKey;
  const envKey =
    provider === 'anthropic'
      ? process.env.ANTHROPIC_API_KEY || getCredential('anthropic')?.apiKey
      : provider === 'openai'
        ? process.env.OPENAI_API_KEY || getCredential('openai')?.apiKey
        : undefined;

  const allowImport = opts.allowImport ?? process.env.SHADOW_ALLOW_IMPORT === '1';
  if (allowImport && provider !== 'mock') {
    const sub = subProviderFor(provider, opts.model ?? '');
    const auth = resolveSubscriptionAuth({
      provider,
      subProvider: sub,
      envBearer: envKey ?? resolveAuthToken(provider),
      allowImport: true,
      nowSec: Math.floor(Date.now() / 1000),
    });
    if (auth?.bearer) return auth.bearer;
  }
  return envKey;
}

/** Bearer token: env (ANTHROPIC_AUTH_TOKEN), then the credentials store. */
export function resolveAuthToken(provider: string, slot?: string): string | undefined {
  if (slot) return getCredential(slot)?.authToken; // vault-only, same no-fallback rule as above
  if (provider === 'anthropic') {
    return process.env.ANTHROPIC_AUTH_TOKEN || getCredential('anthropic')?.authToken;
  }
  return undefined;
}

/** Where a resolved model credential came from — useful for `/provider` and doctor output. */
export type CredSource = 'credRef' | 'inline' | 'provider';

export type EntryCredential =
  | { ok: true; apiKey?: string; authToken?: string; source: CredSource }
  | { ok: false; reason: 'locked' | 'missing'; slot: string };

/**
 * Resolve the credential for one model preset. This is the single place the precedence lives,
 * replacing four copies of `entry?.apiKey ?? resolveApiKey(...)`.
 *
 * Order:
 *  1. `credRef` → the vault slot, and NOTHING else. If the vault is locked or the slot is empty
 *     this FAILS rather than falling through — a fall-through would send the generic adapter key
 *     (or `OPENAI_API_KEY`) to the preset's own `baseUrl`, i.e. disclose your OpenAI key to
 *     api.z.ai or a LAN box. A visible failure is strictly better than a silent leak.
 *  2. Inline `apiKey`/`authToken` on the entry — the legacy, pre-migration path. Still honoured
 *     so an unmigrated config keeps working.
 *  3. The provider-level resolution (env, then adapter slot) for presets that carry no key.
 */
export function resolveEntryCredential(
  entry: { provider?: string; apiKey?: string; authToken?: string; credRef?: string } | undefined,
  opts: { vaultIsLocked?: boolean } = {},
): EntryCredential {
  const provider = entry?.provider ?? 'openai';
  if (entry?.credRef) {
    const slot = entry.credRef;
    const apiKey = resolveApiKey(provider, { slot });
    const authToken = resolveAuthToken(provider, slot);
    if (apiKey || authToken) return { ok: true, apiKey, authToken, source: 'credRef' };
    return { ok: false, reason: opts.vaultIsLocked ? 'locked' : 'missing', slot };
  }
  if (entry?.apiKey || entry?.authToken) {
    return { ok: true, apiKey: entry.apiKey, authToken: entry.authToken, source: 'inline' };
  }
  return {
    ok: true,
    apiKey: resolveApiKey(provider),
    authToken: resolveAuthToken(provider),
    source: 'provider',
  };
}

/** Base URL precedence: explicit (flag/config/global) > env > credentials store. */
export function resolveBaseUrl(provider: string, configured?: string): string | undefined {
  // Normalize so a poisoned value (e.g. bracket-wrapped from the onboarding hint) is
  // ignored rather than returned first and breaking every request.
  const clean = normalizeBaseUrl(configured);
  if (clean) return clean;
  if (provider === 'anthropic')
    return normalizeBaseUrl(process.env.ANTHROPIC_BASE_URL) ?? normalizeBaseUrl(getCredential('anthropic')?.baseUrl);
  if (provider === 'openai')
    return normalizeBaseUrl(process.env.OPENAI_BASE_URL) ?? normalizeBaseUrl(getCredential('openai')?.baseUrl);
  return undefined;
}

function prune(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

function deepMerge(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      out[k] &&
      typeof out[k] === 'object' &&
      !Array.isArray(out[k])
    ) {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}
