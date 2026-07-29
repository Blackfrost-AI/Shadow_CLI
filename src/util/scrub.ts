/**
 * Strip leaked chat-template / control tokens from a model's visible answer.
 * Local and distilled models frequently bleed their prompt-format scaffolding
 * into `content` — observed across the local-model probe:
 *
 *   </think>            (local-n2: a bare reasoning terminator, no opening tag)
 *   <channel|> <tool_call|>          (gemma4-opus)
 *   <|tool_response> <|im_start|> <|assistant|>   (ChatML family)
 *
 * Native Anthropic thinking blocks are handled upstream (signed, round-tripped);
 * this is the safety net for everything else, applied to the COMMITTED answer so
 * history/exports stay clean. Matched `<think>…</think>` reasoning is already
 * routed to the reasoning channel by ThinkingSplitter — here we only remove the
 * stray *tokens*, not content.
 */

// `<|…|>` and `<|…>` (ChatML), `<word|>` (channel/tool_call), bare think tags, and DeepSeek's
// fullwidth-bar tokens `<｜…｜>` (U+FF5C bar, e.g. <｜tool▁sep｜> / <｜end▁of▁sentence｜>).
// The reasoning-tag arm is namespace-aware AND whitespace-tolerant, matching thinkingTags.ts:
// `</mm:think>` (MiniMax-M) and `</think >` both used to survive into exports and replayed history.
const CONTROL_TOKEN =
  /<\|[^>]{0,40}>|<[A-Za-z_]{1,24}\|>|<｜[^>]{0,40}>|<\s*\/?\s*(?:[A-Za-z][\w.-]{0,15}\s*:\s*)?think(?:ing)?\s*>/gi;

export function scrubControlTokens(text: string): string {
  if (!text) return text;
  return text
    .replace(CONTROL_TOKEN, '')
    .replace(/^[ \t\n]+/, '') // a removed leading token often leaves whitespace
    .replace(/[ \t]{2,}/g, ' ');
}

/**
 * Tool-call envelopes a model printed as prose, for the DISPLAY path.
 *
 * `sniffToolCalls` already strips these — but only when it RECOVERS a call, which requires the
 * named tool to be registered. A weak local model that invents a tool name, or emits a malformed
 * envelope, produced no recovery, so the raw XML stayed in `turn.text` and was committed verbatim
 * to the transcript. Markdown then mangled it further (`<tool_call>` reads as an HTML tag), which
 * is exactly what users of Qwen/GLM-class local models saw — Shadow's core audience.
 *
 * Display-only and deliberately blunt: it removes the SCAFFOLDING, never surrounding prose, and is
 * applied where an answer is committed for viewing rather than where it is parsed for calls.
 */
const TOOL_CALL_ENVELOPE =
  /<tool_call>[\s\S]*?<\/tool_call>|<tool_call>[\s\S]*$|<function(?:=|\s+name\s*=)[\s\S]*?<\/function\s*>|<[｜|]tool[▁_]calls?[▁_]begin[｜|][\s\S]*?<[｜|]tool[▁_]calls?[▁_]end[｜|]>/gi;

/**
 * Scrub an answer for DISPLAY: control tokens plus any leftover tool-call scaffolding.
 * Never used for parsing — recovery still goes through sniffToolCalls, which must see the raw text.
 */
export function scrubForDisplay(text: string): string {
  if (!text) return text;
  return scrubControlTokens(text.replace(TOOL_CALL_ENVELOPE, '')).replace(/\n{3,}/g, '\n\n').trim();
}
