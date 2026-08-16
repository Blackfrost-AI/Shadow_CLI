import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { SessionLog } from './session.js';
import { friendlyDeniedReason } from '../util/deniedReason.js';
import { resolveWithin } from '../safety/workspaceJail.js';

export interface ExportMeta {
  version: string;
  workspaceRoot: string;
  provider: string;
  model: string;
  style: string;
  autonomy: string;
  sessionPath: string;
  exportedAt: string;
}

interface SessionEvent {
  kind?: string;
  type?: string;
  task?: string;
  text?: string;
  call?: { name?: string; input?: unknown };
  result?: { ok?: boolean; summary?: string };
  reason?: string;
  message?: string;
  attempt?: number;
  from?: string;
  to?: string;
  ts?: string;
}

/** Display cap for a tool result's summary in exports (envelopes can run to ~maxToolResultChars). */
const EXPORT_SUMMARY_CAP = 4_000;

function previewInput(input: unknown): string {
  const o = input as Record<string, unknown> | undefined;
  if (!o || typeof o !== 'object') return '';
  if (typeof o.command === 'string') return o.command;
  if (typeof o.path === 'string') return o.path;
  if (typeof o.url === 'string') return o.url;
  if (typeof o.pattern === 'string') return o.pattern;
  if (typeof o.reason === 'string') return o.reason;
  try {
    const s = JSON.stringify(o);
    return s.length > 200 ? `${s.slice(0, 197)}…` : s;
  } catch {
    return '';
  }
}

function yamlFront(meta: ExportMeta): string {
  const relSession = meta.sessionPath.startsWith(meta.workspaceRoot)
    ? relative(meta.workspaceRoot, meta.sessionPath)
    : meta.sessionPath;
  return [
    '---',
    `shadow_version: ${meta.version}`,
    `model: ${meta.provider}/${meta.model}`,
    `style: ${meta.style}`,
    `autonomy: ${meta.autonomy}`,
    `workspace: ${meta.workspaceRoot}`,
    `exported_at: ${meta.exportedAt}`,
    `session: ${relSession}`,
    '---',
    '',
  ].join('\n');
}

/** Convert parsed session JSONL events to markdown. */
export function sessionToMarkdown(events: unknown[], meta: ExportMeta): string {
  const lines: string[] = [yamlFront(meta), '# Shadow session export', ''];
  const pendingTools = new Map<string, { name: string; input: unknown }>();

  for (const raw of events) {
    const e = raw as SessionEvent;
    if (e.kind === 'user' && e.task) {
      lines.push('## User', '', `> ${e.task.replace(/\n/g, '\n> ')}`, '');
      continue;
    }
    if (e.kind !== 'event') continue;

    switch (e.type) {
      case 'assistant_done':
        if (e.text?.trim()) lines.push('## Assistant', '', e.text.trimEnd(), '');
        break;
      case 'reasoning_done':
        // F02-04: reasoning is context, not the answer — export it COLLAPSED so the transcript
        // stays readable but nothing is lost (the old export dropped it entirely).
        if (e.text?.trim()) {
          lines.push(
            '## Reasoning',
            '',
            '<details><summary>Reasoning (collapsed)</summary>',
            '',
            e.text.trimEnd(),
            '',
            '</details>',
            '',
          );
        }
        break;
      case 'tool_start':
        if (e.call?.name) pendingTools.set(e.call.name + (e.ts ?? ''), { name: e.call.name, input: e.call.input });
        break;
      case 'tool_end': {
        const name = e.call?.name ?? 'tool';
        const input = e.call?.input;
        const preview = previewInput(input);
        const mark = e.result?.ok ? 'ok' : 'err';
        // Cap the rendered summary — an enveloped web_fetch/MCP result can be ~maxToolResultChars
        // (~16k) and would otherwise bloat the export with one page's whole body per tool call.
        const rawSummary = e.result?.summary ?? '';
        const summary =
          rawSummary.length > EXPORT_SUMMARY_CAP ? `${rawSummary.slice(0, EXPORT_SUMMARY_CAP)}\n…(result truncated in export)` : rawSummary;
        lines.push(`## Tool · ${name}`, '');
        if (preview) lines.push(`**Input:** \`${preview}\`  `);
        lines.push(`**Result:** ${mark} — ${summary}`, '');
        break;
      }
      case 'tool_denied':
        lines.push(
          `## Blocked · ${e.call?.name ?? 'tool'}`,
          '',
          friendlyDeniedReason(e.reason ?? 'denied'),
          '',
        );
        break;
      case 'model_fallback':
        lines.push('## System', '', `Model fallback: ${e.from ?? '?'} → ${e.to ?? '?'} (${e.reason ?? ''})`, '');
        break;
      case 'error':
        lines.push('## System', '', `Error: ${e.message ?? 'unknown'}`, '');
        break;
      case 'retry': {
        // Retry events carry {attempt, delayMs, reason} — never `message`. Rendering the whole
        // event as JSON dumped `{"type":"retry","attempt":1,…}` into every exported transcript;
        // show the human-readable reason + attempt instead.
        const which = typeof e.attempt === 'number' && e.attempt > 0 ? ` (attempt ${e.attempt})` : '';
        lines.push('## System', '', `Retry${which}: ${e.reason ?? e.message ?? 'retrying'}`, '');
        break;
      }
      case 'stop':
        if (e.reason && e.reason !== 'end_turn') {
          lines.push('## System', '', `Stopped: ${e.reason}`, '');
        }
        break;
      default:
        break;
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

export function exportSession(opts: {
  sessionPath: string;
  workspaceRoot: string;
  outPath?: string;
  meta: ExportMeta;
}): { path: string; bytes: number } {
  const events = SessionLog.load(opts.sessionPath);
  const md = sessionToMarkdown(events, opts.meta);
  const stamp = opts.meta.exportedAt.replace(/:/g, '-');
  const defaultOut = join(opts.workspaceRoot, 'exports', `shadow-${stamp}.md`);
  let outPath = opts.outPath ? resolve(opts.workspaceRoot, opts.outPath) : defaultOut;
  try {
    outPath = resolveWithin(opts.workspaceRoot, outPath);
  } catch {
    outPath = defaultOut;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  // An export can contain secrets the redactor missed, and exports/ is a plain workspace dir (not the
  // 0700 .shadow tree), so write it owner-only. writeFileSync's mode applies only on create; chmod
  // forces it when overwriting an existing (possibly 0644) file.
  writeFileSync(outPath, md, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(outPath, 0o600);
  } catch {
    /* best-effort */
  }
  return { path: outPath, bytes: Buffer.byteLength(md, 'utf8') };
}

/** Export from a session file path (CLI). */
export function exportSessionFile(
  sessionPath: string,
  workspaceRoot: string,
  meta: Omit<ExportMeta, 'sessionPath' | 'exportedAt'>,
  outPath?: string,
): { path: string; bytes: number } {
  return exportSession({
    sessionPath,
    workspaceRoot,
    outPath,
    meta: { ...meta, sessionPath, exportedAt: new Date().toISOString() },
  });
}