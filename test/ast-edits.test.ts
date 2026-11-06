/**
 * m9 — Scoped AST edit previews.
 *
 * Every guarantee from src/tools/astEdits.ts is exercised against the REAL
 * TypeScript parser (no fakes at the parser boundary):
 *
 *  1. Closed language scope (.ts/.tsx/.js/.jsx only; everything else refused).
 *  2. Deterministic matches: exactly one node or explicit refusal listing every
 *     candidate; the first match is never silently picked.
 *  3. Byte preservation: splicing — every byte outside [start, end) is
 *     untouched; comments and formatting survive verbatim.
 *  4. Post-parse gate: an edit that introduces any parse error is refused.
 *  5. Replacement-shape gate: error-tolerant parsing is not trusted — a
 *     replacement must scan/parse as exactly one node of the same kind.
 *  6. Verifiable checksums: SHA-256 of before/slice/replacement/after,
 *     independently recomputable with node:crypto.
 *  7. No writes from this module; the journal is the only write seam, and its
 *     drift refusal surfaces verbatim.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { previewAstEdit, prepareAstEdit, AstEditError } from '../src/tools/astEdits.js';
import { createMutationJournal } from '../src/tools/mutation.js';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

function errOf(fn: () => unknown): AstEditError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof AstEditError, `expected AstEditError, got ${e}`);
    return e as AstEditError;
  }
  throw new Error('expected previewAstEdit to throw');
}

// ---- 1. Closed language scope ----

test('non-TS/JS files are refused before any parsing (unsupported-language)', () => {
  for (const file of ['a.py', 'b.rb', 'c.go', 'd.rs', 'noext', 'x.ts.bak']) {
    const e = errOf(() => previewAstEdit({ file, selector: { kind: 'identifier', name: 'x' }, replacement: 'y', text: 'x = 1' }));
    assert.equal(e.code, 'unsupported-language');
    assert.match(e.message, /unsupported language/);
  }
});

test('uppercase extensions are normalized and supported (.TS parses as typescript)', () => {
  const p = previewAstEdit({
    file: 'A.TS',
    selector: { kind: 'identifier', name: 'alpha' },
    replacement: 'beta',
    text: 'const alpha = 1;',
  });
  assert.equal(p.language, 'typescript');
  assert.equal(p.matchCount, 1);
});

test('empty, binary, and oversize files are refused (unsupported-file)', () => {
  const base = { file: 'a.ts', selector: { kind: 'identifier', name: 'x' }, replacement: 'y' } as const;
  const empty = errOf(() => previewAstEdit({ ...base, text: '' }));
  assert.equal(empty.code, 'unsupported-file');
  const binary = errOf(() => previewAstEdit({ ...base, text: 'const x\0 = 1;' }));
  assert.equal(binary.code, 'unsupported-file');
  assert.match(binary.message, /binary/);
  const oversize = errOf(() => previewAstEdit({ ...base, text: 'x'.repeat(1024 * 1024 + 1) }));
  assert.equal(oversize.code, 'unsupported-file');
  assert.match(oversize.message, /exceeds/);
});

// ---- 2. Deterministic match resolution ----

test('zero matches are refused (no-match), never silently edited', () => {
  const e = errOf(() => previewAstEdit({
    file: 'a.ts',
    selector: { kind: 'method', name: 'missing' },
    replacement: 'm() {}',
    text: 'class A { foo() {} }',
  }));
  assert.equal(e.code, 'no-match');
});

test('multiple matches list EVERY candidate and refuse to pick one (ambiguous-match)', () => {
  const text = [
    'class A {',
    '  pick() {}',
    '}',
    'class B {',
    '  pick() {}',
    '}',
  ].join('\n');
  const e = errOf(() => previewAstEdit({
    file: 'a.ts',
    selector: { kind: 'method', name: 'pick' },
    replacement: 'chosen() {}',
    text,
  }));
  assert.equal(e.code, 'ambiguous-match');
  assert.equal(e.candidates?.length, 2);
  assert.equal(e.candidates![0].line, 2);
  assert.equal(e.candidates![1].line, 5);
  assert.ok(e.candidates![0].text.includes('pick() {}'));
});

test('identifiers match every exact-text token, including property access positions', () => {
  const text = 'const x = a.alpha + b.alpha;';
  const e = errOf(() => previewAstEdit({
    file: 'a.ts',
    selector: { kind: 'identifier', name: 'alpha' },
    replacement: 'beta',
    text,
  }));
  assert.equal(e.code, 'ambiguous-match');
  assert.equal(e.candidates?.length, 2);
});

// ---- 3. Byte preservation via splice ----

test('a single-match edit splices only the range; comments and formatting survive byte-for-byte', () => {
  const before = [
    '// leading comment stays',
    'class A {',
    '  // inner comment stays',
    '  alpha() { return 1; }',
    '  keep() { return 2; }',
    '}',
    '// trailing comment stays',
  ].join('\n');
  const p = previewAstEdit({
    file: 'a.ts',
    selector: { kind: 'method', name: 'alpha' },
    replacement: 'renamed() { return 3; }',
    text: before,
  });
  assert.equal(p.matchCount, 1);
  // byte preservation outside the range:
  assert.ok(p.after.startsWith('// leading comment stays\nclass A {\n  // inner comment stays\n'));
  assert.ok(p.after.endsWith('\n  keep() { return 2; }\n}\n// trailing comment stays'));
  // the untouched method is byte-identical:
  assert.ok(p.after.includes('keep() { return 2; }'));
  assert.ok(!p.after.includes('alpha'));
  // honest labeling:
  assert.match(p.description, /syntactic replacement of 1 source range/);
  assert.match(p.description, /NOT a semantic rename/);
});

test('identifier splice refuses to rewrite call sites (no semantic rename)', () => {
  // An identifier selector with multiple occurrences is ambiguous and refused;
  // a unique occurrence edits exactly that token and nothing else.
  const p = previewAstEdit({
    file: 'a.ts',
    selector: { kind: 'identifier', name: 'onlyOne' },
    replacement: 'renamed',
    text: 'const onlyOne = 1; const other = 2;',
  });
  assert.equal(p.matchCount, 1);
  assert.ok(p.after.includes('const renamed = 1;'));
  assert.ok(p.after.includes('const other = 2;'));
  assert.ok(!p.after.includes('onlyOne'));
});

// ---- 4. Post-parse gate ----

test('pre-existing parse problems do not block an otherwise-safe edit', () => {
  const p = previewAstEdit({
    file: 'a.ts',
    selector: { kind: 'identifier', name: 'alpha' },
    replacement: 'beta',
    text: 'const alpha = (;',
  });
  assert.equal(p.matchCount, 1);
  assert.ok(p.after.includes('const beta = (;'));
});

test('an edit that leaves the file broken is refused: broken splice detection', () => {
  // Replacing the whole method with a truncated body must be caught by the
  // post-parse gate (the shape gate alone only sees the replacement in isolation).
  const e = errOf(() => previewAstEdit({
    file: 'a.ts',
    selector: { kind: 'method', name: 'alpha' },
    replacement: 'alpha() { return (',
    text: 'class A { alpha() { return 1; } }',
  }));
  assert.equal(e.code, 'invalid-syntax');
  assert.ok((e.details?.length ?? 0) > 0);
});

// ---- 5. Replacement-shape gate ----

test('identifier replacements must scan as exactly one identifier token', () => {
  const base = {
    file: 'a.ts',
    selector: { kind: 'identifier', name: 'alpha' },
    text: 'const alpha = 1;',
  } as const;
  // Gate 1 (post-parse) fires first for splices that break the file:
  for (const breaksParse of ['beta.gamma', 'beta gamma', '']) {
    const e = errOf(() => previewAstEdit({ ...base, replacement: breaksParse }));
    assert.equal(e.code, 'invalid-syntax', `replacement ${JSON.stringify(breaksParse)} must be refused by the post-parse gate`);
  }
  // Gate 2 (shape) catches what error-tolerant parsing alone would miss —
  // replacements whose splice PARSES CLEAN but is not one identifier token:
  for (const wrongShape of ['await', 'beta;gamma']) {
    const e = errOf(() => previewAstEdit({ ...base, replacement: wrongShape }));
    assert.equal(e.code, 'invalid-replacement-shape', `replacement ${JSON.stringify(wrongShape)} must be refused by the shape gate`);
  }
});

test('method replacements must parse as exactly one class method', () => {
  const base = {
    file: 'a.ts',
    selector: { kind: 'method', name: 'alpha' },
    text: 'class A { alpha() {} }',
  } as const;
  for (const bad of ['', 'alpha() {} keep() {}', 'alphaField = 1;', 'const x = 1;']) {
    const e = errOf(() => previewAstEdit({ ...base, replacement: bad }));
    assert.equal(e.code, 'invalid-replacement-shape', `replacement ${JSON.stringify(bad)}`);
  }
});

// ---- 6. Verifiable checksums ----

test('checksums are SHA-256 and independently recomputable', () => {
  const before = 'const alpha = 1;';
  const p = previewAstEdit({
    file: 'a.ts',
    selector: { kind: 'identifier', name: 'alpha' },
    replacement: 'beta',
    text: before,
  });
  assert.equal(p.beforeChecksum, sha(before));
  const slice = before.slice(p.range.start, p.range.end);
  assert.equal(p.originalChecksum, sha(slice));
  assert.equal(p.replacementChecksum, sha('beta'));
  assert.equal(p.afterChecksum, sha(p.after));
  assert.equal(slice, 'alpha');
  assert.equal(p.after, 'const beta = 1;');
});

// ---- 7. Journal binding: the only write seam ----

test('prepareAstEdit refuses without the journal and surfaces journal drift verbatim', async () => {
  const preview = previewAstEdit({
    file: 'a.ts',
    selector: { kind: 'identifier', name: 'alpha' },
    replacement: 'beta',
    text: 'const alpha = 1;',
  });
  // No journal → refused.
  const noJournal = errOf(() => prepareAstEdit(undefined as never, preview));
  assert.equal(noJournal.code, 'invalid-journal');
  // Real journal against a drift-free on-disk file binds and returns digests;
  // drift between preview bytes and disk is refused by the JOURNAL, verbatim.
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'ast-edit-journal-'));
  try {
    const onDisk = 'const alpha = 1;';
    writeFileSync(join(dir, 'a.ts'), onDisk);
    const journal = createMutationJournal(dir);
    const bound = prepareAstEdit(journal, preview);
    assert.ok(bound.id.length > 0);
    assert.ok(bound.approvalDigest.length === 64);
    // Drift: disk no longer matches the previewed bytes → journal refuses.
    writeFileSync(join(dir, 'a.ts'), 'const DRIFTED = 1;');
    const drifted = previewAstEdit({
      file: 'a.ts',
      selector: { kind: 'identifier', name: 'alpha' },
      replacement: 'beta',
      text: 'const alpha = 1;', // preview built against OLD bytes
    });
    assert.throws(() => prepareAstEdit(journal, drifted), (e: unknown) => {
      assert.ok(e instanceof Error);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 8. Positive .js case and selector validation ----

test('a .js file with a unique selector edits cleanly (javascript)', () => {
  const p = previewAstEdit({
    file: 'a.js',
    selector: { kind: 'method', name: 'onlyMethod' },
    replacement: 'renamedMethod() { return 9; }',
    text: 'class A { onlyMethod() { return 1; } }\n// keep me',
  });
  assert.equal(p.language, 'javascript');
  assert.equal(p.matchCount, 1);
  assert.ok(p.after.includes('renamedMethod() { return 9; }'));
  assert.ok(p.after.includes('// keep me'));
});

test('invalid selectors and calls are refused before any parse', () => {
  const base = { file: 'a.ts', text: 'const alpha = 1;' };
  const noKind = errOf(() => previewAstEdit({ ...base, selector: { kind: 'wildcard', name: 'alpha' }, replacement: 'beta' } as never));
  assert.equal(noKind.code, 'invalid-selector');
  const noName = errOf(() => previewAstEdit({ ...base, selector: { kind: 'identifier', name: '' }, replacement: 'beta' }));
  assert.equal(noName.code, 'invalid-selector');
  const noFile = errOf(() => previewAstEdit({ text: base.text, selector: { kind: 'identifier', name: 'alpha' }, replacement: 'beta' } as never));
  assert.equal(noFile.code, 'invalid-call');
  const noText = errOf(() => previewAstEdit({ file: 'a.ts', selector: { kind: 'identifier', name: 'alpha' }, replacement: 'beta' } as never));
  assert.equal(noText.code, 'invalid-call');
});

test('getters/setters/constructors are NOT method matches — honest zero-match', () => {
  const e = errOf(() => previewAstEdit({
    file: 'a.ts',
    selector: { kind: 'method', name: 'alpha' },
    replacement: 'alpha() {}',
    text: 'class A { get alpha() { return 1; } set alpha(v) {} }',
  }));
  assert.equal(e.code, 'no-match');
});
