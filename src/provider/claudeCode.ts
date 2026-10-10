/** Subscription transport through the unmodified official CLI. It returns data only;
 * Shadow's existing loop remains the sole executor of proposed tool calls. */
import { randomUUID } from 'node:crypto';
import Ajv, { type ValidateFunction } from 'ajv';
import { ClaudeCodeError, preflightClaudeCode, readClaudeCodeStatus, runClaudeCode, type ClaudeCodeRuntime } from '../auth/claudeCode.js';
import { isOfflineMode } from '../safety/egress.js';
import { estimateTokensFromMessages, type CompletionRequest, type Message, type Provider, type ProviderEvent } from './provider.js';

const ENVELOPE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['text', 'toolCalls'],
  properties: {
    text: { type: 'string', maxLength: 1_000_000 },
    toolCalls: { type: 'array', maxItems: 32, items: {
      type: 'object', additionalProperties: false, required: ['name', 'input'],
      properties: { name: { type: 'string', minLength: 1, maxLength: 256 }, input: { type: 'object' } },
    } },
  },
};

interface Envelope { text: string; toolCalls: Array<{ name: string; input: Record<string, unknown> }> }

function requestContract(req: CompletionRequest): { input: string; validators: Map<string, ValidateFunction>; validateEnvelope: ValidateFunction } {
  if (req.messages.some((message) => message.content.some((block) => block.type === 'image'))) throw new ClaudeCodeError('claude_code_images_unsupported', 'This Claude Code connection does not yet support image attachments. Use the Anthropic API connection for this request.');
  if (req.stopSequences?.length) throw new ClaudeCodeError('claude_code_stop_unsupported', 'Custom stop sequences are not supported by this Claude Code connection.');
  if (!Number.isSafeInteger(req.maxOutputTokens) || req.maxOutputTokens < 1) throw new ClaudeCodeError('claude_code_request', 'Claude Code requires a positive output-token limit.');
  const contract = JSON.stringify({ tools: req.tools, toolChoice: req.toolChoice ?? { type: 'auto' } });
  if (Buffer.byteLength(contract) > 512 * 1024 || req.tools.length > 512) throw new ClaudeCodeError('claude_code_schema_limit', 'The tool definitions exceed this Claude Code connection’s limit.');
  const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false, ownProperties: true, logger: false });
  const validators = new Map<string, ValidateFunction>();
  try {
    for (const tool of req.tools) {
      if (!tool.name || validators.has(tool.name)) throw new Error('duplicate');
      validators.set(tool.name, ajv.compile(tool.parameters));
    }
  } catch { throw new ClaudeCodeError('claude_code_tool_schema', 'A tool has an invalid or unsupported JSON Schema. No request was sent.'); }
  if ((req.toolChoice?.type === 'tool' && !validators.has(req.toolChoice.name)) || (req.toolChoice?.type === 'any' && validators.size === 0)) throw new ClaudeCodeError('claude_code_tool_choice', 'The requested tool choice is unavailable.');
  // Keep every conversational block, role, call/result ID and interruption marker.
  // Opaque signatures/reasoning blobs from another transport are not user content.
  const history = req.messages.map((message) => ({ role: message.role, ...(message.interrupted ? { interrupted: true } : {}), content: message.content.filter((block) => block.type !== 'thinking' && block.type !== 'redacted_thinking').map((block) => block.type === 'tool_use' ? { type: block.type, id: block.id, name: block.name, input: block.input } : block) }));
  const input = [
    'You are the inference transport for Shadow. Shadow owns the tool loop. Return one response matching the supplied JSON schema.',
    'The JSON below is the complete ordered Shadow conversation and available tool contract. Follow its system instructions and answer its latest turn.',
    'Tool calls in your response are proposals, not actions you have performed. Shadow will validate and execute them, then provide their results in a later request.',
    'Use only listed tool names and inputs matching their JSON Schemas. Honor toolChoice: none forbids calls; any requires at least one; tool requires that named tool. disableParallelToolUse allows at most one call.',
    'For a normal final answer, put the answer in text and use an empty toolCalls array. Do not claim success for work without a recorded tool result.',
    JSON.stringify({ system: req.system, ...JSON.parse(contract), messages: history }),
  ].join('\n\n');
  if (Buffer.byteLength(input) > 8 * 1024 * 1024) throw new ClaudeCodeError('claude_code_context_limit', 'The conversation exceeds this Claude Code connection’s input limit. Compact the session before continuing.');
  return { input, validators, validateEnvelope: ajv.compile(ENVELOPE_SCHEMA) };
}

function validateCalls(value: unknown, req: CompletionRequest, contract: ReturnType<typeof requestContract>): Envelope {
  if (!contract.validateEnvelope(value)) throw new ClaudeCodeError('claude_code_invalid_output', 'Claude Code returned an invalid structured response. No proposed tools were executed.');
  const envelope = value as Envelope;
  const choice = req.toolChoice;
  if ((choice?.type === 'none' && envelope.toolCalls.length > 0)
    || ((choice?.type === 'any' || choice?.type === 'tool') && envelope.toolCalls.length === 0)
    || (choice?.disableParallelToolUse && envelope.toolCalls.length > 1)) throw new ClaudeCodeError('claude_code_tool_choice', 'Claude Code returned a response that violates the requested tool choice.');
  for (const call of envelope.toolCalls) {
    const validate = contract.validators.get(call.name);
    if (!validate || (choice?.type === 'tool' && call.name !== choice.name) || !validate(call.input)) throw new ClaudeCodeError('claude_code_invalid_tool', 'Claude Code proposed an unavailable tool or invalid tool arguments. No proposed tools were executed.');
  }
  return envelope;
}

function usageOf(result: any): Extract<ProviderEvent, { type: 'usage' }> | undefined {
  const usage = result?.usage;
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  if (!usage || typeof usage !== 'object') return undefined;
  return { type: 'usage', billing: 'subscription', inputTokens: number(usage.input_tokens), outputTokens: number(usage.output_tokens), cacheReadTokens: number(usage.cache_read_input_tokens), cacheWriteTokens: number(usage.cache_creation_input_tokens) };
}

export class ClaudeCodeProvider implements Provider {
  readonly name = 'anthropic';
  readonly allowAutomaticFallback = false;
  private readonly timeoutMs: number;
  constructor(private readonly options: { model: string; timeoutMs?: number }, private readonly runtime: ClaudeCodeRuntime = {}) {
    this.timeoutMs = Math.min(10 * 60_000, Math.max(100, Number.isFinite(options.timeoutMs) ? options.timeoutMs! : 180_000));
  }

  estimateTokens(messages: Message[]): number { return estimateTokensFromMessages(messages); }

  async *send(req: CompletionRequest): AsyncIterable<ProviderEvent> {
    const controller = new AbortController();
    const signal = req.signal ? AbortSignal.any([req.signal, controller.signal]) : controller.signal;
    let task: Promise<void> | undefined;
    let result: any;
    let usageEmitted = false;
    const observedUsage = new Map<string, any>();
    let currentMessageId: string | undefined;
    const reportedUsage = () => {
      const final = usageOf(result);
      if (final) return final;
      if (!observedUsage.size) return undefined;
      const total: Extract<ProviderEvent, { type: 'usage' }> = { type: 'usage', billing: 'subscription', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      for (const usage of observedUsage.values()) {
        const event = usageOf({ usage });
        if (!event) continue;
        total.inputTokens += event.inputTokens; total.outputTokens += event.outputTokens;
        total.cacheReadTokens! += event.cacheReadTokens ?? 0; total.cacheWriteTokens! += event.cacheWriteTokens ?? 0;
      }
      return total;
    };
    try {
      if (signal.aborted) throw new ClaudeCodeError('aborted', 'Claude Code request interrupted.');
      if (isOfflineMode()) throw new ClaudeCodeError('offline', 'Claude Code subscription access is unavailable in offline mode.');
      const contract = requestContract(req);
      const { executable } = await preflightClaudeCode(this.runtime, signal);
      const status = await readClaudeCodeStatus(executable, this.runtime, signal);
      if (!status.loggedIn || status.authMethod !== 'claude.ai') throw new ClaudeCodeError('claude_code_login_required', status.message ?? 'Sign in to a Claude subscription through the official Claude Code login.');
      const args = ['-p', '--safe-mode', '--restricted', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disallowedTools', 'mcp__*', '--disable-slash-commands', '--no-chrome', '--no-session-persistence', '--settings', '{"disableAllHooks":true}', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--json-schema', JSON.stringify(ENVELOPE_SCHEMA), '--max-turns', '2', '--model', req.model || this.options.model];
      if (req.effort) args.push('--effort', req.effort);
      const queue: ProviderEvent[] = [];
      let wake: (() => void) | undefined; let settled = false; let failed: unknown; let thinkingChars = 0;
      const notify = () => { wake?.(); wake = undefined; };
      const runtime = { ...this.runtime, env: { ...(this.runtime.env ?? process.env), CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(req.maxOutputTokens), CLAUDE_CODE_MAX_RETRIES: '0', MAX_STRUCTURED_OUTPUT_RETRIES: '1' } };
      task = runClaudeCode(executable, args, { signal, timeoutMs: this.timeoutMs, input: contract.input, onLine: (line) => {
        const frame = JSON.parse(line);
        if (!frame || typeof frame !== 'object') throw new Error('frame');
        if (result) throw new Error('data after terminal result');
        if (frame.type === 'result') { result = frame; return; }
        if (frame.type === 'assistant' && frame.message?.content?.some((block: any) => block.type === 'tool_use' && block.name !== 'StructuredOutput')) throw new Error('unexpected engine tool');
        if (frame.type === 'assistant' && typeof frame.message?.id === 'string' && frame.message?.usage) observedUsage.set(frame.message.id, { ...observedUsage.get(frame.message.id), ...frame.message.usage });
        if (frame.type === 'stream_event' && frame.event?.type === 'message_start' && typeof frame.event.message?.id === 'string') {
          currentMessageId = frame.event.message.id;
          observedUsage.set(currentMessageId!, frame.event.message.usage ?? {});
        }
        if (frame.type === 'stream_event' && frame.event?.type === 'message_delta' && currentMessageId && frame.event.usage) observedUsage.set(currentMessageId, { ...observedUsage.get(currentMessageId), ...frame.event.usage });
        const delta = frame.type === 'stream_event' ? frame.event?.delta : undefined;
        if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string' && thinkingChars < 64 * 1024) {
          const text = delta.thinking.slice(0, 64 * 1024 - thinkingChars); thinkingChars += text.length;
          queue.push({ type: 'thinking', delta: text }); notify();
        }
        // Text deltas contain the envelope or an intermediate attempt. Only the
        // validated terminal text is ever displayed; tool_use events never execute.
      } }, runtime).then((outcome) => {
        if (outcome.exitCode !== 0) throw new ClaudeCodeError('claude_code_exit', 'Claude Code did not complete the request. Check your official Claude Code login and subscription limits.');
      }).catch((error) => { failed = error; }).finally(() => { settled = true; notify(); });
      while (!settled || queue.length) {
        if (queue.length) yield queue.shift()!;
        else await new Promise<void>((resolve) => { wake = resolve; });
      }
      await task;
      const usage = reportedUsage();
      if (usage) { yield usage; usageEmitted = true; }
      if (failed) throw failed;
      if (signal.aborted) throw new ClaudeCodeError('aborted', 'Claude Code request interrupted.');
      if (!result || result.subtype !== 'success' || result.is_error === true || !result.structured_output) throw new ClaudeCodeError('claude_code_incomplete', 'Claude Code ended without a validated structured response. No proposed tools were executed.');
      const envelope = validateCalls(result.structured_output, req, contract);
      if (envelope.text) yield { type: 'text', delta: envelope.text };
      for (const call of envelope.toolCalls) yield { type: 'tool_call', call: { id: `cc_${randomUUID()}`, name: call.name, input: call.input } };
      yield { type: 'done', stopReason: envelope.toolCalls.length ? 'tool_use' : 'end_turn' };
    } catch (error) {
      const usage = reportedUsage();
      if (usage && !usageEmitted) yield usage;
      const known = error instanceof ClaudeCodeError ? error : new ClaudeCodeError('claude_code_error', 'Claude Code could not complete the request. No proposed tools were executed.');
      yield { type: 'error', recoverable: false, code: known.code, message: known.message };
    } finally {
      controller.abort();
      await task;
    }
  }
}
