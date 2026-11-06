/**
 * m13 — Opt-in bounded advisors.
 *
 * An advisor is a SECOND opinion channel: a different provider/model consulted
 * for a bounded, explicitly-named task. It is NOT a second primary model. Its
 * output is UNTRUSTED DATA — it can never approve tools, mutate files, or be
 * executed.
 *
 * Invariants, each enforced structurally in this file:
 *
 *  1. DEFAULT DISABLED — with no `advisors` block in the global config (the
 *     default), every consultation is refused before any I/O. `provider.send()`
 *     is reachable only from the attempts loop, and only after gates 1-7 pass.
 *  2. EXPLICIT SELECTION — a consultation names a configured endpoint and
 *     carries ONLY the caller-supplied context. The request type has no
 *     session-context field, so silent inheritance is unrepresentable.
 *  3. HARD BOUNDS — caps come from CONFIG ONLY (no cap fields on the request),
 *     enforced BEFORE the request (local pre-flight estimate) and DURING it
 *     (every usage event priced and checked per-axis, plus a wall-clock
 *     watchdog that aborts the stream at the deadline).
 *  4. VISIBLE EGRESS — the operator is told BEFORE any bytes leave (provider,
 *     model, purpose, context size, caps, attempt) and told the honest outcome
 *     afterwards; a veto from `announce()` stops the consultation pre-egress.
 *  5. NO MUTATION AUTHORITY — the result type has no tool/approval/execution
 *     surface (a compile-time assertion below proves it), the result object is
 *     frozen, and the provider request is built with `tools: []`.
 *  6. CANCELLATION — an abort cancels the in-flight request via the composite
 *     signal; time already spent is recorded honestly and nothing is refunded.
 */

import { Budget } from './budget.js';
import type { ModelPrice } from './budget.js';
import type { Provider } from '../provider/provider.js';
import { estimateTokensFromMessages } from '../provider/provider.js';
import type { ShadowConfig } from '../config.js';

/** Named, pre-approved endpoint (provider + model pair) from the global config. */
export interface AdvisorEndpointConfig {
  name: string;
  provider: string;
  model: string;
}

/** A consultation request. Deliberately carries NO caps and NO session context. */
export interface AdvisorConsultationRequest {
  /** Configured endpoint name (must be in the allowlist). */
  endpoint: string;
  /** Short operator-facing purpose label, e.g. 'patch-review'. */
  purpose: string;
  /** The ENTIRE context, explicitly supplied by the caller. Nothing else is sent. */
  context: string;
}

/** Exact usage accounting. No rounding, no inference. */
export interface AdvisorUsage {
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

/** Frozen outcome of a consultation. Untrusted advice + honest accounting. */
export interface AdvisorResult {
  kind: 'advice';
  outcome: 'refused' | 'capped' | 'blocked' | 'cancelled' | 'completed';
  endpoint: string;
  /** UNTRUSTED advice text — render as text only; never execute or approve with it. */
  advice?: string;
  /** Machine-checkable reason code for the outcome. */
  reason: string;
  /** Provider attempts actually made (0 when refused before any egress). */
  attempts: number;
  /** Exact final usage; zero when refused before any egress. */
  usage: AdvisorUsage;
  /** Wall-clock time spent on provider attempts (ms), honest even on abort. */
  spentWallClockMs: number;
  /** Always false — aborting or capping refunds nothing. */
  refunded: false;
}

/** Operator-facing hooks. Both are mandatory; wired at the integration seam. */
export interface AdvisorHooks {
  /** Called BEFORE any bytes leave. Return false to veto (no egress). */
  announce(info: {
    endpoint: string;
    provider: string;
    model: string;
    purpose: string;
    contextChars: number;
    contextTokens: number;
    maxWallClockSec: number;
    maxTotalTokens: number;
    maxCostUSD: number;
    attempt: number;
  }): boolean;
  /** Called AFTER the consultation settles, whatever the outcome. Always fires. */
  record(outcome: AdvisorResult): void;
}

/** Resolves an endpoint to a provider instance. Production wires `createProvider`;
 *  tests wire a fake. Throwing here must never cause egress. */
export type AdvisorProviderFactory = (endpoint: AdvisorEndpointConfig) => Provider;

/** Hard bounds resolved from config. All three caps are mandatory when enabled. */
export interface AdvisorCaps {
  maxWallClockSec: number;
  maxTotalTokens: number;
  maxCostUSD: number;
  maxAttempts: number;
}

/** Bounded retry ceiling — a blocked endpoint can never cause a retry storm. */
export const ADVISOR_MAX_ATTEMPTS_CEILING = 3;

const ZERO_USAGE: AdvisorUsage = Object.freeze({ inputTokens: 0, outputTokens: 0, costUSD: 0 });

/** Per-axis cap attribution: which bound fired, checked in priority order. */
function cappedAxis(
  snap: { inputTokens: number; outputTokens: number; costUSD: number; elapsedSec: number },
  caps: AdvisorCaps,
): 'tokens' | 'cost' | 'wall-clock' | undefined {
  if (caps.maxTotalTokens !== undefined && snap.inputTokens + snap.outputTokens >= caps.maxTotalTokens) {
    return 'tokens';
  }
  if (caps.maxCostUSD !== undefined && snap.costUSD >= caps.maxCostUSD) {
    return 'cost';
  }
  if (caps.maxWallClockSec !== undefined && snap.elapsedSec >= caps.maxWallClockSec) {
    return 'wall-clock';
  }
  return undefined;
}

export class AdvisorService {
  constructor(
    private readonly config: ShadowConfig,
    private readonly factory: AdvisorProviderFactory,
    private readonly hooks: AdvisorHooks,
  ) {}

  /**
   * The single entry point. Refuses (no egress) unless every gate passes.
   * Policy refusals are outcomes, never exceptions.
   */
  async consult(
    request: AdvisorConsultationRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<AdvisorResult> {
    // ---- Gate 1: shape. Cheapest refusal first; no I/O before this passes. ----
    const endpointName = typeof request?.endpoint === 'string' ? request.endpoint.trim() : '';
    const purpose = typeof request?.purpose === 'string' ? request.purpose.trim() : '';
    const context = typeof request?.context === 'string' ? request.context : undefined;
    if (!endpointName || !purpose || context === undefined || context.trim().length === 0) {
      return this.settle('refused', endpointName, 'empty-request', ZERO_USAGE, 0, 0);
    }

    // ---- Gate 2: enabled + complete config (fail closed). ----
    const advisors = this.config.advisors;
    if (!advisors?.enabled) {
      return this.settle('refused', endpointName, 'advisors-disabled', ZERO_USAGE, 0, 0);
    }
    if (!Array.isArray(advisors.endpoints) || advisors.endpoints.length === 0) {
      return this.settle('refused', endpointName, 'no-endpoints', ZERO_USAGE, 0, 0);
    }
    const caps = this.resolveCaps(advisors);
    if (!caps) {
      return this.settle('refused', endpointName, 'caps-incomplete', ZERO_USAGE, 0, 0);
    }

    // ---- Gate 3: endpoint must be in the allowlist (before factory resolution). ----
    const endpoint = advisors.endpoints.find((e) => e.name === endpointName);
    if (!endpoint) {
      return this.settle('refused', endpointName, 'endpoint-not-allowed', ZERO_USAGE, 0, 0);
    }

    // ---- Gate 4: cost must be verifiable when a cost cap exists. ----
    const price = this.priceFor(endpoint.model);
    if (caps.maxCostUSD !== undefined && price === undefined) {
      return this.settle('refused', endpointName, 'cost-not-verifiable', ZERO_USAGE, 0, 0);
    }

    // ---- Gate 5: provider factory resolution (still no network I/O). ----
    let provider: Provider;
    try {
      provider = this.factory(endpoint);
    } catch {
      return this.settle('refused', endpointName, 'factory-error', ZERO_USAGE, 0, 0);
    }

    // ---- Gate 6: pre-flight bounds on the LOCAL estimate — no bytes have left. ----
    const contextTokens = this.estimateContext(context);
    if (caps.maxTotalTokens !== undefined && contextTokens >= caps.maxTotalTokens) {
      return this.settle('capped', endpointName, 'pre-flight-token-cap', ZERO_USAGE, 0, 0);
    }
    if (
      caps.maxCostUSD !== undefined &&
      price !== undefined &&
      (contextTokens * price.input) / 1_000_000 >= caps.maxCostUSD
    ) {
      return this.settle('capped', endpointName, 'pre-flight-cost-cap', ZERO_USAGE, 0, 0);
    }

    // ---- Gate 7: announce BEFORE egress. False = operator veto → no egress. ----
    const allowed = this.hooks.announce({
      endpoint: endpoint.name,
      provider: endpoint.provider,
      model: endpoint.model,
      purpose,
      contextChars: context.length,
      contextTokens,
      maxWallClockSec: caps.maxWallClockSec,
      maxTotalTokens: caps.maxTotalTokens,
      maxCostUSD: caps.maxCostUSD,
      attempt: 1,
    });
    if (!allowed) {
      return this.settle('refused', endpointName, 'operator-veto', ZERO_USAGE, 0, 0);
    }

    // ---- Gate 8: the attempts loop is the ONLY path to provider.send(). ----
    return this.attemptLoop(endpoint, caps, context, contextTokens, opts.signal, provider);
  }

  /** Caps come from config only — fail closed unless all three are present. */
  private resolveCaps(advisors: NonNullable<ShadowConfig['advisors']>): AdvisorCaps | undefined {
    if (
      advisors.maxWallClockSec === undefined ||
      advisors.maxTotalTokens === undefined ||
      advisors.maxCostUSD === undefined
    ) {
      return undefined;
    }
    return {
      maxWallClockSec: advisors.maxWallClockSec,
      maxTotalTokens: advisors.maxTotalTokens,
      maxCostUSD: advisors.maxCostUSD,
      maxAttempts: Math.max(1, Math.min(advisors.maxAttempts ?? 1, ADVISOR_MAX_ATTEMPTS_CEILING)),
    };
  }

  private priceFor(model: string): ModelPrice | undefined {
    return this.config.priceTable?.[model];
  }

  private estimateContext(context: string): number {
    return estimateTokensFromMessages([
      { role: 'user', content: [{ type: 'text', text: context }] },
    ]);
  }

  /**
   * The only code that talks to the provider. Reaching this method means gates
   * 1-7 already passed — including the operator's announce consent.
   */
  private async attemptLoop(
    endpoint: AdvisorEndpointConfig,
    caps: AdvisorCaps,
    context: string,
    contextTokens: number,
    external: AbortSignal | undefined,
    provider: Provider,
  ): Promise<AdvisorResult> {
    const maxAttempts = caps.maxAttempts;
    const controller = new AbortController();

    // Wall-clock watchdog: absolute deadline armed ONCE for the whole
    // consultation. It aborts the in-flight request the moment the cap passes.
    const watchdog: NodeJS.Timeout = setTimeout(
      () => controller.abort(new Error('advisor wall-clock cap')),
      caps.maxWallClockSec * 1_000,
    );

    // Accrue spend through the REAL Budget: exact tokens, provider-priced cost,
    // and — defense in depth — the same wall-clock cap, so a usage event
    // arriving in the gap before the watchdog callback runs still trips the
    // per-event ceiling check.
    const budget = new Budget(
      {
        maxIterations: maxAttempts,
        maxTotalTokens: caps.maxTotalTokens,
        maxCostUSD: caps.maxCostUSD,
        maxWallClockSec: caps.maxWallClockSec,
      },
      endpoint.model,
      this.config.priceTable ?? {},
      Date.now(),
    );

    const startedAtMs = Date.now();
    let attempts = 0;
    let outcome: AdvisorResult['outcome'] | undefined;
    let reason = 'unknown';
    let lastFailure: string | undefined;
    let adviceParts: string[] = [];

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        attempts = attempt;
        adviceParts = []; // advice from a failed attempt is discarded, never mixed in.
        const composite = this.compositeSignal(external, controller.signal);
        const remainingTokens =
          caps.maxTotalTokens !== undefined
            ? Math.max(1, caps.maxTotalTokens - contextTokens)
            : undefined;

        let sawDone = false;
        let unrecoverable = false;
        try {
          const stream = provider.send({
            model: endpoint.model,
            system: '',
            messages: [{ role: 'user', content: [{ type: 'text', text: context }] }],
            tools: [], // NO tools — an advisor cannot emit tool calls at all.
            maxOutputTokens: remainingTokens ?? 4_096,
            signal: composite,
          });
          for await (const ev of stream) {
            if (controller.signal.aborted || external?.aborted) break;
            if (ev.type === 'text') {
              adviceParts.push(ev.delta);
            } else if (ev.type === 'tool_call' || ev.type === 'tool_call_partial') {
              // Structurally impossible (tools: []); any stray tool traffic is
              // discarded unread — an advisor has NO tool surface.
              continue;
            } else if (ev.type === 'usage') {
              budget.recordUsage(ev, Date.now());
              if (budget.checkSpending(Date.now()) === 'budget') {
                const axis = cappedAxis(budget.snapshot(Date.now()), caps);
                outcome = 'capped';
                reason = axis !== undefined ? `mid-flight-${axis}-cap` : 'mid-flight-cap';
                break;
              }
            } else if (ev.type === 'error') {
              unrecoverable = !ev.recoverable;
              lastFailure = unrecoverable ? 'provider-error-unrecoverable' : 'provider-error';
              break;
            } else if (ev.type === 'done') {
              sawDone = true;
              break;
            }
          }
        } catch {
          lastFailure = 'stream-threw';
        }

        // Classify aborts by WHICH signal fired — never by sniffing errors.
        if (controller.signal.aborted) {
          outcome = 'capped';
          reason = 'mid-flight-wall-clock-cap';
          break;
        }
        if (external?.aborted) {
          outcome = 'cancelled';
          reason = 'operator-abort';
          break;
        }
        if (outcome !== undefined) break; // a spending cap already decided this
        if (sawDone) {
          outcome = 'completed';
          reason = 'advice-received';
          break;
        }
        if (unrecoverable) break; // never retry an unrecoverable error
        if (!lastFailure) lastFailure = 'no-completion';
        // Bounded retry: the loop ceiling (maxAttempts <= 3) is the storm bound.
      }
    } finally {
      clearTimeout(watchdog);
    }

    const spentMs = Date.now() - startedAtMs;
    if (outcome === undefined) {
      outcome = 'blocked';
      reason = lastFailure ?? 'attempts-exhausted';
    }
    const snap = budget.snapshot(Date.now());
    const advice =
      outcome === 'completed' && adviceParts.join('').length > 0 ? adviceParts.join('') : undefined;

    return this.settle(
      outcome,
      endpoint.name,
      reason,
      {
        inputTokens: snap.inputTokens,
        outputTokens: snap.outputTokens,
        costUSD: snap.costUSD,
      },
      attempts,
      spentMs,
      advice,
    );
  }

  /**
   * Merge the operator's external signal with the internal watchdog. The stream
   * sees one signal; classification later distinguishes which one fired.
   */
  private compositeSignal(
    external: AbortSignal | undefined,
    internal: AbortSignal,
  ): AbortSignal {
    if (external === undefined) return internal;
    if (typeof AbortSignal.any === 'function') return AbortSignal.any([internal, external]);
    const merged = new AbortController();
    const forward = () => merged.abort();
    external.addEventListener('abort', forward, { once: true });
    internal.addEventListener('abort', forward, { once: true });
    return merged.signal;
  }

  /**
   * The ONLY constructor of the result object — every path funnels through here,
   * so every result is frozen, always recorded, and never carries an authority
   * surface. Pre-egress outcomes get zero usage and zero spent wall-clock.
   */
  private settle(
    outcome: AdvisorResult['outcome'],
    endpoint: string,
    reason: string,
    usage: AdvisorUsage,
    attempts: number,
    spentWallClockMs: number,
    advice?: string,
  ): AdvisorResult {
    const result: AdvisorResult = Object.freeze({
      kind: 'advice',
      outcome,
      endpoint,
      reason,
      advice: advice !== undefined && advice.length > 0 ? advice : undefined,
      attempts,
      usage: Object.freeze({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUSD: usage.costUSD,
      }),
      spentWallClockMs,
      refunded: false,
    }) as AdvisorResult;
    this.hooks.record(result);
    return result;
  }
}

// ── Compile-time no-authority assertion ─────────────────────────────────────
// AdvisorResult carries NO tool, approval, or execution surface. TypeScript's
// structural type system lets us PROVE this at compile time: if a forbidden
// member ever appears on the type, the assignment below stops compiling.
type ForbiddenAuthorityMembers =
  | 'tool'
  | 'toolCall'
  | 'tools'
  | 'call'
  | 'approve'
  | 'approval'
  | 'exec'
  | 'execute'
  | 'run'
  | 'command'
  | 'shell'
  | 'write'
  | 'writeFile'
  | 'mutate'
  | 'patch'
  | 'delete';
type AssertNoAuthority<T extends Record<string, unknown>> = Extract<keyof T, ForbiddenAuthorityMembers> extends never
  ? true
  : never;
/** Compiles only while AdvisorResult has no authority-shaped member. */
export type AdvisorResultHasNoAuthority = AssertNoAuthority<
  Omit<AdvisorResult, 'advice' | 'endpoint'>
>;
export const assertAdvisorResultHasNoAuthority: AdvisorResultHasNoAuthority = true;
