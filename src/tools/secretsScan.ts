// secrets_scan — read-only credential/secret sweep for a workspace or subtree.
//
// Defense-in-depth for vuln hunters and reviewers: find planted API keys, tokens,
// private keys, and high-entropy assignments BEFORE they ship or get committed.
// Output is MASKED ONLY — every hit carries file:line, a rule id, and a masked
// preview (via the same redaction engine that protects session logs). Raw secret
// material never enters the model context, the summary, or any artifact.
//
// Rules come from src/util/redact.ts (getRedactionPatterns) so the scanner and the
// redactor stay in lockstep, plus an optional Shannon-entropy heuristic for generic
// `key = "…"` assignments the shape rules miss. No writes, no network, no execution.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, lstatSync, type Stats } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import { resolveWithin } from '../safety/workspaceJail.js';
import { getSecretScanRules, maskSecret } from '../util/redact.js';
import { scrubbedEnv } from '../util/safeEnv.js';
import { clamp, looksBinary } from './util.js';
import { fail, ok, type Tool, type ToolResult } from './types.js';

const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_FINDINGS = 500;
const MAX_OUTPUT_CHARS = 14_000;
const TIME_LIMIT_MS = 20_000;
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'dist-bin', '.cache', '.shadow', 'build', 'coverage',
  '.next', '.turbo', 'vendor', '__pycache__', '.venv', 'venv', 'target',
]);
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tar',
  '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.mov', '.so', '.dylib', '.dll',
  '.exe', '.bin', '.o', '.a', '.class', '.jar', '.wasm', '.pyc',
]);

const schema = z.object({
  paths: z
    .array(z.string().min(1))
    .max(50)
    .optional()
    .describe('Files or directories to scan (workspace-relative). Default: the whole workspace (git-tracked + untracked, honoring .gitignore).'),
  maxFiles: z.number().int().min(1).max(MAX_FILES).optional().describe('Cap on files scanned (default 20000).'),
  maxFindings: z.number().int().min(1).max(MAX_FINDINGS).optional().describe('Cap on reported findings (default 500).'),
  entropy: z.boolean().optional().describe('Also flag high-entropy key/token assignments (default true). Adds heuristic hits; shape rules always run.'),
  minEntropy: z.number().min(2).max(6).optional().describe('Shannon-entropy threshold (bits/char) for the heuristic (default 4.0).'),
});
export type SecretsScanInput = z.input<typeof schema>;

interface Finding {
  file: string;
  line: number;
  rule: string;
  /** Masked preview — never the raw secret. */
  preview: string;
  /** 'shape' = known credential format; 'entropy' = high-entropy assignment heuristic. */
  kind: 'shape' | 'entropy';
}

export interface SecretsScanData {
  filesScanned: number;
  filesSkipped: number;
  findings: Finding[];
  totalFindings: number;
  truncated: boolean;
  byRule: Record<string, number>;
}

/** Shannon entropy in bits/char over the string's character distribution. */
function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// Generic assignment heuristic: a secret-ish key bound to a long quoted value.
const ASSIGN_RE =
  /(?:api[_-]?key|apikey|secret|token|passwd|password|pwd|access[_-]?key|private[_-]?key|client[_-]?secret|auth)\s*[:=]\s*["']([^"'\s]{16,})["']/gi;

function discoverFiles(root: string, signal: AbortSignal): { files: string[]; gitUsed: boolean } {
  // Prefer git's view (honors .gitignore, includes untracked); fall back to a walk.
  try {
    const out = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'],
      { cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true, env: scrubbedEnv() },
    );
    const files = out.split('\0').filter((f) => f.length > 0);
    if (files.length > 0) return { files, gitUsed: true };
  } catch {
    // not a git repo / git unavailable → bounded walk below
  }
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (files.length >= MAX_FILES || signal.aborted) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (files.length >= MAX_FILES || signal.aborted) return;
      const full = join(dir, name);
      let st: Stats;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(full);
      } else if (st.isFile()) {
        files.push(relative(root, full).split(sep).join('/'));
      }
    }
  };
  walk(root);
  return { files, gitUsed: false };
}

export const secretsScan: Tool<SecretsScanInput, SecretsScanData> = {
  name: 'secrets_scan',
  risk: 'read',
  deferred: true,
  searchAliases: [
    'secrets', 'secret', 'credentials', 'credential', 'leak', 'api-key', 'apikey', 'token',
    'password', 'private-key', 'hardcoded', 'entropy', 'scan-secrets', 'gitleaks', 'trufflehog',
    'exposed', 'key-detection',
  ],
  inputSchema: schema,
  description:
    'Read-only sweep for hardcoded secrets/credentials (API keys, tokens, private keys, passwords) across the ' +
    'workspace or named paths. Output is MASKED ONLY: file:line, rule id, and a masked preview — raw secret ' +
    'material never enters context. Reuses the session redaction engine\'s patterns plus an optional high-entropy ' +
    'assignment heuristic. Honors .gitignore via git; skips binaries and vendor dirs. No writes, no network.',
  async run(input: SecretsScanInput, ctx): Promise<ToolResult<SecretsScanData>> {
    const start = Date.now();
    const failNow = (code: string, message: string) => fail('secrets_scan', 'read', Date.now() - start, code, message);
    try {
      const maxFiles = input.maxFiles ?? MAX_FILES;
      const maxFindings = input.maxFindings ?? MAX_FINDINGS;
      const useEntropy = input.entropy !== false;
      const minEntropy = input.minEntropy ?? 4.0;
      const rules = getSecretScanRules();

      // Resolve scan roots through the jail. Default: the workspace root.
      const roots: string[] = [];
      if (input.paths && input.paths.length > 0) {
        for (const p of input.paths) {
          try {
            roots.push(resolveWithin([ctx.workspaceRoot, ...(ctx.additionalRoots ?? [])], p));
          } catch {
            return failNow('jail_escape', `Path "${p}" resolves outside the workspace jail.`);
          }
        }
      } else {
        roots.push(ctx.workspaceRoot);
      }

      const findings: Finding[] = [];
      const byRule: Record<string, number> = {};
      let filesScanned = 0;
      let filesSkipped = 0;
      let truncated = false;
      const seen = new Set<string>();

      const addFinding = (f: Finding): void => {
        const key = `${f.file}:${f.line}:${f.rule}`;
        if (seen.has(key)) return;
        seen.add(key);
        if (findings.length >= maxFindings) {
          truncated = true;
          return;
        }
        findings.push(f);
        byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
      };

      for (const root of roots) {
        if (ctx.signal?.aborted || Date.now() - start > TIME_LIMIT_MS) {
          truncated = true;
          break;
        }
        let candidates: string[];
        // A single file path scans just that file; a directory discovers beneath it.
        let isSingleFile = false;
        try {
          const st = lstatSync(root);
          isSingleFile = st.isFile();
        } catch {
          filesSkipped++;
          continue;
        }
        if (isSingleFile) {
          candidates = [root];
        } else {
          const disc = discoverFiles(root, ctx.signal ?? new AbortController().signal);
          candidates = disc.files.map((f) => join(root, f));
        }

        for (const full of candidates) {
          if (filesScanned >= maxFiles || ctx.signal?.aborted || Date.now() - start > TIME_LIMIT_MS) {
            truncated = true;
            break;
          }
          const rel = relative(ctx.workspaceRoot, full).split(sep).join('/');
          const ext = rel.includes('.') ? '.' + rel.split('.').pop()!.toLowerCase() : '';
          if (BINARY_EXT.has(ext)) {
            filesSkipped++;
            continue;
          }
          let st: Stats;
          try {
            st = lstatSync(full);
          } catch {
            filesSkipped++;
            continue;
          }
          if (!st.isFile() || st.size > MAX_FILE_BYTES) {
            filesSkipped++;
            continue;
          }
          let buf: Buffer;
          try {
            buf = readFileSync(full);
          } catch {
            filesSkipped++;
            continue;
          }
          if (looksBinary(buf)) {
            filesSkipped++;
            continue;
          }
          filesScanned++;
          const lines = buf.toString('utf8').split('\n');
          for (let i = 0; i < lines.length; i++) {
            if ((i & 255) === 0 && (ctx.signal?.aborted || Date.now() - start > TIME_LIMIT_MS)) {
              truncated = true;
              break;
            }
            const line = lines[i]!;
            if (line.length > 4000) continue; // skip minified mega-lines
            // Shape rules (high confidence). Mask only the secret capture group.
            for (const { id, pattern, secretGroup } of rules) {
              pattern.lastIndex = 0;
              let m: RegExpExecArray | null;
              let guard = 0;
              while ((m = pattern.exec(line)) !== null && guard++ < 20) {
                const secret = m[secretGroup] ?? m[0];
                addFinding({ file: rel, line: i + 1, rule: id, preview: maskSecret(secret), kind: 'shape' });
                if (m.index === pattern.lastIndex) pattern.lastIndex++;
              }
            }
            // Entropy heuristic (generic assignments).
            if (useEntropy) {
              ASSIGN_RE.lastIndex = 0;
              let am: RegExpExecArray | null;
              let guard = 0;
              while ((am = ASSIGN_RE.exec(line)) !== null && guard++ < 20) {
                const value = am[1]!;
                if (shannonEntropy(value) >= minEntropy) {
                  addFinding({ file: rel, line: i + 1, rule: 'high-entropy-assignment', preview: maskSecret(value), kind: 'entropy' });
                }
                if (am.index === ASSIGN_RE.lastIndex) ASSIGN_RE.lastIndex++;
              }
            }
          }
        }
      }

      const data: SecretsScanData = {
        filesScanned,
        filesSkipped,
        findings,
        totalFindings: findings.length,
        truncated,
        byRule,
      };
      const summary = clamp(
        JSON.stringify({
          filesScanned,
          filesSkipped,
          totalFindings: findings.length,
          truncated,
          byRule,
          findings,
        }),
        MAX_OUTPUT_CHARS,
      );
      return ok('secrets_scan', 'read', Date.now() - start, summary, data);
    } catch (e) {
      return failNow('scan_error', (e as Error).message);
    }
  },
};