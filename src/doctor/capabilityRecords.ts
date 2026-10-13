import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AccountConnection, ModelCapabilities } from '../config.js';
import { createProvider, type ProviderName, type ProviderOptions } from '../provider/index.js';
import { isLocalBaseUrl } from '../safety/offline.js';
import { redactString, registerSecret } from '../util/redact.js';
import { withDeadline } from '../onboard/deadline.js';
import { runModelCheck, type ModelCheckResult } from './modelCheck.js';

/** Pass the resolved endpoint and profile actually used for the test, never a preset label. */
export interface CapabilityTarget {
  provider: ProviderName;
  model: string;
  baseUrl?: string;
  connection?: AccountConnection;
  wire?: 'chat' | 'responses';
  selfHosted?: boolean;
  capabilities?: ModelCapabilities;
  reasoningRoundtrip?: 'last' | 'none';
  profile?: string;
}

export interface CapabilityRecord {
  version: 1;
  identity: string;
  checkedAt: string;
  result: ModelCheckResult;
  /** Tool-format success is not proof of these separate transport capabilities. */
  compatibility: { streaming: 'not_assessed'; cancellation: 'not_assessed'; structuredOutput: 'not_assessed' };
}

export interface CapabilityRecordOptions { directory?: string; now?: number }

/** Capture beside createProvider so cache identity never guesses from stale display config. */
export function capabilityTargetFromProviderOptions(options: ProviderOptions, profile?: string): Readonly<CapabilityTarget> {
  const connection: AccountConnection | undefined = options.connection?.kind === 'chatgpt'
    ? { kind: 'chatgpt', profileId: options.connection.profileId }
    : options.connection?.kind === 'claude-code' ? { kind: 'claude-code' } : undefined;
  const cap = options.capabilities;
  const capabilities = cap ? { reasoning: cap.reasoning, reasoningField: cap.reasoningField, effortScale: cap.effortScale?.slice(),
    maxOutputTokens: cap.maxOutputTokens, vision: cap.vision, preserveThinking: cap.preserveThinking,
    chatTemplateEnableThinking: cap.chatTemplateEnableThinking } : undefined;
  const baseUrl = connection?.kind === 'claude-code' ? undefined : connection?.kind === 'chatgpt'
    ? 'https://api.openai.com/v1' : options.baseUrl ?? (options.provider === 'openai' ? 'https://api.openai.com/v1'
      : options.provider === 'anthropic' ? 'https://api.anthropic.com' : undefined);
  const wire = connection?.kind === 'chatgpt' ? 'responses' : connection?.kind === 'claude-code' ? undefined
    : options.provider === 'openai' ? options.wire ?? (process.env.SHADOW_WIRE_API === 'responses' ? 'responses' : 'chat') : undefined;
  return Object.freeze({ provider: options.provider, model: options.model, baseUrl, connection, wire,
    selfHosted: !connection && (options.selfHosted === true || isLocalBaseUrl(baseUrl)),
    capabilities,
    reasoningRoundtrip: options.reasoningRoundtrip ?? 'last', profile });
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}

export function capabilityIdentity(target: CapabilityTarget): string {
  let endpoint = target.baseUrl ?? (target.provider === 'openai' ? 'https://api.openai.com/v1' : target.provider === 'anthropic' ? 'https://api.anthropic.com' : 'mock');
  if (endpoint !== 'mock') {
    const url = new URL(endpoint);
    // Never fingerprint credentials embedded in URLs. The endpoint can still be used; only
    // its optional cached capability record is unavailable until secrets are moved to headers.
    if (url.username || url.password || url.search || url.hash) throw new Error('Capability history is unavailable for URLs containing credentials, queries, or fragments. The endpoint remains usable.');
    endpoint = url.href.replace(/\/+$/, '');
  }
  const cap = target.capabilities;
  const contract = cap ? { reasoning: cap.reasoning, reasoningField: cap.reasoningField, effortScale: cap.effortScale,
    maxOutputTokens: cap.maxOutputTokens, vision: cap.vision, preserveThinking: cap.preserveThinking,
    chatTemplateEnableThinking: cap.chatTemplateEnableThinking } : undefined;
  const connection = target.connection?.kind === 'chatgpt' ? { kind: 'chatgpt', profileId: target.connection.profileId }
    : target.connection?.kind === 'claude-code' ? { kind: 'claude-code' } : undefined;
  const identity = { provider: target.provider, model: target.model, endpoint, connection,
    wire: target.wire ?? (target.provider === 'openai' ? process.env.SHADOW_WIRE_API === 'responses' ? 'responses' : 'chat' : undefined),
    selfHosted: target.selfHosted ?? false, capabilities: contract, reasoningRoundtrip: target.reasoningRoundtrip ?? 'last', profile: target.profile };
  return createHash('sha256').update(JSON.stringify(stable(identity))).digest('hex');
}

function directory(options: CapabilityRecordOptions): string { return options.directory ?? join(homedir(), '.shadow', 'capabilities'); }

export function saveCapabilityRecord(target: CapabilityTarget, result: ModelCheckResult, options: CapabilityRecordOptions = {}): CapabilityRecord {
  if (result.model !== target.model) throw new Error('Capability result belongs to a different model');
  const identity = capabilityIdentity(target);
  const record: CapabilityRecord = { version: 1, identity, checkedAt: new Date(options.now ?? Date.now()).toISOString(),
    result: { ...result, model: redactString(result.model), providerName: redactString(result.providerName),
      recommendation: redactString(result.recommendation).slice(0, 2000),
      probes: result.probes.map((probe) => ({ ...probe, detail: redactString(probe.detail).slice(0, 2000) })) },
    compatibility: { streaming: 'not_assessed', cancellation: 'not_assessed', structuredOutput: 'not_assessed' } };
  const dir = directory(options); mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
  const path = join(dir, `${identity}.json`); const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' }); renameSync(temp, path); }
  finally { try { unlinkSync(temp); } catch { /* rename already consumed this private temporary file */ } }
  return record;
}

export function readCapabilityRecord(target: CapabilityTarget, options: CapabilityRecordOptions = {}): CapabilityRecord | undefined {
  try {
    const identity = capabilityIdentity(target); const path = join(directory(options), `${identity}.json`);
    if (statSync(path).size > 128 * 1024) return undefined;
    const record = JSON.parse(readFileSync(path, 'utf8')) as CapabilityRecord;
    if (record.version !== 1 || record.identity !== identity || !Number.isFinite(Date.parse(record.checkedAt))
        || !record.result || !['agentic', 'limited', 'chat-only'].includes(record.result.verdict)
        || record.result.model !== redactString(target.model)
        || !Array.isArray(record.result.probes) || record.result.probes.length !== 5
        || record.result.probes.some((probe) => !['pass', 'fail'].includes(probe.status) || typeof probe.detail !== 'string')) return undefined;
    return record;
  } catch { return undefined; }
}

/** Explicit post-save opt-in only. At most seven model turns and two minutes total. */
export async function runOnboardCapabilityCheck(options: ProviderOptions, signal: AbortSignal): Promise<ModelCheckResult> {
  registerSecret(options.apiKey); registerSecret(options.authToken);
  return withDeadline((boundedSignal) => runModelCheck(createProvider({ ...options, streamRetries: 0 }), {
    model: options.model, providerName: options.provider, isLocal: options.selfHosted || isLocalBaseUrl(options.baseUrl),
    perTurnTimeoutMs: 15_000, maxOutputTokens: 1024, maxAutonomousTurns: 3, signal: boundedSignal,
  }), 120_000, signal);
}
