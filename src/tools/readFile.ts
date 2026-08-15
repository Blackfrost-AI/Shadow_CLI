import { createReadStream, statSync } from 'node:fs';
import { z } from 'zod';
import type { Tool, ToolResult } from './types.js';
import { ok, fail } from './types.js';
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

    const totalLines = scanned.totalLines;
    const startLine = from + 1;
    const endLine = from + scanned.window.length; // when the window is empty, endLine === startLine - 1
    const content = scanned.window.join(NL);

    ctx.readTracker?.markRead(abs);
    ctx.readTracker?.markSeen(abs); // explicit conversation read for edit parity

    return ok(
      'read_file',
      'read',
      Date.now() - start,
      `Read "${input.path}" lines ${startLine}-${endLine} of ${totalLines}.`,
      { path: abs, content, startLine, endLine, totalLines },
    );
  },
};
