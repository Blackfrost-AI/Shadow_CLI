import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Tool, ToolResult } from './types.js';
import { ok, fail } from './types.js';
import { resolveWithin } from '../safety/workspaceJail.js';
import { looksBinary } from './util.js';

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

export const readFile: Tool<ReadFileInput, ReadFileData> = {
  name: 'read_file',
  description:
    'Read a text file from the workspace and return its contents plus the line range read. ' +
    'Use this BEFORE editing a file so your edit_file old_string matches the on-disk text exactly. ' +
    'Reads are line-based: pass offset (1-based start line) and limit (number of lines) to page ' +
    'through large files. Binary files are refused.',
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

    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch (e) {
      return fail(
        'read_file',
        'read',
        Date.now() - start,
        'read_failed',
        `could not read "${input.path}": ${(e as Error).message}`,
      );
    }

    if (looksBinary(buf)) {
      return fail(
        'read_file',
        'read',
        Date.now() - start,
        'binary',
        `"${input.path}" looks like a binary file — not reading it as text.`,
      );
    }

    const text = buf.toString('utf8');
    const rawLines = text.split('\n');
    // A trailing newline yields a phantom empty final element from split — "a\nb\n" is 2 lines, not 3.
    // Drop that artifact so totalLines and the returned range are accurate (and the model doesn't see a
    // ghost blank last line).
    const lines =
      rawLines.length > 1 && rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines;
    const totalLines = lines.length;

    const from = Math.max(0, (input.offset ?? 1) - 1); // 0-based start
    const sliced = input.limit !== undefined ? lines.slice(from, from + input.limit) : lines.slice(from);
    const startLine = from + 1;
    const endLine = from + sliced.length; // when slice is empty, endLine === startLine - 1
    const content = sliced.join('\n');

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
