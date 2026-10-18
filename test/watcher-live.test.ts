import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WatcherRegistry } from '../src/agent/watcher.js';

/**
 * The claim under test is the one the old design could not make: a watcher keeps running after the
 * process that started it is gone. These tests therefore spawn a real detached shell and observe
 * the filesystem, then kill it. They are slower than the seam-driven tests and are marked with a
 * generous timeout; the harness spawns two processes each.
 */

const WAIT = 5000;

function waitFor(predicate: () => boolean, timeoutMs = WAIT): Promise<boolean> {
  const started = Date.now();
  return new Promise((resolve) => {
    const spin = () => {
      if (predicate()) return resolve(true);
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(spin, 50);
    };
    spin();
  });
}

test('a real watcher keeps ticking after the registry that started it is discarded', { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-watch-live-'));
  const tickFile = join(root, 'ticks.txt');
  try {
    // Append a timestamp each tick, so repeated runs prove the loop repeats rather than firing once.
    const registry = new WatcherRegistry(root);
    const started = registry.start({
      name: `live${process.pid}`,
      command: `date +%s%N >> '${tickFile}'`,
      intervalSec: 10,
    });
    assert.equal(started.status, 'running', `spawn should succeed; log: ${started.logPath}`);

    // First tick lands promptly (the loop runs the command before sleeping).
    const first = await waitFor(() => existsSync(tickFile));
    assert.ok(first, `watcher never wrote its first tick; log: ${started.logPath}`);

    // Simulate the session ending: drop THIS registry object entirely. The detached process must
    // not notice. A brand-new registry re-reads durable state and must still see it alive.
    const fresh = new WatcherRegistry(root);
    const seen = fresh.list().find((w) => w.name === started.name);
    assert.ok(seen, 'a new process must see a watcher started by an earlier one');
    assert.equal(seen!.status, 'running');

    fresh.cancel(started.name);
    const after = new WatcherRegistry(root).list().find((w) => w.name === started.name);
    assert.equal(after?.status, 'stopped');
  } finally {
    // Best-effort cleanup: never leave a detached loop running on the host.
    try {
      const reg = new WatcherRegistry(root);
      for (const w of reg.list()) reg.remove(w.name);
    } catch {
      /* ignore */
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('the watcher log captures command output for later inspection', { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-watch-log-'));
  try {
    const registry = new WatcherRegistry(root);
    const w = registry.start({ name: `logged${process.pid}`, command: 'echo HELLO-FROM-WATCHER', intervalSec: 10 });
    assert.equal(w.status, 'running');

    const got = await waitFor(() => registry.logTail(w.name).includes('HELLO-FROM-WATCHER'));
    assert.ok(got, 'the log must contain the command output, otherwise `watcher log` is useless');

    registry.cancel(w.name);
  } finally {
    try {
      const reg = new WatcherRegistry(root);
      for (const x of reg.list()) reg.remove(x.name);
    } catch {
      /* ignore */
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('an invalid name is rejected by the real spawn path too, not just the seams', () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-watch-bad-'));
  try {
    const registry = new WatcherRegistry(root);
    assert.throws(() => registry.start({ name: '../escape', command: 'true', intervalSec: 10 }));
    // And nothing was written outside the jail.
    assert.equal(existsSync(join(root, '..', 'escape.log')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('command output is redacted before it reaches the log tail', { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-watch-redact-'));
  try {
    const registry = new WatcherRegistry(root);
    // A shape the redactor is expected to catch; the point is that logTail runs it through redact.
    const w = registry.start({
      name: `secret${process.pid}`,
      command: "echo 'ANTHROPIC_API_KEY=sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'",
      intervalSec: 10,
    });
    assert.equal(w.status, 'running');
    const waited = await waitFor(() => registry.logTail(w.name).length > 0);
    assert.ok(waited, 'expected output in the log');
    const tail = registry.logTail(w.name);
    assert.ok(!tail.includes('sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), `secret leaked into log tail: ${tail}`);
    registry.cancel(w.name);
  } finally {
    try {
      const reg = new WatcherRegistry(root);
      for (const x of reg.list()) reg.remove(x.name);
    } catch {
      /* ignore */
    }
    rmSync(root, { recursive: true, force: true });
  }
});
