/**
 * Landlock launcher grammar — the argument contract between TypeScript and the C launcher.
 *
 * The C side is exercised for real in a Linux container (see docs/DEEP_REVIEW_2026-10-18.md), but
 * the *grammar* is pure and testable anywhere: which paths land in the read set, which in the write
 * set, and — the bug that actually shipped — that `--ro` is never mistaken for `--rw`. A read-only
 * mode that silently grants writes is worse than no sandbox, because it reports containment it does
 * not have.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { buildLandlockArgs, standardReadRoots, standardWritableDevices } from '../src/safety/landlock.js';

test('buildLandlockArgs emits --ro for reads and --rw for writes, in that order', () => {
  const argv = buildLandlockArgs('echo hi', {
    launcher: '/x/shadow-landlock',
    allowedRead: ['/usr', '/lib'],
    writableRoots: ['/ws'],
  });
  assert.deepEqual(argv, [
    '--ro',
    '/usr',
    '--ro',
    '/lib',
    '--rw',
    '/ws',
    '--',
    '/bin/sh',
    '-c',
    'echo hi',
  ]);
});

test('every read path is prefixed with --ro, never --rw', () => {
  const reads = ['/usr', '/lib', '/bin', '/etc/ssl/certs'];
  const argv = buildLandlockArgs('true', {
    launcher: '/x/l',
    allowedRead: reads,
    writableRoots: [],
  });
  // Pair them up: argv is [--ro, path, --ro, path, ...] up to the `--` separator.
  const end = argv.indexOf('--');
  const pairs = argv.slice(0, end);
  assert.equal(pairs.length, reads.length * 2);
  for (let i = 0; i < pairs.length; i += 2) {
    assert.equal(pairs[i], '--ro', `read path ${pairs[i + 1]} must be --ro`);
    assert.equal(pairs[i + 1], reads[i / 2]);
  }
});

test('the command tail is separated by -- so it cannot be parsed as a flag', () => {
  const argv = buildLandlockArgs('--ro /etc', {
    launcher: '/x/l',
    allowedRead: ['/usr'],
    writableRoots: [],
  });
  const sep = argv.indexOf('--');
  assert.ok(sep > 0, 'a -- separator must exist');
  assert.equal(argv[sep + 1], '/bin/sh');
  // A command whose text looks like a flag stays behind the separator.
  assert.equal(argv[sep + 3], '--ro /etc');
});

test('a custom shell is honoured', () => {
  const argv = buildLandlockArgs('true', {
    launcher: '/x/l',
    allowedRead: [],
    writableRoots: [],
    shell: '/bin/bash',
  });
  assert.equal(argv[argv.indexOf('--') + 1], '/bin/bash');
});

test('standardReadRoots includes the runtime and the workspace, but not $HOME', () => {
  const roots = standardReadRoots('/ws/project');
  assert.ok(roots.includes(resolve('/ws/project')), 'the workspace must be readable');
  assert.ok(roots.includes(resolve('/usr')), 'the runtime must be readable');
  // The whole point of read confinement is that credentials under $HOME are NOT implicitly readable.
  const home = resolve(homedir());
  assert.ok(
    !roots.includes(home),
    `$HOME (${home}) must not be in the default read set — that is where credentials live`,
  );
});

test('standardReadRoots is absolute', () => {
  for (const p of standardReadRoots('/ws')) {
    assert.ok(p.startsWith('/'), `${p} must be absolute`);
  }
});

test('standardWritableDevices are the harmless sinks a shell needs, granted write', () => {
  const devs = standardWritableDevices();
  for (const d of ['/dev/null', '/dev/zero', '/dev/full', '/dev/tty']) {
    assert.ok(devs.includes(resolve(d)), `${d} must be writable so ordinary redirection works`);
  }
  // Nothing under $HOME or the workspace: this list must not widen the write set.
  for (const d of devs) {
    assert.ok(d.startsWith('/dev/'), `${d} must be a device node`);
  }
});

test('the Landlock launcher documents that inode metadata is not mediated', () => {
  // Landlock has no chmod/chown/utimes access bit, so a read-only ruleset still permits metadata
  // changes. That is a real limitation, and the one place it must never be silently lost is the
  // source of truth — otherwise a later change may start describing the sandbox as "no
  // modification" when it only means "no content modification".
  const src = readFileSync(new URL('../native/shadow-landlock.c', import.meta.url), 'utf8');
  assert.match(src, /INODE METADATA IS NOT MEDIATED/);
  assert.match(src, /chmod/);
  assert.match(src, /no content modification/i);
});