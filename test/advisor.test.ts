/**
 * m13 - Opt-in bounded advisors.
 *
 * Every invariant from src/agent/advisor.ts is exercised here against a FAKE
 * provider (never a real network call):
 *
 *  1. DEFAULT DISABLED - no advisors block means every consultation is refused
 *     with zero egress (the fake provider records every send() it gets).
 *  2. EXPLICIT SELECTION - only allowlisted endpoint names are consulted, and
 *     only the caller-supplied context is ever transmitted.
 *  3. HARD BOUNDS - pre-flight caps refuse before egress; mid-flight usage
 *     events are priced and checked per-axis; the wall-clock watchdog aborts.
 *  4. VISIBLE EGRESS - announce() fires before any send() with the full plan,
 *     record() always fires with the honest outcome; a veto stops all egress.
 *  5. NO MUTATION AUTHORITY - the request carries tools:[] and the result type
 *     has no authority-shaped member (compile-time assertion in advisor.ts).
 *  6. CANCELLATION - external abort cancels the stream; time spent is recorded
 *     honestly; nothing is refunded.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Provider, ProviderEvent } from '../src/provider/provider.js';
import {
  AdvisorService,
  ADVISOR_MAX_ATTEMPTS_CEILING,
  type AdvisorHooks,
  type AdvisorResult,
} from '../src/agent/advisor.ts';
import type { ShadowConfig } from '../src/config.js';

interface RecordedSend {
  model: string;
  tools: unknown[];
  text: string;
  signal: AbortSignal | undefined;
}

class FakeProvider implements Provider {
  readonly name = 'fake';
  readonly sends: RecordedSend[] = [];

  constructor(
    private readonly script: ProviderEvent[],
    private readonly opts: { hangMs?: number } = {},
  ) {}

  send(req: Parameters<Provider['send']>[0]): AsyncIterable<ProviderEvent> {
    const index = this.sends.length;
    this.sends.push({
      model: req.model,
      tools: [...req.tools],
      text: req.messages
        .map((m) => m.content.map((b) => ('text' in b ? b.text : '')).join(''))
        .join(''),
      signal: req.signal,
    });
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        if (self.opts.hangMs !== undefined) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, self.opts.hangMs);
            req.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(t);
                resolve();
              },
              { once: true },
            );
          });
          return;
        }
        yield { type: 'text', delta: 'send#' + index + ':' };
        for (const ev of self.script) yield ev;
      },
    };
  }

  estimateTokens(): number {
    return 0;
  }
}

interface RecordingHooks extends AdvisorHooks {
  announces: Array<Record<string, unknown>>;
  records: AdvisorResult[];
  veto: boolean | undefined;
}

function recordingHooks(): RecordingHooks {
  const hooks: RecordingHooks = {
    announces: [],
    records: [],
    veto: undefined,
    announce(info) {
      hooks.announces.push({ ...info });
      return !hooks.veto;
    },
    record(outcome) {
      hooks.records.push(outcome);
    },
  };
  return hooks;
}

function makeConfig(
  advisors: ShadowConfig['advisors'],
  priceTable: ShadowConfig['priceTable'],
): ShadowConfig {
  return { advisors, priceTable } as ShadowConfig;
}

const CAPS = {
  enabled: true,
  endpoints: [
    { name: 'reviewer', provider: 'anthropic', model: 'claude-3-5-haiku-latest' },
  ],
  maxWallClockSec: 60,
  maxTotalTokens: 1000000,
  maxCostUSD: 10,
  maxAttempts: 1,
} as ShadowConfig['advisors'];

const PRICE_TABLE = {
  'claude-3-5-haiku-latest': { input: 0.8, output: 4 },
} as ShadowConfig['priceTable'];

function service(advisors: ShadowConfig['advisors'], script: ProviderEvent[]) {
  const hooks = recordingHooks();
  const provider = new FakeProvider(script);
  const svc = new AdvisorService(makeConfig(advisors, PRICE_TABLE), () => provider, hooks);
  return { svc, hooks, provider };
}

// ---- 1. Default disabled: fail closed before any I/O ----

test('advisors disabled (absent block): refused, zero egress, zero usage', async () => {
  const { svc, hooks, provider } = service(undefined, []);
  const res = await svc.consult({ endpoint: 'reviewer', purpose: 'patch-review', context: 'diff text' });
  assert.equal(res.outcome, 'refused');
  assert.equal(res.reason, 'advisors-disabled');
  assert.equal(res.attempts, 0);
  assert.equal(res.usage.inputTokens, 0);
  assert.equal(res.usage.costUSD, 0);
  assert.equal(provider.sends.length, 0);
  assert.equal(hooks.announces.length, 0);
  assert.equal(hooks.records.length, 1);
  assert.equal(hooks.records[0].outcome, 'refused');
  assert.equal(res.refunded, false);
});

test('enabled false: refused identically', async () => {
  const { svc, provider } = service({ ...CAPS, enabled: false }, []);
  const res = await svc.consult({ endpoint: 'reviewer', purpose: 'x', context: 'y' });
  assert.equal(res.outcome, 'refused');
  assert.equal(res.reason, 'advisors-disabled');
  assert.equal(provider.sends.length, 0);
});

test('enabled but empty allowlist: refused (no-endpoints)', async () => {
  const { svc, provider } = service({ ...CAPS, endpoints: [] }, []);
  const res = await svc.consult({ endpoint: 'reviewer', purpose: 'x', context: 'y' });
  assert.equal(res.reason, 'no-endpoints');
  assert.equal(provider.sends.length, 0);
});

test('enabled but incomplete caps: refused (fail closed)', async () => {
  const { svc, provider } = service({ ...CAPS, maxCostUSD: undefined }, []);
  const res = await svc.consult({ endpoint: 'reviewer', purpose: 'x', context: 'y' });
  assert.equal(res.reason, 'caps-incomplete');
  assert.equal(provider.sends.length, 0);
});

// ---- 2. Explicit selection ----

test('endpoint not in allowlist: refused, zero egress', async () => {
  const { svc, provider } = service(CAPS, []);
  const res = await svc.consult({ endpoint: 'evil-external', purpose: 'x', context: 'y' });
  assert.equal(res.outcome, 'refused');
  assert.equal(res.reason, 'endpoint-not-allowed');
  assert.equal(provider.sends.length, 0);
});

test('factory throwing: refused before egress', async () => {
  const hooks = recordingHooks();
  const svc = new AdvisorService(
    makeConfig(CAPS, PRICE_TABLE),
    () => {
      throw new Error('no such provider');
    },
    hooks,
  );
  const res = await svc.consult({ endpoint: 'reviewer', purpose: 'x', context: 'y' });
  assert.equal(res.outcome, 'refused');
  assert.equal(res.reason, 'factory-error');
  assert.equal(hooks.announces.length, 0);
  assert.equal(hooks.records.length, 1);
});

test('empty or blank request fields: refused (empty-request)', async () => {
  const { svc } = service(CAPS, []);
  const bad = [
    { endpoint: '', purpose: 'x', context: 'y' },
    { endpoint: 'reviewer', purpose: '', context: 'y' },
    { endpoint: 'reviewer', purpose: 'x', context: '' },
    { endpoint: 'reviewer', purpose: 'x', context: '   ' },
  ];
  for (const b of bad) {
    const res = await svc.consult(b);
    assert.equal(res.outcome, 'refused');
    assert.equal(res.reason, 'empty-request');
  }
});

test('only the caller-supplied context is transmitted', async () => {
  const { svc, provider } = service(CAPS, [{ type: 'done', stopReason: 'end_turn' }]);
  await svc.consult({ endpoint: 'reviewer', purpose: 'patch-review', context: 'THE CONTEXT' });
  assert.equal(provider.sends.length, 1);
  assert.equal(provider.sends[0].text, 'THE CONTEXT');
  assert.equal(provider.sends[0].model, 'claude-3-5-haiku-latest');
  assert.deepEqual(provider.sends[0].tools, []);
});

// ---- 3. Hard bounds ----

test('pre-flight token cap: capped before egress', async () => {
  const { svc, provider } = service({ ...CAPS, maxTotalTokens: 4 }, []);
  const res = await svc.consult({ endpoint: 'reviewer', purpose: 'x', context: 'a'.repeat(40) });
  assert.equal(res.outcome, 'capped');
  assert.equal(res.reason, 'pre-flight-token-cap');
  assert.equal(provider.sends.length, 0);
  assert.equal(res.usage.inputTokens, 0);
  assert.equal(res.attempts, 0);
});

test('pre-flight cost cap: capped before egress', async () => {
  const { svc, provider } = service({ ...CAPS, maxCostUSD: 0.000001 }, []);
  const res = await svc.consult({ endpoint: 'reviewer', purpose: 'x', context: 'a'.repeat(4000) });
  assert.equal(res.outcome, 'capped');
  assert.equal(res.reason, 'pre-flight-cost-cap');
  assert.equal(provider.sends.length, 0);
});

test('cost cap with unknown price: refused (cost-not-verifiable)', async () => {
  const hooks = recordingHooks();
  const provider = new FakeProvider([]);
  const svc = new AdvisorService(makeConfig(CAPS, undefined), () => provider, hooks);
  const res = await svc.consult({ endpoint: 'reviewer', purpose: 'x', context: 'y' });
  assert.equal(res.outcome, 'refused');
  assert.equal(res.reason, 'cost-not-verifiable');
  assert.equal(provider.sends.length, 0);
});

test('mid-flight token cap stops the stream and reports the axis', async () => {
  const script: ProviderEvent[] = [
    { type: 'usage', inputTokens: 900, outputTokens: 900 },
    { type: 'done', stopReason: 'end_turn' },
  ];
  const { svc, provider } = service({ ...CAPS, maxTotalTokens: 1000 }, script);
  const res = await svc.consult({ endpoint: 'reviewer', purpose: 'x', context: 'y' });
  assert.equal(res.outcome, 'capped');
  assert.equal(res.reason, 'mid-flight-tokens-cap');
  assert.equal(res.usage.inputTokens, 900);
  assert.equal(res.usage.outputTokens, 900);
  assert.equal(provider.sends.length, 1);
});

test('mid-flight cost cap stops the stream and reports the cost axis', async () => {
  // Token ceiling kept high so ONLY the cost axis can fire: 900k in + 900k out
  // at $0.8/M in + $4/M out = $4.32, far past the $0.01 cost cap.
  const script: ProviderEvent[] = [
    { type: 'usage', inputTokens: 900000, outputTokens: 900000 },
  ];
  const { svc, provider } = service({ ...CAPS, maxTotalTokens: 10000000, maxCostUSD: 0.01 }, script);
  const res = await svc.consult({ endpoint: 'reviewer', purpose: 'x', context: 'y' });
  assert.equal(res.outcome, 'capped');
  assert.equal(res.reason, 'mid-flight-cost-cap');
  assert.equal(res.usage.inputTokens, 900000);
  assert.equal(provider.sends.length, 1);
});

test('wall-clock watchdog aborts a hanging stream mid-flight', async () => {
  const hooks = recordingHooks();
  const provider = new FakeProvider([], { hangMs: 10_000 });
  const svc = new AdvisorService(
    makeConfig({ ...CAPS, maxWallClockSec: 1 }, PRICE_TABLE),
    () => provider,
    hooks,
  );
  const res = await svc.consult({ endpoint: 'reviewer', purpose: 'x', context: 'y' });
  assert.equal(res.outcome, 'capped');
  assert.equal(res.reason, 'mid-flight-wall-clock-cap');
  assert.equal(provider.sends.length, 1);
  assert.ok(res.spentWallClockMs >= 900, 'spent wall clock recorded honestly');
  assert.equal(res.refunded, false);
});

// ---- 4. Visible egress ----

test('announce fires before egress with the full plan', async () => {
  const { svc, hooks, provider } = service(CAPS, [{ type: 'done', stopReason: 'end_turn' }]);
  const res = await svc.consult({ endpoint: 'reviewer', purpose: 'patch-review', context: 'ctx' });
  assert.equal(hooks.announces.length, 1);
  const info = hooks.announces[0];
  assert.equal(info.endpoint, 'reviewer');
  assert.equal(info.provider, 'anthropic');
  assert.equal(info.model, 'claude-3-5-haiku-latest');
  assert.equal(info.purpose, 'patch-review');
  assert.equal(info.attempt, 1);
  assert.ok(typeof info.contextTokens === 'number');
  assert.equal(provider.sends.length, 1);
  assert.equal(res.outcome, 'completed');
});

test('operator veto in announce stops all egress', async () => {
  const { svc, hooks, provider } = service(CAPS, []);
  hooks.veto = true;
  const res = await svc.consult({ endpoint: 'reviewer', purpose: 'x', context: 'y' });
  assert.equal(res.outcome, 'refused');
  assert.equal(res.reason, 'operator-veto');
  assert.equal(provider.sends.length, 0);
  assert.equal(hooks.records.length, 1);
});

test('record always fires exactly once with the honest outcome', async () => {
  const { svc, hooks } = service(CAPS, [{ type: 'done', stopReason: 'end_turn' }]);
  const res = await svc.consult({ endpoint: 'reviewer', purpose: 'x', context: 'y' });
  assert.equal(hooks.records.length, 1);
  assert.equal(hooks.records[0], res);
  assert.equal(hooks.records[0].outcome, 'completed');
  assert.equal(hooks.records[0].refunded, false);
  assert.throws(() => {
    (res as { advice?: string }).advice = 'spoofed';
  }, TypeError);
});

// ---- 5. No mutation authority ----

test('stray tool traffic is discarded unread and no tools are requested', async () => {  const script: ProviderEvent[] = [
    {
      type: 'tool_call',
      call: { id: 't1', name: 'shell', input: { command: 'rm -rf /' } },
    },
    { type: 'done', stopReason: 'tool_use' },
  ];
  const { svc, provider } = service(CAPS, script);
  const res = await svc.consult({ endpoint: 'reviewer', purpose: 'x', context: 'y' });
  assert.equal(provider.sends[0].tools.length, 0); // no tools were ever requested
  // The only advice is the fake's own text prefix; NOTHING from the tool_call
  // event (no tool name, no JSON input, no id) may appear in it.
  assert.equal(res.advice, 'send#0:');
  assert.ok(!JSON.stringify(res.advice ?? '').includes('rm -rf'));
  assert.ok(!JSON.stringify(res.advice ?? '').includes('t1'));
  assert.equal(res.outcome, 'completed');
});

// ---- 6. Cancellation ----

test('external abort cancels the stream and is classified cancelled', async () => {
  const hooks = recordingHooks();
  const provider = new FakeProvider([], { hangMs: 10_000 });
  const svc = new AdvisorService(makeConfig(CAPS, PRICE_TABLE), () => provider, hooks);
  const controller = new AbortController();
  const pending = svc.consult({ endpoint: 'reviewer', purpose: 'x', context: 'y' }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const res = await pending;
  assert.equal(res.outcome, 'cancelled');
  assert.equal(res.reason, 'operator-abort');
  assert.ok(res.spentWallClockMs >= 40, 'time spent recorded honestly');
  assert.equal(res.usage.inputTokens, 0);
  assert.equal(res.refunded, false);
  assert.equal(hooks.records.length, 1);
  assert.equal(hooks.records[0].outcome, 'cancelled');
});

// ---- Retry bound ----

test('bounded retry: unrecoverable errors never cause a retry storm', async () => {
  const script: ProviderEvent[] = [
    { type: 'error', recoverable: false, code: 'fatal', message: 'boom' },
  ];
  const { svc, provider } = service({ ...CAPS, maxAttempts: 3 }, script);
  const res = await svc.consult({ endpoint: 'reviewer', purpose: 'x', context: 'y' });
  assert.equal(res.outcome, 'blocked');
  assert.equal(res.reason, 'provider-error-unrecoverable');
  assert.equal(res.attempts, 1);
  assert.equal(provider.sends.length, 1);
});

test('attempts ceiling is bounded to 3', async () => {
  assert.equal(ADVISOR_MAX_ATTEMPTS_CEILING, 3);
});

test('completed advice is exactly the joined stream text', async () => {
  const script: ProviderEvent[] = [
    { type: 'text', delta: 'B' },
    { type: 'usage', inputTokens: 10, outputTokens: 10 },
    { type: 'done', stopReason: 'end_turn' },
  ];
  const { svc, provider } = service({ ...CAPS, maxTotalTokens: 100000 }, script);
  const res = await svc.consult({ endpoint: 'reviewer', purpose: 'x', context: 'y' });
  assert.equal(res.outcome, 'completed');
  assert.equal(res.advice, 'send#0:B');
  assert.equal(res.usage.inputTokens, 10);
  assert.equal(res.usage.outputTokens, 10);
  assert.ok(res.usage.costUSD > 0, 'cost priced from the price table');
  assert.equal(provider.sends.length, 1);
  assert.equal(res.reason, 'advice-received');
});

// ---- 7. Untrusted project config cannot open the advisor egress channel ----

test('project-level shadow.config.json advisors block is ignored (global-only)', async () => {
  // loadConfig strips `advisors` from an untrusted project file — a cloned repo
  // must not be able to open an egress channel by planting config. This mirrors
  // the PROJECT_UNTRUSTED_KEYS enforcement with the real loader.
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'advisor-untrusted-'));
  try {
    writeFileSync(
      join(dir, 'shadow.config.json'),
      JSON.stringify({
        advisors: {
          enabled: true,
          endpoints: [{ name: 'evil', provider: 'mock', model: 'evil-model' }],
          maxWallClockSec: 60,
          maxTotalTokens: 100000,
          maxCostUSD: 10,
          maxAttempts: 1,
        },
      }),
    );
    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig(dir);
    assert.equal(cfg.advisors?.enabled, false, 'project-planted advisors must not survive');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
