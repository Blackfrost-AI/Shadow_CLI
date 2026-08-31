/**
 * Import Claude Code transcripts into Shadow's session store.
 *
 * Claude Code stores sessions under `<baseDir>/<encoded-project-path>/<sessionId>.jsonl`
 * (default baseDir `~/.claude/projects`) — one JSON record per line:
 * `{type: user|assistant|system|summary…, message: {role, content: string | blocks[]}, timestamp, …}`,
 * with the project path dash-encoded in the directory name (e.g. `-Users-craigmac-shadow-cli`).
 *
 * This module SCANS that tree and REWRITES transcripts as genuine Shadow session files in the
 * target store: replay records (`kind: user|event`, the shapes `shadow export` renders) plus a
 * final `context_snapshot` record in Shadow's block-based Message model — so imported sessions
 * are immediately resumable. Foreign tool names/args (Claude's Read/Write/Edit/Bash) are
 * normalized through the foreignAdapter, so imported transcripts round-trip through display.
 *
 * The source tree is treated strictly READ-ONLY: this module only ever reads under baseDir.
 * All written records pass through the same `redact` scrubber Shadow's own session log uses.
 * Shadow session ids derive deterministically from the Claude session id (`claude-<id>`), so
 * re-imports dedupe: an existing target file is skipped, never overwritten.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { redact } from '../util/redact.js';
import { textOf, type ContentBlock, type Message } from '../provider/provider.js';
import { normalizeForeignTool } from '../tools/foreignAdapter.js';

/** Prefix of Shadow session ids derived from Claude session ids. */
export const CLAUDE_ID_PREFIX = 'claude-';
/** Files above this size are skipped (scan warns, import refuses). */
export const CLAUDE_MAX_IMPORT_BYTES = 50 * 1024 * 1024; // 50 MB
/** How much of a file the cheap scan reads (title + metadata come from the head). */
const SCAN_HEAD_BYTES = 256 * 1024;
/** Title hunt looks at this many leading records at most. */
const TITLE_RECORD_LIMIT = 50;
/** Default cap on how many sessions a scan lists (newest first). */
const DEFAULT_MAX_LISTED = 100;
/** Replay-record summary cap so a huge tool result can't bloat the session file. */
const RESULT_SUMMARY_CAP = 1000;

export interface ClaudeSessionInfo {
  /** Absolute path of the Claude transcript (read-only source). */
  file: string;
  /** Claude session id (the JSONL filename stem). */
  sessionId: string;
  /** Decoded project path — the transcript's own `cwd` when present, else dash-decoded dir name. */
  projectPath: string;
  mtimeMs: number;
  sizeBytes: number;
  /** First meaningful user text (first ~50 records), '' when none. */
  title: string;
  /** Approximate turn count (assistant responses; extrapolated when only the head was read). */
  turns: number;
}

export interface ClaudeScanResult {
  /** Newest (mtime) first, capped at `maxListed`. */
  sessions: ClaudeSessionInfo[];
  /** Human-readable skip/parse problems (oversized files, unparseable files, missing dir). */
  warnings: string[];
  /** True when more sessions were found than `maxListed`. */
  truncated: boolean;
}

export type ClaudeImportStatus = 'imported' | 'skipped-duplicate' | 'skipped-too-large' | 'failed';

export interface ClaudeImportResult {
  file: string;
  sessionId: string;
  status: ClaudeImportStatus;
  /** Set for imported and skipped-duplicate. */
  targetPath?: string;
  /** Shadow Message count written (imported only). */
  messageCount?: number;
  /** Lines that failed to parse and were dropped. */
  skippedLines?: number;
  /** Set for failed. */
  error?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Best-effort inverse of Claude's dash-encoding (`-Users-x-proj` → `/Users/x/proj`).
 * Ambiguous when a path segment itself contains a dash — prefer the transcript's own `cwd`,
 * which the scanner does whenever the record carries one.
 */
export function decodeClaudeProjectDir(dirName: string): string {
  return '/' + dirName.replace(/^-/, '').replace(/-/g, '/');
}

/** Deterministic Shadow session id for a Claude session id (filesystem-safe). */
export function shadowSessionIdForClaude(claudeSessionId: string): string {
  return CLAUDE_ID_PREFIX + claudeSessionId.replace(/[^A-Za-z0-9._-]/g, '-');
}

/** Read up to `maxBytes` from the start of a file; returns null on I/O failure. */
function readHead(
  file: string,
  sizeBytes: number,
  maxBytes: number,
): { text: string; bytesRead: number; complete: boolean } | null {
  let fd: number | undefined;
  try {
    const want = Math.min(sizeBytes, maxBytes);
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(want);
    const got = readSync(fd, buf, 0, want, 0);
    let text = buf.toString('utf8', 0, got);
    const complete = got >= sizeBytes;
    if (!complete) {
      // Don't hand back a torn trailing line — cut at the last newline boundary.
      const nl = text.lastIndexOf('\n');
      if (nl >= 0) text = text.slice(0, nl);
    }
    return { text, bytesRead: got, complete };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
  }
}

/** Parse JSONL text; unparseable/non-object lines are counted, never thrown on. */
function parseJsonl(text: string): { records: Array<Record<string, unknown>>; skipped: number } {
  const records: Array<Record<string, unknown>> = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (isRecord(v)) records.push(v);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { records, skipped };
}

/** Claude tool_result `content` (string or blocks[]) → model-facing text. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (isRecord(b) && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** Map one Claude `message.content` (string or blocks[]) to Shadow content blocks. */
function claudeContentToBlocks(content: unknown): ContentBlock[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const out: ContentBlock[] = [];
  for (const raw of content) {
    if (!isRecord(raw)) continue;
    switch (raw.type) {
      case 'text':
        if (typeof raw.text === 'string') out.push({ type: 'text', text: raw.text });
        break;
      case 'thinking': {
        const thinking =
          typeof raw.thinking === 'string' ? raw.thinking : typeof raw.text === 'string' ? raw.text : '';
        // Keep the reasoning text for display, but drop the signature: it is long-invalid
        // outside the original request, and provider adapters only replay signed thinking —
        // an empty signature keeps the block inert when the imported session is resumed.
        out.push({ type: 'thinking', thinking, signature: '' });
        break;
      }
      case 'tool_use':
        if (typeof raw.id === 'string' && typeof raw.name === 'string') {
          // Normalize Claude's tool dialect (Read/Write/Edit/Bash + arg shapes) to Shadow's.
          const norm = normalizeForeignTool({ name: raw.name, input: raw.input });
          out.push({ type: 'tool_use', id: raw.id, name: norm.name, input: norm.input });
        }
        break;
      case 'tool_result':
        out.push({
          type: 'tool_result',
          toolCallId: typeof raw.tool_use_id === 'string' ? raw.tool_use_id : '',
          ok: raw.is_error !== true,
          content: toolResultText(raw.content),
        });
        break;
      case 'image':
        if (
          isRecord(raw.source) &&
          raw.source.type === 'base64' &&
          typeof raw.source.data === 'string' &&
          typeof raw.source.media_type === 'string'
        ) {
          out.push({ type: 'image', mediaType: raw.source.media_type, data: raw.source.data });
        }
        break;
      default:
        break; // unknown block types are dropped — replay fidelity beats a hard failure
    }
  }
  return out;
}

/** Convert one Claude JSONL record to a Shadow Message, or null (system/summary/meta noise). */
function convertClaudeRecord(rec: Record<string, unknown>): Message | null {
  const msg = isRecord(rec.message) ? rec.message : null;
  if (!msg) return null;
  const role =
    msg.role === 'user' || rec.type === 'user'
      ? 'user'
      : msg.role === 'assistant' || rec.type === 'assistant'
        ? 'assistant'
        : null;
  if (!role) return null;
  const content = claudeContentToBlocks(msg.content);
  if (!content.length) return null;
  return { role, content };
}

/**
 * Convert a whole Claude transcript to Shadow Messages:
 * - consecutive same-role records merge (Anthropic requires alternating roles; Claude
 *   transcripts routinely run user records together),
 * - tool_results whose tool_use never appeared (e.g. lost to a malformed line) are dropped —
 *   both providers reject an unmatched result.
 * Returns messages + the number of assistant responses (used as the snapshot `turn`).
 */
export function convertClaudeTranscript(records: Array<Record<string, unknown>>): {
  messages: Message[];
  assistantTurns: number;
} {
  const messages: Message[] = [];
  const seenToolUse = new Set<string>();
  let assistantTurns = 0;
  for (const rec of records) {
    const m = convertClaudeRecord(rec);
    if (!m) continue;
    if (m.role === 'assistant') assistantTurns++;
    let content = m.content;
    if (content.some((b) => b.type === 'tool_result')) {
      content = content.filter((b) => b.type !== 'tool_result' || seenToolUse.has(b.toolCallId));
      if (!content.length) continue;
    }
    for (const b of content) if (b.type === 'tool_use') seenToolUse.add(b.id);
    const last = messages[messages.length - 1];
    if (last && last.role === m.role) last.content.push(...content);
    else messages.push({ role: m.role, content });
  }
  return { messages, assistantTurns };
}

/** Claude records that look like automated command/meta noise — excluded from titles. */
const META_TEXT_PREFIXES = ['<command-name>', '<command-message>', '<command-args>', '<local-command-'];

/** First meaningful user text within the leading records, or ''. */
function extractTitle(records: Array<Record<string, unknown>>): string {
  let seen = 0;
  for (const rec of records) {
    if (seen++ >= TITLE_RECORD_LIMIT) break;
    const m = isRecord(rec.message) ? rec.message : null;
    if (!m || (rec.type !== 'user' && m.role !== 'user')) continue;
    if (rec.isMeta === true) continue;
    const raw = m.content;
    const text =
      typeof raw === 'string'
        ? raw
        : Array.isArray(raw)
          ? raw
              .map((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
              .join('\n')
          : '';
    const t = text.trim().split('\n')[0]!.trim();
    if (!t) continue;
    if (META_TEXT_PREFIXES.some((p) => t.startsWith(p))) continue;
    return t.length > 120 ? `${t.slice(0, 117)}…` : t;
  }
  return '';
}

/**
 * List Claude Code sessions under `baseDir` with cheap metadata. Reads only the head of each
 * file (title from the first ~50 records, turn count extrapolated when the head is partial).
 * Unreadable/oversized/unparseable files are skipped with a warning collected in the result.
 */
export function scanClaudeSessions(baseDir: string, opts?: { maxListed?: number }): ClaudeScanResult {
  const warnings: string[] = [];
  const sessions: ClaudeSessionInfo[] = [];
  const maxListed = opts?.maxListed ?? DEFAULT_MAX_LISTED;

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    warnings.push(`no Claude Code projects directory at ${baseDir}`);
    return { sessions, warnings, truncated: false };
  }

  for (const dir of projectDirs) {
    const dirPath = join(baseDir, dir);
    let files: string[];
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue; // unreadable project dir — nothing to import from it
    }
    for (const f of files) {
      const file = join(dirPath, f);
      let st;
      try {
        st = statSync(file);
      } catch {
        warnings.push(`unreadable: ${file}`);
        continue;
      }
      if (st.size > CLAUDE_MAX_IMPORT_BYTES) {
        warnings.push(`skipped ${file}: ${st.size} bytes exceeds the ${CLAUDE_MAX_IMPORT_BYTES}-byte cap`);
        continue;
      }
      const head = readHead(file, st.size, SCAN_HEAD_BYTES);
      if (!head) {
        warnings.push(`unreadable: ${file}`);
        continue;
      }
      const { records } = parseJsonl(head.text);
      if (!records.length) {
        warnings.push(`skipped unparseable file: ${file}`);
        continue;
      }
      // Project path: the transcript's own `cwd` is exact; dash-decoding is the fallback.
      let projectPath = '';
      for (const r of records) {
        if (typeof r.cwd === 'string' && r.cwd) {
          projectPath = r.cwd;
          break;
        }
      }
      if (!projectPath) projectPath = decodeClaudeProjectDir(dir);
      const headTurns = records.filter(
        (r) => r.type === 'assistant' || (isRecord(r.message) && r.message.role === 'assistant'),
      ).length;
      const turns = head.complete
        ? headTurns
        : Math.max(headTurns, Math.round((headTurns * st.size) / Math.max(1, head.bytesRead)));
      sessions.push({
        file,
        sessionId: f.replace(/\.jsonl$/, ''),
        projectPath,
        mtimeMs: st.mtimeMs,
        sizeBytes: st.size,
        title: extractTitle(records),
        turns,
      });
    }
  }

  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const truncated = sessions.length > maxListed;
  return { sessions: truncated ? sessions.slice(0, maxListed) : sessions, warnings, truncated };
}

/**
 * Convert one Claude transcript into a genuine Shadow session file in `targetStore` (Shadow's
 * session directory). Deterministic target name (`claude-<sessionId>.jsonl`) → re-imports
 * dedupe. Never modifies the source; never throws (failures come back as `failed`).
 */
export function importClaudeSession(file: string, targetStore: string): ClaudeImportResult {
  const sessionId = basename(file).replace(/\.jsonl$/, '');
  const targetPath = join(targetStore, `${shadowSessionIdForClaude(sessionId)}.jsonl`);
  try {
    if (existsSync(targetPath)) {
      return { file, sessionId, status: 'skipped-duplicate', targetPath };
    }
    let st;
    try {
      st = statSync(file);
    } catch {
      return { file, sessionId, status: 'failed', error: `unreadable source: ${file}` };
    }
    if (st.size > CLAUDE_MAX_IMPORT_BYTES) {
      return { file, sessionId, status: 'skipped-too-large' };
    }
    const { records, skipped } = parseJsonl(readFileSync(file, 'utf8'));
    const { messages, assistantTurns } = convertClaudeTranscript(records);
    if (!messages.length) {
      return { file, sessionId, status: 'failed', skippedLines: skipped, error: 'no convertible records' };
    }

    const lines: string[] = [];
    const push = (rec: Record<string, unknown>): void => {
      lines.push(JSON.stringify(redact({ ts: new Date().toISOString(), ...rec })));
    };

    // Replay records mirroring what the agent loop writes (consumed by `shadow export`).
    const calls = new Map<string, { name: string; input: unknown }>();
    for (const m of messages) {
      const text = textOf(m.content);
      if (m.role === 'user' && text.trim()) push({ kind: 'user', task: text });
      if (m.role === 'assistant' && text.trim()) push({ kind: 'event', type: 'assistant_done', text });
      for (const b of m.content) {
        if (b.type === 'tool_use') {
          calls.set(b.id, { name: b.name, input: b.input });
          push({ kind: 'event', type: 'tool_start', call: { id: b.id, name: b.name, input: b.input } });
        } else if (b.type === 'tool_result') {
          const call = calls.get(b.toolCallId);
          const summary = b.content.length > RESULT_SUMMARY_CAP ? `${b.content.slice(0, RESULT_SUMMARY_CAP)}…` : b.content;
          push({
            kind: 'event',
            type: 'tool_end',
            call: { id: b.toolCallId, ...(call ?? { name: 'tool', input: {} }) },
            result: { ok: b.ok, summary },
          });
        }
      }
    }

    // The resume payload: a standard Shadow context_snapshot record.
    push({
      kind: 'context_snapshot',
      turn: assistantTurns,
      data: {
        messages,
        pinnedPrefix: messages[0]?.role === 'user' ? 1 : 0,
        lastActualTokens: 0,
        subAgentTasks: [],
      },
      importedFrom: { source: 'claude-code', sessionId, file, importedAt: new Date().toISOString() },
    });

    mkdirSync(targetStore, { recursive: true, mode: 0o700 });
    try {
      chmodSync(targetStore, 0o700); // force perms even if umask widened the create mode
    } catch {
      /* best-effort */
    }
    writeFileSync(targetPath, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
    try {
      chmodSync(targetPath, 0o600); // match SessionLog's owner-only hygiene
    } catch {
      /* best-effort */
    }
    return { file, sessionId, status: 'imported', targetPath, messageCount: messages.length, skippedLines: skipped };
  } catch (e) {
    return { file, sessionId, status: 'failed', error: (e as Error).message };
  }
}
