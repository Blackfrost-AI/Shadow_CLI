import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  EndpointConflictError,
  createEndpointId,
  loadEndpointRegistry,
  savedEndpointFromModelEntry,
  updateEndpointRegistry,
} from '../src/endpoints/store.js';
import { emptyEndpointRegistry, endpointIdentity, normalizeEndpointUrl } from '../src/endpoints/types.js';

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'shadow-endpoints-')), 'endpoints.json');
}

function endpoint(label: string, id = createEndpointId()) {
  return {
    id,
    label,
    provider: 'openai' as const,
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'fixture-model',
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
  };
}

test('endpoint contracts normalize URLs and reject credentials/unsupported schemes', () => {
  assert.equal(normalizeEndpointUrl('http://127.0.0.1:8000/v1/'), 'http://127.0.0.1:8000/v1');
  assert.equal(endpointIdentity('http://127.0.0.1:8000/v1/'), 'http://127.0.0.1:8000/v1');
  assert.throws(() => normalizeEndpointUrl('ftp://example.test/model'), /http or https/);
  assert.throws(() => normalizeEndpointUrl('https://user:pass@example.test/v1'), /credentials/);
});

test('empty registry has explicit schema and revision', () => {
  const state = emptyEndpointRegistry('2026-10-28T00:00:00.000Z');
  assert.deepEqual(state, {
    schemaVersion: 1,
    revision: 0,
    endpoints: [],
    observations: [],
    updatedAt: '2026-10-28T00:00:00.000Z',
  });
});

test('registry updates are atomic and reject stale revisions', () => {
  const path = tempPath();
  try {
    const first = updateEndpointRegistry({ expectedRevision: 0, add: endpoint('first') }, path, '2026-10-28T00:00:01.000Z');
    assert.equal(first.revision, 1);
    assert.equal(loadEndpointRegistry(path).endpoints[0].label, 'first');
    assert.throws(
      () => updateEndpointRegistry({ expectedRevision: 0, add: endpoint('stale') }, path),
      (error: unknown) => error instanceof EndpointConflictError && error.actualRevision === 1,
    );
    const second = updateEndpointRegistry(
      { expectedRevision: 1, update: { id: first.endpoints[0].id, label: 'renamed' } },
      path,
      '2026-10-28T00:00:02.000Z',
    );
    assert.equal(second.endpoints[0].label, 'renamed');
  } finally {
    rmSync(path, { force: true });
    rmSync(`${path}.lock`, { recursive: true, force: true });
  }
});

test('model preset conversion preserves credential references and does not copy secrets', () => {
  const saved = savedEndpointFromModelEntry({
    label: 'fixture',
    provider: 'openai',
    model: 'fixture-model',
    baseUrl: 'http://127.0.0.1:8000/v1/',
    credRef: 'fixture-slot',
  });
  assert.equal(saved.credentialRef, 'fixture-slot');
  assert.equal('apiKey' in saved, false);
  assert.equal(saved.baseUrl, 'http://127.0.0.1:8000/v1');
});
