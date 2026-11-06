// sshRemote tests — controlled fixtures only. The SSH command surface is a
// injected fake runner that simulates a remote filesystem in a local map; NO
// real network is ever touched. The real runner is untested by design: this
// repository has no live authorized target in CI.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSshRemote,
  remoteWriteApprovalDigest,
  parseProbeOutput,
  withinPrefix,
  type SshRunner,
  type PinnedHost,
  type RunnerSpec,
  type RunnerResult,
} from '../src/tools/sshRemote.js';

const PIN = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const OTHER_PIN = 'SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';
const PREFIX = '/srv/data';

function sha256hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'shadow-ssh-remote-'));
  mkdirSync(join(root, 'inbox'), { recursive: true });
  return root;
}

/** One simulated remote filesystem, addressable by exact path. */
class FakeRemoteFs {
  public files = new Map<string, Buffer>();
  public dirs = new Set<string>([PREFIX]);
  public calls: RunnerSpec[] = [];
  public presentedFingerprint = PIN;
  public connectRefused = false;
  public writeFailures = new Set<number>(); // call indices (within write kind) that fail
  public readFailures = new Set<number>();
  public probeFailures = new Set<string>();
  /** Paths whose probe fails only from its Nth invocation onward (count resets only via probeCounts.clear()). */
  public probeFailAfter = new Map<string, number>();
  public probeCounts = new Map<string, number>();

  snapshot(): { files: Record<string, string>; calls: Array<RunnerSpec['kind']> } {
    return {
      files: Object.fromEntries([...this.files].map(([path, bytes]) => [path, bytes.toString('utf8')])),
      calls: this.calls.map((spec) => spec.kind),
    };
  }
}

/**
 * The injected fake runner: simulates the full protocol surface exactly as the
 * real runner would — connect reports the presented fingerprint, probe reports
 * size+digest or MISSING/TYPE, read returns bytes, write stores stdin.
 */
function makeFakeRunner(fs: FakeRemoteFs): SshRunner {
  return async (spec: RunnerSpec): Promise<RunnerResult> => {
    fs.calls.push(spec);
    const host = spec.host as PinnedHost;
    assert.ok(host && typeof host.alias === 'string', 'runner must receive a pinned host object');
    if (spec.kind === 'connect') {
      if (fs.connectRefused) return { exitCode: 255, stdout: Buffer.alloc(0), stderr: 'connection refused' };
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: '', presentedFingerprint: fs.presentedFingerprint };
    }
    if (spec.kind === 'probe') {
      const path = spec.remotePath!;
      const count = (fs.probeCounts.get(path) ?? 0) + 1;
      fs.probeCounts.set(path, count);
      const failAfter = fs.probeFailAfter.get(path);
      if (fs.probeFailures.has(path) || (failAfter !== undefined && count > failAfter)) {
        return { exitCode: 1, stdout: Buffer.alloc(0), stderr: 'probe failed' };
      }
      if (!fs.files.has(path)) return { exitCode: 0, stdout: Buffer.from('MISSING\n'), stderr: '' };
      const bytes = fs.files.get(path)!;
      return { exitCode: 0, stdout: Buffer.from(`${bytes.length}\n${sha256hex(bytes)}\n`), stderr: '' };
    }
    if (spec.kind === 'read') {
      const index = fs.calls.filter((call) => call.kind === 'read').length - 1;
      if (fs.readFailures.has(index)) return { exitCode: 1, stdout: Buffer.alloc(0), stderr: 'read failed' };
      const bytes = fs.files.get(spec.remotePath!);
      if (!bytes) return { exitCode: 1, stdout: Buffer.alloc(0), stderr: 'no such file' };
      return { exitCode: 0, stdout: bytes, stderr: '' };
    }
    if (spec.kind === 'write') {
      const index = fs.calls.filter((call) => call.kind === 'write').length - 1;
      if (fs.writeFailures.has(index)) return { exitCode: 1, stdout: Buffer.alloc(0), stderr: 'write failed' };
      fs.files.set(spec.remotePath!, spec.payload!);
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: '' };
    }
    throw new Error(`unexpected runner kind: ${spec.kind}`);
  };
}

function makeRemote(root: string, runner: SshRunner, hostOverrides: Record<string, unknown> = {}) {
  return createSshRemote(root, [{
    alias: 'lab',
    address: 'lab.invalid',
    user: 'operator',
    hostKeyFingerprint: PIN,
    allowedPrefix: PREFIX,
    ...hostOverrides,
  }], { runner });
}

// ── Configuration model ─────────────────────────────────────────────────────

test('unconfigured host is refused outright with zero runner calls', async () => {
  const root = workspace();
  const fs = new FakeRemoteFs();
  const remote = makeRemote(root, makeFakeRunner(fs));
  try {
    await assert.rejects(() => remote.readRemote({ host: 'evil', items: [{ remotePath: `${PREFIX}/a`, localPath: 'inbox/a' }] }),
      /not configured: evil/);
    await assert.rejects(() => remote.prepareWrite({ host: 'evil', items: [{ remotePath: `${PREFIX}/a`, content: 'x' }] }),
      /not configured: evil/);
    assert.equal(fs.calls.length, 0, 'no runner call may be made for an unconfigured host');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('host configuration is validated and frozen at construction', async () => {
  const root = workspace();
  const fs = new FakeRemoteFs();
  const runner = makeFakeRunner(fs);
  try {
    assert.throws(() => makeRemote(root, runner, { hostKeyFingerprint: 'md5:aa' }), /canonical OpenSSH form/);
    assert.throws(() => makeRemote(root, runner, { allowedPrefix: '/' }), /narrower than \//);
    assert.throws(() => makeRemote(root, runner, { address: 'lab.invalid:22' }), /hostname or IPv4 literal/);
    assert.throws(() => makeRemote(root, runner, { user: 'ro ot' }), /must match/);
    assert.throws(() => makeRemote(root, runner, { allowedPrefix: 'relative/path' }), /invalid/);
    assert.throws(() => makeRemote(root, runner, { maxReadBytes: 0 }), /maxReadBytes/);
    assert.equal(fs.calls.length, 0, 'validation happens before any runner call');
    // The pinned host is frozen: per-call mutation attempts must not change it.
    const remote = makeRemote(root, runner);
    await assert.rejects(() => remote.readRemote({
      host: 'lab', items: [{ remotePath: `${PREFIX}/a`, localPath: 'inbox/a' }],
      agentForwarding: true,
    } as never), /not configured for host lab/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('no runner and no realRunner opt-in fails closed', async () => {
  const root = workspace();
  try {
    const remote = createSshRemote(root, [{
      alias: 'lab', address: 'lab.invalid', user: 'operator',
      hostKeyFingerprint: PIN, allowedPrefix: PREFIX,
    }]);
    await assert.rejects(() => remote.readRemote({ host: 'lab', items: [{ remotePath: `${PREFIX}/a`, localPath: 'inbox/a' }] }),
      /No SSH runner configured/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── Host-key verification ────────────────────────────────────────────────────

test('host-key mismatch aborts with the specific fingerprint diff before any command', async () => {
  const root = workspace();
  const fs = new FakeRemoteFs();
  fs.presentedFingerprint = OTHER_PIN;
  fs.files.set(`${PREFIX}/a`, Buffer.from('secret'));
  const remote = makeRemote(root, makeFakeRunner(fs));
  try {
    await assert.rejects(() => remote.readRemote({ host: 'lab', items: [{ remotePath: `${PREFIX}/a`, localPath: 'inbox/a' }] }),
      new RegExp(`pinned ${PIN}.*presented ${OTHER_PIN}`));
    // Only the connect call happened: no probe, read or write was issued.
    assert.deepEqual(fs.calls.map((c) => c.kind), ['connect']);
    await assert.rejects(() => remote.prepareWrite({ host: 'lab', items: [{ remotePath: `${PREFIX}/a`, content: 'x' }] }),
      new RegExp(`pinned ${PIN}.*presented ${OTHER_PIN}`));
    assert.deepEqual(fs.calls.map((c) => c.kind), ['connect', 'connect']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('no presented host key aborts with no probe issued', async () => {
  const root = workspace();
  const fs = new FakeRemoteFs();
  // The server presented no host key at all (empty fingerprint).
  fs.presentedFingerprint = '';
  const remote = makeRemote(root, makeFakeRunner(fs));
  try {
    await assert.rejects(() => remote.readRemote({ host: 'lab', items: [{ remotePath: `${PREFIX}/a`, localPath: 'inbox/a' }] }),
      /no host key was presented/);
    assert.deepEqual(fs.calls.map((c) => c.kind), ['connect']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── Agent forwarding ─────────────────────────────────────────────────────────

test('agent forwarding is off by default and per-call requests are refused pre-connection', async () => {
  const root = workspace();
  const fs = new FakeRemoteFs();
  fs.files.set(`${PREFIX}/a`, Buffer.from('secret'));
  const remote = makeRemote(root, makeFakeRunner(fs));
  try {
    await assert.rejects(() => remote.readRemote({
      host: 'lab', items: [{ remotePath: `${PREFIX}/a`, localPath: 'inbox/a' }], agentForwarding: true,
    } as never), /cannot be enabled per call/);
    assert.equal(fs.calls.length, 0, 'refusal must precede any connection');
    // The default flow carries ForwardAgent=no and ClearAllForwardings=yes.
    await remote.readRemote({ host: 'lab', items: [{ remotePath: `${PREFIX}/a`, localPath: 'inbox/a' }] });
    const sshCalls = fs.calls.filter((c) => c.kind !== 'connect');
    for (const call of sshCalls) {
      assert.ok(call.argv.includes('ForwardAgent=no'), 'every ssh argv must pin ForwardAgent=no');
      assert.ok(call.argv.includes('ClearAllForwardings=yes'), 'every ssh argv must clear all forwardings');
      assert.ok(!call.argv.includes('-A'), 'argv must never use the -A shorthand');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('agent forwarding opt-in host configuration builds ForwardAgent=yes and per-call refusal disappears', async () => {
  const root = workspace();
  const fs = new FakeRemoteFs();
  fs.files.set(`${PREFIX}/a`, Buffer.from('secret'));
  const remote = makeRemote(root, makeFakeRunner(fs), { allowAgentForwarding: true });
  try {
    await remote.readRemote({
      host: 'lab', items: [{ remotePath: `${PREFIX}/a`, localPath: 'inbox/a' }], agentForwarding: true,
    } as never);
    const sshCalls = fs.calls.filter((c) => c.kind !== 'connect');
    assert.ok(sshCalls.length > 0);
    for (const call of sshCalls) {
      assert.ok(call.argv.includes('ForwardAgent=yes'));
      assert.ok(!call.argv.includes('ClearAllForwardings=yes'));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── Bounded remote paths ────────────────────────────────────────────────────

test('out-of-prefix paths are refused before any connection', async () => {
  const root = workspace();
  const fs = new FakeRemoteFs();
  const remote = makeRemote(root, makeFakeRunner(fs));
  const outside = [
    '/etc/passwd',
    '/srv/other/file',
    `${PREFIX}x/file`,            // sibling by suffix — NOT under the prefix
    `${PREFIX}/../escape`,       // normalizes outside the prefix
    '/srv/data2/file',           // sibling directory
    'relative/path',
  ];
  try {
    for (const path of outside) {
      await assert.rejects(() => remote.readRemote({ host: 'lab', items: [{ remotePath: path, localPath: 'inbox/a' }] }),
        /outside the allowed prefix|must be absolute/);
      await assert.rejects(() => remote.prepareWrite({ host: 'lab', items: [{ remotePath: path, content: 'x' }] }),
        /outside the allowed prefix|must be absolute/);
    }
    assert.equal(fs.calls.length, 0, 'path refusal must precede any connection');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('withinPrefix is exact-prefix containment only', () => {
  assert.ok(withinPrefix('/srv/data/a', '/srv/data'));
  assert.ok(withinPrefix('/srv/data', '/srv/data'));
  assert.ok(!withinPrefix('/srv/data2/a', '/srv/data'));
  assert.ok(!withinPrefix('/srv', '/srv/data'));
});

// └ helper boundary check for probe parsing (pure function)

test('bounded reads refuse oversize at probe layer and enforce the cap on received bytes', async () => {
  const root = workspace();
  const fs = new FakeRemoteFs();
  fs.files.set(`${PREFIX}/big`, Buffer.from('a'.repeat(3000)));
  const remote = makeRemote(root, makeFakeRunner(fs), { maxReadBytes: 1024 });
  try {
    const result = await remote.readRemote({ host: 'lab', items: [{ remotePath: `${PREFIX}/big`, localPath: 'inbox/big' }] });
    assert.equal(result.outcome, 'refused');
    assert.equal(result.items[0]!.status, 'refused-oversize');
    assert.equal(existsSync(join(root, 'inbox/big')), false, 'nothing may land locally');
    // Second layer: the runner returns more bytes than the probe claimed.
    fs.probeFailures.clear();
    fs.files.set(`${PREFIX}/liar`, Buffer.from('a'.repeat(3000)));
    let probeSeen = false;
    const baseRunner = makeFakeRunner(fs);
    const lyingRunner: SshRunner = async (spec) => {
      if (spec.kind === 'probe' && spec.remotePath === `${PREFIX}/liar` && !probeSeen) {
        probeSeen = true;
        // The probe lies: claims 5 bytes so the cap passes.
        return { exitCode: 0, stdout: Buffer.from(`5\n${sha256hex('small')}\n`), stderr: '' };
      }
      if (spec.kind === 'read' && spec.remotePath === `${PREFIX}/liar`) {
        // The read returns the full oversized payload anyway.
        return { exitCode: 0, stdout: fs.files.get(`${PREFIX}/liar`)!, stderr: '' };
      }
      return baseRunner(spec);
    };
    const remote2 = makeRemote(root, lyingRunner, { maxReadBytes: 1024 });
    const result2 = await remote2.readRemote({ host: 'lab', items: [{ remotePath: `${PREFIX}/liar`, localPath: 'inbox/liar' }] });
    assert.ok(probeSeen);
    assert.equal(result2.outcome, 'unknown');
    assert.equal(result2.items[0]!.status, 'truncated');
    assert.equal(existsSync(join(root, 'inbox/liar')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('parseProbeOutput classifies probe protocols', () => {
  assert.deepEqual(parseProbeOutput(Buffer.from('MISSING\n')), { status: 'missing' });
  assert.deepEqual(parseProbeOutput(Buffer.from('TYPE\n')), { status: 'non-regular' });
  const digest = sha256hex('x');
  assert.deepEqual(parseProbeOutput(Buffer.from(`1\n${digest}\n`)), { status: 'regular', bytes: 1, digest });
  assert.deepEqual(parseProbeOutput(Buffer.from('garbage')), { status: 'unreadable' });
  assert.deepEqual(parseProbeOutput(Buffer.from('')), { status: 'unreadable' });
});

// ── End-to-end (fake runner) ─────────────────────────────────────────────────

test('configured fixture produces a working end-to-end read+write cycle', async () => {
  const root = workspace();
  const fs = new FakeRemoteFs();
  fs.files.set(`${PREFIX}/doc.txt`, Buffer.from('remote-documentation'));
  const remote = makeRemote(root, makeFakeRunner(fs));
  try {
    // READ: lands byte-identical with a recorded checksum.
    const read = await remote.readRemote({ host: 'lab', items: [{ remotePath: `${PREFIX}/doc.txt`, localPath: 'inbox/doc.txt' }] });
    assert.equal(read.outcome, 'complete');
    assert.equal(read.items[0]!.status, 'landed');
    assert.equal(read.items[0]!.digest, sha256hex('remote-documentation'));
    assert.equal(readFileSync(join(root, 'inbox/doc.txt'), 'utf8'), 'remote-documentation');

    // WRITE: prepare binds the precondition, approve requires the exact digest, apply verifies remotely.
    const prepared = await remote.prepareWrite({ host: 'lab', items: [{ remotePath: `${PREFIX}/new.txt`, content: 'v1' }] });
    assert.equal(prepared.state, 'prepared');
    assert.equal(prepared.items[0]!.preconditionDigest, null);
    assert.notEqual(prepared.approvalDigest, '0'.repeat(64));
    const approved = await remote.approveWrite(prepared.id, prepared.approvalDigest);
    assert.equal(approved.state, 'approved');
    const outcome = await remote.applyWrite(prepared.id, prepared.approvalDigest);
    assert.equal(outcome.state, 'applied');
    assert.deepEqual(outcome.items.map((i) => i.truth), ['matches-after']);
    assert.equal(fs.files.get(`${PREFIX}/new.txt`)!.toString('utf8'), 'v1');

    // ROUND-TRIP: read the written file back through the same bounded path.
    const roundTrip = await remote.readRemote({ host: 'lab', items: [{ remotePath: `${PREFIX}/new.txt`, localPath: 'inbox/new.txt' }] });
    assert.equal(roundTrip.outcome, 'complete');
    assert.equal(readFileSync(join(root, 'inbox/new.txt'), 'utf8'), 'v1');

    // The local landing verification is per-item and never a silent no-op.
    assert.equal(remote.writeStatus(prepared.id).state, 'applied');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── Write approval binding ───────────────────────────────────────────────────

test('write approval is bound to exact host identity, path, content and precondition', async () => {
  const root = workspace();
  const fs = new FakeRemoteFs();
  fs.files.set(`${PREFIX}/a`, Buffer.from('old'));
  fs.files.set(`${PREFIX}/b`, Buffer.from('old-b'));
  const remote = makeRemote(root, makeFakeRunner(fs));
  const otherFs = new FakeRemoteFs();
  otherFs.presentedFingerprint = OTHER_PIN;
  const otherHostRemote = createSshRemote(root, [
    { alias: 'other', address: 'other.invalid', user: 'operator', hostKeyFingerprint: OTHER_PIN, allowedPrefix: '/srv/other' },
  ], { runner: makeFakeRunner(otherFs) });
  try {
    const record = await remote.prepareWrite({ host: 'lab', items: [{ remotePath: `${PREFIX}/a`, content: 'NEW-A' }] });
    assert.equal(record.items[0]!.preconditionDigest, sha256hex('old'));
    // approve requires the exact digest
    await assert.rejects(() => remote.approveWrite(record.id, 'f'.repeat(64)), /does not bind/);
    await remote.approveWrite(record.id, record.approvalDigest);

    // (a) approval for content A cannot authorize content B at the same path:
    const contentB = await remote.prepareWrite({ host: 'lab', items: [{ remotePath: `${PREFIX}/a`, content: 'NEW-B' }] });
    assert.notEqual(record.approvalDigest, contentB.approvalDigest);
    await assert.rejects(() => remote.applyWrite(record.id, contentB.approvalDigest), /does not bind/);

    // (b) different path: same content, different target cannot reuse the approval.
    const otherPath = await remote.prepareWrite({ host: 'lab', items: [{ remotePath: `${PREFIX}/b`, content: 'NEW-A' }] });
    assert.notEqual(record.approvalDigest, otherPath.approvalDigest);
    await assert.rejects(() => remote.applyWrite(record.id, otherPath.approvalDigest), /does not bind/);

    // (c) different host identity: same path shape and content on another pinned host.
    const otherHostRecord = await otherHostRemote.prepareWrite({ host: 'other', items: [{ remotePath: `/srv/other/a`, content: 'NEW-A' }] });
    assert.notEqual(record.approvalDigest, otherHostRecord.approvalDigest);
    await assert.rejects(() => remote.applyWrite(record.id, otherHostRecord.approvalDigest), /does not bind/);

    // (d) precondition drift after approval invalidates apply (before any transfer).
    fs.files.set(`${PREFIX}/a`, Buffer.from('drifted'));
    await assert.rejects(() => remote.applyWrite(record.id, record.approvalDigest), /precondition drifted/);
    assert.equal(fs.files.get(`${PREFIX}/a`)!.toString('utf8'), 'drifted', 'no transfer may happen after drift');

    // (e) the digest function itself binds all four dimensions.
    const items = [{ remotePath: `${PREFIX}/a`, contentB64: '', contentDigest: sha256hex('NEW-A'), preconditionDigest: sha256hex('old') }];
    const base = remoteWriteApprovalDigest(PIN, items as never);
    assert.notEqual(base, remoteWriteApprovalDigest(OTHER_PIN, items as never));
    assert.notEqual(base, remoteWriteApprovalDigest(PIN, [{ ...items[0]!, remotePath: `${PREFIX}/z` }] as never));
    assert.notEqual(base, remoteWriteApprovalDigest(PIN, [{ ...items[0]!, contentDigest: sha256hex('NEW-Z') }] as never));
    assert.notEqual(base, remoteWriteApprovalDigest(PIN, [{ ...items[0]!, preconditionDigest: null }] as never));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── Partial and unknown outcomes ────────────────────────────────────────────

test('partial write outcome is recorded as partial, never success', async () => {
  const root = workspace();
  const fs = new FakeRemoteFs();
  const remote = makeRemote(root, makeFakeRunner(fs));
  // Item 0 transfers; item 1's transfer fails: one applied, one still precondition-absent.
  fs.writeFailures.add(1);
  try {
    const record = await remote.prepareWrite({ host: 'lab', items: [
      { remotePath: `${PREFIX}/one`, content: 'first' },
      { remotePath: `${PREFIX}/two`, content: 'second' },
    ] });
    await remote.approveWrite(record.id, record.approvalDigest);
    await assert.rejects(() => remote.applyWrite(record.id, record.approvalDigest), /did not complete/);
    const status = remote.writeStatus(record.id);
    assert.equal(status.state, 'partial');
    assert.deepEqual(status.resolution!.map((r) => r.truth), ['matches-after', 'matches-before']);
    assert.equal(fs.files.get(`${PREFIX}/one`)!.toString('utf8'), 'first');
    assert.equal(fs.files.has(`${PREFIX}/two`), false);
    // No replay: an interrupted operation cannot be re-applied.
    await assert.rejects(() => remote.applyWrite(record.id, record.approvalDigest), /Only an approved/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unknown write outcome is recorded as unknown when the probe cannot classify', async () => {
  const root = workspace();
  const fs = new FakeRemoteFs();
  const remote = makeRemote(root, makeFakeRunner(fs));
  fs.writeFailures.add(0);
  fs.probeFailures.add(`${PREFIX}/one`);
  try {
    // probe failure at prepare time refuses to bind an unreadable precondition.
    await assert.rejects(() => remote.prepareWrite({ host: 'lab', items: [{ remotePath: `${PREFIX}/one`, content: 'x' }] }),
      /unreadable precondition/);
    fs.probeFailures.clear();
    const record = await remote.prepareWrite({ host: 'lab', items: [
      { remotePath: `${PREFIX}/one`, content: 'x' },
      { remotePath: `${PREFIX}/two`, content: 'y' },
    ] });
    await remote.approveWrite(record.id, record.approvalDigest);
    fs.probeFailures.add(`${PREFIX}/two`);
    // An unverifiable precondition at apply time refuses without a transfer and
    // leaves the record 'approved': no partial state was ever created.
    await assert.rejects(() => remote.applyWrite(record.id, record.approvalDigest),
      /unverifiable right now/);
    assert.equal(remote.writeStatus(record.id).state, 'approved');
    // The write kind was never even attempted.
    assert.equal(fs.calls.filter((c) => c.kind === 'write').length, 0);

    // When probes fail only AFTER a transfer has begun, the state becomes
    // unknown: the remote effect is undetermined. Reset the fixture's probe
    // counters and make probes on both paths fail from their 2nd invocation
    // onward: the apply-time precondition re-probe (1st here) must succeed so the
    // transfer is attempted, and the post-transfer classification probe (2nd)
    // fails, making the outcome unknown.
    fs.probeFailures.clear();
    fs.probeCounts.clear();
    fs.writeFailures.add(0);
    fs.probeFailAfter.set(`${PREFIX}/one`, 1);
    fs.probeFailAfter.set(`${PREFIX}/two`, 1);
    await assert.rejects(() => remote.applyWrite(record.id, record.approvalDigest), /did not complete/);
    const status = remote.writeStatus(record.id);
    assert.equal(status.state, 'unknown');
    assert.deepEqual(status.resolution!.map((r) => r.truth), ['unverifiable', 'unverifiable']);
    // The remote files were never touched: nothing landed remotely.
    assert.equal(fs.files.has(`${PREFIX}/one`), false);
    assert.equal(fs.files.has(`${PREFIX}/two`), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a transfer that claims success but did not land is caught by the live re-probe', async () => {
  const root = workspace();
  const fs = new FakeRemoteFs();
  const runner = makeFakeRunner(fs);
  // The write kind returns exit 0 but silently drops the payload.
  const lying: SshRunner = async (spec) => {
    fs.calls.push(spec);
    if (spec.kind === 'write') return { exitCode: 0, stdout: Buffer.alloc(0), stderr: '' };
    return runner(spec);
  };
  const remote = makeRemote(root, lying);
  try {
    const record = await remote.prepareWrite({ host: 'lab', items: [{ remotePath: `${PREFIX}/silent`, content: 'v' }] });
    await remote.approveWrite(record.id, record.approvalDigest);
    const outcome = await remote.applyWrite(record.id, record.approvalDigest);
    // The live re-probe classifies the true remote state: nothing landed.
    assert.equal(outcome.state, 'unknown');
    assert.deepEqual(outcome.items.map((i) => i.truth), ['matches-before']);
    assert.equal(fs.files.has(`${PREFIX}/silent`), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('local rollback does not claim remote restoration', async () => {
  const root = workspace();
  const fs = new FakeRemoteFs();
  const remote = makeRemote(root, makeFakeRunner(fs));
  try {
    const record = await remote.prepareWrite({ host: 'lab', items: [{ remotePath: `${PREFIX}/gone`, content: 'v' }] });
    await remote.approveWrite(record.id, record.approvalDigest);
    const outcome = await remote.applyWrite(record.id, record.approvalDigest);
    assert.equal(outcome.state, 'applied');
    assert.equal(outcome.localRestore.available, false);
    assert.match(outcome.localRestore.reason, /do not restore remote state/);
    // localRestore always refuses and leaves the record standing.
    await assert.rejects(() => remote.localRestore(record.id), /do not restore remote state/);
    assert.equal(remote.writeStatus(record.id).state, 'applied');
    const status = await remote.localRestoreStatus(record.id);
    assert.equal(status.available, false);
    assert.equal(status.remoteState, 'applied');
    assert.equal(fs.files.get(`${PREFIX}/gone`)!.toString('utf8'), 'v', 'remote state is unchanged');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reconcile reports per-item truth for interrupted operations without replay', async () => {
  const root = workspace();
  const fs = new FakeRemoteFs();
  const remote = makeRemote(root, makeFakeRunner(fs));
  try {
    const record = await remote.prepareWrite({ host: 'lab', items: [
      { remotePath: `${PREFIX}/x`, content: 'x' },
      { remotePath: `${PREFIX}/y`, content: 'y' },
    ] });
    await remote.approveWrite(record.id, record.approvalDigest);
    fs.writeFailures.add(1);
    await assert.rejects(() => remote.applyWrite(record.id, record.approvalDigest), /did not complete/);
    const operations = await remote.reconcile();
    assert.equal(operations.length, 1);
    assert.equal(operations[0]!.state, 'partial');
    assert.deepEqual(operations[0]!.items.map((i) => i.truth), ['matches-after', 'matches-before']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── Local landing protections ───────────────────────────────────────────────

test('reads never overwrite existing local files and reject bad landing paths', async () => {
  const root = workspace();
  const fs = new FakeRemoteFs();
  fs.files.set(`${PREFIX}/doc`, Buffer.from('doc'));
  const remote = makeRemote(root, makeFakeRunner(fs));
  try {
    writeFileSync(join(root, 'inbox/exists.txt'), 'keep me');
    await assert.rejects(() => remote.readRemote({ host: 'lab', items: [{ remotePath: `${PREFIX}/doc`, localPath: 'inbox/exists.txt' }] }),
      /already exists/);
    await assert.rejects(() => remote.readRemote({ host: 'lab', items: [{ remotePath: `${PREFIX}/doc`, localPath: '/etc/thing' }] }),
      /workspace-relative/);
    await assert.rejects(() => remote.readRemote({ host: 'lab', items: [{ remotePath: `${PREFIX}/doc`, localPath: '../out' }] }),
      /inside the workspace/);
    await assert.rejects(() => remote.readRemote({ host: 'lab', items: [{ remotePath: `${PREFIX}/doc`, localPath: 'no-such-dir/x' }] }),
      /does not exist|must be a directory/);
    await assert.rejects(() => remote.readRemote({ host: 'lab', items: [{ remotePath: `${PREFIX}/doc`, localPath: '.shadow/ssh-remote/x' }] }),
      /inside the SSH journal/);
    assert.equal(fs.calls.length, 0, 'all landing checks happen before any connection');
    assert.equal(readFileSync(join(root, 'inbox/exists.txt'), 'utf8'), 'keep me');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing and non-regular remote targets are refused, not fetched', async () => {
  const root = workspace();
  const fs = new FakeRemoteFs();
  fs.files.set(`${PREFIX}/existing`, Buffer.from('ok'));
  const remote = makeRemote(root, makeFakeRunner(fs));
  try {
    const result2 = await remote.readRemote({ host: 'lab', items: [
      { remotePath: `${PREFIX}/missing`, localPath: 'inbox/m1' },
      { remotePath: `${PREFIX}/existing`, localPath: 'inbox/m2' },
    ] });
    assert.equal(result2.outcome, 'partial');
    assert.equal(result2.items[0]!.status, 'refused-missing');
    assert.equal(result2.items[1]!.status, 'landed');
    assert.equal(existsSync(join(root, 'inbox/m1')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('read of a non-regular remote file is refused as refused-non-regular', async () => {
  const root = workspace();
  const fs = new FakeRemoteFs();
  const runner = makeFakeRunner(fs);
  const fake: SshRunner = async (spec) => {
    fs.calls.push(spec);
    if (spec.kind === 'probe' && spec.remotePath === `${PREFIX}/tty`) {
      return { exitCode: 0, stdout: Buffer.from('TYPE\n'), stderr: '' };
    }
    return runner(spec);
  };
  const remote = makeRemote(root, fake);
  try {
    const result = await remote.readRemote({ host: 'lab', items: [{ remotePath: `${PREFIX}/tty`, localPath: 'inbox/tty' }] });
    assert.equal(result.outcome, 'refused');
    assert.equal(result.items[0]!.status, 'refused-non-regular');
    assert.equal(existsSync(join(root, 'inbox/tty')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('probe failure during a read makes the outcome unknown, never refused', async () => {
  const root = workspace();
  const fs = new FakeRemoteFs();
  fs.probeFailures.add(`${PREFIX}/x`);
  fs.files.set(`${PREFIX}/y`, Buffer.from('ok'));
  const remote = makeRemote(root, makeFakeRunner(fs));
  try {
    const result = await remote.readRemote({ host: 'lab', items: [
      { remotePath: `${PREFIX}/x`, localPath: 'inbox/x' },
      { remotePath: `${PREFIX}/y`, localPath: 'inbox/y' },
    ] });
    assert.equal(result.hostAlias, 'lab');
    assert.equal(result.outcome, 'unknown');
    assert.equal(result.items[0]!.status, 'probe-failed');
    assert.equal(result.items[1]!.status, 'landed');
    assert.equal(existsSync(join(root, 'inbox/y')), true);
    assert.equal(existsSync(join(root, 'inbox/x')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unconfigured host in journal reconciliation is reported, not trusted', async () => {
  const root = workspace();
  const fs = new FakeRemoteFs();
  const remote = makeRemote(root, makeFakeRunner(fs));
  try {
    const record = await remote.prepareWrite({ host: 'lab', items: [{ remotePath: `${PREFIX}/a`, content: 'a' }] });
    await remote.approveWrite(record.id, record.approvalDigest);
    fs.writeFailures.add(0);
    await assert.rejects(() => remote.applyWrite(record.id, record.approvalDigest), /did not complete/);
    // Recreate the remote with an empty registry: the host is gone.
    const bare = createSshRemote(root, [], { runner: makeFakeRunner(new FakeRemoteFs()) });
    const operations = await bare.reconcile();
    assert.equal(operations.length, 1);
    assert.equal(operations[0]!.state, 'unknown');
    assert.deepEqual(operations[0]!.items.map((i) => i.truth), ['unverifiable']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a tampered journal record is reported per record without hiding others', async () => {
  const root = workspace();
  const fs = new FakeRemoteFs();
  const remote = makeRemote(root, makeFakeRunner(fs));
  try {
    const record = await remote.prepareWrite({ host: 'lab', items: [{ remotePath: `${PREFIX}/a`, content: 'a' }] });
    // State manipulated on disk to 'applying' — reconcile must classify it live.
    const raw = JSON.parse(readFileSync(join(root, '.shadow', 'ssh-remote', `${record.id}.json`), 'utf8'));
    raw.state = 'applying';
    writeFileSync(join(root, '.shadow', 'ssh-remote', `${record.id}.json`), JSON.stringify(raw));
    const operations = await remote.reconcile();
    assert.equal(operations.length, 1);
    assert.equal(operations[0]!.state, 'applying');
    assert.deepEqual(operations[0]!.items.map((i) => i.truth), ['matches-before']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reads of multiple items land every file or report partial per-item truth', async () => {
  const root = workspace();
  const fs = new FakeRemoteFs();
  fs.files.set(`${PREFIX}/one`, Buffer.from('one'));
  fs.files.set(`${PREFIX}/two`, Buffer.from('two'));
  const remote = makeRemote(root, makeFakeRunner(fs));
  try {
    // Both land: complete.
    const ok = await remote.readRemote({ host: 'lab', items: [
      { remotePath: `${PREFIX}/one`, localPath: 'inbox/one' },
      { remotePath: `${PREFIX}/two`, localPath: 'inbox/two' },
    ] });
    assert.equal(ok.outcome, 'complete');
    assert.equal(readFileSync(join(root, 'inbox/one'), 'utf8'), 'one');
    assert.equal(readFileSync(join(root, 'inbox/two'), 'utf8'), 'two');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
