import { readFileSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { Context, MAX_CONTEXT_SOURCE_CHARACTERS, type ContextSource } from '../agent/context.js';
import type { ContentBlock, Message, Provider, ToolSchema } from '../provider/provider.js';
import { resolveWithin } from '../safety/workspaceJail.js';
import { blockTokenEstimate } from '../tui/contextViz.js';

export interface ContextInspectionEntry {
  id: string;
  label: string;
  kind: 'system' | 'tool-schema' | 'history' | 'source';
  origin: string;
  reason: string;
  estimatedTokens: number;
  state: 'included' | 'pinned' | 'excluded';
  /** Only explicit attachments/exclusions are mutable. Chat and essential instructions stay intact. */
  mutable: boolean;
  preview: string;
  source?: ContextSource;
}

export interface ContextInspection {
  basis: 'prepared-request' | 'draft';
  preparedAt?: string;
  model: string;
  provider: string;
  destination?: string;
  estimatedTokens: number;
  lastActualTokens: number;
  budget: number;
  messageCount: number;
  entries: ContextInspectionEntry[];
  notices: string[];
  compaction: { historyMessages: number; protectedMessages: number; pinnedSources: number; pinnedEstimatedTokens: number; description: string };
}

export interface ContextOrigin {
  label: string;
  origin: string;
  /** Exact included text, if available; only matching sources appear as system-origin notes. */
  content?: string;
}

function previewBlock(block: ContentBlock): string {
  if (block.type === 'text') return block.text;
  if (block.type === 'tool_result') return block.content;
  if (block.type === 'tool_use') return `${block.name}\n${JSON.stringify(block.input, null, 2)}`;
  if (block.type === 'image') return `[${block.mediaType} image; content omitted from inspector]`;
  return '[Provider reasoning state; retained for continuation, not displayed here]';
}

function historyOrigin(message: Message, toolOrigins: Map<string, string>): string {
  return message.content.map((block) => {
    if (block.type === 'tool_result') return toolOrigins.get(block.toolCallId) ?? `tool result ${block.toolCallId}`;
    if (block.type === 'tool_use') {
      const input = block.input as Record<string, unknown> | null;
      const path = input && (input.path ?? input.file_path ?? input.filePath);
      return `${block.name}${typeof path === 'string' ? ` · ${path}` : ''}`;
    }
    return '';
  }).filter(Boolean).join(', ') || `${message.role} conversation`;
}

/** Inspect the request inputs without a provider call or tokenizer download. */
export function buildContextInspection(options: {
  context: Context;
  provider: Provider;
  model: string;
  system: string;
  tools: readonly ToolSchema[];
  destination?: string;
  origins?: readonly ContextOrigin[];
  /** Supply normalized messages for a provisional draft; captured requests take precedence. */
  messages?: Message[];
}): ContextInspection {
  const { context, provider } = options;
  const prepared = context.preparedRequestMetadata();
  const model = prepared?.model ?? options.model;
  const system = prepared?.system ?? options.system;
  const tools = prepared?.tools ?? options.tools;
  const request = prepared?.messages ?? options.messages ?? context.requestMessages();
  const sourcePins = context.sources().filter((source) => source.state === 'pinned');
  const systemTokens = Math.ceil(system.length / 4);
  const schemaTokens = Math.ceil(JSON.stringify(tools).length / 4);
  const systemOrigins = (options.origins ?? []).filter((origin) => origin.content && system.includes(origin.content));
  const entries: ContextInspectionEntry[] = [{
    id: 'system', label: 'System instructions', kind: 'system', origin: systemOrigins.length
      ? systemOrigins.map((origin) => `${origin.label}: ${origin.origin}`).join('\n') : 'Active runtime system prompt',
    reason: prepared ? 'Exact system prompt in the last prepared request, including dynamic runtime additions. Source attribution appears where supplied and matched.'
      : 'Provisional system prompt. Per-turn additions may change it when the next request is prepared; source attribution appears where supplied and matched.',
    estimatedTokens: systemTokens, state: 'included', mutable: false, preview: system,
  }, {
    id: 'tool-schemas', label: `${tools.length} tool definitions`, kind: 'tool-schema', origin: 'Active tool registry',
    reason: prepared ? 'Exact tool names, descriptions, and JSON schemas in the last prepared request.' : 'Provisional tool registry; per-turn filtering may change the next request.', estimatedTokens: schemaTokens,
    state: 'included', mutable: false, preview: tools.map((tool) => `${tool.name}\n${tool.description}\n${JSON.stringify(tool.parameters)}`).join('\n\n'),
  }];
  for (const source of context.sources()) entries.push({
    id: `source:${source.id}`, label: `${prepared ? 'Next request: ' : ''}${source.label}`, kind: 'source', origin: source.origin,
    reason: (prepared ? 'Control for the next request; not a category of the historical totals above. ' : '') + (source.state === 'pinned' ? 'Explicit attachment: retained verbatim across compaction; a snapshot of the file when pinned.'
      : 'Excluded from managed attachments and repository_context retrieval. Existing conversation and other tools are unchanged.'),
    estimatedTokens: source.state === 'pinned' ? Math.ceil(source.content.length / 4) : 0,
    state: source.state, mutable: true, preview: source.content, source,
  });
  const origins = new Map<string, string>();
  for (const message of request) for (const block of message.content) {
    if (block.type === 'tool_use') origins.set(block.id, historyOrigin({ role: 'assistant', content: [block] }, new Map()));
  }
  // Provisional pins already have a source row. Captured requests include every exact message,
  // including the original pin carrier; current controls above are explicitly for the next send.
  const visibleMessages = prepared ? request : request.slice(sourcePins.length ? 1 : 0);
  visibleMessages.forEach((message, index) => entries.push({
    id: `history:${index}`, label: `${index + 1}. ${message.role}${message.content.some((block) => block.type === 'tool_result') ? ' · tool output' : ''}`,
    kind: 'history', origin: historyOrigin(message, origins),
    reason: `${prepared ? 'Message in the last prepared request.' : 'Current conversation history.'} Read-only here to preserve instructions and tool/result pairing; excluding a file does not erase this history.`,
    estimatedTokens: message.content.reduce((total, block) => total + blockTokenEstimate(block), 0)
      + Math.ceil((message.providerReasoning?.text.length ?? 0) / 4),
    state: 'included', mutable: false, preview: message.content.map(previewBlock).join('\n\n'),
  }));
  const pinnedTokens = sourcePins.reduce((total, source) => total + Math.ceil(source.content.length / 4), 0);
  const retained = Math.min(context.messages().length, context.budget() <= 40_000 ? Math.min(context.policy().keepLastTurns, 6) : context.policy().keepLastTurns);
  return {
    basis: prepared ? 'prepared-request' : 'draft', preparedAt: prepared?.preparedAt,
    model, provider: prepared?.provider ?? provider.name, destination: options.destination,
    estimatedTokens: provider.estimateTokens(request) + systemTokens + schemaTokens,
    lastActualTokens: context.actualTokens(), budget: context.budget(), messageCount: request.length, entries,
    notices: [
      prepared ? `Inspecting the provider-neutral request prepared at ${prepared.preparedAt}. This is historical: subsequent messages and control changes apply to the next request. Adapter formatting and image costs can differ.`
        : 'Provisional request draft: no main request has been captured in this process yet. Dynamic system additions, tool filtering, message healing and adapter formatting may change the actual request.',
      'Provider usage describes the previous measured request, not this estimate. No remote token-count request is made.',
      'Exclusions affect explicit attachments and repository_context only. They do not erase already-sent content, prior summaries, shell output, or other tools.',
      ...(pinnedTokens > context.budget() * 0.25 ? ['Pinned material exceeds 25% of the context budget; remove pins if compaction cannot make enough room.'] : []),
    ],
    compaction: { historyMessages: context.messages().length, protectedMessages: retained, pinnedSources: sourcePins.length,
      pinnedEstimatedTokens: pinnedTokens,
      description: `Compaction preserves the session objective, recent history (approximately ${retained} messages; tool pairs can extend it), and ${sourcePins.length} pinned source(s). Older history becomes a summary; failed summaries may reclaim tool output. Pins are never silently removed.`,
    },
  };
}

/** Read an explicit user-selected file only. Never expands globs or scans the home directory. */
export function pinContextFile(context: Context, workspaceRoot: string, path: string): ContextSource {
  const absolute = resolveWithin(workspaceRoot, path);
  const st = statSync(absolute);
  if (!st.isFile() || st.size > MAX_CONTEXT_SOURCE_CHARACTERS * 4) throw new Error('Pin a text file smaller than 256 KB or choose an excerpt.');
  const content = readFileSync(absolute, 'utf8');
  if (content.includes('\0')) throw new Error('Binary files cannot be pinned as text context.');
  const source = { id: `file:${absolute}`, label: relative(workspaceRoot, absolute) || path, kind: 'file' as const, origin: absolute, content };
  context.pinSource(source);
  return { ...source, state: 'pinned' };
}

export function excludeContextFile(context: Context, workspaceRoot: string, path: string): void {
  const absolute = resolveWithin(workspaceRoot, path);
  try {
    if (statSync(absolute).isDirectory()) throw new Error('Exclude a file path; directory exclusions are not supported.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  context.excludeSource(`file:${absolute}`, { label: relative(workspaceRoot, absolute) || path, kind: 'file', origin: absolute });
}
