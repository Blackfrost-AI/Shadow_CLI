import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Tool, ToolResult } from './types.js';
import { ok, fail } from './types.js';
import { resolveWithin } from '../safety/workspaceJail.js';
import { applyStringEdit, nearestMatch, atomicWrite } from './util.js';
import { diffLines } from '../util/diff.js';
import { saveCheckpoint } from '../state/checkpoints.js';

const inputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe('File to edit, relative to the workspace root or absolute. Must stay inside the workspace.'),
  old_string: z.string().describe('Exact text to find. Must match the file exactly and be unique unless replace_all is true.'),
  new_string: z.string().describe('Text to replace old_string with.'),
  replace_all: z
    .boolean()
    .optional()
    .describe('Replace every occurrence instead of requiring a unique match. Default false.'),
});

type EditFileInput = z.infer<typeof inputSchema>;

export interface EditFileData {
  path: string;
  replacements: number;
}

export const editFile: Tool<EditFileInput, EditFileData> = {
  name: 'edit_file',
  description:
    'Make a targeted edit to an existing file by replacing an exact string. old_string must match ' +
    'the file exactly (read the file first) and be unique, unless replace_all is true. If old_string ' +
    'is not unique, the edit is refused — add surrounding context to disambiguate. The write is atomic.',
  risk: 'write',
  inputSchema,
  async run(input, ctx): Promise<ToolResult<EditFileData>> {
    const start = Date.now();
    const replaceAll = input.replace_all ?? false;

    let abs: string;
    try {
      abs = resolveWithin([ctx.workspaceRoot, ...(ctx.additionalRoots ?? [])], input.path);
    } catch (e) {
      return fail('edit_file', 'write', Date.now() - start, 'outside_workspace', (e as Error).message);
    }

    if (input.old_string === input.new_string) {
      return fail(
        'edit_file',
        'write',
        Date.now() - start,
        'noop',
        'old_string and new_string are identical — nothing to do.',
      );
    }

    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch (e) {
      return fail(
        'edit_file',
        'write',
        Date.now() - start,
        'read_failed',
        `could not read "${input.path}": ${(e as Error).message}`,
      );
    }

    // Conversation read guard (Claude parity): you must have called read_file on this path
    // (or write_file to create it) in this session, or the edit is refused.
    if (ctx.readTracker && !ctx.readTracker.hasSeen(abs)) {
      return fail(
        'edit_file',
        'write',
        Date.now() - start,
        'read_required',
        'You must use the read_file tool on this file before editing it. (Exact string match alone is not sufficient — read it in this conversation first.)',
      );
    }

    // Stale-edit guard: if it has changed on disk since last mark, refuse.
    const guard = ctx.readTracker?.check(abs);
    if (guard && !guard.ok) {
      return fail('edit_file', 'write', Date.now() - start, 'read_required', guard.reason);
    }

    const result = applyStringEdit(text, input.old_string, input.new_string, replaceAll);
    if (!result.ok) {
      if (result.reason === 'multiple') {
        return fail(
          'edit_file',
          'write',
          Date.now() - start,
          'not_unique',
          `old_string matches ${result.count} times. Add surrounding lines to make it unique, or pass replace_all: true.`,
        );
      }
      const near = nearestMatch(text, input.old_string);
      const tail = near ? `\n\nClosest region of the file — compare it against your old_string:\n${near}` : '';
      if (result.reason === 'ambiguous') {
        return fail(
          'edit_file',
          'write',
          Date.now() - start,
          'ambiguous',
          `old_string was not found exactly, and the closest fuzzy match is ambiguous (two regions are ` +
            `about equally similar), so I will not guess. Make old_string match the file exactly.${tail}`,
        );
      }
      return fail(
        'edit_file',
        'write',
        Date.now() - start,
        'not_found',
        `old_string was not found — it must match the file exactly, character for character.${tail}`,
      );
    }

    const via = result.strategy === 'exact' ? '' : ` (matched via ${result.strategy})`;

    if (ctx.dryRun) {
      return ok(
        'edit_file',
        'write',
        Date.now() - start,
        `[dry-run] would replace ${result.count} occurrence(s) in "${input.path}"${via}.`,
        { path: abs, replacements: result.count },
      );
    }

    try {
      if (ctx.checkpoint) {
        saveCheckpoint(ctx.workspaceRoot, ctx.checkpoint.sessionId, ctx.checkpoint.turn, input.path, text);
      }
      atomicWrite(abs, result.updated);
    } catch (e) {
      return fail('edit_file', 'write', Date.now() - start, 'write_failed', `write failed: ${(e as Error).message}`);
    }

    ctx.readTracker?.markRead(abs);
    ctx.readTracker?.markSeen(abs); // edited by us → still known for subsequent edits

    const res = ok(
      'edit_file',
      'write',
      Date.now() - start,
      `Edited "${input.path}" — replaced ${result.count} occurrence(s)${via}.`,
      { path: abs, replacements: result.count },
    );
    const diff = diffLines(text, result.updated); // UI-only; rides on meta, not the model result
    if (diff.length) res.meta.diff = diff;
    return res;
  },
};
