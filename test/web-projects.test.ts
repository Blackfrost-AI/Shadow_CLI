import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { realpathSync } from 'node:fs';
import { request } from 'node:http';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

// Redirect ~/.shadow to a throwaway HOME BEFORE importing (GLOBAL_DIR + the SENSITIVE list derive
// from homedir() at module load), and PROVE it took — addProject writes the global config.json, so
// a runner ignoring process.env.HOME would mutate a real ~/.shadow. `npm test`, never `bun test`.
const { home: HOME } = isolateHome('projects');

const projects = await import('../src/web/projects.js');
const store = await import('../src/state/globalStore.js');
assertStoreIsolated(store.GLOBAL_DIR, HOME);

const isDarwin = process.platform === 'darwin';
const mk = (rel: string): string => {
  const p = join(HOME, rel);
  mkdirSync(p, { recursive: true });
  return p;
};

test('the deny gauntlet refuses dangerous roots', () => {
  assert.throws(() => projects.addProject('/'), /filesystem root/);
  assert.throws(() => projects.addProject(HOME), /home directory/);
  // A PARENT of the (isolated) home stands in for /Users — an ancestor of $HOME.
  assert.throws(() => projects.addProject(dirname(HOME)), /parent of your home/);
  assert.throws(() => projects.addProject(store.GLOBAL_DIR), /\.shadow/);
  // ~/.ssh is refused even though it does not exist — rule 5 runs before the exists check, and it
  // is a DESCENDANT of $HOME that rule 3 (ancestors only) would miss.
  assert.throws(() => projects.addProject(join(HOME, '.ssh')), /sensitive directory/);
  assert.throws(() => projects.addProject(join(HOME, 'Library', 'Keychains')), /sensitive directory/);
});

test('a case-mismatched home is refused on darwin (the deny check fails closed, not open)', () => {
  if (!isDarwin) return;
  // path.relative is case-sensitive on darwin, so an exact `=== homedir()` check would be bypassed
  // by a differently-cased spelling; the deny gauntlet folds case. Re-case only the basename so the
  // (already canonical) /private/var prefix stays intact and the mismatch is purely case.
  const canonHome = realpathSync(HOME);
  const miscased = join(dirname(canonHome), canonHome.slice(dirname(canonHome).length + 1).toUpperCase());
  assert.throws(() => projects.assertProjectAddable(miscased), /home directory/);
});

test('a file is refused; a non-existent path is refused and NOT created', () => {
  const filePath = join(HOME, 'notadir.txt');
  writeFileSync(filePath, 'x');
  assert.throws(() => projects.addProject(filePath), /not a directory/);

  const ghost = join(HOME, 'does', 'not', 'exist');
  assert.throws(() => projects.addProject(ghost), /does not exist/);
  assert.equal(existsSync(ghost), false, 'the allowlist POST did not create the directory');
});

test('add / list / remove round-trips, and tilde expands to an absolute path at write time', () => {
  const proj = mk('code/app');
  const entry = projects.addProject('~/code/app', 'My App');
  assert.equal(entry.path, realpathSync(proj), 'stored path is absolute + realpath, not "~/…"');
  assert.equal(entry.label, 'My App');
  assert.match(entry.id, /^[0-9a-f]{12}$/, 'opaque 12-hex id');

  assert.equal(projects.listProjects().length, 1);
  assert.equal(projects.removeProject(entry.id), true);
  assert.equal(projects.listProjects().length, 0);
  assert.equal(projects.removeProject(entry.id), false, 'removing a gone id is false, never throws');
});

test('trailing slash and .. normalize to the SAME single entry (idempotent add)', () => {
  const proj = mk('ws/one');
  const a = projects.addProject(proj + '/');
  const b = projects.addProject(proj + '/../one');
  assert.equal(a.id, b.id, 'same directory → same entry');
  assert.equal(projects.listProjects().filter((e) => e.path === realpathSync(proj)).length, 1);
});

test('a sibling dir is not treated as contained (/foo/bar vs /foo/barbaz)', () => {
  const bar = mk('sib/bar');
  mk('sib/barbaz');
  projects.addProject(bar);
  // resolveJail of the sibling must THROW — barbaz is not inside bar, and startsWith would wrongly
  // match. (Uses contains(), not startsWith.)
  assert.throws(() => projects.resolveJail(join(HOME, 'sib', 'barbaz')), /not an allowlisted/);
});

test('resolveJail returns a frozen jail for an allowlisted root and throws after revocation', () => {
  const proj = mk('jailed/here');
  const entry = projects.addProject(proj);
  const jail = projects.resolveJail(proj);
  assert.equal(jail.workspaceRoot, realpathSync(proj), 'pinned realpath root');
  assert.deepEqual(jail.additionalRoots, [], 'no extra roots on the wire');
  assert.equal(Object.isFrozen(jail), true);

  // Fresh re-read from disk on every call: revoke, then resolveJail must throw (no TOCTOU trust).
  projects.removeProject(entry.id);
  assert.throws(() => projects.resolveJail(proj), /not an allowlisted/);
});

test('a /tmp path normalizes through the /private symlink and still resolves (darwin)', () => {
  if (!isDarwin) return;
  const tmpProj = mkdtempSync('/tmp/shadow-proj-');
  try {
    const entry = projects.addProject(tmpProj); // stored as /private/tmp/…
    assert.ok(entry.path.startsWith('/private/tmp/'), `realpath'd through /private (${entry.path})`);
    // Adding via the /tmp spelling resolves to the SAME entry — normalize realpaths both sides.
    const jail = projects.resolveJail(tmpProj);
    assert.equal(jail.workspaceRoot, entry.path);
  } finally {
    rmSync(tmpProj, { recursive: true, force: true });
  }
});

// ── /api/projects routes (against the ISOLATED home — the server writes global config.json) ──

const server = await import('../src/web/server.js');
const { EventBus } = await import('../src/agent/events.js');

function req(
  port: number,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          host: `127.0.0.1:${port}`,
          authorization: `Bearer ${token}`,
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : {} }));
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

test('POST /api/projects: valid dir is 200, dangerous roots are 403, GET lists, remove revokes', async () => {
  store.saveGlobalConfig({ projects: [] }); // isolate from entries the earlier unit tests left behind
  const h = await server.startWebServer({ bus: new EventBus() });
  const proj = mk('served/app');
  try {
    // A valid directory is accepted.
    const add = await req(h.port, 'POST', '/api/projects', h.token, { path: proj, label: 'Served' });
    assert.equal(add.status, 200);
    const entry = add.json.project as { id: string; path: string; label: string };
    assert.equal(entry.label, 'Served');

    // Dangerous roots are refused with 403 (not 400 — the request is well-formed).
    for (const bad of ['/', HOME, store.GLOBAL_DIR, join(HOME, '.ssh')]) {
      const r = await req(h.port, 'POST', '/api/projects', h.token, { path: bad });
      assert.equal(r.status, 403, `${bad} → 403`);
    }

    // GET lists exactly the one we added.
    const list = await req(h.port, 'GET', '/api/projects', h.token);
    assert.equal(list.status, 200);
    assert.equal((list.json.projects as unknown[]).length, 1);

    // Removal always succeeds (keyed on the opaque id in the body, never a path in the URL).
    const rm = await req(h.port, 'POST', '/api/projects/remove', h.token, { id: entry.id });
    assert.equal(rm.status, 200);
    assert.equal(rm.json.removed, true);
    const after = await req(h.port, 'GET', '/api/projects', h.token);
    assert.equal((after.json.projects as unknown[]).length, 0);
  } finally {
    await h.close();
  }
});
