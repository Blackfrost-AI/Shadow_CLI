import type { SseParseOutcome } from './sse.js';

type FinishReason = 'tool_calls' | 'function_call' | 'length' | 'stop' | 'content_filter' | 'other' | 'none';
export type ToolParseOutcome = 'emitted' | 'empty' | 'nameless' | 'invalid_args';

/** Counts only: never retain provider content, call ids/names, arguments, or arbitrary strings. */
export interface OpenAIStreamSummary {
  version: 1;
  transport: 'openai-sse';
  dataEvents: number;
  parsedFrames: number;
  malformedPayloads: number;
  ignoredJsonValues: number;
  unrecognizedFrames: number;
  unsupportedToolFrames: number;
  contentDeltas: number;
  reasoningDeltas: number;
  toolFragments: number;
  unsupportedToolFragments: number;
  argumentFragments: number;
  argumentChars: number;
  objectArgumentFragments: number;
  indexes: number[];
  unlistedIndexFragments: number;
  finishReason: FinishReason;
  toolSlots: number;
  emittedCalls: number;
  emptySlots: number;
  namelessCalls: number;
  invalidArgumentCalls: number;
}

export interface ProviderDiagnosticEvent {
  type: 'diagnostic';
  code: 'openai_stream_summary';
  data: OpenAIStreamSummary;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

/** One bounded summary per completed SSE parse; interrupted requests need no final event. */
export class OpenAIStreamDiagnostics {
  private readonly summary: OpenAIStreamSummary = {
    version: 1, transport: 'openai-sse', dataEvents: 0, parsedFrames: 0,
    malformedPayloads: 0, ignoredJsonValues: 0, unrecognizedFrames: 0, unsupportedToolFrames: 0,
    contentDeltas: 0, reasoningDeltas: 0, toolFragments: 0, unsupportedToolFragments: 0,
    argumentFragments: 0, argumentChars: 0, objectArgumentFragments: 0,
    indexes: [], unlistedIndexFragments: 0, finishReason: 'none',
    toolSlots: 0, emittedCalls: 0, emptySlots: 0, namelessCalls: 0, invalidArgumentCalls: 0,
  };

  observeDataEvent(): void { this.summary.dataEvents++; }

  observeParseOutcome(outcome: SseParseOutcome): void {
    if (outcome === 'malformed') this.summary.malformedPayloads++;
    else this.summary.ignoredJsonValues++;
  }

  observeFrame(frame: unknown): void {
    const s = this.summary;
    s.parsedFrames++;
    const obj = object(frame);
    const choice = Array.isArray(obj?.choices) ? object(obj.choices[0]) : undefined;
    const delta = object(choice?.delta);
    const message = object(choice?.message);
    if ((delta?.tool_calls != null && !Array.isArray(delta.tool_calls)) ||
        delta?.function_call != null || message?.tool_calls != null || message?.function_call != null) {
      s.unsupportedToolFrames++;
    }
    if (!delta && !choice?.finish_reason && !object(obj?.usage) && !object(obj?.error)) {
      s.unrecognizedFrames++;
    }
    if (typeof delta?.content === 'string' && delta.content) s.contentDeltas++;
    if ((typeof delta?.reasoning_content === 'string' && delta.reasoning_content) ||
        (typeof delta?.reasoning === 'string' && delta.reasoning)) s.reasoningDeltas++;
    const finish = choice?.finish_reason;
    if (finish != null) {
      switch (finish) {
        case 'tool_calls': s.finishReason = 'tool_calls'; break;
        case 'function_call': s.finishReason = 'function_call'; break;
        case 'length': s.finishReason = 'length'; break;
        case 'stop': s.finishReason = 'stop'; break;
        case 'content_filter': s.finishReason = 'content_filter'; break;
        default: s.finishReason = 'other';
      }
    }
  }

  observeToolFragment(fragment: unknown): void {
    const s = this.summary;
    s.toolFragments++;
    const tc = object(fragment);
    const fn = object(tc?.function);
    const index = tc?.index;
    if (typeof index === 'number' && Number.isSafeInteger(index) && index >= 0 && !s.indexes.includes(index)) {
      if (s.indexes.length < 16) s.indexes.push(index);
      else s.unlistedIndexFragments++;
    }
    if (!tc || (tc.function != null && !fn) || (!fn && ('name' in tc || 'arguments' in tc))) {
      s.unsupportedToolFragments++;
      return;
    }
    const args = fn?.arguments;
    if (typeof args === 'string') {
      s.argumentFragments++;
      s.argumentChars += args.length;
    } else if (args !== null && typeof args === 'object') {
      s.argumentFragments++;
      s.objectArgumentFragments++;
    } else if (args != null) s.unsupportedToolFragments++;
  }

  recordToolOutcome(outcome: ToolParseOutcome): void {
    const s = this.summary;
    s.toolSlots++;
    switch (outcome) {
      case 'emitted': s.emittedCalls++; break;
      case 'empty': s.emptySlots++; break;
      case 'nameless': s.namelessCalls++; break;
      case 'invalid_args': s.invalidArgumentCalls++; break;
    }
  }

  event(): ProviderDiagnosticEvent {
    return {
      type: 'diagnostic', code: 'openai_stream_summary',
      data: { ...this.summary, indexes: [...this.summary.indexes] },
    };
  }
}
