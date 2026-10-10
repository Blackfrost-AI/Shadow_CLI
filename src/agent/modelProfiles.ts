import { Context } from './context.js';
import { ModelSwitcher } from '../app/modelSwitch.js';
import type { ModelEntry, ShadowConfig } from '../config.js';
import type { Effort, Provider } from '../provider/provider.js';
import { redactString } from '../util/redact.js';
import { createHash } from 'node:crypto';

export interface ModelProfileIdentity {
  profile: string;
  provider: string;
  model: string;
  baseUrl?: string;
  effort?: Effort;
  /** Versioned public configuration identity, excluding auth material. */
  fingerprint?: string;
}

export interface ResolvedModelProfile extends ModelProfileIdentity {
  client: Provider;
  policy: { contextBudget: number; triggerRatio: number; keepLastTurns: number };
  maxOutputTokens: number;
}

/** Resolve by stable preset label first, then an unambiguous provider/model or model identity. */
export function findRoleProfile(entries: ModelEntry[], reference: string): ModelEntry {
  const query = reference.trim().toLocaleLowerCase();
  const labels = entries.filter((entry) => entry.label.toLocaleLowerCase() === query);
  const matches = labels.length ? labels : entries.filter((entry) =>
    `${entry.provider}/${entry.model}`.toLocaleLowerCase() === query || entry.model.toLocaleLowerCase() === query);
  if (!matches.length) throw new Error(`No configured model profile "${reference}". Choose a preset from /model.`);
  if (matches.length > 1) throw new Error(`Model profile "${reference}" is ambiguous. Use its unique preset label.`);
  if (matches[0]!.disabled) throw new Error(`Model profile "${matches[0]!.label}" is disabled.`);
  return matches[0]!;
}

export class ModelProfileResolver {
  constructor(private options: {
    cfg: ShadowConfig;
    current: () => { provider: Provider; model: string };
    offline?: boolean;
    baseContextPolicy?: { contextBudget: number; triggerRatio: number; keepLastTurns: number };
    notice?: (message: string) => void;
  }) {}

  list(): ModelProfileIdentity[] {
    return this.options.cfg.models.filter((entry) => !entry.disabled).map((entry) => ({
      profile: entry.label, provider: entry.provider, model: entry.model,
      ...(entry.baseUrl ? { baseUrl: redactString(entry.baseUrl) } : {}),
    }));
  }

  currentSelection(): string | undefined {
    const current = this.options.current();
    const entries = this.options.cfg.models.filter((entry) => !entry.disabled);
    const named = entries.find((entry) => entry.label === this.options.cfg.lastModel && entry.provider === current.provider.name);
    if (named) return named.label;
    const matches = entries.filter((entry) => entry.model === current.model && entry.provider === current.provider.name);
    return matches.length === 1 ? matches[0]!.label : undefined;
  }

  async resolve(reference: string, options: { effort?: Effort; signal?: AbortSignal } = {}): Promise<ResolvedModelProfile> {
    options.signal?.throwIfAborted();
    const entry = findRoleProfile(this.options.cfg.models, reference);
    const source = this.options.cfg;
    const effort = options.effort ?? source.effort;
    const scale = entry.capabilities?.effortScale;
    if (effort && scale?.length && !scale.includes(effort)) {
      throw new Error(`Profile "${entry.label}" supports effort ${scale.join(', ')}; requested ${effort}.`);
    }
    // buildProvider has the credential/endpoint binding, subscription, capability and local
    // server contracts. Give it isolated mutable policy so resolving a role cannot switch the lead.
    const cfg = { ...source };
    const context = new Context({ contextBudget: cfg.contextBudget, triggerRatio: cfg.summarizeTriggerRatio, keepLastTurns: cfg.keepLastTurns });
    let currentProvider = this.options.current().provider;
    let current = { provider: String(currentProvider.name), model: this.options.current().model };
    const switcher = new ModelSwitcher({
      cfg, context, offline: this.options.offline,
      baseContextPolicy: this.options.baseContextPolicy ?? context.policy(),
      get provider() { return currentProvider; }, set provider(provider) { currentProvider = provider; },
      get current() { return current; }, set current(value) { current = value; },
      get loop() { return null; },
      pushLine: (line) => this.options.notice?.(redactString(line.text)),
      isRunning: () => false,
    });
    const built = await switcher.buildProvider(entry, { applyPolicy: () => !options.signal?.aborted });
    options.signal?.throwIfAborted();
    if (!built.ok) throw new Error(built.error);
    const policy = context.policy();
    const maxOutputTokens = Math.min(cfg.maxOutputTokens, entry.capabilities?.maxOutputTokens ?? cfg.maxOutputTokens);
    let endpoint = built.baseUrl;
    if (endpoint) {
      try { const url = new URL(endpoint); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; endpoint = url.toString(); }
      catch { endpoint = '[invalid endpoint]'; }
    }
    const capabilities = entry.capabilities;
    const fingerprint = 'profile-v1:' + createHash('sha256').update(JSON.stringify({
      provider: built.provider, model: built.model, endpoint, effort,
      capabilities: capabilities ? { reasoning: capabilities.reasoning, reasoningField: capabilities.reasoningField,
        effortScale: capabilities.effortScale, maxOutputTokens: capabilities.maxOutputTokens, vision: capabilities.vision,
        preserveThinking: capabilities.preserveThinking,
        chatTemplateEnableThinking: capabilities.chatTemplateEnableThinking } : undefined,
      policy, maxOutputTokens,
      capsVersion: 1, caps: { maxIterations: cfg.maxIterations, maxTotalTokens: cfg.budget.maxTotalTokens,
        maxCostUSD: cfg.budget.maxCostUSD, maxWallClockSec: cfg.budget.maxWallClockSec },
    })).digest('hex');
    return {
      profile: entry.label, provider: built.provider, model: built.model,
      ...(built.baseUrl ? { baseUrl: redactString(built.baseUrl) } : {}),
      effort, fingerprint, client: built.client, policy, maxOutputTokens,
    };
  }
}
