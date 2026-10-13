import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceStore, parseFindingImport } from '../src/security/evidence.js';
import { registerSecret } from '../src/util/redact.js';

test('SARIF import deduplicates, preserves evidence, records retest and reopens recurring findings', () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-evidence-')); const store = new EvidenceStore(root);
  try {
    const inputs = parseFindingImport({ version: '2.1.0', runs: [{ tool: { driver: { name: 'fixture' } }, results: [{ ruleId: 'R1', level: 'error', message: { text: 'Unsafe configuration' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'config.json' }, region: { startLine: 2 } } }] }] }] });
    const first = store.importFindings(inputs); assert.equal(first.added, 1); const id = first.ids[0]!;
    store.update(id, 'remediated', 'Changed setting'); assert.throws(() => store.retest(id, { id: 'old', passed: true, command: 'check', scope: root, recordedAt: 0 }), /after the latest/);
    registerSecret('unique-fixture-secret-987654321'); writeFileSync(join(root, 'evidence.txt'), 'token=unique-fixture-secret-987654321');
    const attached = store.attach(id, 'evidence.txt', 'local check'); const evidence = attached.history.at(-1)!.evidence!;
    assert.ok(!readFileSync(join(root, evidence.path), 'utf8').includes('unique-fixture-secret-987654321'));
    store.retest(id, { id: 'run-1', passed: true, command: 'fixture check', scope: root, recordedAt: Date.now() + 1 });
    assert.equal(store.get(id).status, 'verified');
    const second = new EvidenceStore(root);
    try { assert.equal(second.importFindings(inputs).duplicates, 1); } finally { second.close(); }
    assert.equal(store.get(id).status, 'open'); assert.equal(store.get(id).occurrences, 2);
    const report = store.exportReport(); assert.match(readFileSync(report, 'utf8'), /run-1/); assert.ok(!store.report().includes('unique-fixture-secret-987654321'));
    assert.throws(() => store.update(id, 'verified' as 'open', 'fake pass'), /requires a recorded check/);
    assert.throws(() => store.attach(id, '../outside', 'escape'), /outside|escape|workspace/i);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('invalid imports fail before persisting any finding; exports escape active markup', () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-evidence-')); const store = new EvidenceStore(root);
  try {
    assert.throws(() => store.importFindings([{ title: 'valid' }, { title: '' }] as never)); assert.equal(store.list().length, 0);
    store.importFindings(parseFindingImport([{ title: '<script>test</script>', description: '[click](https://invalid.test)', severity: 'note' }]));
    store.scope('Local fixture'); assert.ok(!store.report().includes('<script>')); assert.match(store.report(), /Local fixture/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
