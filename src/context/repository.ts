import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, lstatSync, statSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import { resolveWithin } from '../safety/workspaceJail.js';
import type { SourceLocation } from '../agent/lsp/protocol.js';

const exec = promisify(execFile);
const SKIP_PARTS = new Set(['.git', '.shadow', 'node_modules', 'vendor', 'dist', 'dist-bin', 'build', 'coverage', '.next', '.cache', '.tmp', '__pycache__', '.venv', 'target']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.php', '.vue', '.svelte', '.md', '.json', '.yaml', '.yml', '.toml', '.sh', '.css', '.html', '.sql']);
const MAX_FILES = 5_000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_INDEX_BYTES = 24 * 1024 * 1024;
const STOP_WORDS = new Set(['the', 'this', 'that', 'with', 'from', 'into', 'file', 'files', 'code', 'and', 'for', 'fix', 'add', 'use']);

export interface RepositorySymbol { name: string; kind: string; line: number; col: number; signature: string }
interface IndexedFile { path: string; stamp: string; lines: string[]; symbols: RepositorySymbol[]; terms: Set<string>; bytes: number }
export interface RepositorySnapshot { files: number; symbols: number; updated: number; removed: number; skipped: number; truncated: boolean; discovery: 'git' | 'rg'; }
export interface ContextExcerpt {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  reasons: string[];
}
export interface RankedContext { excerpts: ContextExcerpt[]; characters: number; approximateTokens: number; truncated: boolean; snapshot: RepositorySnapshot }

/** Split code identifiers as well as prose. Scoring remains inspectable, local and deterministic. */
function terms(text: string): string[] {
  return [...new Set(text.replace(/([a-z\d])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9_]+/)
    .flatMap((word) => [word, ...word.split('_')]).filter((word) => word.length > 1 && !STOP_WORDS.has(word)))];
}
function allowed(path: string): boolean {
  const parts = path.split(/[\\/]/);
  const base = parts.at(-1) ?? '';
  return !parts.some((part) => SKIP_PARTS.has(part)) && !/\.(?:min\.[cm]?js|map|lock|generated\.[^.]+)$/.test(base)
    && !/^(?:package-lock\.json|yarn\.lock|bun\.lockb?|pnpm-lock\.yaml|\.env(?:\..*)?)$/.test(base)
    && (SOURCE_EXTENSIONS.has(extname(base).toLowerCase()) || /^(?:Makefile|Dockerfile|Justfile)$/.test(base));
}

/** Lexical fallback reports declarations only; it never pretends these are semantic references. */
export function lexicalSymbols(lines: string[]): RepositorySymbol[] {
  const symbols: RepositorySymbol[] = [];
  const declaration = /(?:^|\s)(?:(?:export|default|public|private|protected|static|async|abstract|declare|pub|unsafe)\s+)*(function|class|interface|type|enum|struct|trait|fn|def|const|let|var|func|module)\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/;
  for (let i = 0; i < lines.length && symbols.length < 300; i++) {
    const line = lines[i]!;
    if (/^\s*(?:\/\/|#|\*|<!--)/.test(line)) continue;
    const hit = declaration.exec(line);
    if (!hit) continue;
    symbols.push({ name: hit[2]!, kind: hit[1]!, line: i + 1, col: line.indexOf(hit[2]!, hit.index) + 1, signature: line.trim().slice(0, 180) });
  }
  return symbols;
}

/** One bounded in-memory index per workspace. Reconcile membership and file stamps on every query. */
export class RepositoryIndex {
  private readonly files = new Map<string, IndexedFile>();
  private flight: Promise<RepositorySnapshot> | undefined;
  constructor(readonly workspaceRoot: string) {}

  async refresh(signal?: AbortSignal): Promise<RepositorySnapshot> {
    if (this.flight) return this.flight;
    this.flight = this.scan(signal);
    try { return await this.flight; } finally { this.flight = undefined; }
  }

  private async scan(signal?: AbortSignal): Promise<RepositorySnapshot> {
    signal?.throwIfAborted();
    let paths: string[];
    let discovery: 'git' | 'rg' = 'git';
    const options = { cwd: this.workspaceRoot, encoding: 'utf8' as const, maxBuffer: 4 * 1024 * 1024, timeout: 5_000, signal };
    try {
      const { stdout } = await exec('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], options);
      paths = stdout.split('\0').filter(Boolean);
    } catch (error) {
      signal?.throwIfAborted();
      discovery = 'rg';
      try {
        const { stdout } = await exec('rg', ['--files', '--hidden', '--no-require-git', '-0'], options);
        paths = stdout.split('\0').filter(Boolean);
      } catch (fallback) {
        if ((fallback as { code?: unknown }).code === 1) paths = [];
        else throw new Error(`Repository discovery requires Git or ripgrep: ${(error as Error).message}`);
      }
    }
    const candidates = [...new Set(paths.map((path) => path.split(sep).join('/')))].filter(allowed).sort();
    const selected = candidates.slice(0, MAX_FILES);
    const membership = new Set(selected);
    let removed = 0;
    for (const path of this.files.keys()) if (!membership.has(path)) { this.files.delete(path); removed++; }
    let updated = 0, skipped = 0, bytes = 0;
    let truncated = candidates.length > MAX_FILES;
    for (let i = 0; i < selected.length; i++) {
      signal?.throwIfAborted();
      if (i % 50 === 0) await new Promise<void>((done) => setImmediate(done));
      const path = selected[i]!;
      try {
        const absolute = resolveWithin(this.workspaceRoot, path);
        if (lstatSync(resolve(this.workspaceRoot, path)).isSymbolicLink()) throw new Error('symlink');
        const st = statSync(absolute);
        if (!st.isFile() || st.size > MAX_FILE_BYTES || bytes + st.size > MAX_INDEX_BYTES) {
          if (bytes + st.size > MAX_INDEX_BYTES) truncated = true;
          throw new Error('index budget');
        }
        bytes += st.size;
        const stamp = `${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
        if (this.files.get(path)?.stamp === stamp) continue;
        const text = readFileSync(absolute, 'utf8');
        if (text.includes('\0') || /(?:@generated|DO NOT EDIT|Code generated[^\n]*DO NOT EDIT)/i.test(text.slice(0, 1000))) throw new Error('generated or binary');
        const lines = text.split(/\r?\n/);
        const symbols = lexicalSymbols(lines);
        this.files.set(path, { path, stamp, lines, symbols, terms: new Set(terms(path + '\n' + text)), bytes: st.size });
        updated++;
      } catch { this.files.delete(path); skipped++; }
    }
    return { files: this.files.size, symbols: [...this.files.values()].reduce((n, f) => n + f.symbols.length, 0), updated, removed, skipped, truncated, discovery };
  }

  async map(opts: { query?: string; maxCharacters?: number; signal?: AbortSignal } = {}): Promise<{ text: string; snapshot: RepositorySnapshot; truncated: boolean }> {
    const snapshot = await this.refresh(opts.signal);
    const budget = Math.max(100, Math.min(24_000, opts.maxCharacters ?? 6_000));
    const query = terms(opts.query ?? '');
    const ranked = this.rank(query);
    const lines: string[] = [];
    let characters = 0;
    let truncated = snapshot.truncated;
    for (const { file } of ranked) {
      const line = `${file.path}${file.symbols.length ? ': ' + file.symbols.slice(0, 12).map((s) => `${s.name}@${s.line}`).join(', ') : ''}`;
      if (characters + line.length + 1 > budget) { truncated = true; break; }
      lines.push(line); characters += line.length + 1;
    }
    return { text: lines.join('\n'), snapshot, truncated };
  }

  private rank(query: string[]): Array<{ file: IndexedFile; score: number; reasons: string[] }> {
    const counts = new Map<string, number>();
    for (const term of query) counts.set(term, [...this.files.values()].filter((file) => file.terms.has(term)).length);
    return [...this.files.values()].map((file) => {
      let score = 0;
      const reasons: string[] = [];
      const pathTerms = terms(file.path);
      for (const term of query) {
        if (!file.terms.has(term)) continue;
        const weight = 1 + Math.log(1 + this.files.size / (1 + (counts.get(term) ?? 0)));
        score += weight;
        reasons.push(`content:${term}`);
        if (pathTerms.includes(term)) { score += weight * 3; reasons.push(`path:${term}`); }
        if (file.symbols.some((symbol) => terms(symbol.name).includes(term))) { score += weight * 4; reasons.push(`symbol:${term}`); }
      }
      return { file, score, reasons };
    }).filter((entry) => query.length === 0 || entry.score > 0).sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
  }

  async context(query: string, opts: { maxCharacters?: number; maxFiles?: number; signal?: AbortSignal } = {}): Promise<RankedContext> {
    const snapshot = await this.refresh(opts.signal);
    const budget = Math.max(100, Math.min(32_000, opts.maxCharacters ?? 8_000));
    const queryTerms = terms(query);
    const ranked = this.rank(queryTerms);
    const excerpts: ContextExcerpt[] = [];
    let characters = 0;
    let clipped = false;
    for (const { file, score, reasons } of ranked.slice(0, Math.max(1, Math.min(20, opts.maxFiles ?? 6)))) {
      const lineScores = file.lines.map((line, i) => ({ i, score: queryTerms.reduce((n, term) => n + (terms(line).includes(term) ? 1 : 0), 0) }));
      const best = lineScores.sort((a, b) => b.score - a.score || a.i - b.i)[0]?.i ?? 0;
      const start = Math.max(0, best - 4);
      const end = Math.min(file.lines.length, best + 16);
      const overhead = file.path.length + 30;
      const room = budget - characters - overhead;
      if (room <= 0) break;
      const window = file.lines.slice(start, end).join('\n');
      const content = window.slice(0, room);
      if (content.length < window.length) clipped = true;
      excerpts.push({ path: file.path, startLine: start + 1, endLine: start + content.split('\n').length, content, score: Math.round(score * 100) / 100, reasons });
      characters += content.length + overhead;
    }
    return { excerpts, characters, approximateTokens: Math.ceil(characters / 4), truncated: snapshot.truncated || clipped || excerpts.length < ranked.length, snapshot };
  }

  async navigate(kind: 'symbols' | 'definition' | 'references', path: string, line = 1, col = 1, signal?: AbortSignal): Promise<SourceLocation[]> {
    await this.refresh(signal);
    const absolute = resolveWithin(this.workspaceRoot, path);
    const rel = relative(this.workspaceRoot, absolute).split(sep).join('/');
    const file = this.files.get(rel);
    if (!file) return [];
    if (kind === 'symbols') return file.symbols.map((symbol) => ({ path: absolute, line: symbol.line, col: symbol.col, name: symbol.name, kind: symbol.kind }));
    const text = file.lines[line - 1] ?? '';
    const before = text.slice(0, Math.max(0, col - 1));
    const after = text.slice(Math.max(0, col - 1));
    const word = (before.match(/[\w$]+$/)?.[0] ?? '') + (after.match(/^[\w$]+/)?.[0] ?? '');
    if (!word) return [];
    const found: SourceLocation[] = [];
    for (const candidate of this.files.values()) {
      if (kind === 'definition') {
        for (const symbol of candidate.symbols.filter((item) => item.name === word)) found.push({ path: resolve(this.workspaceRoot, candidate.path), line: symbol.line, col: symbol.col, name: word, kind: symbol.kind });
      } else {
        const pattern = new RegExp(`(?<![\\w$])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`, 'g');
        candidate.lines.forEach((source, i) => {
          for (const match of source.matchAll(pattern)) if (found.length < 300) found.push({ path: resolve(this.workspaceRoot, candidate.path), line: i + 1, col: match.index + 1, name: word });
        });
      }
      if (found.length >= 300) break;
    }
    return found.slice(0, 300);
  }
}

const indexes = new Map<string, RepositoryIndex>();
export function getRepositoryIndex(root: string): RepositoryIndex {
  const key = resolve(root);
  let index = indexes.get(key);
  if (!index) { index = new RepositoryIndex(key); indexes.set(key, index); }
  return index;
}
