import { readFileSync, existsSync, statSync } from 'node:fs';
import { z } from 'zod';
import type { Tool, ToolResult } from './types.js';
import { ok, fail } from './types.js';
import { resolveWithin } from '../safety/workspaceJail.js';
import { atomicWrite } from './util.js';
import { diffLines } from '../util/diff.js';
import { saveCheckpoint } from '../state/checkpoints.js';

const inputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe('Destination path, relative to the workspace root or absolute. Must stay inside the workspace.'),
  content: z.string().describe('Full file content to write. Overwrites any existing content.'),
});

type WriteFileInput = z.infer<typeof inputSchema>;

export interface WriteFileData {
  path: string;
  bytesWritten: number;
  changed: boolean;
}

export const writeFile: Tool<WriteFileInput, WriteFileData> = {
  name: 'write_file',
  description:
    'Create a new file or completely overwrite an existing one with the given content. ' +
    'Parent directories are created automatically. The write is atomic (temp file + rename) and ' +
    'idempotent: if the file already holds identical content it is left untouched and reported as ' +
    'unchanged. For a small change to an existing file, prefer edit_file.',
  risk: 'write',
  inputSchema,
  async run(input, ctx): Promise<ToolResult<WriteFileData>> {
    const start = Date.now();
    let abs: string;
    try {
      abs = resolveWithin([ctx.workspaceRoot, ...(ctx.additionalRoots ?? [])], input.path);
    } catch (e) {
      return fail('write_file', 'write', Date.now() - start, 'outside_workspace', (e as Error).message);
    }

    const bytes = Buffer.byteLength(input.content, 'utf8');

    // Refuse to clobber a directory.
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      return fail('write_file', 'write', Date.now() - start, 'is_directory', `"${input.path}" is a directory.`);
    }

    // Idempotency: identical existing content → no-op.
    let existed = false;
    let oldText = '';
    if (existsSync(abs)) {
      existed = true;
      try {
        oldText = readFileSync(abs, 'utf8');
        if (oldText === input.content) {
          return ok(
            'write_file',
            'write',
            Date.now() - start,
            `"${input.path}" already up to date — no change (${bytes} bytes).`,
            { path: abs, bytesWritten: bytes, changed: false },
          );
        }
      } catch {
        /* unreadable (e.g. binary) — fall through and overwrite */
      }
    }

    if (ctx.dryRun) {
      return ok(
        'write_file',
        'write',
        Date.now() - start,
        `[dry-run] would ${existed ? 'overwrite' : 'create'} "${input.path}" (${bytes} bytes).`,
        { path: abs, bytesWritten: bytes, changed: true },
      );
    }

    try {
      if (ctx.checkpoint && existed) {
        saveCheckpoint(ctx.workspaceRoot, ctx.checkpoint.sessionId, ctx.checkpoint.turn, input.path, oldText);
      }
      atomicWrite(abs, input.content);
    } catch (e) {
      return fail('write_file', 'write', Date.now() - start, 'write_failed', `write failed: ${(e as Error).message}`);
    }

    ctx.readTracker?.markRead(abs);
    ctx.readTracker?.markSeen(abs); // newly created/written by us → can edit without separate read_file

    const res = ok(
      'write_file',
      'write',
      Date.now() - start,
      `${existed ? 'Overwrote' : 'Created'} "${input.path}" (${bytes} bytes).`,
      { path: abs, bytesWritten: bytes, changed: true },
    );
    const diff = diffLines(oldText, input.content); // UI-only; rides on meta, not the model result
    if (diff.length) res.meta.diff = diff;
    return res;
  },
};
