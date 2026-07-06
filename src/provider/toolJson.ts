/**
 * Tool-call JSON repair ladder.
 *
 * Local models frequently emit *almost*-valid JSON for tool arguments: wrapped in
 * ```fences```, with leading/trailing prose, trailing commas, single quotes, or
 * Python literals (True/False/None). A frontier model rarely does; a weak local
 * model does it constantly. We try a strict parse first, then a sequence of
 * conservative repairs, then parse again. This is the cheap first layer that keeps
 * a model's tool calls from failing outright — paired with the loop's
 * retry-on-failure feedback (the second layer) for the cases repair can't save.
 */
export interface ToolArgsParse {
  ok: boolean;
  value?: unknown;
  /** true when a repair (not a strict parse) produced the value. */
  repaired?: boolean;
  error?: string;
}

export function parseToolArgs(raw: string): ToolArgsParse {
  const src = raw.trim() === '' ? '{}' : raw.trim(); // a no-arg call streams "" → {}

  const strict = tryParse(src);
  if (strict.ok) return strict;

  const repaired = repairJson(src);
  if (repaired !== null && repaired !== src) {
    const r = tryParse(repaired);
    if (r.ok) return { ...r, repaired: true };
  }

  return { ok: false, error: `arguments were not valid JSON, even after repair: ${truncate(src, 180)}` };
}

function tryParse(s: string): ToolArgsParse {
  try {
    let v: unknown = JSON.parse(s);
    // Double-encoded args: a JSON *string* that itself contains an object/array.
    if (typeof v === 'string') {
      const t = v.trim();
      if (t.startsWith('{') || t.startsWith('[')) {
        try {
          v = JSON.parse(t);
        } catch {
          /* keep the string */
        }
      }
    }
    return { ok: true, value: v };
  } catch {
    return { ok: false };
  }
}

/** Conservative repairs. Returns the repaired string, or null if unchanged. */
function repairJson(input: string): string | null {
  let t = input;

  // 1. Strip a ```json … ``` / ``` … ``` code fence. Use indexOf (not a regex) so a
  //    huge/adversarial model output can't trigger catastrophic backtracking.
  const open = t.indexOf('```');
  if (open !== -1) {
    const close = t.indexOf('```', open + 3);
    if (close !== -1) t = t.slice(open + 3, close).replace(/^[a-z]+\s*/i, '').trim();
  }

  // 2. Drop surrounding prose: keep from the first { or [ to the last } or ].
  const first = Math.min(idx(t, '{'), idx(t, '['));
  const last = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (first !== Infinity && last > first) t = t.slice(first, last + 1);

  // 3. Python / JS literals → JSON.
  t = t.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null');

  // 4. Remove trailing commas before a closing } or ].
  t = t.replace(/,(\s*[}\]])/g, '$1');

  // 5. Single-quoted → double-quoted, but ONLY when there are no double quotes to
  //    mangle (a whole object quoted with ' instead of "). Best-effort, conservative.
  if (!t.includes('"') && t.includes("'")) t = t.replace(/'/g, '"');

  // 6. Escape literal control chars (raw newlines/tabs/etc.) that appear INSIDE
  //    string values. JSON forbids them, so a weak local model writing a multi-line
  //    value — code or JSON as a `content`/`write_file` arg — produces JSON that
  //    JSON.parse rejects outright. This is the #1 reason a file-writing tool call
  //    fails to parse. We rewrite only chars *inside* strings; structural newlines
  //    between tokens are valid JSON and left untouched.
  t = escapeControlCharsInStrings(t);

  return t === input ? null : t;
}

/**
 * Escape literal control characters (code point < 0x20) that occur inside JSON
 * string literals, leaving everything outside strings — including structural
 * whitespace — unchanged. Walks the text once tracking string state and honoring
 * backslash escapes, so an already-escaped `\n` and an unescaped `"` are handled
 * correctly. Single pass, no regex: safe on huge/adversarial inputs.
 */
function escapeControlCharsInStrings(input: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  let changed = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString && ch.charCodeAt(0) < 0x20) {
      changed = true;
      switch (ch) {
        case '\n': out += '\\n'; break;
        case '\r': out += '\\r'; break;
        case '\t': out += '\\t'; break;
        case '\b': out += '\\b'; break;
        case '\f': out += '\\f'; break;
        default: out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`; break;
      }
      continue;
    }
    out += ch;
  }
  return changed ? out : input;
}

function idx(s: string, ch: string): number {
  const i = s.indexOf(ch);
  return i === -1 ? Infinity : i;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
