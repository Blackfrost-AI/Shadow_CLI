import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverWorkflows, prepareWorkflow, assertWorkflowUnchanged, workflowSchema } from '../src/workflows/catalog.js';

test('workflow preview validates inputs, keeps commands static, and detects edits before launch', () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-workflow-')); const dir = join(root, 'workflows'); mkdirSync(dir);
  try {
    const path = join(dir, 'audit.json');
    const value = { version: 1, id: 'audit', title: 'Audit', task: 'Review {{target}}', preset: 'implement-review', parameters: { target: { description: 'Target' } }, checks: ['npm test'] };
    writeFileSync(path, JSON.stringify(value));
    const catalog = discoverWorkflows([{ label: 'test', dir }]); assert.equal(catalog.errors.length, 0);
    const entry = catalog.entries[0]!;
    assert.throws(() => prepareWorkflow(entry, {}, root), /Missing required/);
    assert.throws(() => prepareWorkflow(entry, { target: 'src', unexpected: 'x' }, root), /Unknown/);
    const prepared = prepareWorkflow(entry, { target: 'src; echo harmless-prompt-data' }, root);
    assert.deepEqual(prepared.input.checks, ['npm test']); assert.match(prepared.preview, /no model\/tool calls/);
    assertWorkflowUnchanged(prepared);
    writeFileSync(path, JSON.stringify({ ...value, task: 'changed' }));
    assert.throws(() => assertWorkflowUnchanged(prepared), /changed after preview/);
    writeFileSync(path, JSON.stringify({ ...value, checks: ['echo {{target}}'] }));
    assert.match(discoverWorkflows([{ label: 'test', dir }]).errors[0]!, /cannot contain parameter/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('workflow discovery is bounded to explicit roots and reports duplicates', () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-workflow-')); const dir = join(root, 'defs'); mkdirSync(dir);
  try {
    const value = { version: 1, id: 'sample', title: 'Sample', task: 'read only' };
    writeFileSync(join(dir, 'a.json'), JSON.stringify(value)); writeFileSync(join(dir, 'b.json'), JSON.stringify(value));
    writeFileSync(join(root, 'outside.json'), JSON.stringify({ ...value, id: 'outside' }));
    const result = discoverWorkflows([{ label: 'test', dir }]);
    assert.equal(result.entries.filter((entry) => entry.workflow.id === 'sample').length, 1);
    assert.ok(!result.entries.some((entry) => entry.workflow.id === 'outside')); assert.equal(result.errors.length, 1);
    const defaults = discoverWorkflows([]); assert.equal(defaults.entries.length, 4);
    assert.equal(prepareWorkflow(defaults.entries[0]!, {}, root).input.preset, 'second-opinion');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('workflow discovery rejects a file symlink outside its explicit root', { skip: process.platform === 'win32' ? 'File symlinks require Windows developer mode or elevation.' : false }, () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-workflow-')); const dir = join(root, 'defs'); mkdirSync(dir);
  try {
    writeFileSync(join(root, 'outside.json'), JSON.stringify({ version: 1, id: 'outside', title: 'Outside', task: 'read only' }));
    symlinkSync(join(root, 'outside.json'), join(dir, 'escape.json'));
    const result = discoverWorkflows([{ label: 'test', dir }]);
    assert.ok(!result.entries.some((entry) => entry.workflow.id === 'outside'));
    assert.equal(result.errors.length, 1); assert.match(result.errors[0]!, /outside|escape/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('workflow preview rejects acceptance contracts the selected runtime cannot execute and empty pipelines', () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-workflow-contract-')); const dir = join(root, 'defs'); mkdirSync(dir);
  try {
    for (const preset of ['second-opinion', 'parallel-team', 'pipeline', 'debate', 'solve']) {
      const workflow = workflowSchema.parse({ version: 1, id: 'unsupported', title: 'Unsupported', task: 'Inspect the fixture', preset,
        checks: ['fixture-check'], steps: preset === 'pipeline' ? [{ task: 'Inspect' }] : undefined });
      const entry = { workflow, source: 'builtin:fixture', digest: 'fixture' };
      assert.throws(() => prepareWorkflow(entry, {}, root), /currently require preset implement-review/);
    }
    writeFileSync(join(dir, 'empty.json'), JSON.stringify({ version: 1, id: 'empty', title: 'Empty', task: 'Inspect', preset: 'pipeline' }));
    writeFileSync(join(dir, 'unverified-artifact.json'), JSON.stringify({ version: 1, id: 'bad_artifact', title: 'Bad artifact', task: 'Inspect', expectedArtifacts: ['report.md'] }));
    const catalog = discoverWorkflows([{ label: 'test', dir }]);
    assert.equal(catalog.entries.length, 4, 'only builtins remain; invalid jobs cannot be selected');
    assert.ok(catalog.errors.some((error) => /explicit steps/.test(error)));
    assert.ok(catalog.errors.some((error) => /implement-review/.test(error)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
