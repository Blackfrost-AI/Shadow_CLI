import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { versionGreater, maybeNotifyUpdate } from '../src/update/checkUpdate.js';

test('versionGreater compares dotted numeric versions correctly', () => {
  assert.equal(versionGreater('2.5.6', '2.5.4'), true);
  assert.equal(versionGreater('2.5.10', '2.5.9'), true, 'numeric, not lexical (10 > 9)');
  assert.equal(versionGreater('3.0.0', '2.9.9'), true);
  assert.equal(versionGreater('2.5.4', '2.5.4'), false, 'equal is not greater');
  assert.equal(versionGreater('2.5.4', '2.5.6'), false, 'older is not greater');
});

const fakeFetch = (version: string): typeof fetch =>
  (async () => ({ ok: true, text: async () => JSON.stringify({ version }) })) as unknown as typeof fetch;

test('maybeNotifyUpdate is a NO-OP when disabled (opt-in) — never touches the network', async () => {
  let notified = '';
  let fetched = false;
  const spyFetch = (async () => {
    fetched = true;
    return { ok: true, text: async () => '{"version":"9.9.9"}' };
  }) as unknown as typeof fetch;
  const out = await maybeNotifyUpdate('2.5.4', false, (l) => (notified = l), { fetchImpl: spyFetch, now: 1_000_000 });
  assert.equal(out, null, 'returns null when disabled');
  assert.equal(fetched, false, 'no fetch when the check is off');
  assert.equal(notified, '', 'no notice when the check is off');
});

test('maybeNotifyUpdate notifies on a NEWER version, stays quiet otherwise, and rate-limits to once/day', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'upd-'));
  const state = join(dir, 'update-check.json');
  try {
    const T0 = 2_000_000_000; // a realistic ms timestamp (> one day past epoch 0, so the first check runs)
    let notice = '';
    // newer → one line
    const a = await maybeNotifyUpdate('2.5.4', true, (l) => (notice = l), { fetchImpl: fakeFetch('2.5.6'), now: T0, statePath: state });
    assert.equal(a, '2.5.6');
    assert.match(notice, /Shadow v2\.5\.6 is available.*you have v2\.5\.4.*shadow update/);

    // within 24h → rate-limited, no fetch, no notice (even though a newer version exists)
    notice = '';
    let fetched = false;
    const spy = (async () => { fetched = true; return { ok: true, text: async () => '{"version":"9.9.9"}' }; }) as unknown as typeof fetch;
    const b = await maybeNotifyUpdate('2.5.4', true, (l) => (notice = l), { fetchImpl: spy, now: T0 + 60_000, statePath: state });
    assert.equal(b, null, 'second check within 24h is skipped');
    assert.equal(fetched, false, 'no network on the rate-limited check');
    assert.equal(notice, '', 'no notice on the rate-limited check');

    // a day later, same-or-older remote → checks but stays quiet
    notice = '';
    const c = await maybeNotifyUpdate('2.5.4', true, (l) => (notice = l), { fetchImpl: fakeFetch('2.5.4'), now: T0 + 25 * 60 * 60 * 1000, statePath: state });
    assert.equal(c, '2.5.4', 'checked (a day passed)');
    assert.equal(notice, '', 'no notice when the current version is up to date');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
