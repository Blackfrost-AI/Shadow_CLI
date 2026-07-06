/**
 * Recover an `apply_patch` envelope a model emitted as assistant TEXT instead of via a
 * native tool call. Codex/Grok-class models sometimes print the patch directly:
 *
 *   *** Begin Patch
 *   *** Update File: src/app.py
 *   @@ def greet():
 *   -print("Hi")
 *   +print("Hello, world!")
 *   *** End Patch
 *
 * The extracted patch text is handed to the apply_patch tool VERBATIM — it must NOT go
 * through the JSON repair ladder (parseToolArgs), which would mangle the `{`/`}` and the
 * `***`/`@@` markers. The loop wraps it as `{ patch: <raw text> }` directly.
 */
const BEGIN = '*** Begin Patch';
const END = '*** End Patch';

export interface ExtractedPatch {
  patch: string; // the verbatim envelope, Begin…End inclusive
  cleaned: string; // the surrounding text with the envelope removed
}

export function extractPatchBlock(text: string): ExtractedPatch | null {
  const b = text.indexOf(BEGIN);
  if (b === -1) return null;
  const e = text.indexOf(END, b);
  if (e === -1) return null;
  const end = e + END.length;
  return {
    patch: text.slice(b, end),
    cleaned: (text.slice(0, b) + text.slice(end)).trim(),
  };
}
