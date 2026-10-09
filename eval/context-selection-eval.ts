/** Deterministic retrieval comparison, not a model-quality or competitor score.
 * node --import tsx/esm eval/context-selection-eval.ts [evidence.json]
 * Twenty fixed symbols at varied file depths, three repetitions, equal 800-char
 * budgets. The baseline gets the correct file, but only its leading excerpt. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { RepositoryIndex } from '../src/context/repository.js';

const tasks = [
  'calculateInvoice', 'normalizeHeader', 'parseDuration', 'validateEmail', 'formatCurrency',
  'mergeSettings', 'resolveWorkspace', 'readManifest', 'decodeMessage', 'encodePayload',
  'sortRecords', 'filterEntries', 'groupResults', 'cancelRequest', 'resumeSession',
  'renderStatus', 'paginateItems', 'compareVersions', 'sanitizeFilename', 'computeChecksum',
];
const root = mkdtempSync(join(tmpdir(), 'shadow-context-eval-'));
const budget = 800;
const rows: Array<{ task: string; repetition: number; targetLine: number; rankedFound: boolean; prefixFound: boolean; rankedCharacters: number; prefixCharacters: number; elapsedMs: number }> = [];
try {
  execFileSync('git', ['init', '-q'], { cwd: root });
  const files = tasks.map((symbol, index) => {
    const prefix = '// Existing module documentation and unrelated historical examples.\n'.repeat(index % 5 === 0 ? 0 : 30 + index * 4);
    const text = prefix + `export function ${symbol}(value: string): string { return value.trim(); }\n`;
    writeFileSync(join(root, `${symbol}.ts`), text);
    return { symbol, text, targetLine: prefix.split('\n').length };
  });
  for (let repetition = 1; repetition <= 3; repetition++) {
    const index = new RepositoryIndex(root);
    for (const file of files) {
      const start = performance.now();
      const ranked = await index.context(file.symbol, { maxCharacters: budget, maxFiles: 1 });
      const prefix = file.text.slice(0, budget);
      rows.push({ task: file.symbol, repetition, targetLine: file.targetLine,
        rankedFound: ranked.excerpts.some((excerpt) => excerpt.content.includes(`function ${file.symbol}(`)),
        prefixFound: prefix.includes(`function ${file.symbol}(`), rankedCharacters: ranked.characters,
        prefixCharacters: prefix.length, elapsedMs: performance.now() - start });
    }
  }
  const report = { version: 1, scope: 'synthetic retrieval only; not coding-task success, billed tokens or competitor parity',
    tasks: tasks.length, repetitions: 3, characterBudget: budget,
    rankedCoverage: rows.filter((row) => row.rankedFound).length,
    prefixCoverage: rows.filter((row) => row.prefixFound).length,
    rankedMeanCharacters: rows.reduce((sum, row) => sum + row.rankedCharacters, 0) / rows.length,
    prefixMeanCharacters: rows.reduce((sum, row) => sum + row.prefixCharacters, 0) / rows.length,
    rows };
  if (process.argv[2]) { mkdirSync(dirname(process.argv[2]), { recursive: true }); writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n'); }
  console.log(JSON.stringify({ ...report, rows: undefined }, null, 2));
  if (rows.some((row) => row.rankedCharacters > budget || !row.rankedFound)) process.exitCode = 1;
} finally { rmSync(root, { recursive: true, force: true }); }
