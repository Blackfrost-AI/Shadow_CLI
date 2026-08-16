import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAcpArgs } from '../src/acp/cli.js';

/**
 * The `shadow acp` entry point: argument parsing (unit) + the stdout-purity and shutdown-drain
 * wiring that only a spawned process could exercise end-to-end, pinned structurally.
 */

test('parseAcpArgs: no args, --add-project (space and = forms), repeatable', () => {
  assert.deepEqual(parseAcpArgs([]), { addProjects: [], help: false });
  assert.deepEqual(parseAcpArgs(['--add-project', '/a']), { addProjects: ['/a'], help: false });
  assert.deepEqual(parseAcpArgs(['--add-project=/b']), { addProjects: ['/b'], help: false });
  assert.deepEqual(parseAcpArgs(['--add-project', '/a', '--add-project=/a', '--add-project', '/c']), {
    addProjects: ['/a', '/a', '/c'],
    help: false,
  });
});

test('parseAcpArgs: --help / -h', () => {
  assert.deepEqual(parseAcpArgs(['--help']), { addProjects: [], help: true });
  assert.deepEqual(parseAcpArgs(['-h']), { addProjects: [], help: true });
});

test('parseAcpArgs: unknown flags and a missing path throw loudly', () => {
  assert.throws(() => parseAcpArgs(['--add-projct', '/a']), /unknown argument/);
  assert.throws(() => parseAcpArgs(['--add-project']), /needs a <path>/);
});

test('shutdown destroys stdin — a signal-path teardown must not leave the process undead', () => {
  // On SIGINT/SIGTERM the editor never closes our stdin, and the open pipe with its 'data'
  // listener keeps the event loop referenced: without destroying the handle, `shadow acp`
  // would outlive its own teardown (registers handlers also remove Node's default death).
  const src = readFileSync(fileURLToPath(new URL('../src/acp/cli.ts', import.meta.url)), 'utf8');
  const start = src.indexOf('const shutdown =');
  const end = src.indexOf('// Editor exits'); // the first line AFTER the shutdown definition
  assert.ok(start > 0 && end > start, 'the shutdown definition is where the source structure expects it');
  const shutdown = src.slice(start, end);
  assert.ok(shutdown.includes('process.stdin.destroy()'), 'the shutdown path destroys the stdin handle');
});

test('RPC mode writes diagnostics to stderr only — stdout stays the wire', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/acp/cli.ts', import.meta.url)), 'utf8');
  const rpcMode = src.slice(src.indexOf('for (const raw of args.addProjects)'));
  const stdoutWrites = rpcMode.match(/process\.stdout\.write/g) ?? [];
  assert.equal(stdoutWrites.length, 1, 'exactly one stdout writer once RPC mode starts (help text is pre-RPC)');
  const peerLine = src.match(/\(line\) => process\.stdout\.write\(line\)/);
  assert.ok(peerLine, 'and it is the RPC peer itself — no other write can corrupt the wire');
});
