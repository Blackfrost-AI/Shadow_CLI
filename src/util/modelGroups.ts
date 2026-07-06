/**
 * Grouping for the `/model` picker. Pure (no React/ink) so it unit-tests cleanly.
 *
 * A model on a LOCAL endpoint groups under "Local" — locality beats the model's maker
 * (a local gemma is "Local", not "Google"). Cloud models group by company. An explicit
 * `group` on the entry always wins.
 */
import type { ModelEntry } from '../config.js';
import { isLocalBaseUrl } from '../safety/offline.js';

export function modelGroup(e: ModelEntry): string {
  if (e.group) return e.group;
  const url = (e.baseUrl ?? '').toLowerCase();
  // Locality beats the model's maker (a local gemma is "Local", not "Google"). isLocalBaseUrl
  // catches localhost AND private LAN/WG ranges (e.g. a quad-served model on a private LAN IP) — the
  // regex adds the common local-runtime ports/keywords (ollama, LM Studio, host.docker).
  if (isLocalBaseUrl(e.baseUrl) || /ollama|:11434|:1234|:8000|host\.docker/.test(url)) return 'Local';
  const m = e.model.toLowerCase();
  if (/claude|opus|sonnet|haiku|fable|anthropic/.test(m)) return 'Anthropic';
  if (/gpt|codex|davinci|(^|[-/])o[1345]\b|text-embedding/.test(m)) return 'OpenAI';
  if (/grok/.test(m)) return 'xAI';
  if (/gemini|gemma|palm/.test(m)) return 'Google';
  if (/deepseek/.test(m)) return 'DeepSeek';
  if (/qwen/.test(m)) return 'Qwen';
  if (/llama|codellama/.test(m)) return 'Meta';
  if (/mistral|mixtral|codestral|magistral/.test(m)) return 'Mistral';
  if (/glm|chatglm/.test(m)) return 'Zhipu';
  if (/command|cohere/.test(m)) return 'Cohere';
  if (/phi-?\d/.test(m)) return 'Microsoft';
  if (/nemotron/.test(m)) return 'NVIDIA';
  return e.provider === 'anthropic' ? 'Anthropic' : 'Other';
}

/** A row in the grouped picker: a non-selectable category header, or a selectable model. */
export type PickerRow = { kind: 'header'; label: string } | { kind: 'model'; entry: ModelEntry };

/** Group entries into header+model rows (a header per category, first-seen order). */
export function groupedModelRows(entries: ModelEntry[]): PickerRow[] {
  const groups = new Map<string, ModelEntry[]>();
  for (const e of entries) {
    const g = modelGroup(e);
    const list = groups.get(g) ?? [];
    list.push(e);
    groups.set(g, list);
  }
  const rows: PickerRow[] = [];
  for (const [label, es] of groups) {
    rows.push({ kind: 'header', label });
    for (const e of es) rows.push({ kind: 'model', entry: e });
  }
  return rows;
}

/** First selectable (model) row index, or 0. */
export function firstSelectableRow(rows: PickerRow[]): number {
  const i = rows.findIndex((r) => r.kind === 'model');
  return i >= 0 ? i : 0;
}

/** Step from `from` in `dir` to the next model row, skipping headers; stays put at the ends. */
export function stepSelectableRow(rows: PickerRow[], from: number, dir: 1 | -1): number {
  for (let i = from + dir; i >= 0 && i < rows.length; i += dir) {
    if (rows[i]!.kind === 'model') return i;
  }
  return from;
}
