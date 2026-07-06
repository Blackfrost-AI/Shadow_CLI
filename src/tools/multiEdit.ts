import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Tool, ToolResult } from './types.js';
import { ok, fail } from './types.js';
import { resolveWithin } from '../safety/workspaceJail.js';
import { applyStringEdit, atomicWrite } from './util.js';
import { diffLines } from '../util/diff.js';

const editSchema = z.object({
  old_string: z.string().describe('Exact text to find (must match the file after prior edits in this call).'),
  new_string: z.string().describe('Replacement text.'),
  replace_all: z.boolean().optional().describe('Replace every occurrence. Default false.'),
});

const inputSchema = z.object({
  path: z.string().min(1).describe('File to edit, relative to the workspace or absolute.'),
  edits: z.array(editSchema).min(1).describe('Edits applied IN ORDER, each to the result of the previous.'),
});

type MultiEditInput = z.infer<typeof inputSchema>;

export interface MultiEditData {
  path: string;
  edits: number;
  replacements: number;
}

export const multiEdit: Tool<MultiEditInput, MultiEditData> = {
  name: 'multi_edit',
  description:
    'Apply several string edits to ONE file atomically, in order — each edit operates on the result ' +
    'of the previous one. If ANY edit fails to match, nothing is written (all-or-nothing). Prefer this ' +
    'over multiple edit_file calls when changing several spots in the same file. Read the file first.',
  risk: 'write',
  inputSchema,
  async run(input, ctx): Promise<ToolResult<MultiEditData>> {
    const start = Date.now();

    let abs: string;
    try {
      abs = resolveWithin([ctx.workspaceRoot, ...(ctx.additionalRoots ?? [])], input.path);
    } catch (e) {
      return fail('multi_edit', 'write', Date.now() - start, 'outside_workspace', (e as Error).message);
    }

    let original: string;
    try {
      original = readFileSync(abs, 'utf8');
    } catch (e) {
      return fail('multi_edit', 'write', Date.now() - start, 'read_failed', `could not read "${input.path}": ${(e as Error).message}`);
    }

    // Conversation read guard (Claude parity).
    if (ctx.readTracker && !ctx.readTracker.hasSeen(abs)) {
      return fail(
        'multi_edit',
        'write',
        Date.now() - start,
        'read_required',
        'You must use the read_file tool on this file before editing it.',
      );
    }

    // Stale-edit guard.
    const guard = ctx.readTracker?.check(abs);
    if (guard && !guard.ok) {
      return fail('multi_edit', 'write', Date.now() - start, 'read_required', guard.reason);
    }

    // Apply edits sequentially against an in-memory buffer — abort the whole call
    // on the first failure so a partial set of edits never lands on disk.
    let text = original;
    let replacements = 0;
    for (let i = 0; i < input.edits.length; i++) {
      const e = input.edits[i]!;
      if (e.old_string === e.new_string) {
        return fail('multi_edit', 'write', Date.now() - start, 'noop', `edit #${i + 1}: old_string and new_string are identical.`);
      }
      const r = applyStringEdit(text, e.old_string, e.new_string, e.replace_all ?? false);
      if (!r.ok) {
        const why =
          r.reason === 'multiple'
            ? `matches ${r.count} times — add context or set replace_all`
            : r.reason === 'ambiguous'
              ? 'no exact match and the closest fuzzy match is ambiguous'
              : 'old_string not found (must match exactly after prior edits)';
        return fail('multi_edit', 'write', Date.now() - start, r.reason, `edit #${i + 1}: ${why}. No changes were written.`);
      }
      text = r.updated;
      replacements += r.count;
    }

    if (text === original) {
      return ok('multi_edit', 'write', Date.now() - start, `"${input.path}" unchanged — no net edits.`, {
        path: abs,
        edits: input.edits.length,
        replacements,
      });
    }

    if (ctx.dryRun) {
      return ok('multi_edit', 'write', Date.now() - start, `[dry-run] would apply ${input.edits.length} edit(s) to "${input.path}".`, {
        path: abs,
        edits: input.edits.length,
        replacements,
      });
    }

    try {
      atomicWrite(abs, text);
    } catch (e) {
      return fail('multi_edit', 'write', Date.now() - start, 'write_failed', `write failed: ${(e as Error).message}`);
    }
    ctx.readTracker?.markRead(abs);
    ctx.readTracker?.markSeen(abs);

    const res = ok(
      'multi_edit',
      'write',
      Date.now() - start,
      `Applied ${input.edits.length} edit(s) to "${input.path}" (${replacements} replacement(s)).`,
      { path: abs, edits: input.edits.length, replacements },
    );
    const diff = diffLines(original, text);
    if (diff.length) res.meta.diff = diff;
    return res;
  },
};
