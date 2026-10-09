/**
 * Strip leaked chat-template / control tokens from a model's visible answer.
 * Local and distilled models frequently bleed their prompt-format scaffolding
 * into `content` — observed across the local-model probe:
 *
 *   <channel|> <tool_call|>          (gemma4-opus)
 *   <|tool_response> <|im_start|> <|assistant|>   (ChatML family)
 *
 * Native Anthropic thinking blocks are handled upstream (signed, round-tripped);
 * this is the safety net for everything else, applied to the COMMITTED answer so
 * history/exports stay clean. Reasoning tags are never scrubbed here: only the
 * provider adapter knows whether inline thinking is enabled or `content` is an
 * authoritative field. That adapter's ThinkingSplitter owns structural tags;
 * literal `<think>` and `</think>` must survive in history and exports.
 */

// `<|…|>` and `<|…>` (ChatML), `<word|>` (channel/tool_call), and DeepSeek's
// fullwidth-bar tokens `<｜…｜>` (U+FF5C bar, e.g. <｜tool▁sep｜> / <｜end▁of▁sentence｜>).
const CONTROL_TOKEN = /<\|[^>]{0,40}>|<[A-Za-z_]{1,24}\|>|<｜[^>]{0,40}>/gi;

type LiteralRange = { start: number; end: number };

/** Regions that describe tokens instead of using them as model scaffolding. */
function literalRanges(text: string): LiteralRange[] {
  const ranges: LiteralRange[] = [];
  const escaped = (at: number): boolean => {
    let slashes = 0;
    while (at > 0 && text[--at] === '\\') slashes++;
    return slashes % 2 === 1;
  };
  for (let i = 0; i < text.length;) {
    if (i === 0 || text[i - 1] === '\n') {
      const newline = text.indexOf('\n', i);
      const end = newline < 0 ? text.length : newline + 1;
      const line = text.slice(i, end).replace(/\r?\n$/, '');
      const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        const close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}[ \\t]*$`);
        let next = end;
        while (next < text.length) {
          const nl = text.indexOf('\n', next);
          const after = nl < 0 ? text.length : nl + 1;
          const closed = close.test(text.slice(next, after).replace(/\r?\n$/, ''));
          next = after;
          if (closed) break;
        }
        ranges.push({ start: i, end: next });
        i = next;
        continue;
      }
      if (/^(?: {4}|\t| {0,3}>)/.test(line)) {
        ranges.push({ start: i, end });
        i = end;
        continue;
      }
    }
    const char = text[i];
    if (char === '`' && !escaped(i)) {
      let runEnd = i + 1;
      while (text[runEnd] === '`') runEnd++;
      const delimiter = text.slice(i, runEnd);
      let close = text.indexOf(delimiter, runEnd);
      while (close >= 0 && (text[close - 1] === '`' || text[close + delimiter.length] === '`')) {
        close = text.indexOf(delimiter, close + delimiter.length);
      }
      // A partial streamed code span is also literal, even before its closer arrives.
      const end = close < 0 ? text.length : close + delimiter.length;
      ranges.push({ start: i, end });
      i = end;
      continue;
    }
    const quoteClose = char === '“' ? '”' : char === '‘' ? '’' : char === '"' || char === "'" ? char : '';
    if (quoteClose && !escaped(i) && !(char === "'" && /[\p{L}\p{N}]/u.test(text[i - 1] ?? ''))) {
      let close = text.indexOf(quoteClose, i + 1);
      while (close >= 0 && escaped(close)) close = text.indexOf(quoteClose, close + 1);
      // An unmatched prose apostrophe/quote must not shield the rest of the answer.
      if (close >= 0) {
        ranges.push({ start: i, end: close + 1 });
        i = close + 1;
        continue;
      }
    }
    if (char === '<' && escaped(i)) {
      const end = text.indexOf('>', i + 1);
      if (end >= 0) ranges.push({ start: i, end: end + 1 });
    }
    i++;
  }
  return ranges;
}

function removeOutsideLiterals(text: string, pattern: RegExp): { text: string; removedPrefix: boolean } {
  const ranges = literalRanges(text);
  const firstContent = text.search(/\S/);
  let range = 0;
  let removedPrefix = false;
  const cleaned = text.replace(pattern, (match: string, offset: number) => {
    while (ranges[range] && ranges[range].end <= offset) range++;
    if (ranges[range] && ranges[range].start <= offset) return match;
    if (offset === firstContent) removedPrefix = true;
    return '';
  });
  return { text: cleaned, removedPrefix };
}

export function scrubControlTokens(text: string): string {
  if (!text) return text;
  const cleaned = removeOutsideLiterals(text, CONTROL_TOKEN);
  let result = cleaned.text;
  // Shed separator whitespace after leaked prefix tokens, preserving an indented code block.
  if (cleaned.removedPrefix) {
    result = result.replace(/^(?:[ \t]*\r?\n)+/, '');
    if (!/^(?: {4}|\t)/.test(result)) result = result.replace(/^[ \t]+/, '');
  }
  return result;
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
 * F05-04: neutralize terminal escape sequences before text reaches `<Text>`.
 *
 * Tool output (shell stdout, live shell preview) and — rarer — model text can carry raw terminal
 * escapes. Rendered unfiltered they are an output-side attack/corruption surface: cursor-movement
 * CSI can rewrite surrounding lines, DEC private modes can flip the terminal into an alternate
 * buffer or toggle the cursor, OSC can retarget titles/clipboard. Shadow never interprets any of
 * them, so the documented choice is: **strip everything except SGR color/style spans**, and even
 * those only where colors are legitimate (real terminal output). SGR can only change rendition —
 * it cannot move the cursor or change terminal modes — and displayWidth() already measures through
 * it (its SGR strip accepts the same 0x20-0x3f parameter bytes incl. colon subparameters), so kept
 * colors cannot break row layout either.
 *
 * keepSgr=true keeps `ESC[…m` spans (tool output: `ls --color`, npm, test runners) and appends a
 * trailing `\x1b[0m` on every line that carried SGR so a style can never leak past its line into
 * Shadow's own chrome. keepSgr=false strips SGR too (assistant/model text has no legitimate source
 * of rendition codes). The scanner is single-pass and total: a malformed/partial sequence drops
 * ONLY its own bytes (resuming at the offending byte, so a mid-string partial escape can't eat the
 * tail of the text), and is never half-emitted.
 */
export function sanitizeTerminalEscapes(text: string, keepSgr: boolean): string {
  if (!text) return text;
  let out = '';
  let sgrOnLine = false; // SGR emitted since the last newline (keepSgr only)
  const closeSgr = (): void => {
    if (sgrOnLine) {
      out += '\x1b[0m';
      sgrOnLine = false;
    }
  };
  let i = 0;
  const n = text.length;
  while (i < n) {
    const cp = text.codePointAt(i)!;
    const size = cp > 0xffff ? 2 : 1;
    if (cp === 0x1b) {
      // ESC sequence. Classify by the byte that follows.
      const next = i + 1 < n ? text.codePointAt(i + 1)! : -1;
      if (next === 0x5b) {
        // CSI: params/intermediates 0x20-0x3f, then ONE final byte 0x40-0x7e.
        let j = i + 2;
        while (j < n) {
          const b = text.codePointAt(j)!;
          if (b >= 0x20 && b <= 0x3f) {
            j++;
            continue;
          }
          break;
        }
        const final = j < n ? text.codePointAt(j)! : -1;
        if (final >= 0x40 && final <= 0x7e) {
          if (keepSgr && final === 0x6d) {
            out += text.slice(i, j + 1);
            sgrOnLine = true;
          }
          i = j + 1; // complete CSI consumed (kept only if it was SGR)
        } else {
          // Malformed or truncated CSI. Drop ONLY the partial sequence and resume scanning at
          // the offending byte — a mid-string partial escape (a tool that prints `ESC[3` then
          // real output) must not swallow the entire rest of the text. j === n means the input
          // simply ended mid-sequence, which is the same drop.
          i = j < n ? j : n;
        }
        continue;
      }
      if (next === 0x5d || next === 0x50 || next === 0x5f || next === 0x5e || next === 0x58) {
        // OSC / DCS / APC / PM / SOS: payload runs until BEL or ST (ESC \). Always dropped —
        // titles, clipboard, hyperlinks and downloads are never Shadow's business.
        let j = i + 2;
        while (j < n) {
          const b = text.codePointAt(j)!;
          if (b === 0x07) {
            j++;
            break;
          }
          if (b === 0x1b && j + 1 < n && text.codePointAt(j + 1) === 0x5c) {
            j += 2;
            break;
          }
          j++;
        }
        i = j;
        continue;
      }
      if (next === -1) {
        i = n; // bare trailing ESC — drop
        continue;
      }
      // Other two-byte sequences (charset designators ESC 0x28-0x2f take one extra param byte).
      i = next >= 0x28 && next <= 0x2f ? Math.min(n, i + 3) : i + 2;
      continue;
    }
    if (cp === 0x0a) {
      closeSgr();
      out += '\n';
      i++;
      continue;
    }
    if (cp === 0x09) {
      out += '\t';
      i++;
      continue;
    }
    // Everything else in C0 (incl. \r), DEL, and the C1 block is control noise — drop.
    // Printable ASCII and everything ≥ U+00A0 passes through untouched.
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) {
      i += size;
      continue;
    }
    out += text.slice(i, i + size);
    i += size;
  }
  closeSgr();
  return out;
}

/**
 * Scrub an answer for DISPLAY: control tokens plus any leftover tool-call scaffolding.
 * Never used for parsing — recovery still goes through sniffToolCalls, which must see the raw text.
 * Terminal escapes go first (keepSgr=false): assistant text has no legitimate source of rendition
 * or mode codes, and the envelope/token regexes must not have to reason about text interleaved
 * with CSI payloads.
 */
export function scrubForDisplay(text: string): string {
  if (!text) return text;
  return scrubControlTokens(removeOutsideLiterals(sanitizeTerminalEscapes(text, false), TOOL_CALL_ENVELOPE).text)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
