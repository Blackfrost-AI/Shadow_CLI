import { fileURLToPath } from 'node:url';
import type { LspServerFlavor, NavigationKind, SourceLocation } from './protocol.js';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === 'object' ? value as ObjectValue : {};
const positive = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;

/** Normalize LSP Location/LocationLink/DocumentSymbol and native tsserver spans. */
export function normalizeNavigation(raw: unknown, flavor: LspServerFlavor, kind: NavigationKind, path: string): SourceLocation[] {
  const out: SourceLocation[] = [];
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 20 || out.length >= 500) return;
    if (Array.isArray(value)) { for (const entry of value) visit(entry, depth + 1); return; }
    const item = object(value);
    if (flavor === 'tsserver') {
      if (Array.isArray(item.refs)) { visit(item.refs, depth + 1); return; }
      const span = object(Array.isArray(item.spans) ? item.spans[0] : undefined);
      const start = object(item.start ?? span.start);
      if (Object.keys(start).length) out.push({
        path: typeof item.file === 'string' ? item.file : path,
        line: positive(start.line), col: positive(start.offset),
        endLine: positive(object(item.end ?? span.end).line),
        ...(typeof item.text === 'string' ? { name: item.text } : {}),
        ...(typeof item.kind === 'string' ? { kind: item.kind } : {}),
      });
      if (kind === 'symbols' && item.childItems) visit(item.childItems, depth + 1);
      return;
    }
    const location = Object.keys(object(item.location)).length ? object(item.location) : item;
    const range = object(location.targetSelectionRange ?? location.targetRange ?? location.selectionRange ?? location.range);
    const start = object(range.start);
    const uri = location.targetUri ?? location.uri;
    let locationPath = path;
    if (typeof uri === 'string') {
      try { locationPath = fileURLToPath(uri); } catch { return; }
    }
    if (Object.keys(start).length) out.push({
      path: locationPath, line: positive(typeof start.line === 'number' ? start.line + 1 : 1),
      col: positive(typeof start.character === 'number' ? start.character + 1 : 1),
      endLine: positive(typeof object(range.end).line === 'number' ? (object(range.end).line as number) + 1 : 1),
      ...(typeof item.name === 'string' ? { name: item.name } : {}),
      ...(typeof item.kind === 'number' ? { kind: String(item.kind) } : {}),
    });
    if (kind === 'symbols' && item.children) visit(item.children, depth + 1);
  };
  visit(raw);
  return out;
}
