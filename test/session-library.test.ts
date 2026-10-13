import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, symlinkSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SessionLibrary } from '../src/state/sessionLibrary.js';
import { removeFixtureTree } from './helpers/removeFixtureTree.js';

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'shadow-session-library-')));
  const root = join(base, 'current'); const other = join(base, "other's project"); const hidden = join(base, 'not-selected');
  for (const path of [root, other, hidden]) mkdirSync(join(path, '.shadow', 'sessions'), { recursive: true });
  return { base, root, other, hidden, stateDir: join(base, 'user-state') };
}
function session(root: string, name: string, records: unknown[]): string {
  const path = join(root, '.shadow', 'sessions', `${name}.jsonl`);
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n'); return path;
}
const user = (text: string) => ({ kind: 'user', task: text, ts: '2026-10-12T12:00:00Z' });
const answer = (text: string) => ({ kind: 'event', type: 'assistant_done', text });
const snapshot = { kind: 'context_snapshot', data: { messages: [] } };
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('library searches only selected project roots, preserves transcripts, and never persists snippets', async () => {
  const f = fixture();
  const own = session(f.root, '2026-own', [user('Current task'), answer('Visible UNIQUE_TRANSCRIPT_SENTINEL result'), snapshot]);
  const external = session(f.other, '2026-external', [user('External task'), answer('Visible result'), snapshot]);
  session(f.hidden, '2026-hidden', [user('Hidden task'), answer('Visible result'), snapshot]);
  const before = digest(own);
  const library = new SessionLibrary(f.root, { stateDir: f.stateDir, sessionDirOverride: null });
  try {
    assert.deepEqual((await library.search('visible')).sessions.map((item) => item.path), [own]);
    library.addProject(f.other);
    const found = await library.search('visible');
    assert.equal(found.sessions.length, 2); assert.ok(!found.sessions.some((item) => item.projectRoot === f.hidden));
    const ownRow = found.sessions.find((item) => item.path === own)!;
    assert.equal(ownRow.canResumeHere, true); assert.equal(ownRow.resumable, true);
    assert.match(ownRow.snippet, /UNIQUE_TRANSCRIPT_SENTINEL/);
    const externalRow = found.sessions.find((item) => item.path === external)!;
    assert.equal(externalRow.canResumeHere, false); assert.equal(externalRow.navigation.workspaceRoot, f.other);
    if (process.platform === 'win32') {
      assert.match(externalRow.navigation.command, /other''s project/);
      assert.match(externalRow.navigation.command, /^if \(Set-Location -LiteralPath .* -PassThru -ErrorAction Stop\) \{ shadow resume --session /);
    } else {
      assert.match(externalRow.navigation.command, /other'\\''s project/);
      assert.match(externalRow.navigation.command, /^cd .* && shadow resume --session /);
    }
    library.removeProject(f.other); assert.deepEqual((await library.search('visible')).sessions.map((item) => item.path), [own]);
    assert.equal(digest(own), before, 'search and metadata actions never modify transcript bytes');
    assert.doesNotMatch(readFileSync(library.path).toString('utf8'), /UNIQUE_TRANSCRIPT_SENTINEL/);
    if (process.platform !== 'win32') assert.equal(statSync(library.path).mode & 0o777, 0o600);
  } finally { library.close(); await removeFixtureTree(f.base); }
});

test('pins and tags survive reopening, independent metadata updates merge, and removing roots purges metadata', async () => {
  const f = fixture();
  const own = session(f.root, 'a', [user('first'), snapshot]);
  const external = session(f.other, 'z', [user('second'), snapshot]);
  let library = new SessionLibrary(f.root, { stateDir: f.stateDir, sessionDirOverride: null });
  try {
    library.addProject(f.other); library.setPinned(own, true); library.setTags(own, ['release', 'release', 'audit']);
    const concurrent = new SessionLibrary(f.root, { stateDir: f.stateDir, sessionDirOverride: null });
    try { concurrent.setTags(own, ['updated']); library.setPinned(own, false); }
    finally { concurrent.close(); }
    library.setPinned(external, true); library.setTags(external, ['firm']); library.close();
    library = new SessionLibrary(f.root, { stateDir: f.stateDir, sessionDirOverride: null });
    const found = await library.search();
    assert.equal(found.sessions[0]?.path, external, 'pins sort before recency');
    assert.deepEqual(found.sessions.find((item) => item.path === own)?.tags, ['updated']);
    assert.equal((await library.search('', { tag: 'firm', pinnedOnly: true })).sessions[0]?.path, external);
    library.removeProject(f.other); library.addProject(f.other);
    const restoredRoot = (await library.search()).sessions.find((item) => item.path === external)!;
    assert.equal(restoredRoot.pinned, false); assert.deepEqual(restoredRoot.tags, []);
    assert.throws(() => library.setPinned(join(f.hidden, '.shadow/sessions/nope.jsonl'), true), /not in a selected/);
    assert.throws(() => library.setTags(own, ['\x1btag']), /control characters/);
  } finally { library.close(); await removeFixtureTree(f.base); }
});

test('current workspaces are not silently added as persistent cross-project roots', async () => {
  const f = fixture();
  const first = new SessionLibrary(f.root, { stateDir: f.stateDir, sessionDirOverride: null }); first.close();
  const second = new SessionLibrary(f.other, { stateDir: f.stateDir, sessionDirOverride: null });
  try { assert.deepEqual(second.projects().map((item) => item.path), [f.other]); }
  finally { second.close(); await removeFixtureTree(f.base); }
});

test('shared session override is searched once and never attributed to every selected project', async () => {
  const f = fixture(); const shared = join(f.base, 'shared'); mkdirSync(join(shared, 'sessions'), { recursive: true });
  const sharedLog = join(shared, 'sessions', 'shared.jsonl'); writeFileSync(sharedLog, `${JSON.stringify(user('shared owner unknown'))}\n${JSON.stringify(snapshot)}\n`);
  const external = session(f.other, 'external', [user('external known'), snapshot]);
  const library = new SessionLibrary(f.root, { stateDir: f.stateDir, sessionDirOverride: shared });
  try {
    library.addProject(f.other); const found = await library.search();
    assert.equal(found.sessions.length, 2);
    const unknown = found.sessions.find((item) => item.path === sharedLog)!;
    assert.equal(unknown.projectRoot, null); assert.equal(unknown.canResumeHere, false); assert.equal(unknown.navigation.workspaceRoot, undefined);
    assert.equal(found.sessions.find((item) => item.path === external)?.projectRoot, f.other);
    assert.match(found.notices.join(' '), /unknown workspace ownership/);
  } finally { library.close(); await removeFixtureTree(f.base); }
});

test('lineage and search snippets use recorded events, skip snapshot copies/opaque frames and tolerate malformed lines', async () => {
  const f = fixture();
  const path = session(f.root, 'fork', [user('first title'), { kind: 'forked_from', sessionId: 'parent', path: '/unselected/parent.jsonl' },
    { kind: 'session_title', title: 'Named session' }, { kind: 'event', type: 'tool_end', result: { summary: 'tool summary', data: { excerpt: 'tool searchable phrase' } } },
    { kind: 'context_snapshot', data: { messages: [{ content: 'SNAPSHOT_ONLY_TOKEN' }] } },
    { kind: 'raw_frame', data: 'OPAQUE_ONLY_TOKEN' }, { kind: 'resumed_from', sessionId: 'new-parent', path: '/unselected/new-parent.jsonl' }]);
  writeFileSync(path, readFileSync(path, 'utf8') + '{broken}\n');
  const library = new SessionLibrary(f.root, { stateDir: f.stateDir, sessionDirOverride: null });
  try {
    const found = await library.search('searchable phrase'); const entry = found.sessions[0]!;
    assert.equal(entry.title, 'Named session'); assert.equal(entry.lineage?.parentId, 'new-parent'); assert.equal(entry.lineage?.kind, 'resumed_from');
    assert.equal(entry.match?.kind, 'tool_end'); assert.ok(entry.match!.byteOffset > 0);
    assert.equal((await library.search('SNAPSHOT_ONLY_TOKEN')).sessions.length, 0); assert.equal((await library.search('OPAQUE_ONLY_TOKEN')).sessions.length, 0);
    assert.match(found.notices.join(' '), /malformed JSONL/);
    assert.equal(existsSync('/unselected/new-parent.jsonl'), false, 'lineage is metadata only; no referenced paths opened');
  } finally { library.close(); await removeFixtureTree(f.base); }
});

test('bounded head/tail search reports incomplete coverage, total and result limits, and supports cancellation', async () => {
  const f = fixture();
  session(f.root, 'a-big', [user('HEAD_MATCH'), ...Array.from({ length: 60 }, (_, i) => answer(`MIDDLE_${i} ${'x'.repeat(80)}`)), answer('TAIL_MATCH'), snapshot]);
  session(f.root, 'z-small', [user('TAIL_MATCH tiny'), snapshot]);
  const library = new SessionLibrary(f.root, { stateDir: f.stateDir, sessionDirOverride: null,
    limits: { maxFileBytes: 800, maxTotalBytes: 1000, maxLineBytes: 300 } });
  try {
    const found = await library.search('TAIL_MATCH', { limit: 1 });
    assert.equal(found.sessions.length, 1); assert.equal(found.truncated, true); assert.ok(found.scannedBytes <= 1000);
    assert.match(found.notices.join(' '), /omitted middle bytes|additional matches omitted/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(library.search('', { signal: controller.signal }), /abort/i);
  } finally { library.close(); await removeFixtureTree(f.base); }
});

test('session files/store symlinks cannot silently expand the search scope', async () => {
  if (process.platform === 'win32') return;
  const f = fixture(); const secret = session(f.hidden, 'secret', [user('OUTSIDE_SENTINEL')]);
  symlinkSync(secret, join(f.root, '.shadow/sessions/linked.jsonl'));
  const library = new SessionLibrary(f.root, { stateDir: f.stateDir, sessionDirOverride: null });
  try {
    assert.equal((await library.search('OUTSIDE_SENTINEL')).sessions.length, 0);
    assert.throws(() => library.setPinned(join(f.root, '.shadow/sessions/linked.jsonl'), true), /regular session/);
    const symlinkProject = join(f.base, 'symlink-project'); mkdirSync(join(symlinkProject, '.shadow'), { recursive: true });
    symlinkSync(join(f.hidden, '.shadow/sessions'), join(symlinkProject, '.shadow/sessions')); library.addProject(symlinkProject);
    const found = await library.search('OUTSIDE_SENTINEL'); assert.equal(found.sessions.length, 0);
    assert.match(found.notices.join(' '), /outside its selected project/);
  } finally { library.close(); await removeFixtureTree(f.base); }
});

test('newer SQLite schema is refused without rewriting it', async () => {
  const f = fixture(); mkdirSync(f.stateDir);
  const path = join(f.stateDir, 'session-library.sqlite'); const db = new DatabaseSync(path); db.exec('PRAGMA user_version=99'); db.close();
  try {
    assert.throws(() => new SessionLibrary(f.root, { stateDir: f.stateDir, sessionDirOverride: null }), /newer than/);
    const verify = new DatabaseSync(path); assert.equal((verify.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 99); verify.close();
  } finally { await removeFixtureTree(f.base); }
});
