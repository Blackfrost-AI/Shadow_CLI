import { z } from 'zod';
import { readFileSync, statSync } from 'node:fs';
import { resolveWithin } from '../safety/workspaceJail.js';
import { getRepositoryIndex } from '../context/repository.js';
import { getLspService, lspKillSwitchActive, type LspServiceConfig } from '../agent/lsp/index.js';
import { discoverProjectInstructions, boundedInstructionSources } from '../system/projectInstructions.js';
import type { Tool } from './types.js';
import { ok, fail } from './types.js';

const inputSchema = z.object({
  action: z.enum(['map', 'context', 'symbols', 'definition', 'references', 'range', 'instructions']),
  query: z.string().max(2000).optional().describe('Task or identifier used to rank relevant code. Required for context.'),
  path: z.string().optional().describe('Workspace path for navigation, range or scoped instructions.'),
  line: z.number().int().positive().optional().describe('1-based source line.'),
  col: z.number().int().positive().optional().describe('1-based character column.'),
  endLine: z.number().int().positive().optional().describe('Inclusive final line for a range.'),
  maxCharacters: z.number().int().min(100).max(32000).optional().describe('Bound the returned code or map; default 8000 for context.'),
});
type Input = z.infer<typeof inputSchema>;

/** Read-only, bounded repository intelligence. All fallbacks explicitly identify their evidence. */
export function makeRepositoryContextTool(lsp?: LspServiceConfig): Tool<Input> {
  return {
    name: 'repository_context', risk: 'read', inputSchema,
    description: 'Find source definitions/call sites/symbols with LSP or an explicitly labeled lexical fallback; build a compact repository map; rank bounded excerpts for a task; read a file range; inspect applicable ancestor/nested project instructions. Ignores generated files and repository ignores. Context results explain each selection and include instruction origins.',
    async run(input, ctx) {
      const start = Date.now();
      try {
        ctx.signal?.throwIfAborted();
        const index = getRepositoryIndex(ctx.workspaceRoot);
        if (input.action === 'map') {
          const data = await index.map({ query: input.query, maxCharacters: input.maxCharacters, signal: ctx.signal });
          return ok('repository_context', 'read', Date.now() - start, `${data.snapshot.files} indexed files; lexical declaration map${data.truncated ? ' (bounded)' : ''}.`, data);
        }
        if (input.action === 'context') {
          if (!input.query?.trim()) return fail('repository_context', 'read', Date.now() - start, 'bad_input', 'Context selection requires a query describing the task.');
          const data = await index.context(input.query, { maxCharacters: input.maxCharacters, signal: ctx.signal });
          const sources = new Map<string, ReturnType<typeof discoverProjectInstructions>['sources'][number]>();
          for (const excerpt of data.excerpts) {
            const path = resolveWithin(ctx.workspaceRoot, excerpt.path);
            ctx.readTracker?.markRead(path);
            for (const source of discoverProjectInstructions(ctx.workspaceRoot, { targetPath: excerpt.path }).sources) sources.set(source.path, source);
          }
          return ok('repository_context', 'read', Date.now() - start, `${data.excerpts.length} ranked excerpts, approximately ${data.approximateTokens} code tokens (estimate). Reasons and instruction scopes are included.`, { ...data, instructions: boundedInstructionSources([...sources.values()]) });
        }
        if (input.action === 'instructions') {
          const data = discoverProjectInstructions(ctx.workspaceRoot, { targetPath: input.path ?? '.' });
          return ok('repository_context', 'read', Date.now() - start, `${data.sources.length} instruction sources, in increasing precedence. Same-directory SHADOW > AGENTS > CLAUDE; nearer directories override ancestors.`, data);
        }
        if (!input.path) return fail('repository_context', 'read', Date.now() - start, 'bad_input', `${input.action} requires a path.`);
        const path = resolveWithin(ctx.workspaceRoot, input.path);
        if (input.action === 'range') {
          const st = statSync(path);
          if (!st.isFile() || st.size > 1024 * 1024) throw new Error('Range reads require a source file smaller than 1 MiB.');
          const text = readFileSync(path, 'utf8');
          if (text.includes('\0')) throw new Error('Binary files are not source context.');
          const lines = text.split(/\r?\n/);
          const line = input.line ?? 1;
          const endLine = input.endLine ?? Math.min(lines.length, line + 79);
          if (endLine < line) throw new Error('endLine must be at least line.');
          const window = lines.slice(line - 1, endLine).join('\n');
          const content = window.slice(0, input.maxCharacters ?? 8000);
          ctx.readTracker?.markRead(path);
          return ok('repository_context', 'read', Date.now() - start, `Source range ${input.path}:${line}-${line + content.split('\n').length - 1}.`, {
            path: input.path, startLine: line, endLine: line + content.split('\n').length - 1,
            content, truncated: content.length < window.length, totalLines: lines.length,
            instructions: boundedInstructionSources(discoverProjectInstructions(ctx.workspaceRoot, { targetPath: input.path }).sources),
          });
        }
        let locations = !lspKillSwitchActive() ? await getLspService(ctx.workspaceRoot, lsp).navigate?.({
          kind: input.action, path, line: input.line, col: input.col, signal: ctx.signal,
        }) : null;
        ctx.signal?.throwIfAborted();
        const source = locations === null || locations === undefined ? 'lexical' : 'language-server';
        if (source === 'lexical') locations = await index.navigate(input.action, path, input.line, input.col, ctx.signal);
        return ok('repository_context', 'read', Date.now() - start,
          `${locations?.length ?? 0} ${input.action} results (${source}${source === 'lexical' ? '; text matches may include unrelated identifiers' : ''}).`,
          { source, locations, instructions: boundedInstructionSources(discoverProjectInstructions(ctx.workspaceRoot, { targetPath: input.path }).sources) });
      } catch (error) {
        return fail('repository_context', 'read', Date.now() - start, ctx.signal?.aborted ? 'interrupted' : 'context_unavailable', (error as Error).message);
      }
    },
  };
}
