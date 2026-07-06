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
const CONTROL_TOKEN = /<\|[^>]{0,40}>|<[A-Za-z_]{1,24}\|>|<｜[^>]{0,40}>|<\/?think(?:ing)?>/gi;

export function scrubControlTokens(text: string): string {
  if (!text) return text;
  return text
    .replace(CONTROL_TOKEN, '')
    .replace(/^[ \t\n]+/, '') // a removed leading token often leaves whitespace
    .replace(/[ \t]{2,}/g, ' ');
}
