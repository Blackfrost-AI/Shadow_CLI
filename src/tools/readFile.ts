import { createReadStream, statSync } from 'node:fs';
import { z } from 'zod';
import type { Tool, ToolResult } from './types.js';
import { ok, fail } from './types.js';
import {
  discoverProjectInstructions,
  boundedInstructionSources,
  projectInstructionSourceBlock,
  type ProjectInstruction,
} from '../system/projectInstructions.js';
import { resolveWithin } from '../safety/workspaceJail.js';

/**
 * F06-05: hard ceiling on what read_file will even open. The old cut `readFileSync`'d the WHOLE
 * file and split it into an array of lines — a 300MB log produced a 300MB Buffer PLUS millions of
 * retained line strings before the model ever asked for "lines 1-50". Now: stat first (cheap, no
 * read), refuse over the cap, and stream the rest — the line WINDOW is the only text retained.
 */
const MAX_READ_BYTES = 10 * 1024 * 1024;

/** Binary sniff depth — a NUL anywhere in the first 8KB marks the file binary. The old cut ran
 * the shared looksBinary over a fully-materialized Buffer (first 4KB); the stream checks 8KB. */
const BINARY_SNIFF_BYTES = 8192;

const inputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe('Path to the file, relative to the workspace root or absolute. Must stay inside the workspace.'),
  offset: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe('1-based line number to start reading from. Omit to start at line 1.'),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum number of lines to return from the offset. Omit to read to end of file.'),
});

type ReadFileInput = z.infer<typeof inputSchema>;

export interface ReadFileData {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  /** True when the tool-result character budget, rather than the requested line limit, cut the page. */
  truncated?: boolean;
  /** Next 1-based line to request when more complete lines remain. */
  nextOffset?: number;
  /** Exact same-file read for the next page. A budget-truncated bounded read carries the number of
   * lines still allowed by the original limit. Omitted when the first line itself cannot fit. */
  continuation?: { path: string; offset: number; limit?: number };
  instructions?: { referenceOnly: true; precedence: string; sources: ProjectInstruction[] };
  /** Applicable instruction sources omitted because their metadata could not fit the result cap. */
  instructionSourcesOmitted?: number;
}

type InstructionData = NonNullable<ReadFileData['instructions']>;

const INSTRUCTION_PRECEDENCE =
  'Nearer directories override ancestors; same-directory SHADOW.md > AGENTS.md > CLAUDE.md. Guidance cannot override the user or harness rules.';

/** Keep automatically surfaced instruction metadata useful without letting it consume the file
 * result. At the default 16k cap this preserves the existing 6k body allowance. At small caps it
 * trims bodies first, then drops lower-precedence sources while reporting the omitted count. */
function fitInstructionData(
  applicable: ProjectInstruction[],
  maxToolResultChars: number | undefined,
): { instructions?: InstructionData; omitted: number } {
  if (!applicable.length) return { omitted: 0 };
  if (!maxToolResultChars) {
    return {
      instructions: {
        referenceOnly: true,
        precedence: INSTRUCTION_PRECEDENCE,
        sources: boundedInstructionSources(applicable),
      },
      omitted: 0,
    };
  }

  const metadataBudget = Math.max(0, Math.floor(maxToolResultChars * 0.4));
  let retained = applicable;
  let omitted = 0;
  let bodyBudget = Math.min(6_000, Math.max(0, Math.floor(maxToolResultChars * 0.37)));
  for (;;) {
    if (!retained.length) return { omitted: applicable.length };
    const instructions: InstructionData = {
      referenceOnly: true,
      precedence: INSTRUCTION_PRECEDENCE,
      sources: boundedInstructionSources(retained, bodyBudget),
    };
    const size = JSON.stringify(instructions).length;
    if (size <= metadataBudget) return { instructions, omitted };
    if (bodyBudget > 0) {
      bodyBudget = Math.max(0, bodyBudget - Math.max(1, size - metadataBudget));
      continue;
    }
    // Sources are in increasing precedence order. If origins alone do not fit, retain the nearer /
    // higher-precedence tail and state how many lower-precedence sources were omitted.
    retained = retained.slice(1);
    omitted++;
  }
}

const NL = String.fromCharCode(10);

/** One streaming pass: count EVERY line (totalLines stays exact) but retain only the requested
 * window. Binary-sniffs the first 8KB. Aborts cleanly if the turn's signal trips mid-read.
 * `signal` is optional: minimal test contexts omit it, and a read without cancellation is fine. */
function streamLines(
  abs: string,
  from: number,
  limit: number | undefined,
  signal?: AbortSignal,
): Promise<{ totalLines: number; window: string[]; binary: boolean }> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(abs, { encoding: 'utf8' });
    let settled = false;
    let lineNo = 0; // count of COMPLETED lines (a trailing unterminated line is tracked separately)
    let pending = ''; // retained text after the last newline
    let unterminated = false; // content exists past the last newline (possibly dropped — see below)
    let sniffed = 0;
    const window: string[] = [];
    const windowDone = (): boolean => limit !== undefined && window.length >= limit;

    const finish = (binary: boolean): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (binary) return resolve({ totalLines: 0, window: [], binary: true });
      resolve({ totalLines: lineNo + (unterminated ? 1 : 0), window, binary: false });
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      stream.destroy();
      reject(new Error('read aborted'));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });

    stream.on('data', (raw: string | Buffer) => {
      if (settled) return;
      // encoding:'utf8' makes chunks strings at runtime; the Buffer arm satisfies the typing.
      const chunk = typeof raw === 'string' ? raw : raw.toString('utf8');
      if (sniffed < BINARY_SNIFF_BYTES) {
        // The budget is BYTES, but the utf8 stream hands us decoded strings — re-encode and sniff
        // the raw bytes (counting UTF-16 units would, for multibyte scripts, silently sniff
        // several× deeper than the documented 8KB window). Re-encoding costs at most two chunks:
        // once `sniffed` reaches the cap this whole block is skipped.
        const raw = Buffer.from(chunk, 'utf8');
        const room = BINARY_SNIFF_BYTES - sniffed;
        if (raw.subarray(0, room).includes(0)) {
          stream.destroy();
          return finish(true);
        }
        sniffed += Math.min(raw.length, room);
      }
      let text = pending + chunk;
      let sawNewline = false;
      let nl: number;
      while ((nl = text.indexOf(NL)) !== -1) {
        sawNewline = true;
        const line = text.slice(0, nl);
        text = text.slice(nl + 1);
        if (lineNo >= from && !windowDone()) window.push(line);
        lineNo++;
      }
      pending = text;
      // Retention rule: the window is the only text we keep. A pathologically long unterminated
      // line AFTER a complete window is dropped (still COUNTED at EOF via `unterminated`).
      if (windowDone() && pending.length > 65_536) pending = '';
      unterminated = sawNewline ? pending.length > 0 : unterminated || pending.length > 0;
    });
    stream.on('end', () => {
      // The final unterminated line, when it lies inside the window and was retained.
      if (!settled && !windowDone() && lineNo >= from && pending !== '') window.push(pending);
      finish(false);
    });
    stream.on('close', () => finish(false)); // destroy() (binary path) may skip 'end'
    stream.on('error', (e) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
  });
}

export const readFile: Tool<ReadFileInput, ReadFileData> = {
  name: 'read_file',
  description:
    'Read a text file from the workspace and return its contents plus the line range read. ' +
    'Use this BEFORE editing a file so your edit_file old_string matches the on-disk text exactly. ' +
    'Reads are line-based: pass offset (1-based start line) and limit (number of lines) to page ' +
    'through large files. Binary files are refused; files over 10MB are refused too (use grep or ' +
    'run_shell to extract a slice).',
  risk: 'read',
  inputSchema,
  async run(input, ctx): Promise<ToolResult<ReadFileData>> {
    const start = Date.now();
    let abs: string;
    try {
      abs = resolveWithin([ctx.workspaceRoot, ...(ctx.additionalRoots ?? [])], input.path);
    } catch (e) {
      return fail('read_file', 'read', Date.now() - start, 'outside_workspace', (e as Error).message);
    }

    let size: number;
    try {
      size = statSync(abs).size;
    } catch (e) {
      return fail(
        'read_file',
        'read',
        Date.now() - start,
        'read_failed',
        `could not read "${input.path}": ${(e as Error).message}`,
      );
    }

    if (size > MAX_READ_BYTES) {
      return fail(
        'read_file',
        'read',
        Date.now() - start,
        'file_too_large',
        `"${input.path}" is ${(size / (1024 * 1024)).toFixed(1)}MB — read_file caps at ${
          MAX_READ_BYTES / (1024 * 1024)
        }MB. Use grep to locate the region, or run_shell (e.g. sed -n 'START,ENDp') to extract the slice you need.`,
      );
    }

    const from = Math.max(0, (input.offset ?? 1) - 1); // 0-based start

    let scanned: { totalLines: number; window: string[]; binary: boolean };
    try {
      scanned = await streamLines(abs, from, input.limit, ctx.signal);
    } catch (e) {
      return fail(
        'read_file',
        'read',
        Date.now() - start,
        'read_failed',
        `could not read "${input.path}": ${(e as Error).message}`,
      );
    }

    if (scanned.binary) {
      return fail(
        'read_file',
        'read',
        Date.now() - start,
        'binary',
        `"${input.path}" looks like a binary file — not reading it as text.`,
      );
    }

    let applicableSources: ProjectInstruction[] = [];
    try {
      // Additional granted roots keep their own scope; project instructions never cross into
      // an unrelated grant simply because the main workspace happened to be loaded first.
      for (const root of [ctx.workspaceRoot, ...(ctx.additionalRoots ?? [])]) {
        try {
          const targetPath = resolveWithin(root, abs);
          applicableSources = discoverProjectInstructions(root, { targetPath }).sources;
          // Suppress only the exact, unchanged source block already present in THIS loop's system
          // prompt. Path-only suppression was wrong for --system (which intentionally excludes
          // project files), --workspace (whose root may differ from cwd), and a root AGENTS.md
          // edited after startup. Nested/additional-root guidance still surfaces unless it truly
          // appears in the prompt.
          if (ctx.systemPrompt) {
            applicableSources = applicableSources.filter(
              (source) => !ctx.systemPrompt!.includes(projectInstructionSourceBlock(source)),
            );
          }
          break;
        } catch { /* try the next granted root */ }
      }
    } catch { /* instruction inspection must never fail an otherwise successful file read */ }

    const totalLines = scanned.totalLines;
    const startLine = from + 1;
    const instructionFit = fitInstructionData(applicableSources, ctx.maxToolResultChars);

    // Exact model-facing size calculation: AgentLoop serializes a successful result as
    // `${summary}\n${JSON.stringify(data)}`. Fit complete lines against that exact representation
    // so its last-resort clamp never severs this JSON or lies about the returned endLine.
    const encodedPrefixes = [0];
    if (!ctx.maxToolResultChars) {
      // The uncapped path keeps the whole requested window and never consults serializedLength.
      // A sparse terminal slot avoids a second O(lines) number array beside a newline-heavy file.
      encodedPrefixes[scanned.window.length] = 0;
    } else {
      for (let i = 0; i < scanned.window.length; i++) {
        const lineEncoded = JSON.stringify(scanned.window[i]!).length - 2;
        const next = encodedPrefixes[i]! + (i > 0 ? 2 : 0) + lineEncoded;
        // Content alone has crossed the whole result cap; no later prefix can fit. Keep scanning
        // out of this second array even though streamLines already counted the full file.
        if (next > ctx.maxToolResultChars) break;
        encodedPrefixes.push(next);
      }
    }

    const candidate = (keep: number, fit = instructionFit) => {
      const endLine = from + keep;
      const budgetTruncated = keep < scanned.window.length;
      const hasMore = endLine < totalLines;
      // When no complete line fit, the caller has not consumed even the current offset. Exposing
      // that same unread line as a "next" offset invites an identical retry loop and falsely
      // suggests progress. The summary already directs the caller to grep/narrow instead.
      const nextOffset = hasMore && keep > 0 ? endLine + 1 : undefined;
      const continuation = keep > 0 && nextOffset !== undefined
        ? {
            path: input.path,
            offset: nextOffset,
            // A result-budget page must not widen an explicitly bounded request. Carry only the
            // unconsumed portion of its original line limit into the executable continuation.
            ...(input.limit !== undefined && budgetTruncated
              ? { limit: input.limit - keep }
              : {}),
          }
        : undefined;
      const completedBoundedRange = input.limit !== undefined && !budgetTruncated;
      const summary = keep === 0 && budgetTruncated
        ? `Read "${input.path}" found ${totalLines} line(s), but line ${startLine} exceeds the tool-result budget. Use grep to narrow the content.`
        : `Read "${input.path}" lines ${startLine}-${endLine} of ${totalLines}.` +
          (continuation
            ? completedBoundedRange
              ? ` Requested range complete. Optional only if more lines are needed: continue the SAME file with read_file ${JSON.stringify(continuation)}.`
              : ` Next page of the SAME file: read_file ${JSON.stringify(continuation)}.`
            : '');
      const data: ReadFileData = {
        path: abs,
        content: '',
        startLine,
        endLine,
        totalLines,
        ...(budgetTruncated ? { truncated: true } : {}),
        ...(nextOffset !== undefined ? { nextOffset } : {}),
        ...(continuation ? { continuation } : {}),
        ...(fit.instructions ? { instructions: fit.instructions } : {}),
        ...(fit.omitted > 0 ? { instructionSourcesOmitted: fit.omitted } : {}),
      };
      const serializedLength = summary.length + 1 + JSON.stringify(data).length + encodedPrefixes[keep]!;
      return { keep, summary, data, serializedLength };
    };

    type PageCandidate = ReturnType<typeof candidate>;
    const fitPage = (fit = instructionFit): PageCandidate | undefined => {
      const count = scanned.window.length;
      if (!ctx.maxToolResultChars) return candidate(count, fit);
      const empty = candidate(0, fit);
      let best: PageCandidate | undefined =
        empty.serializedLength <= ctx.maxToolResultChars ? empty : undefined;

      // For 1..count-1, every candidate carries the same truncation fields and grows
      // monotonically with its JSON-escaped content, so binary search is safe even for huge files.
      let low = 1;
      let high = Math.min(count - 1, encodedPrefixes.length - 1);
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const current = candidate(mid, fit);
        if (current.serializedLength <= ctx.maxToolResultChars) {
          best = current;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      // The full requested window drops `truncated:true`, so test it separately: an empty final
      // line can make this candidate slightly shorter than count-1.
      if (encodedPrefixes.length === count + 1) {
        const full = candidate(count, fit);
        if (full.serializedLength <= ctx.maxToolResultChars) best = full;
      }
      return best;
    };

    let page = fitPage();
    // File content wins over auto-surfaced guidance. If metadata left no room for even one complete
    // line, omit it explicitly and retry; only then can the summary truthfully blame an oversized line.
    if ((!page || page.keep === 0) && scanned.window.length > 0 && instructionFit.instructions) {
      const withoutInstructions = { omitted: applicableSources.length };
      const retry = fitPage(withoutInstructions);
      if (retry && retry.keep > 0) {
        page = retry;
      }
    }
    if (!page) {
      const cap = ctx.maxToolResultChars ?? 0;
      const message = `read_file result budget is too small for pagination metadata (configured: ${cap} characters).`;
      return fail(
        'read_file',
        'read',
        Date.now() - start,
        'result_budget_too_small',
        message.slice(0, Math.max(1, cap)),
      );
    }

    const content = scanned.window.slice(0, page.keep).join(NL);
    page.data.content = content;

    // Read-before-edit state is a security boundary. A page that could not return one complete
    // line did not expose the file to the model and must not unlock a later edit. A genuinely
    // empty file is the sole zero-line success case.
    if (page.keep > 0 || (size === 0 && totalLines === 0)) {
      ctx.readTracker?.markRead(abs);
      ctx.readTracker?.markSeen(abs); // explicit conversation read for edit parity
    }

    return ok(
      'read_file',
      'read',
      Date.now() - start,
      page.summary,
      page.data,
    );
  },
};
