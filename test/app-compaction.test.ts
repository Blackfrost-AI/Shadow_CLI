import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';
import type { CompactResult } from '../src/agent/context.js';
import type { FlattenItem } from '../src/tui/flatten.js';

const isolated = isolateHome('pi-compaction');
const store = await import('../src/state/globalStore.js');
assertStoreIsolated(store.GLOBAL_DIR, isolated.home);
const { ShadowApp } = await import('../src/app/app.js');
after(() => rmSync(isolated.home, { recursive: true, force: true }));

type CompactCall = {
  provider: unknown;
  model: string;
  force: boolean;
  signal: AbortSignal;
  options: { temperature?: number };
};

type CompactApp = {
  runSlash(raw: string): void;
  abortCompaction(): void;
  running: boolean;
  compacting: boolean;
  compactController: AbortController | null;
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function harness(options: {
  running?: boolean;
  result?: Promise<CompactResult>;
  model?: string;
  temperature?: number;
} = {}) {
  const output: Array<Partial<FlattenItem>> = [];
  const records: unknown[] = [];
  const calls: CompactCall[] = [];
  const provider = { id: 'fake-provider' };
  const queued = ['queued after compaction'];
  const flushed: string[][] = [];
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const result = options.result ?? Promise.resolve<CompactResult>('summarized');

  const app = Object.assign(Object.create(ShadowApp.prototype), {
    opts: {
      cfg: { temperature: options.temperature ?? 0.42 },
      sessionLog: { record: (record: unknown) => records.push(record) },
      context: {
        maybeSummarize: (
          receivedProvider: unknown,
          model: string,
          force: boolean,
          signal: AbortSignal,
          summarizeOptions: { temperature?: number },
        ) => {
          calls.push({
            provider: receivedProvider,
            model,
            force,
            signal,
            options: summarizeOptions,
          });
          return result;
        },
      },
    },
    provider,
    current: { provider: 'fake', model: options.model ?? 'current-model' },
    running: options.running ?? false,
    compacting: false,
    compactController: null,
    queued,
    pushLine: (line: Partial<FlattenItem>) => output.push(line),
    flushQueue: () => {
      flushed.push(queued.splice(0));
      settle();
    },
  }) as CompactApp;

  return {
    app,
    calls,
    flushed,
    output,
    provider,
    queued,
    records,
    settled,
    text: () => output.map((line) => line.text ?? '').join('\n'),
  };
}

test('pi /compact refuses while a turn is running', () => {
  const h = harness({ running: true });

  h.app.runSlash('/compact');

  assert.match(h.text(), /Finish the current operation before compacting/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.app.compacting, false);
  assert.equal(h.app.compactController, null);
  assert.deepEqual(h.queued, ['queued after compaction']);
  assert.deepEqual(h.flushed, []);
});

test('pi /compact forwards the active model and temperature and refuses a concurrent request', async () => {
  const pending = deferred<CompactResult>();
  const h = harness({ result: pending.promise, model: 'model-in-use', temperature: 0.37 });

  h.app.runSlash('/compact');
  const activeController = h.app.compactController;

  assert.equal(h.app.compacting, true);
  assert.ok(activeController instanceof AbortController);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.provider, h.provider);
  assert.equal(h.calls[0]!.model, 'model-in-use');
  assert.equal(h.calls[0]!.force, true);
  assert.equal(h.calls[0]!.signal, activeController.signal);
  assert.deepEqual(h.calls[0]!.options, { temperature: 0.37 });

  h.app.runSlash('/compact');
  assert.match(h.text(), /Already compacting — Esc to cancel/);
  assert.equal(h.calls.length, 1, 'a second summarizer must not start');
  assert.equal(h.app.compactController, activeController);

  pending.resolve('summarized');
  await h.settled;

  assert.match(h.text(), /Context compacted — earlier turns summarized/);
  assert.equal(h.app.compacting, false);
  assert.equal(h.app.compactController, null);
  assert.deepEqual(h.flushed, [['queued after compaction']]);
  assert.deepEqual(h.queued, []);
});

for (const fixture of [
  {
    result: 'truncated' as const,
    message: /context reclaimed by dropping the oldest tool results/,
  },
  {
    result: 'failed' as const,
    message: /Compaction failed — summarizer unavailable and nothing left to reclaim/,
  },
]) {
  test(`pi /compact reports and records a degraded ${fixture.result} result`, async () => {
    const h = harness({ result: Promise.resolve(fixture.result) });

    h.app.runSlash('/compact');
    await h.settled;

    assert.match(h.text(), fixture.message);
    assert.deepEqual(h.records, [
      { kind: 'compaction_degraded', mode: fixture.result, source: 'manual' },
    ]);
    assert.equal(h.app.compacting, false);
    assert.equal(h.app.compactController, null);
    assert.deepEqual(h.flushed, [['queued after compaction']]);
    assert.deepEqual(h.queued, []);
  });
}

test('pi /compact reports cancellation and releases the queue after the attempt settles', async () => {
  const pending = deferred<CompactResult>();
  const h = harness({ result: pending.promise });

  h.app.runSlash('/compact');
  const activeController = h.app.compactController;
  assert.ok(activeController instanceof AbortController);

  h.app.abortCompaction();
  assert.equal(activeController.signal.aborted, true);
  pending.resolve(false);
  await h.settled;

  assert.match(h.text(), /Compaction cancelled — context unchanged/);
  assert.deepEqual(h.records, []);
  assert.equal(h.app.compacting, false);
  assert.equal(h.app.compactController, null);
  assert.deepEqual(h.flushed, [['queued after compaction']]);
  assert.deepEqual(h.queued, []);
});
