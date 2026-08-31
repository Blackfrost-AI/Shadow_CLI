// Note rendering + dedupe for LSP diagnostics (plan 3.1). PURE: takes diagnostics, returns
// model-facing text or null. The note rides the tool result's summary exactly like the v0
// `[diagnostics: …]` channel, so the model recognizes the shape.

import type { LspDiagnostic } from './protocol.js';
import { MAX_DIAGS_PER_FILE, MAX_NOTE_CHARS } from './protocol.js';

const HEAD_CHARS = 3_000;
const TAIL_CHARS = 800;

/**
 * Render one file's diagnostics as a model-facing note, or null when there is nothing to say.
 * Errors and warnings only — info/hints are context pollution. Clean file → null (silence is
 * free), matching the v0 diagnostics rule.
 */
export function renderDiagnostics(input: {
  serverId: string;
  relPath: string;
  diags: LspDiagnostic[];
}): string | null {
  const visible = input.diags.filter((d) => d.severity === 'error' || d.severity === 'warning');
  if (visible.length === 0) return null;
  const errors = visible.filter((d) => d.severity === 'error').length;
  const warnings = visible.length - errors;
  const head =
    `[lsp: ${input.serverId}] ` +
    `${errors} ${errors === 1 ? 'error' : 'errors'}, ${warnings} ${warnings === 1 ? 'warning' : 'warnings'} in ${input.relPath}`;
  const shown = visible.slice(0, MAX_DIAGS_PER_FILE);
  const lines = shown.map(
    (d) =>
      `${input.relPath}:${d.line}:${d.col} — ${singleLine(d.message)}` +
      (d.code ? ` (${d.severity}, ${d.code})` : ` (${d.severity})`),
  );
  if (visible.length > shown.length) lines.push(`(+${visible.length - shown.length} more)`);
  return capNote(`\n\n${head}\n${lines.join('\n')}`);
}

/** Collapse a diagnostic message to one 200-char line — messages can embed whole snippets. */
function singleLine(text: string, max = 200): string {
  const flat = text.replaceAll('\n', ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

function capNote(s: string): string {
  if (s.length <= MAX_NOTE_CHARS) return s;
  const omitted = s.length - HEAD_CHARS - TAIL_CHARS;
  return `${s.slice(0, HEAD_CHARS)}\n…(${omitted} chars omitted)…\n${s.slice(s.length - TAIL_CHARS)}`;
}

const MAX_TRACKED_URIS = 256;

/**
 * Suppresses repeat noise: a file whose rendered diagnostics did not change since the last
 * emitted note stays silent (the model already saw these). Any change — or a different file —
 * emits again. The uri → signature map is bounded; past the bound it resets wholesale (a
 * dedup table must never grow unbounded across a long session).
 */
export class NoteDeduper {
  private readonly last = new Map<string, string>();

  /** True when this (uri, signature) pair differs from the last emitted note for that uri. */
  shouldEmit(uri: string, signature: string): boolean {
    if (this.last.get(uri) === signature) return false;
    if (this.last.size >= MAX_TRACKED_URIS) this.last.clear();
    this.last.set(uri, signature);
    return true;
  }
}
