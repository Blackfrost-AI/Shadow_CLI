import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelCheckResult } from '../src/doctor/modelCheck.js';
import type { Provider } from '../src/provider/provider.js';
import type { ProviderOptions } from '../src/provider/index.js';
import type { OnboardUI, Screen, Choice } from '../src/onboard/ui.js';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';
const { home } = isolateHome('capability-records');
const store = await import('../src/state/globalStore.js'); assertStoreIsolated(store.GLOBAL_DIR, home);
const { capabilityIdentity, capabilityTargetFromProviderOptions, saveCapabilityRecord, readCapabilityRecord } = await import('../src/doctor/capabilityRecords.js');
const { runModelCheck } = await import('../src/doctor/modelCheck.js');
const { offerOnboardCapabilityCheck, runOnboard } = await import('../src/onboard/onboard.js');
const { BACK, OnboardCancelled } = await import('../src/onboard/ui.js');
type Back = typeof import('../src/onboard/ui.js').BACK;
test.after(() => rmSync(home, { recursive: true, force: true }));

const target = { provider: 'openai' as const, model: 'test-model', baseUrl: 'http://127.0.0.1:9999/v1', selfHosted: true };
function result(): ModelCheckResult {
  return { model: target.model, providerName: target.provider, isLocal: true, verdict: 'limited', recommendation: 'Use supervision for multi-step work.', elapsedMs: 200,
    probes: ['tool_call', 'format', 'file_edit', 'error_recovery', 'autonomous'].map((id) => ({ id: id as ModelCheckResult['probes'][number]['id'], label: id, status: id === 'autonomous' ? 'fail' : 'pass', detail: 'fixture observation' })) };
}

test('local capability identity separates endpoints, models, profiles and wire contracts without credential fields', () => {
  const dir = join(home, 'records');
  const extra = { ...target, apiKey: 'not-recorded-first-secret', extraHeaders: { Authorization: 'never-record-me' } };
  const record = saveCapabilityRecord(extra, result(), { directory: dir, now: Date.parse('2026-10-12T12:00:00Z') });
  assert.equal(record.checkedAt, '2026-10-12T12:00:00.000Z');
  assert.deepEqual(readCapabilityRecord(target, { directory: dir }), record);
  const changedKey = { ...extra, apiKey: 'another-secret' };
  assert.equal(capabilityIdentity(changedKey), record.identity);
  for (const change of [{ model: 'other' }, { baseUrl: 'http://127.0.0.1:9998/v1' }, { profile: 'different' }, { wire: 'responses' as const }, { capabilities: { preserveThinking: true } }]) {
    assert.equal(readCapabilityRecord({ ...target, ...change }, { directory: dir }), undefined);
  }
  const text = readFileSync(join(dir, readdirSync(dir)[0]!), 'utf8');
  assert.doesNotMatch(text, /not-recorded|another-secret|never-record-me|127\.0\.0\.1/);
  assert.deepEqual(record.compatibility, { streaming: 'not_assessed', cancellation: 'not_assessed', structuredOutput: 'not_assessed' });
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, readdirSync(dir)[0]!)).mode & 0o777, 0o600);
  assert.throws(() => capabilityIdentity({ ...target, baseUrl: 'https://user:secret@host/v1' }), /history is unavailable/);
  assert.throws(() => capabilityIdentity({ ...target, baseUrl: 'https://host/v1?api_key=secret' }), /history is unavailable/);
});

test('effective capability metadata snapshots the resolved endpoint and wire while excluding credentials', () => {
  const previousWire = process.env.SHADOW_WIRE_API;
  try {
    process.env.SHADOW_WIRE_API = 'chat';
    const options: ProviderOptions = { provider: 'openai', model: 'resolved-wire-model',
      baseUrl: 'https://resolved.invalid/responses-backend', wire: 'responses',
      apiKey: 'never-include-key', authToken: 'never-include-token', extraHeaders: { Authorization: 'never-include-header' },
      capabilities: { preserveThinking: true, effortScale: ['low', 'high'] }, reasoningRoundtrip: 'none' };
    const captured = capabilityTargetFromProviderOptions(options, 'selected-profile');
    const identity = capabilityIdentity(captured);
    assert.equal(captured.model, 'resolved-wire-model');
    assert.equal(captured.baseUrl, options.baseUrl);
    assert.equal(captured.wire, 'responses', 'resolved credential wire takes priority over the environment');
    assert.equal(captured.profile, 'selected-profile');
    assert.equal(captured.reasoningRoundtrip, 'none');
    assert.doesNotMatch(JSON.stringify(captured), /never-include|apiKey|authToken|extraHeaders/);
    options.capabilities!.effortScale!.push('medium');
    options.capabilities!.preserveThinking = false;
    process.env.SHADOW_WIRE_API = 'responses';
    assert.equal(capabilityIdentity(captured), identity, 'later config changes cannot rewrite a captured target');
    assert.deepEqual(captured.capabilities!.effortScale, ['low', 'high']);
    const local = capabilityTargetFromProviderOptions({ provider: 'openai', model: 'managed-wire-model', baseUrl: 'http://127.0.0.1:19123/v1' });
    assert.equal(local.selfHosted, true);
    assert.notEqual(capabilityIdentity(local), capabilityIdentity({ ...local, baseUrl: 'http://127.0.0.1:19124/v1' }));
    process.env.SHADOW_WIRE_API = 'chat';
    assert.equal(local.wire, 'responses', 'environment wire selection is captured once beside provider construction');
    const account = capabilityTargetFromProviderOptions({ provider: 'openai', model: 'account-model', connection: { kind: 'chatgpt', profileId: 'account-id' } });
    assert.equal(account.wire, 'responses');
    assert.equal(account.baseUrl, 'https://api.openai.com/v1');
  } finally {
    if (previousWire === undefined) delete process.env.SHADOW_WIRE_API;
    else process.env.SHADOW_WIRE_API = previousWire;
  }
});

class UI implements OnboardUI {
  seen: Screen[] = []; selections: Choice[][] = [];
  constructor(private readonly choice: 'skip' | 'run' | 'cancel', private readonly cancelBusy = false) {}
  async choose(screen: Screen, choices: Choice[]) {
    this.seen.push(screen); this.selections.push(choices);
    if (this.choice === 'cancel') throw new OnboardCancelled();
    return [screen.title === 'Capability results' ? 'done' : this.choice];
  }
  async text() { return ''; }
  async busy<T>(screen: Screen, work: (signal: AbortSignal) => Promise<T>): Promise<T | Back> {
    this.seen.push(screen);
    if (this.cancelBusy) return BACK as Back;
    return work(new AbortController().signal);
  }
  close() {}
}

test('deeper onboarding check is explicit opt-in; skip and cancellation make no probe calls', async () => {
  let calls = 0;
  for (const ui of [new UI('skip'), new UI('cancel'), new UI('run', true)]) {
    const summary = await offerOnboardCapabilityCheck(ui, target, async () => { calls++; return result(); });
    assert.match(summary, /skipped|cancelled/);
    assert.match(ui.seen[0]!.description!, /saved/);
    assert.match(ui.seen[0]!.details!.join(' '), /2 minutes.*7 model turns.*tokens.*charges/i);
  }
  assert.equal(calls, 0);
});

test('capability result is dated and visible while a failing capability verdict leaves the selected endpoint intact', async () => {
  store.saveGlobalConfig({ provider: target.provider, model: target.model, baseUrl: target.baseUrl });
  const before = JSON.stringify(store.loadGlobalConfig()); const ui = new UI('run');
  const summary = await offerOnboardCapabilityCheck(ui, target, async (actual, signal) => {
    assert.equal(actual.baseUrl, target.baseUrl); assert.equal(signal.aborted, false); return result();
  });
  assert.match(summary, /LIMITED.*supervision[\s\S]*Saved locally/);
  assert.equal(readCapabilityRecord(target)?.result.verdict, 'limited');
  assert.equal(JSON.stringify(store.loadGlobalConfig()), before);
  assert.match(ui.seen.at(-1)!.details!.join(' '), /not assessed/);
  const failed = await offerOnboardCapabilityCheck(new UI('run'), target, async () => { throw new Error('deadline elapsed'); });
  assert.match(failed, /deadline elapsed.*saved setup is ready/);
  assert.equal(JSON.stringify(store.loadGlobalConfig()), before);
});

test('a parent cancellation stops model capability probes without issuing a second provider request', async () => {
  let calls = 0; const controller = new AbortController(); let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  const provider: Provider = { name: 'fixture', estimateTokens: () => 0,
    async *send(request) {
      calls++; started();
      await new Promise<void>((resolve) => request.signal!.addEventListener('abort', () => resolve(), { once: true }));
      yield { type: 'done' as const, stopReason: 'end_turn' as const };
    } };
  const pending = runModelCheck(provider, { model: target.model, signal: controller.signal });
  await start; controller.abort(new Error('user cancelled'));
  await assert.rejects(pending, /user cancelled/);
  assert.equal(calls, 1);
});

test('full onboarding saves before optional probing and reports success when that probe is cancelled', async () => {
  const answers = new Map([['How do you want to run Shadow?', 'server'], ['Choose a model server', 'custom'],
    ['Choose models', target.model], ['Review and save', 'save'], ['Test agent capabilities?', 'run']]);
  let checked = false;
  const ui: OnboardUI = {
    async choose(screen) { return [answers.get(screen.title) ?? 'done']; },
    async text(screen) { return screen.title === 'Endpoint URL' ? target.baseUrl : ''; },
    async busy(screen, work) { return work(new AbortController().signal); }, close() {},
  };
  assert.equal(await runOnboard({ ui,
    probe: async () => ({ ok: true, models: [target.model], source: 'live', compatibility: 'openai', hosting: 'self-hosted', baseUrl: target.baseUrl }),
    test: async () => ({ ok: true }), capabilityCheck: async () => {
      checked = true; assert.equal(store.loadGlobalConfig().model, target.model); throw new OnboardCancelled();
    } }), true);
  assert.equal(checked, true); assert.equal(store.loadGlobalConfig().baseUrl, target.baseUrl);
});
