// src/app/modelSwitch.ts — mid-session model switching, ported VERBATIM from the Ink shell's
// buildProvider/selectModel (src/tui.tsx @ 8.7). The plan's instruction for this module is:
// port the logic, do not re-derive it. Every credential, endpoint-binding, auto-endpoint,
// offline and policy-clamp branch below exists because a switch is a provider-boundary event —
// a dropped branch sends the new key to the old endpoint or clamps to the wrong window.
//
// Decoupled from React: the Ink version lived in useCallbacks over refs; here the same state
// lives on ShadowApp and is passed in as one facade.

import {
  configuredContextWindow,
  detectServerContextWindow,
  ensureLocalServer,
  isLocalServedEntry,
  mlxOfflineReady,
} from '../gguf.js';
import { createProvider, entryStreamContract, type ProviderName } from '../provider/index.js';
import { subProviderFor } from '../auth/spec.js';
import { ensureFreshSubscriptionCredential } from '../auth/refresh.js';
import { resolveAutoModel } from '../local/autoEndpoint.js';
import { vaultExists } from '../auth/vault.js';
import { saveGlobalConfig, vaultUnlocked } from '../state/globalStore.js';
import {
  resolveBaseUrl,
  resolveEntryCredential,
  resolveProviderCredential,
  type ModelEntry,
  type ShadowConfig,
} from '../config.js';
import { clampLocalContextBudget, keepLastTurnsForBudget, triggerRatioForBudget } from '../util/contextBudget.js';
import { isLocalBaseUrl, isLocalModelTarget } from '../safety/offline.js';
import { familyProfile } from '../config/familyProfiles.js';
import { assertAccountPresetCompatible } from '../config/modelPresets.js';
import type { Context } from '../agent/context.js';
import type { Provider } from '../provider/provider.js';
import type { AgentLoop } from '../agent/loop.js';
import { C } from '../tui/theme.js';

export interface BuiltProvider {
  ok: true;
  client: Provider;
  provider: ProviderName;
  /** The model id for the WIRE (an `autoModel` entry re-reads it from its endpoint). */
  model: string;
  /** The entry's identity — what `cfg.model` and every entry lookup are keyed on. */
  entryModel: string;
  baseUrl?: string;
  selfHosted: boolean;
}
export type BuildResult = BuiltProvider | { ok: false; error: string; fatal?: boolean };

/** The shell state a switch reads and mutates. `provider`, `current` and `loop` are ACCESSORS —
 *  a switch must mutate the same live state the turn loop and HUD read, never a stale copy. */
export interface SwitchHost {
  cfg: ShadowConfig;
  context: Context;
  offline?: boolean;
  baseContextPolicy: { contextBudget: number; triggerRatio: number; keepLastTurns: number };
  get provider(): Provider;
  set provider(p: Provider);
  get current(): { provider: string; model: string };
  set current(c: { provider: string; model: string });
  get loop(): AgentLoop | null;
  /** Transcript output (dim/yellow/red handled by the caller's pushLine). */
  pushLine(p: { text: string; color?: string; dimColor?: boolean }): void;
  /** True while a turn is executing — a model switch must not run underneath it. */
  isRunning(): boolean;
  onModelSwitch?(provider: Provider, model: string): void;
  /** Keep renderer status/provider surfaces on the effective runtime endpoint after a switch. */
  onTargetChange?(target: { baseUrl?: string; selfHosted: boolean }): void;
}

export type BuildOpts = { clampBudget?: boolean; applyPolicy?: () => boolean };

export class ModelSwitcher {
  /** Monotonic switch sequence — a superseded switch must not partially apply (the generation
   *  guard; see selectModel). */
  private seq = 0;
  private switching = false;

  constructor(private host: SwitchHost) {}

  get isSwitching(): boolean {
    return this.switching;
  }

  async buildProvider(entry: ModelEntry, opts: BuildOpts = {}): Promise<BuildResult> {
    try { assertAccountPresetCompatible(entry); }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'The subscription preset is invalid.', fatal: false }; }
    const { host } = this;
    const pushLine = host.pushLine.bind(host);
    let provider = entry.provider;
    const configuredBaseUrl = resolveBaseUrl(entry.provider, entry.baseUrl, entry.connection);
    let baseUrl = configuredBaseUrl;
    let detectedWindow: number | undefined;
    const cred = resolveEntryCredential(entry, { vaultIsLocked: vaultExists() && !vaultUnlocked() });
    if (!cred.ok) {
      // Soft failure: the session survives on the current model rather than dying. Falling
      // through to the adapter key here would send it to this preset's baseUrl.
      return {
        ok: false,
        error: `"${entry.label}" needs the vault slot "${cred.slot}", which is ${
          cred.reason === 'locked' ? 'locked — unlock the vault to use it.' : 'empty — re-add its key.'
        }`,
        fatal: false,
      };
    }
    // Same endpoint binding as boot: a /model switch onto a model with an imported subscription
    // credential must carry that credential's base URL, headers and wire, or it would send the
    // token to the previous model's endpoint. The refresh runs first for the same reason it does
    // at boot — a switch is a natural moment to notice the token aged out.
    const allowImport = !entry.connection && process.env.SHADOW_ALLOW_IMPORT === '1';
    if (allowImport) {
      const subForEntry = subProviderFor(entry.provider, entry.model);
      if (subForEntry) {
        const refreshed = await ensureFreshSubscriptionCredential(subForEntry, {
          nowSec: Math.floor(Date.now() / 1000),
          allowNetwork: !host.offline,
        });
        if (refreshed.error) pushLine({ text: `  ⚠ subscription token: ${refreshed.error}`, color: C.yellow });
      }
    }
    const entryCred =
      cred.source === 'provider'
        ? resolveProviderCredential(entry.provider, { model: entry.model, allowImport, configuredBaseUrl })
        : { bearer: cred.apiKey, source: 'store' as const };
    if (entryCred.conflict) pushLine({ text: `  ⚠ ${entryCred.conflict}`, color: C.yellow });
    if (entryCred.baseUrl) baseUrl = entryCred.baseUrl;
    // `let` on purpose: a local-served entry rewrites it below (`entry.apiKey ?? 'sk-local'`).
    let apiKey = entryCred.bearer;
    // Auto endpoint: ask the box what it is serving right now and use that id on the wire, so a
    // restarted server with a new model needs no config edit. The probe also corrects a base URL
    // written without `/v1`. Never fatal — an unreachable box keeps the declared id.
    const auto = await resolveAutoModel(entry);
    if (auto.baseUrl) baseUrl = auto.baseUrl;
    if (auto.contextWindow) detectedWindow = auto.contextWindow;
    if (auto.error && entry.autoModel) pushLine({ text: `  ⚠ ${auto.error}`, color: C.yellow });
    else if (auto.detected && auto.model !== entry.model) {
      pushLine({ text: `  ${entry.label} serves ${auto.model}`, dimColor: true });
    }
    const wireModel = auto.model ?? entry.model;
    const mlxReadyOffline = entry.mlx ? mlxOfflineReady(entry.mlx) : false;
    if (host.offline && !isLocalModelTarget({ gguf: entry.gguf, mlx: mlxReadyOffline ? entry.mlx : undefined, vllm: entry.vllm, baseUrl })) {
      // A soft refusal (yellow), with the actionable local-model hint preserved verbatim.
      return { ok: false, error: `Offline mode: "${entry.label}" is a cloud endpoint — switch refused. Local models only (see /local list, then /local use <name>).` };
    }
    if (isLocalServedEntry(entry)) {
      try {
        const r = await ensureLocalServer(entry, (m) => pushLine({ text: m, dimColor: true }), { offline: host.offline });
        provider = 'openai';
        baseUrl = r.baseUrl;
        apiKey = entry.apiKey ?? 'sk-local';
        detectedWindow = await detectServerContextWindow(r.baseUrl);
      } catch (e) {
        // A hard failure (red) — the local server couldn't start, so nothing can route here.
        return { ok: false, error: `Local model failed: ${(e as Error).message}`, fatal: true };
      }
    }
    // Derive a complete policy for THIS provider/model. Query local servers after startup;
    // explicit contextWindow metadata covers cloud/custom presets. Resetting actual tokens is
    // essential because the old provider's usage is not a valid floor for the new request.
    if (opts.clampBudget !== false && (opts.applyPolicy?.() ?? true)) {
      const localish = isLocalBaseUrl(baseUrl);
      if (localish && baseUrl && !detectedWindow) detectedWindow = await detectServerContextWindow(baseUrl);
      // The local context-window probe is asynchronous. Recheck before touching shared config or
      // Context so a superseded fallback cannot partially switch policy after steering aborted it.
      if (opts.applyPolicy?.() ?? true) {
        const hardWindow = detectedWindow ?? configuredContextWindow(entry);
        const base = host.baseContextPolicy;
        const nextBudget = hardWindow
          ? clampLocalContextBudget(base.contextBudget, hardWindow)
          : base.contextBudget;
        const nextPolicy = {
          contextBudget: nextBudget,
          triggerRatio: triggerRatioForBudget(nextBudget, base.triggerRatio),
          keepLastTurns: keepLastTurnsForBudget(nextBudget, base.keepLastTurns),
        };
        const previous = host.context.policy();
        host.cfg.contextBudget = nextPolicy.contextBudget;
        host.cfg.summarizeTriggerRatio = nextPolicy.triggerRatio;
        host.cfg.keepLastTurns = nextPolicy.keepLastTurns;
        host.context.setPolicy(nextPolicy, true);
        if (
          previous.contextBudget !== nextPolicy.contextBudget ||
          previous.triggerRatio !== nextPolicy.triggerRatio ||
          previous.keepLastTurns !== nextPolicy.keepLastTurns
        ) {
          const source = hardWindow ? ` for ${hardWindow.toLocaleString()} server/model window` : '';
          pushLine({ text: `  context policy → ${nextBudget.toLocaleString()} tokens${source}`, dimColor: true });
        }
      }
    }
    const client = createProvider({
      // F10-01: a live /model switch or in-TUI fallback must carry the entry's P1A-04 stream
      // knobs + P1A-06 capability block exactly like bootstrap does — omitting them silently
      // reverted the idle watchdog to 120s and dropped the self-hosted contract mid-session.
      ...entryStreamContract(entry, host.cfg.stream),
      provider,
      model: wireModel,
      apiKey,
      authToken: cred.authToken,
      baseUrl,
      // A local launcher rewrote baseUrl; otherwise the credential's endpoint contract travels with it.
      extraHeaders: isLocalServedEntry(entry) ? undefined : entryCred.extraHeaders,
      wire: isLocalServedEntry(entry) ? undefined : entryCred.wire,
      selfHosted:
        provider === 'openai'
          ? entry.selfHosted === true ||
            isLocalModelTarget({ gguf: entry.gguf, mlx: entry.mlx, vllm: entry.vllm, baseUrl })
          : undefined,
      reasoningRoundtrip: host.cfg.reasoningRoundtrip,
    });
    const selfHosted =
      provider === 'openai' &&
      (entry.selfHosted === true ||
        isLocalModelTarget({ gguf: entry.gguf, mlx: entry.mlx, vllm: entry.vllm, baseUrl }));
    return {
      ok: true,
      client,
      provider,
      model: wireModel,
      entryModel: entry.model,
      baseUrl,
      selfHosted,
    };
  }

  /**
   * Switch the live session onto `entry`. Rejected while a turn runs; generation-guarded so a
   * superseded switch (two rapid selections) cannot partially apply.
   */
  async selectModel(entry: ModelEntry): Promise<boolean> {
    const { host } = this;
    // Mid-turn refusal (Ink parity): a picker can be open when a queued wakeup starts a turn,
    // and switching the provider under a RUNNING loop swaps its transport and policy mid-flight.
    if (host.isRunning()) {
      host.pushLine({ text: 'Wait for the current turn to finish before switching models.', color: C.yellow });
      return false;
    }
    if (this.switching) {
      host.pushLine({ text: 'A model switch is already in flight — one moment.', color: C.yellow });
      return false;
    }
    const generation = ++this.seq;
    this.switching = true;
    // Context budget must track the ACTIVE model's window across mid-session switches: a session
    // started on a 128k cloud model that switches to a 32k llama-server would otherwise compact
    // at ~109k — long past the server window — and die on a 400. Switching back to a cloud model
    // restores the session's original budget. (Mirrors the startup clamp in index.ts.)
    try {
      const built = await this.buildProvider(entry, { applyPolicy: () => generation === this.seq });
      if (generation !== this.seq) return false;
      if (!built.ok) {
        host.pushLine({ text: built.error, color: built.fatal ? C.red : C.yellow });
        return false;
      }
      host.provider = built.client;
      host.current = { provider: built.provider, model: built.model };
      host.onTargetChange?.({ baseUrl: built.baseUrl, selfHosted: built.selfHosted });
      host.loop?.setProvider(built.client, built.model);
      host.onModelSwitch?.(built.client, built.model); // keep the agent tool's sub-agents on the live model
      try {
        saveGlobalConfig({ lastModel: entry.label });
      } catch {
        // best-effort persistence; the live switch already applies this session
      }
      // Keep the in-memory preset identity aligned with the provider that is now live. Surfaces
      // such as `/provider` use this label to select the right credential when presets share a
      // provider/model/endpoint tuple.
      host.cfg.lastModel = entry.label;
      host.cfg.connection = entry.connection;
      host.pushLine({ text: `Model → ${entry.label} (${built.provider}/${built.model})`, color: C.cyan });
      // `entryModel`, never `built.model`: an autoModel entry's identity is the preset, and that is
      // what `cfg.models.find(m => m.model === cfg.model)` and the picker's active row are keyed on.
      host.cfg.model = built.entryModel;
      const prof = familyProfile(built.model);
      if (prof?.note) host.pushLine({ text: `  ${prof.family}: ${prof.note}`, dimColor: true });
      return true;
    } finally {
      if (generation === this.seq) this.switching = false;
    }
  }
}
