import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  WatcherRegistry,
  WatcherError,
  assertWatcherName,
  watcherScript,
  MIN_INTERVAL_SEC,
  MAX_WATCHERS,
  WATCHER_STATE_REL,
  REAP_LOG_MAX_BYTES,
  type WatcherRecord,
} from '../src/agent/watcher.js';

/** Every test drives fake processes; nothing here spawns or signals a real one. */
function harness(overrides: { alive?: (pid: number) => boolean; spawn?: (r: WatcherRecord) => number | null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'shadow-watcher-'));
  const killed: number[] = [];
  let nextPid = 1000;
  const registry = new WatcherRegistry(root, {
    now: () => 1_700_000_000_000,
    alive: overrides.alive ?? (() => true),
    spawn: overrides.spawn ?? (() => nextPid++),
    kill: (pid) => {
      killed.push(pid);
      return true;
    },
  });
  return { root, registry, killed, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('watcher names are constrained so they can never become shell text or a traversal', () => {
  assert.equal(assertWatcherName('ci'), 'ci');
  assert.equal(assertWatcherName('  deploy-logs '), 'deploy-logs');
  assert.equal(assertWatcherName('build.2_x'), 'build.2_x');
  for (const bad of ['', '../etc', 'a b', 'a/b', '-leading', 'x'.repeat(49), 'a;rm -rf /']) {
    assert.throws(() => assertWatcherName(bad), WatcherError, `should reject ${JSON.stringify(bad)}`);
  }
});

test('the loop body runs the command then sleeps, in that order', () => {
  assert.equal(watcherScript('gh run list', 30), 'while :; do gh run list; sleep 30; done');
});

test('start records a running watcher with its pid and persists it atomically', () => {
  const h = harness();
  try {
    const w = h.registry.start({ name: 'ci', command: 'gh run list', intervalSec: 30 });
    assert.equal(w.status, 'running');
    assert.equal(w.pid, 1000);
    assert.equal(w.intervalSec, 30);

    // Durable state is what lets a NEW process see the watcher, so assert it actually hit disk.
    const statePath = join(h.root, WATCHER_STATE_REL);
    assert.ok(existsSync(statePath), 'state file must exist');
    const onDisk = JSON.parse(readFileSync(statePath, 'utf8')) as { watchers: WatcherRecord[] };
    assert.equal(onDisk.watchers.length, 1);
    assert.equal(onDisk.watchers[0]!.name, 'ci');
  } finally {
    h.cleanup();
  }
});

test('interval is floored so a tiny value cannot spin a fork loop, and nonsense is rejected', () => {
  const h = harness();
  try {
    assert.equal(h.registry.start({ name: 'fast', command: 'true', intervalSec: 1 }).intervalSec, MIN_INTERVAL_SEC);
    assert.equal(h.registry.start({ name: 'frac', command: 'true', intervalSec: 10.4 }).intervalSec, MIN_INTERVAL_SEC);
    // A negative interval is not a small interval — it is a bad request, and silently coercing it
    // would hide the caller's mistake.
    assert.throws(
      () => h.registry.start({ name: 'neg', command: 'true', intervalSec: -5 }),
      (err: unknown) => err instanceof WatcherError && err.code === 'bad_interval',
    );
  } finally {
    h.cleanup();
  }
});

test('re-starting a live watcher is refused rather than duplicated', () => {
  const h = harness();
  try {
    h.registry.start({ name: 'ci', command: 'gh run list', intervalSec: 30 });
    assert.throws(
      () => h.registry.start({ name: 'ci', command: 'other', intervalSec: 30 }),
      (err: unknown) => err instanceof WatcherError && err.code === 'already_running',
    );
    assert.equal(h.registry.list().length, 1);
  } finally {
    h.cleanup();
  }
});

test('a watcher whose process died is reported stopped, not silently dropped', () => {
  let alive = true;
  const h = harness({ alive: () => alive });
  try {
    h.registry.start({ name: 'ci', command: 'gh run list', intervalSec: 30 });
    alive = false; // the detached loop exited while we were away
    const [w] = h.registry.list();
    assert.ok(w, 'the record must survive its process');
    assert.equal(w!.status, 'stopped');
  } finally {
    h.cleanup();
  }
});

test('an EPERM-alive process still counts as running (injected via alive seam)', () => {
  // The real defaultAlive treats EPERM as alive; this asserts the registry honours that verdict.
  const h = harness({ alive: () => true });
  try {
    h.registry.start({ name: 'ci', command: 'x', intervalSec: 30 });
    assert.equal(h.registry.list()[0]!.status, 'running');
  } finally {
    h.cleanup();
  }
});

test('a failed spawn is recorded as failed and surfaced, never as phantom success', () => {
  const h = harness({ spawn: () => null });
  try {
    const w = h.registry.start({ name: 'ci', command: 'gh run list', intervalSec: 30 });
    assert.equal(w.status, 'failed');
    assert.equal(w.pid, null);
    // It must still be in the list: a watcher that failed to start is information.
    assert.equal(h.registry.list().length, 1);
  } finally {
    h.cleanup();
  }
});

test('MAX_WATCHERS bounds how many detached processes a loop can fork', () => {
  const h = harness();
  try {
    for (let i = 0; i < MAX_WATCHERS; i++) {
      h.registry.start({ name: `w${i}`, command: 'true', intervalSec: 30 });
    }
    assert.throws(
      () => h.registry.start({ name: 'overflow', command: 'true', intervalSec: 30 }),
      (err: unknown) => err instanceof WatcherError && err.code === 'too_many',
    );
  } finally {
    h.cleanup();
  }
});

test('cancel signals the process and marks the record stopped', () => {
  const h = harness();
  try {
    const started = h.registry.start({ name: 'ci', command: 'gh run list', intervalSec: 30 });
    const stopped = h.registry.cancel('ci');
    assert.deepEqual(h.killed, [started.pid]);
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.pid, null);
    // And the change is durable, not just in memory.
    assert.equal(h.registry.list()[0]!.status, 'stopped');
  } finally {
    h.cleanup();
  }
});

test('cancel on an unknown name is an explicit error, not a silent no-op', () => {
  const h = harness();
  try {
    assert.throws(
      () => h.registry.cancel('nope'),
      (err: unknown) => err instanceof WatcherError && err.code === 'not_found',
    );
  } finally {
    h.cleanup();
  }
});

test('remove deletes the record so it stops appearing in the overlay', () => {
  const h = harness();
  try {
    h.registry.start({ name: 'ci', command: 'true', intervalSec: 30 });
    assert.equal(h.registry.remove('ci'), true);
    assert.equal(h.registry.list().length, 0);
    assert.equal(h.registry.remove('ci'), false);
  } finally {
    h.cleanup();
  }
});

test('empty or whitespace commands are rejected before anything is spawned', () => {
  const h = harness();
  try {
    assert.throws(
      () => h.registry.start({ name: 'ci', command: '   ', intervalSec: 30 }),
      (err: unknown) => err instanceof WatcherError && err.code === 'bad_command',
    );
  } finally {
    h.cleanup();
  }
});

test('a corrupt state file degrades to empty instead of bricking the feature', () => {
  const h = harness();
  try {
    const statePath = join(h.root, WATCHER_STATE_REL);
    mkdirSync(join(h.root, '.shadow'), { recursive: true });
    writeFileSync(statePath, '{ not json');
    assert.deepEqual(h.registry.list(), []);
    // And it must still be usable afterwards.
    assert.equal(h.registry.start({ name: 'ci', command: 'true', intervalSec: 30 }).status, 'running');
  } finally {
    h.cleanup();
  }
});

test('logTail returns empty for a watcher that has not written yet', () => {
  const h = harness();
  try {
    h.registry.start({ name: 'ci', command: 'true', intervalSec: 30 });
    assert.equal(h.registry.logTail('ci'), '');
  } finally {
    h.cleanup();
  }
});

test('the watcher record is never keyed by shell text: the name is validated first', () => {
  const h = harness();
  try {
    // A command-injection name must fail before spawn is ever reached.
    let spawned = false;
    const reg = new WatcherRegistry(h.root, {
      spawn: () => {
        spawned = true;
        return 1;
      },
    });
    assert.throws(() => reg.start({ name: 'a; rm -rf /', command: 'true', intervalSec: 30 }));
    assert.equal(spawned, false, 'spawn must not run for an invalid name');
  } finally {
    h.cleanup();
  }
});

// ── reaper ───────────────────────────────────────────────────────────────────────────────────
// The reaper exists because a detached loop outlives the session by design, but nothing used to
// guarantee it was ever stopped. These tests pin the three outcomes apart, because collapsing
// them would either kill watchers that are working or resurrect records that are not.

test('reap keeps a watcher that is still alive: surviving the session is the whole point', () => {
  const h = harness({ alive: () => true });
  try {
    h.registry.start({ name: 'ci', command: 'gh run list', intervalSec: 30 });
    const changed = h.registry.reap();
    assert.deepEqual(changed, [], 'a live watcher must not be reaped');
    assert.equal(h.registry.list()[0]?.status, 'running');
    assert.deepEqual(h.killed, [], 'a live watcher must never be signalled');
  } finally {
    h.cleanup();
  }
});

/**
 * Liveness that flips: alive when the watcher starts, dead afterwards. A static `alive: () => false`
 * cannot model a reap, because the record is dead from birth and the very first list() would
 * correct it before reap() ever sees it — which is exactly what these tests are asserting against.
 */
function dyingHarness() {
  let isAlive = true;
  const h = harness({ alive: () => isAlive });
  return { ...h, die: () => { isAlive = false; } };
}

test('reap marks a dead watcher stopped and keeps the record as evidence', () => {
  const h = dyingHarness();
  try {
    h.registry.start({ name: 'ci', command: 'gh run list', intervalSec: 30 });
    h.die();

    const changed = h.registry.reap();
    assert.deepEqual(changed.map((w) => w.name), ['ci']);
    const after = h.registry.list()[0]!;
    assert.equal(after.status, 'stopped');
    assert.equal(after.pid, null, 'a dead PID must be cleared so it cannot be signalled later');
    assert.equal(after.command, 'gh run list', 'the record is evidence: it must not be deleted');
    assert.deepEqual(h.killed, [], 'reap must never signal a PID it believes dead');
  } finally {
    h.cleanup();
  }
});

test('reap is idempotent: a second pass changes nothing and signals nothing', () => {
  const h = dyingHarness();
  try {
    h.registry.start({ name: 'ci', command: 'true', intervalSec: 30 });
    h.die();
    assert.equal(h.registry.reap().length, 1);
    assert.equal(h.registry.reap().length, 0, 'the record is no longer running, so nothing to do');
    assert.deepEqual(h.killed, []);
  } finally {
    h.cleanup();
  }
});

test('reap leaves a non-running record alone', () => {
  const h = harness({ alive: () => false });
  try {
    h.registry.start({ name: 'ci', command: 'true', intervalSec: 30 });
    h.registry.cancel('ci');
    assert.equal(h.registry.reap().length, 0);
  } finally {
    h.cleanup();
  }
});

test('PID recycling: a live PID that is NOT ours is treated as dead and never signalled', () => {
  // The hazard this guards: watcher dies, OS reissues its PID to something unrelated,
  // kill(pid, 0) now succeeds. Without an identity check the registry reports a phantom "running"
  // and cancel() would SIGTERM a stranger's process group.
  const root = mkdtempSync(join(tmpdir(), 'shadow-watcher-'));
  const killed: number[] = [];
  try {
    const reg = new WatcherRegistry(root, {
      now: () => 1_700_000_000_000,
      alive: () => true, // the number IS live…
      verify: () => false, // …but it is not our watcher
      spawn: () => 4242,
      kill: (pid) => {
        killed.push(pid);
        return true;
      },
    });
    reg.start({ name: 'ci', command: 'true', intervalSec: 30 });

    assert.equal(reg.list()[0]?.status, 'stopped', 'a recycled PID must not read as running');
    assert.equal(reg.reap().length, 0, 'list() already corrected it, so reap has nothing to do');

    // And the decisive one: cancelling must not signal that number.
    reg.start({ name: 'deploy', command: 'true', intervalSec: 30 });
    reg.cancel('deploy');
    assert.deepEqual(killed, [], 'a PID that fails verification must never be signalled');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reap trims a dead watcher log but keeps the tail', () => {
  const h = dyingHarness();
  try {
    h.registry.start({ name: 'ci', command: 'true', intervalSec: 30 });
    const rec = h.registry.list()[0]!;
    h.die();
    // Overshoot the cap with a recognisable last line.
    writeFileSync(rec.logPath, `${'x'.repeat(REAP_LOG_MAX_BYTES + 1024)}LAST-LINE\n`);
    h.registry.reap();
    const after = readFileSync(rec.logPath, 'utf8');
    assert.ok(after.length < REAP_LOG_MAX_BYTES, 'log should be trimmed below the cap');
    assert.ok(after.includes('LAST-LINE'), 'the tail is the part worth keeping');
    assert.ok(after.startsWith('[reaped:'), 'truncation must be labelled, not silent');
  } finally {
    h.cleanup();
  }
});

test('reap tolerates a missing log file', () => {
  const h = dyingHarness();
  try {
    h.registry.start({ name: 'ci', command: 'true', intervalSec: 30 });
    rmSync(h.registry.list()[0]!.logPath, { force: true });
    h.die();
    assert.deepEqual(h.registry.reap().map((w) => w.name), ['ci']);
  } finally {
    h.cleanup();
  }
});
