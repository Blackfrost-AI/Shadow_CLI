/**
 * Recover tool calls that a (usually weaker / local) model emitted as assistant
 * TEXT instead of via the provider's native tool-call channel. Observed in the
 * wild from gemma/qwen-class models served over Ollama:
 *
 *   <tool_call>{"name":"write_file","arguments":{...}}</tool_call>
 *   call:run_shell{command:"echo hi"}
 *   {"tool_calls":[{"name":"write_file","args":{...}}]}
 *   {"writables":[{"role":"assistant","tool_calls":[{"name":...,"args":...}]}]}
 *
 * Only fires when the turn produced NO real tool calls, and only for names that
 * match a REGISTERED tool — so prose that merely mentions a tool is not mistaken
 * for a call. Argument blobs go through the same repair ladder as native calls.
 */
import { parseToolArgs } from './toolJson.js';

export interface RecoveredCall {
  name: string;
  input: unknown;
}

export interface SniffResult {
  calls: RecoveredCall[];
  cleaned: string; // input text with the recovered call spans removed
}

/** Top-level balanced `{...}` spans, quote-aware (handles ' and "). */
function balancedObjects(s: string): Array<{ raw: string; start: number }> {
  const out: Array<{ raw: string; start: number }> = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let quote = '';
    let esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j]!;
      if (esc) {
        esc = false;
        continue;
      }
      if (inStr) {
        if (c === '\\') esc = true;
        else if (c === quote) inStr = false;
        continue;
      }
      if (c === '"' || c === "'") {
        inStr = true;
        quote = c;
      } else if (c === '{') {
        depth++;
      } else if (c === '}') {
        depth--;
        if (depth === 0) {
          out.push({ raw: s.slice(i, j + 1), start: i });
          i = j;
          break;
        }
      }
    }
  }
  return out;
}

type Entry = Record<string, unknown>;

/** Pull {name, args} pairs out of a parsed envelope (tool_calls / writables / bare / function). */
function collectEntries(obj: unknown): Array<{ name: string; args: unknown }> {
  const found: Array<{ name: string; args: unknown }> = [];
  const pushEntry = (e: Entry): void => {
    const fn = (e.function as Entry | undefined) ?? undefined;
    const name = (typeof e.name === 'string' ? e.name : undefined) ?? (typeof fn?.name === 'string' ? fn.name : undefined);
    if (!name) return;
    const args = e.arguments ?? e.args ?? e.parameters ?? e.input ?? fn?.arguments ?? {};
    found.push({ name, args });
  };
  const walk = (o: unknown): void => {
    if (!o || typeof o !== 'object') return;
    const e = o as Entry;
    if (Array.isArray(e.tool_calls)) for (const tc of e.tool_calls) pushEntry(tc as Entry);
    if (Array.isArray(e.writables)) for (const w of e.writables) walk(w);
    if (e.name || e.function) pushEntry(e);
  };
  walk(obj);
  return found;
}

/**
 * Hermes/Qwen XML tool-call form, which Qwen-class models drift to under long-context
 * load: `<function=NAME><parameter=KEY>VALUE</parameter>...</function>` (optionally wrapped
 * in <tool_call>; also accepts a name="..." attribute style). Parameter values are kept as
 * trimmed strings — the downstream arg repair / zod coercion handles typing.
 *
 * ROBUST to missing close tags, which weak/local models drop constantly: a value ends at the
 * next `<parameter` / `</parameter>` / `</function>` (whichever comes first), and a function ends
 * at `</function>` or the next `<function`. Without this, a dropped `</parameter>` after the first
 * arg made the non-greedy match swallow every following parameter into that arg — e.g. a whole CSS
 * file became `write_file`'s `path`, which then failed with ENAMETOOLONG.
 */
function collectXmlFunctions(text: string): Array<{ name: string; args: Record<string, string>; raw: string }> {
  const out: Array<{ name: string; args: Record<string, string>; raw: string }> = [];
  const fnRe = /<function(?:=|\s+name\s*=\s*["'])\s*([A-Za-z_]\w*)\s*["']?\s*>([\s\S]*?)(?:<\/function\s*>|(?=<function[=\s])|$)/gi;
  let fm: RegExpExecArray | null;
  while ((fm = fnRe.exec(text)) !== null) {
    if (!fm[0]) {
      fnRe.lastIndex++; // never spin on a zero-width match
      continue;
    }
    const args: Record<string, string> = {};
    const pRe = /<parameter(?:=|\s+name\s*=\s*["'])\s*([A-Za-z_]\w*)\s*["']?\s*>([\s\S]*?)(?:<\/parameter\s*>|(?=<parameter[=\s])|(?=<\/function\s*>)|$)/gi;
    let pm: RegExpExecArray | null;
    while ((pm = pRe.exec(fm[2]!)) !== null) {
      if (!pm[0]) {
        pRe.lastIndex++;
        continue;
      }
      args[pm[1]!] = pm[2]!.trim();
    }
    out.push({ name: fm[1]!, args, raw: fm[0]! });
  }
  return out;
}

/** Strip stray Hermes/Qwen tool-XML fragments left after an unbalanced recovery — a dropped close
 *  tag can leave a bare `</parameter>` / `</function>` behind that would otherwise render as prose. */
function stripXmlToolTags(s: string): string {
  return s.replace(/<\/?(?:function|parameter)(?:[=\s][^>]*)?>/gi, '');
}

/**
 * DeepSeek's native tool-call token form (R1 / V3 chat template). DeepSeek-R1 in particular
 * frequently emits these as assistant TEXT instead of via the OpenAI `tool_calls` channel — it
 * runs fine in harnesses that recover it (e.g. Claude Code), so Shadow must too:
 *
 *   <｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>NAME
 *   ```json
 *   { ...args... }
 *   ```<｜tool▁call▁end｜><｜tool▁calls▁end｜>
 *
 * The bar is fullwidth U+FF5C (｜) and the word-separator is U+2581 (▁); ASCII |/_ are also
 * accepted defensively. A truncated stream (missing the closing token) still parses via the
 * next-token / end-of-string lookahead. Multiple calls in one envelope are each recovered.
 */
function collectDeepSeekCalls(text: string): Array<{ name: string; args: string; raw: string }> {
  const out: Array<{ name: string; args: string; raw: string }> = [];
  const re =
    /<[｜|]tool[▁_]call[▁_]begin[｜|]>[\s\S]*?<[｜|]tool[▁_]sep[｜|]>\s*([A-Za-z_]\w*)\s*([\s\S]*?)(?=<[｜|]tool[▁_]call[▁_]begin[｜|]>|<[｜|]tool[▁_]call[▁_]end[｜|]>|<[｜|]tool[▁_]calls[▁_]end[｜|]>|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1]!;
    const body = m[2] ?? '';
    const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
    let argSrc = fence ? fence[1]! : body;
    const objs = balancedObjects(argSrc);
    if (objs.length) argSrc = objs[0]!.raw;
    out.push({ name, args: argSrc.trim(), raw: m[0]! });
  }
  return out;
}

/** Strip DeepSeek's wrapper / separator control tokens (never legitimate prose). */
function stripDeepSeekTokens(s: string): string {
  return s
    .replace(/<[｜|]tool[▁_]calls?[▁_](?:begin|end)[｜|]>/g, '')
    .replace(/<[｜|]tool[▁_]sep[｜|]>/g, '');
}

export function sniffToolCalls(text: string, isKnownTool: (name: string) => boolean): SniffResult {
  const calls: RecoveredCall[] = [];
  let cleaned = text;

  const take = (name: string, args: unknown): boolean => {
    if (!isKnownTool(name)) return false;
    const raw = typeof args === 'string' ? args : JSON.stringify(args ?? {});
    const parsed = parseToolArgs(raw);
    calls.push({ name, input: parsed.ok ? parsed.value : {} });
    return true;
  };

  // 1) <tool_call>...</tool_call> spans. Body may be a JSON envelope OR the Hermes/Qwen
  //    XML function form (<function=NAME><parameter=KEY>V</parameter></function>).
  cleaned = cleaned.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi, (m, body: string) => {
    let any = false;
    const obj = parseLoose(body);
    for (const e of obj ? collectEntries(obj) : []) if (take(e.name, e.args)) any = true;
    if (!any) for (const fn of collectXmlFunctions(body)) if (take(fn.name, fn.args)) any = true;
    return any ? '' : m;
  });

  // 1b) Bare Hermes/Qwen XML function form with no <tool_call> wrapper.
  let sawXml = false;
  for (const fn of collectXmlFunctions(cleaned)) {
    if (take(fn.name, fn.args)) {
      cleaned = cleaned.replace(fn.raw, '');
      sawXml = true;
    }
  }
  if (sawXml) cleaned = stripXmlToolTags(cleaned); // scrub any leftover unbalanced tag fragments

  // 1c) DeepSeek's native tool-call token form (fullwidth ｜ / ▁ delimiters). R1 emits these as
  //     TEXT rather than via tool_calls; recover them and strip the leftover wrapper tokens.
  let sawDeepSeek = false;
  for (const d of collectDeepSeekCalls(cleaned)) {
    if (take(d.name, d.args)) {
      cleaned = cleaned.replace(d.raw, '');
      sawDeepSeek = true;
    }
  }
  if (sawDeepSeek) cleaned = stripDeepSeekTokens(cleaned);

  // 2) call:NAME{...} form (balanced braces after the name).
  let m: RegExpExecArray | null;
  const callRe = /call:\s*([A-Za-z_]\w*)\s*(?=\{)/g;
  const toRemove: string[] = [];
  while ((m = callRe.exec(cleaned)) !== null) {
    const name = m[1]!;
    const objs = balancedObjects(cleaned.slice(m.index + m[0].length));
    const first = objs[0];
    if (first && first.start === 0) {
      if (take(name, parseLoose(first.raw) ?? first.raw)) toRemove.push(m[0] + first.raw);
    }
  }
  for (const r of toRemove) cleaned = cleaned.replace(r, '');

  // 3) JSON envelopes containing tool_calls / writables / a bare {name,args}.
  for (const { raw } of balancedObjects(cleaned)) {
    const obj = parseLoose(raw);
    if (!obj) continue;
    const entries = collectEntries(obj);
    if (!entries.length) continue;
    let any = false;
    for (const e of entries) if (take(e.name, e.args)) any = true;
    if (any) cleaned = cleaned.replace(raw, '');
  }

  return { calls, cleaned: cleaned.trim() };
}

/** Parse JSON, falling back to the tool-arg repair ladder (single quotes, etc.). */
function parseLoose(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    const r = parseToolArgs(s);
    return r.ok ? r.value : null;
  }
}
