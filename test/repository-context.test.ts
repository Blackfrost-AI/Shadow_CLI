import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { RepositoryIndex } from '../src/context/repository.js';
import { readFile } from '../src/tools/readFile.js';
import { makeRepositoryContextTool } from '../src/tools/repositoryContext.js';
import { createTsserverConnection } from '../src/agent/lsp/tsserver.js';
import { normalizeNavigation } from '../src/agent/lsp/navigation.js';
import type { ToolContext } from '../src/tools/types.js';
import { removeFixtureTree } from './helpers/removeFixtureTree.js';

function fixture(): { root: string; put: (p: string, value: string) => void } {
  const root = mkdtempSync(join(tmpdir(), 'shadow-repomap-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  return { root, put: (p, value) => { const path = join(root, p); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, value); } };
}

test('repository map respects ignores/generated/symlinks, invalidates changes and ranks relevant excerpt beyond prefix', async () => {
  const f = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'shadow-repomap-out-'));
  try {
    f.put('.gitignore', 'ignored/\n');
    f.put('src/payment.ts', `${'// documentation filler\n'.repeat(100)}export function calculateInvoice(total: number) { return total * 1.05; }\n`);
    f.put('src/unrelated.ts', 'export function renderHeader() { return "header"; }');
    f.put('ignored/secret.ts', 'export const shouldNotAppear = true;');
    f.put('src/generated.ts', '// @generated DO NOT EDIT\nexport const generated = 1;');
    f.put('node_modules/lib/index.ts', 'export const dependency = 1;');
    writeFileSync(join(outside, 'private.ts'), 'export const externalSecret = 1;');
    if (process.platform !== 'win32') symlinkSync(join(outside, 'private.ts'), join(f.root, 'src/linked.ts'));
    const index = new RepositoryIndex(f.root);
    const first = await index.map();
    assert.match(first.text, /calculateInvoice@101/);
    assert.doesNotMatch(first.text, /secret|generated|dependency|linked/);
    assert.equal((await index.refresh()).updated, 0);
    const context = await index.context('calculate invoice total', { maxCharacters: 900 });
    assert.equal(context.excerpts[0]?.path, 'src/payment.ts');
    assert.ok(context.excerpts[0]!.startLine > 80);
    assert.match(context.excerpts[0]!.content, /calculateInvoice/);
    assert.ok(context.characters <= 900);
    assert.ok(context.excerpts[0]!.reasons.some((reason) => reason.startsWith('symbol:')));
    f.put('src/payment.ts', 'export function newInvoice() { return 0; }');
    utimesSync(join(f.root, 'src/payment.ts'), new Date(), new Date(Date.now() + 1000));
    assert.match((await index.map()).text, /newInvoice/);
    rmSync(join(f.root, 'src/unrelated.ts'));
    assert.equal((await index.refresh()).removed, 1);
  } finally { rmSync(f.root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('context tool provides lexical definition/references and applicable nested instructions with bounds', async () => {
  const f = fixture();
  try {
    f.put('AGENTS.md', 'Root convention');
    f.put('src/AGENTS.md', 'Nested convention');
    f.put('src/a.ts', 'export function addNumbers(a: number, b: number) { return a + b; }\n');
    f.put('src/b.ts', 'import { addNumbers } from "./a";\nconst total = addNumbers(1, 2);\n');
    const tool = makeRepositoryContextTool({ enabled: false });
    const ctx = { workspaceRoot: f.root, signal: new AbortController().signal } as ToolContext;
    const result = await tool.run({ action: 'definition', path: 'src/b.ts', line: 2, col: 18 }, ctx);
    assert.equal(result.ok, true);
    const data = result.data as { source: string; locations: Array<{ path: string }>; instructions: Array<{ body: string }> };
    assert.equal(data.source, 'lexical');
    assert.ok(data.locations.some((location) => location.path.replaceAll('\\', '/').endsWith('/src/a.ts')));
    assert.deepEqual(data.instructions.map((source) => source.body), ['Root convention', 'Nested convention']);
    const ordinaryRead = await readFile.run({ path: 'src/b.ts' }, ctx);
    assert.deepEqual(ordinaryRead.data?.instructions?.sources.map((source) => source.body), ['Root convention', 'Nested convention']);
    f.put('src/AGENTS.md', 'Updated nested convention');
    const nextRead = await readFile.run({ path: 'src/b.ts' }, ctx);
    assert.equal(nextRead.data?.instructions?.sources.at(-1)?.body, 'Updated nested convention');
    const refs = await tool.run({ action: 'references', path: 'src/b.ts', line: 2, col: 18 }, ctx);
    assert.equal((refs.data as { locations: unknown[] }).locations.length, 3);
    const range = await tool.run({ action: 'range', path: 'src/b.ts', line: 2, endLine: 2 }, ctx);
    assert.equal((range.data as { content: string }).content, 'const total = addNumbers(1, 2);');
    assert.equal((await tool.run({ action: 'range', path: '../outside.ts' }, ctx)).ok, false);
    const cancelled = new AbortController(); cancelled.abort();
    assert.equal((await tool.run({ action: 'map' }, { ...ctx, signal: cancelled.signal })).error?.code, 'interrupted');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('real installed tsserver returns symbols, cross-file definition and callers with normalized positions', async () => {
  const f = fixture();
  const conn = createTsserverConnection({ id: 'typescript', flavor: 'tsserver', command: process.execPath,
    args: [resolve('node_modules/typescript/lib/tsserver.js')], projectSourced: false }, { workspaceRoot: f.root });
  const keepAlive = setInterval(() => {}, 1000);
  try {
    f.put('tsconfig.json', '{"compilerOptions":{"strict":true},"include":["src/**/*.ts"]}');
    f.put('src/a.ts', 'export function addNumbers(a: number, b: number) { return a + b; }\n');
    f.put('src/b.ts', 'import { addNumbers } from "./a";\nconst total = addNumbers(1, 2);\n');
    await conn.start(5000);
    const path = join(f.root, 'src/b.ts');
    conn.notifyOpen(path, 'import { addNumbers } from "./a";\nconst total = addNumbers(1, 2);\n', 1);
    const definition = normalizeNavigation(await conn.navigate!({ kind: 'definition', path, line: 2, col: 18, deadlineMs: 10000 }), 'tsserver', 'definition', path);
    assert.ok(definition.some((location) => location.path.replaceAll('\\', '/').endsWith('/src/a.ts') && location.line === 1));
    const symbols = normalizeNavigation(await conn.navigate!({ kind: 'symbols', path, deadlineMs: 5000 }), 'tsserver', 'symbols', path);
    assert.ok(symbols.some((location) => location.name === 'total'));
    const references = normalizeNavigation(await conn.navigate!({ kind: 'references', path, line: 2, col: 18, deadlineMs: 5000 }), 'tsserver', 'references', path);
    assert.ok(references.length >= 3);
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(conn.navigate!({ kind: 'symbols', path, signal: cancelled.signal }), /interrupted/);
  } finally { clearInterval(keepAlive); conn.stop(); await removeFixtureTree(f.root); }
});
