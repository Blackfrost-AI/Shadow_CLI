/**
 * Scoped AST edit previews: deterministic, syntax-aware source-range edits for
 * TypeScript and JavaScript ONLY, applied exclusively through the mutation journal.
 *
 * Scope declaration (plan §8 — Structural editing): this module supports exactly
 * the extensions `.ts`, `.tsx`, `.js`, `.jsx`. Every other language is refused
 * with an `unsupported-language` error; there is no fallback and no graceful
 * degradation.
 *
 * What this module is NOT: it is not a refactoring engine and not a rename tool.
 * It never resolves bindings, never follows references, and never rewrites call
 * sites. Every proposal describes a SYNTACTIC REPLACEMENT of source ranges —
 * never a semantic rename — and says so in its own description.
 *
 * What it guarantees instead:
 * - Deterministic matches: a selector resolves against the real parsed AST and
 *   must yield EXACTLY ONE node. Zero matches and multiple matches are both
 *   explicit rejections; multiple matches list every candidate location. The
 *   first match is never picked silently.
 * - Verifiable previews: every proposal reports the match count, the exact
 *   source range, and SHA-256 checksums of the original and replacement text.
 * - Byte preservation: the edit is computed by splicing text at [start, end) on
 *   the ORIGINAL source. The AST is never re-printed; every byte outside the
 *   replaced range is preserved exactly, including comments and formatting.
 * - Safety gates, in order: (1) the spliced after-text is re-parsed and the
 *   edit is rejected pre-write if it introduces any parse error the original
 *   did not have; (2) the replacement must parse as exactly one node of the
 *   same structural kind, because TS's error-tolerant parser reports many
 *   semantically-wrong programs as syntactically clean (e.g. a keyword
 *   substituted for an identifier still parses).
 * - No direct writes: this module performs NO filesystem writes and NO reads.
 *   Applying is done by the mutation journal, which binds exact bytes, refuses
 *   drift between preview and apply, and refuses replay. Rollback restores
 *   the exact original bytes.
 */

import { createHash } from 'node:crypto';
import ts from 'typescript';
import type { StoredMutationFile } from './mutation.js';

/** Every error this module throws. Each variant is an explicit refusal. */
export type AstEditErrorCode =
  | 'invalid-call'
  | 'invalid-selector'
  | 'unsupported-language'
  | 'unsupported-file'
  | 'no-match'
  | 'ambiguous-match'
  | 'invalid-syntax'
  | 'invalid-replacement-shape'
  | 'invalid-journal';

export class AstEditError extends Error {
  constructor(
    public readonly code: AstEditErrorCode,
    message: string,
    /** Every candidate location, populated for ambiguous-match. */
    public readonly candidates?: readonly CandidateLocation[],
    /** Parse problems introduced by the edit, populated for invalid-syntax. */
    public readonly details?: readonly string[],
  ) {
    super(message);
    this.name = 'AstEditError';
  }
}

export type AstEditSelectorKind = 'method' | 'identifier';

/**
 * Selector grammar (closed set). A selector names a structural kind and an
 * exact name; it never names a position, so a match can never be "the first".
 */
export interface AstEditSelector {
  kind: AstEditSelectorKind;
  name: string;
}

/** One candidate location, reported for every ambiguous match. */
export interface CandidateLocation {
  /** 1-based line of the range start. */
  line: number;
  /** 1-based column (UTF-16 code units) of the range start. */
  character: number;
  /** 0-based offset of the range start in the file. */
  start: number;
  /** 0-based offset of the range end (exclusive). */
  end: number;
  /** The candidate's own source text, so a human can tell them apart. */
  text: string;
}

export interface AstEditPreview {
  file: string;
  /** Always 'syntactic replacement of N source ranges' — never 'rename'. */
  description: string;
  language: 'typescript' | 'javascript';
  selector: AstEditSelector;
  /** Number of AST nodes that matched the selector. A proposal exists only at 1. */
  matchCount: number;
  /** Every candidate the selector found, in source order. */
  candidates: readonly CandidateLocation[];
  /** The single chosen range [start, end), 0-based offsets into the file. */
  range: { start: number; end: number };
  /** SHA-256 of the entire original text. */
  beforeChecksum: string;
  /** SHA-256 of the original slice being replaced. */
  originalChecksum: string;
  /** SHA-256 of the replacement text. */
  replacementChecksum: string;
  /** SHA-256 of the entire after-text (never written by this module). */
  afterChecksum: string;
  /** The exact bytes before the edit, for binding to the journal. */
  before: string;
  /** The exact bytes after the edit, for binding to the journal. */
  after: string;
}

/** The ONLY supported extensions. Anything else is an unsupported language. */
const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(['.ts', '.tsx', '.js', '.jsx']);
/** Hard cap aligned with the mutation journal's own MAX_BYTES (1 MiB). */
const MAX_EDIT_BYTES = 1024 * 1024;

/** Internal per-file parse context. */
interface ParsedFile {
  path: string;
  scriptKind: ts.ScriptKind;
  text: string;
  sourceFile: ts.SourceFile;
  /** The ORIGINAL's parse problems: an edit may introduce none of these. */
  parseProblems: readonly string[];
}

/**
 * The narrowest possible view of TS's runtime-only `parseDiagnostics` property.
 * It is deliberately absent from the public typescript.d.ts, so access is
 * confined to this structural view; everything else stays statically typed.
 */
interface SourceFileWithParseDiagnostics {
  readonly parseDiagnostics?: readonly {
    code?: unknown;
    messageText?: unknown;
  }[];
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return '';
  return path.slice(dot).toLowerCase();
}

/**
 * Resolve the script kind for a path. The extension list is closed: anything
 * outside it is an unsupported language and refused without parsing.
 */
function resolveLanguage(path: string): { language: 'typescript' | 'javascript'; scriptKind: ts.ScriptKind } {
  switch (extensionOf(path)) {
    case '.ts': return { language: 'typescript', scriptKind: ts.ScriptKind.TS };
    case '.tsx': return { language: 'typescript', scriptKind: ts.ScriptKind.TSX };
    case '.js': return { language: 'javascript', scriptKind: ts.ScriptKind.JS };
    case '.jsx': return { language: 'javascript', scriptKind: ts.ScriptKind.JSX };
    default:
      throw new AstEditError(
        'unsupported-language',
        `unsupported language: ${JSON.stringify(extensionOf(path) || path)} — AST edits support TypeScript/JavaScript only (${[...SUPPORTED_EXTENSIONS].join(', ')})`,
      );
  }
}

/** Fail closed when the runtime does not expose usable parse diagnostics. */
function parseProblems(
  sourceFile: ts.SourceFile,
  unavailableCode: AstEditErrorCode = 'invalid-syntax',
): readonly string[] {
  const runtime = sourceFile as unknown as SourceFileWithParseDiagnostics;
  if (!runtime.parseDiagnostics || !Array.isArray(runtime.parseDiagnostics)) {
    throw new AstEditError(
      unavailableCode,
      `parse diagnostics are unavailable for ${sourceFile.fileName}; refusing the edit`,
    );
  }
  const problems: string[] = [];
  for (const diagnostic of runtime.parseDiagnostics) {
    const code = typeof diagnostic.code === 'number' ? diagnostic.code : -1;
    const message = ts.flattenDiagnosticMessageText(
      diagnostic.messageText as string | ts.DiagnosticMessageChain | undefined,
      ' ',
    );
    problems.push(`${code}:${message}`);
  }
  return problems;
}

function parseSourceFile(path: string, text: string, scriptKind: ts.ScriptKind): ParsedFile {
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, scriptKind);
  return {
    path,
    scriptKind,
    text,
    sourceFile,
    parseProblems: parseProblems(sourceFile),
  };
}

/**
 * Iterative in-order traversal: no recursion (no stack overflow on pathologically
 * nested input) and no full-node materialization (children buffered per node).
 */
function forEachNode(sourceFile: ts.SourceFile, visit: (node: ts.Node) => void): void {
  const stack: ts.Node[] = [sourceFile];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    visit(node);
    const children: ts.Node[] = [];
    ts.forEachChild(node, (child) => { children.push(child); return undefined; });
    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]!);
  }
}

/** A property name that is an identifier token, by its exact text. */
function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  // String/numeric/computed property names are not identifier-backed and are
  // reported as no-match rather than silently skipped or approximated.
  return null;
}

/** Describe one candidate for both the ambiguity listing and the preview. */
function describeCandidate(file: ParsedFile, node: ts.Node): CandidateLocation {
  const start = node.getStart(file.sourceFile);
  const end = node.end;
  const position = file.sourceFile.getLineAndCharacterOfPosition(start);
  const text = file.text.slice(start, end);
  return {
    line: position.line + 1,
    character: position.character + 1,
    start,
    end,
    // Enough source to tell candidates apart, bounded so a huge method cannot
    // turn an ambiguity listing into a file dump.
    text: text.length > 200 ? `${text.slice(0, 200)}… [${text.length - 200} more characters]` : text,
  };
}

/**
 * Resolve every AST node matching a selector. This is the determinism core:
 * ALL matches are collected and returned; nothing is picked silently.
 */
function resolveCandidates(file: ParsedFile, selector: AstEditSelector): CandidateLocation[] {
  const candidates: CandidateLocation[] = [];
  forEachNode(file.sourceFile, (node) => {
    if (selector.kind === 'method') {
      if (ts.isMethodDeclaration(node)) {
        const name = propertyNameText(node.name);
        if (name === selector.name) candidates.push(describeCandidate(file, node));
      }
    } else if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      // Every identifier TOKEN with this exact text is a candidate, including
      // property-access and qualified-name positions: the selector is
      // structural and exact-text, and cannot be scoped by owner.
      if (node.text === selector.name) candidates.push(describeCandidate(file, node));
    }
  });
  candidates.sort((a, b) => a.start - b.start || a.end - b.end);
  return candidates;
}

/** Reject inputs the parser must not be fed at all. */
function assertFileIsSupported(text: string): void {
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength === 0) {
    throw new AstEditError('unsupported-file', 'empty files cannot be edited');
  }
  if (byteLength > MAX_EDIT_BYTES) {
    throw new AstEditError('unsupported-file', `file exceeds ${MAX_EDIT_BYTES} bytes and cannot be edited`);
  }
  // A NUL anywhere makes this a binary file, not a program. The byte cap above
  // bounds this scan to 1 MiB.
  if (text.includes('\0')) {
    throw new AstEditError('unsupported-file', 'binary files cannot be edited');
  }
}

/**
 * Gate 2 — replacement shape. An identifier replacement must scan as EXACTLY
 * ONE identifier token: no keywords, no member expressions, no whitespace, no
 * empty string. Post-parse validation alone cannot catch these, because TS's
 * error-tolerant parser accepts many such programs as syntactically clean.
 */
function assertIdentifierShape(parsed: ParsedFile, replacement: string): void {
  if (replacement.length === 0) {
    throw new AstEditError('invalid-replacement-shape', 'an identifier cannot be replaced by an empty string');
  }
  const variant = parsed.scriptKind === ts.ScriptKind.TSX || parsed.scriptKind === ts.ScriptKind.JSX
    ? ts.LanguageVariant.JSX
    : ts.LanguageVariant.Standard;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, variant, 'shape');
  scanner.setText(replacement);
  const first = scanner.scan();
  const firstText = scanner.getTokenText();
  const second = scanner.scan();
  if (first !== ts.SyntaxKind.Identifier && first !== ts.SyntaxKind.PrivateIdentifier) {
    throw new AstEditError(
      'invalid-replacement-shape',
      `replacement must be exactly one identifier token; got ${JSON.stringify(replacement)} (first token: ${ts.SyntaxKind[first]})`,
    );
  }
  if (firstText !== replacement || second !== ts.SyntaxKind.EndOfFileToken) {
    throw new AstEditError(
      'invalid-replacement-shape',
      `replacement must be exactly one identifier token; got ${JSON.stringify(replacement)}`,
    );
  }
}

/**
 * Gate 2 for methods. A method replacement must parse as EXACTLY ONE class
 * method covering exactly the replacement bytes — the same structural kind as
 * the node it replaces, no more and no less.
 */
function assertMethodShape(parsed: ParsedFile, replacement: string): void {
  if (replacement.length === 0) {
    // The declared scope is replacement, not deletion: an empty method
    // replacement is refused rather than silently becoming a deletion.
    throw new AstEditError('invalid-replacement-shape', 'a method cannot be replaced by an empty string');
  }
  const wrapper = `class ShapeProbe { ${replacement} }`;
  const probe = ts.createSourceFile(
    `${parsed.path}.shape-probe`, wrapper, ts.ScriptTarget.Latest, false, parsed.scriptKind,
  );
  const probeProblems = parseProblems(probe, 'invalid-replacement-shape');
  if (probeProblems.length > 0) {
    throw new AstEditError(
      'invalid-replacement-shape',
      `replacement does not parse as a single class method: ${probeProblems.join('; ')}`,
    );
  }
  const statement = probe.statements[0];
  if (!statement || !ts.isClassDeclaration(statement) || statement.members.length !== 1) {
    throw new AstEditError('invalid-replacement-shape', 'replacement must parse as exactly one class method');
  }
  const member = statement.members[0]!;
  if (!ts.isMethodDeclaration(member)) {
    throw new AstEditError(
      'invalid-replacement-shape',
      `replacement must parse as a class method; got ${ts.SyntaxKind[member.kind]}`,
    );
  }
  const start = member.getStart(probe);
  if (wrapper.slice(start, member.end) !== replacement) {
    throw new AstEditError(
      'invalid-replacement-shape',
      'replacement must parse as exactly one class method covering its own bytes',
    );
  }
}

/**
 * Build a verifiable preview for replacing a selector's single AST match with
 * `replacement`. NEVER writes anything; never re-prints the AST.
 *
 * `text` must be the file's exact current text; the mutation journal re-reads
 * the file and refuses drift before anything is applied.
 */
export function previewAstEdit(input: {
  file: string;
  selector: AstEditSelector;
  replacement: string;
  text: string;
}): AstEditPreview {
  if (!input || typeof input !== 'object') {
    throw new AstEditError('invalid-call', 'preview requires file, selector, replacement, and text');
  }
  if (typeof input.file !== 'string' || input.file.length === 0 || typeof input.text !== 'string') {
    throw new AstEditError('invalid-call', 'preview requires a file path and the current text');
  }
  if (typeof input.replacement !== 'string') {
    throw new AstEditError('invalid-call', 'preview requires a replacement string');
  }
  if (!input.selector || typeof input.selector !== 'object') {
    throw new AstEditError('invalid-call', 'preview requires a selector');
  }
  const selector = input.selector;
  if (typeof selector.name !== 'string' || selector.name.length === 0) {
    throw new AstEditError('invalid-selector', 'selector name must be a nonempty string');
  }
  if (selector.kind !== 'method' && selector.kind !== 'identifier') {
    throw new AstEditError(
      'invalid-selector',
      `unsupported selector kind ${JSON.stringify(selector.kind)}; supported kinds: method, identifier`,
    );
  }

  const { language, scriptKind } = resolveLanguage(input.file);
  assertFileIsSupported(input.text);

  const before = input.text;
  const parsed = parseSourceFile(input.file, before, scriptKind);

  // Deterministic match resolution: ALL candidates first, verdict second.
  const candidates = resolveCandidates(parsed, selector);
  if (candidates.length === 0) {
    throw new AstEditError('no-match', `selector matched 0 nodes in ${input.file}`);
  }
  if (candidates.length > 1) {
    throw new AstEditError(
      'ambiguous-match',
      `selector matched ${candidates.length} nodes in ${input.file}; every candidate is listed; refusing to pick one`,
      candidates,
    );
  }
  const chosen = candidates[0]!;

  // Splice the ORIGINAL source. Nothing outside [start, end) changes.
  const after = before.slice(0, chosen.start) + input.replacement + before.slice(chosen.end);

  // Gate 1 — post-parse validation: the edit may not introduce any parse error.
  const reparsed = parseSourceFile(input.file, after, scriptKind);
  const baseline = new Set(parsed.parseProblems);
  const introduced = reparsed.parseProblems.filter((problem) => !baseline.has(problem));
  if (introduced.length > 0) {
    throw new AstEditError(
      'invalid-syntax',
      `replacement would leave ${input.file} syntactically invalid: ${introduced.join('; ')}`,
      undefined,
      introduced,
    );
  }

  // Gate 2 — replacement shape: catch what error-tolerant parsing misses.
  if (selector.kind === 'identifier') assertIdentifierShape(parsed, input.replacement);
  else assertMethodShape(parsed, input.replacement);

  return {
    file: input.file,
    // Honest labeling: a syntactic replacement, NOT a semantic rename.
    description:
      `syntactic replacement of ${candidates.length} source range${candidates.length === 1 ? '' : 's'} `
      + `(${chosen.start}..${chosen.end}) in ${input.file}; NOT a semantic rename — bindings and call sites are untouched`,
    language,
    selector,
    matchCount: candidates.length,
    candidates,
    range: { start: chosen.start, end: chosen.end },
    beforeChecksum: sha256(before),
    originalChecksum: sha256(before.slice(chosen.start, chosen.end)),
    replacementChecksum: sha256(input.replacement),
    afterChecksum: sha256(after),
    before,
    after,
  };
}

/**
 * Bind a preview to the mutation journal. This is the ONLY seam between a
 * preview and a write: the journal's prepare() re-reads the file from disk and
 * refuses any drift between the previewed bytes and reality, and its error
 * surfaces here verbatim. The journal performs every write; this module
 * performs none.
 */
export function prepareAstEdit(
  journal: { prepare(files: StoredMutationFile[]): { id: string; approvalDigest: string } },
  preview: AstEditPreview,
): { id: string; approvalDigest: string } {
  if (!journal || typeof (journal as { prepare?: unknown }).prepare !== 'function') {
    throw new AstEditError('invalid-journal', 'applying requires the mutation journal');
  }
  if (!preview || typeof preview !== 'object'
    || typeof preview.file !== 'string' || typeof preview.before !== 'string' || typeof preview.after !== 'string') {
    throw new AstEditError('invalid-journal', 'preview is malformed and cannot be bound to the journal');
  }
  // The journal re-reads the target and refuses drift; its MutationError (or
  // underlying filesystem error) propagates to the caller verbatim.
  return journal.prepare([{ path: preview.file, before: preview.before, after: preview.after }]);
}
