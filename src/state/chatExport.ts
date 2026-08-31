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

/** Export output format. `markdown` (default) is the original .md transcript. */
export type ExportFormat = 'markdown' | 'html';

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
  // Subagent / background-agent events (agentTool → bus → session log).
  taskId?: string;
  prompt?: string;
  subagentType?: string;
  answer?: string;
  fromSubagent?: string;
}

/** Display cap for a tool result's summary in exports (envelopes can run to ~maxToolResultChars). */
const EXPORT_SUMMARY_CAP = 4_000;

/** Cap for displayed tool args/results and subagent transcripts. */
const DISPLAY_MAX = 2000;

/** Cap displayed text at `max` chars, appending a "… N more chars" marker when trimmed. */
export function trimDisplay(text: string, max = DISPLAY_MAX): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… ${text.length - max} more chars`;
}

/** Escape dynamic content so it renders as inert text in HTML (no script/attribute breakout). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function previewInput(input: unknown, max = 200): string {
  const o = input as Record<string, unknown> | undefined;
  if (!o || typeof o !== 'object') return '';
  if (typeof o.command === 'string') return o.command;
  if (typeof o.path === 'string') return o.path;
  if (typeof o.url === 'string') return o.url;
  if (typeof o.pattern === 'string') return o.pattern;
  if (typeof o.reason === 'string') return o.reason;
  try {
    const s = JSON.stringify(o);
    return s.length > max ? `${s.slice(0, max - 3)}…` : s;
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

/* ------------------------------------------------------------------ */
/* Standalone HTML export                                              */
/* ------------------------------------------------------------------ */

/** Inline-only CSS: system fonts, no external assets; dark via prefers-color-scheme. */
const HTML_CSS = `
:root {
  color-scheme: light dark;
  --bg: #f6f7f9; --panel: #ffffff; --fg: #1d2129; --muted: #5c6572;
  --border: #d8dde4; --code-bg: #eef0f3;
  --user-bg: #e9f1fd; --user-accent: #3466c9;
  --assistant-accent: #7c5cd4; --tool-accent: #2f8f5f;
  --err-accent: #b3261e; --blocked-accent: #b97d10; --system-bg: #f0f1f4;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #121418; --panel: #1a1d23; --fg: #e6e9ee; --muted: #9aa3b0;
    --border: #2c323c; --code-bg: #22262e;
    --user-bg: #16233a; --user-accent: #6b9bff;
    --assistant-accent: #a98bff; --tool-accent: #4cc38a;
    --err-accent: #ff6b61; --blocked-accent: #e0a63f; --system-bg: #171a1f;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0 auto; max-width: 56rem; padding: 2rem 1.25rem 4rem;
  background: var(--bg); color: var(--fg);
  font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
}
header { margin-bottom: 1.75rem; padding-bottom: 1rem; border-bottom: 1px solid var(--border); }
h1 { margin: 0 0 .75rem; font-size: 1.3rem; overflow-wrap: anywhere; }
.facts { display: flex; flex-wrap: wrap; gap: .3rem 1.5rem; margin: 0; font-size: .9rem; }
.facts div { display: flex; gap: .4rem; }
.facts dt { color: var(--muted); }
.facts dt::after { content: ":"; }
.facts dd { margin: 0; overflow-wrap: anywhere; }
section, details {
  margin: .9rem 0; padding: .7rem .9rem; background: var(--panel);
  border: 1px solid var(--border); border-left-width: 4px; border-radius: 6px;
}
h2 {
  margin: 0 0 .45rem; font-size: .78rem; text-transform: uppercase;
  letter-spacing: .06em; color: var(--muted);
}
.body { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.msg.user { background: var(--user-bg); border-left-color: var(--user-accent); }
.msg.assistant { border-left-color: var(--assistant-accent); }
section.tool { border-left-color: var(--tool-accent); }
section.tool.err { border-left-color: var(--err-accent); }
section.blocked { border-left-color: var(--blocked-accent); }
section.system { background: var(--system-bg); border-left-color: var(--muted); }
section.tool dl { margin: 0; }
section.tool dt { color: var(--muted); font-size: .8rem; margin-top: .45rem; }
section.tool dd { margin: 0; }
pre.detail {
  margin: .2rem 0 0; padding: .5rem .6rem; background: var(--code-bg); border-radius: 4px;
  white-space: pre-wrap; overflow-wrap: anywhere;
  font: .85rem ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
details.subagent { border-left-color: var(--assistant-accent); }
details.subagent summary { cursor: pointer; font-weight: 600; font-size: .9rem; }
details.subagent .body { margin-top: .5rem; padding: .5rem .6rem; background: var(--code-bg); border-radius: 4px; }
`.trim();

/** First ISO timestamp in the log (= session start, since every record gets a ts). */
function sessionStartTs(events: unknown[]): string | null {
  for (const raw of events) {
    const ts = (raw as SessionEvent).ts;
    if (typeof ts === 'string' && ts) return ts;
  }
  return null;
}

function countUserTurns(events: unknown[]): number {
  let n = 0;
  for (const raw of events) {
    const e = raw as SessionEvent;
    if (e.kind === 'user' && e.task) n++;
  }
  return n;
}

function msgBlock(cls: string, title: string, text: string): string {
  return `<section class="msg ${cls}"><h2>${escapeHtml(title)}</h2><div class="body">${escapeHtml(text)}</div></section>`;
}

/** Convert parsed session JSONL events to a single self-contained HTML document
 * (inline CSS only — zero JavaScript, zero external assets). */
export function sessionToHtml(events: unknown[], meta: ExportMeta): string {
  const sessionId = SessionLog.sessionIdFromPath(meta.sessionPath);
  const sections: string[] = [];

  for (const raw of events) {
    const e = raw as SessionEvent;
    if (e.kind === 'user' && e.task) {
      sections.push(msgBlock('user', 'User', e.task));
      continue;
    }
    if (e.kind !== 'event') continue;

    switch (e.type) {
      case 'assistant_done':
        if (e.text?.trim()) sections.push(msgBlock('assistant', 'Assistant', e.text.trimEnd()));
        break;
      case 'reasoning_done':
        // F02-04 parity with the markdown export: reasoning is context, not the answer —
        // render it COLLAPSED so the transcript stays readable but nothing is lost.
        if (e.text?.trim()) {
          sections.push(
            `<details><summary>Reasoning (collapsed)</summary><div class="body">${escapeHtml(e.text.trimEnd())}</div></details>`,
          );
        }
        break;
      case 'tool_end': {
        const name = e.call?.name ?? 'tool';
        const ok = !!e.result?.ok;
        const rows: string[] = [];
        const preview = trimDisplay(previewInput(e.call?.input, DISPLAY_MAX));
        if (preview) rows.push(`<dt>Input</dt><dd><pre class="detail">${escapeHtml(preview)}</pre></dd>`);
        const summary = trimDisplay(e.result?.summary ?? '');
        rows.push(`<dt>Result</dt><dd><pre class="detail">${ok ? 'ok' : 'err'} — ${escapeHtml(summary)}</pre></dd>`);
        sections.push(
          `<section class="tool ${ok ? 'ok' : 'err'}"><h2>Tool · ${escapeHtml(name)}</h2><dl>${rows.join('')}</dl></section>`,
        );
        break;
      }
      case 'tool_denied':
        sections.push(
          msgBlock('blocked', `Blocked · ${e.call?.name ?? 'tool'}`, friendlyDeniedReason(e.reason ?? 'denied')),
        );
        break;
      case 'model_fallback':
        sections.push(msgBlock('system', 'System', `Model fallback: ${e.from ?? '?'} → ${e.to ?? '?'} (${e.reason ?? ''})`));
        break;
      case 'error':
        sections.push(msgBlock('system', 'System', `Error: ${e.message ?? 'unknown'}`));
        break;
      case 'retry': {
        // Same shape as the markdown path: human-readable reason + attempt, never the raw event JSON.
        const which = typeof e.attempt === 'number' && e.attempt > 0 ? ` (attempt ${e.attempt})` : '';
        sections.push(msgBlock('system', 'System', `Retry${which}: ${e.reason ?? e.message ?? 'retrying'}`));
        break;
      }
      case 'stop':
        if (e.reason && e.reason !== 'end_turn') {
          sections.push(msgBlock('system', 'System', `Stopped: ${e.reason}`));
        }
        break;
      case 'bg_agent_launched': {
        const label = e.subagentType ?? 'subagent';
        const id = e.taskId ? ` (${e.taskId})` : '';
        sections.push(
          `<details class="subagent"><summary>Background agent launched · ${escapeHtml(label + id)}</summary>` +
            `<div class="body">${escapeHtml(trimDisplay(e.prompt ?? ''))}</div></details>`,
        );
        break;
      }
      case 'task_notification': {
        const label = e.fromSubagent ?? e.taskId ?? 'subagent';
        sections.push(
          `<details class="subagent"><summary>Subagent result · ${escapeHtml(label)}</summary>` +
            `<div class="body">${escapeHtml(trimDisplay(e.answer ?? ''))}</div></details>`,
        );
        break;
      }
      default:
        break;
    }
  }

  const title = `Shadow session ${sessionId}`;
  const facts: string[] = [`<div><dt>Session</dt><dd>${escapeHtml(sessionId)}</dd></div>`];
  const startTs = sessionStartTs(events);
  if (startTs) facts.push(`<div><dt>Started</dt><dd>${escapeHtml(startTs)}</dd></div>`);
  if (meta.provider || meta.model) {
    facts.push(`<div><dt>Model</dt><dd>${escapeHtml(`${meta.provider}/${meta.model}`)}</dd></div>`);
  }
  facts.push(`<div><dt>Turns</dt><dd>${countUserTurns(events)}</dd></div>`);
  facts.push(`<div><dt>Exported</dt><dd>${escapeHtml(meta.exportedAt)}</dd></div>`);

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="generator" content="Shadow CLI ${escapeHtml(meta.version)}">`,
    `<title>${escapeHtml(title)}</title>`,
    `<style>${HTML_CSS}</style>`,
    '</head>',
    '<body>',
    '<header>',
    `<h1>${escapeHtml(title)}</h1>`,
    `<dl class="facts">${facts.join('')}</dl>`,
    '</header>',
    '<main>',
    ...sections,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

export function exportSession(opts: {
  sessionPath: string;
  workspaceRoot: string;
  outPath?: string;
  format?: ExportFormat;
  meta: ExportMeta;
}): { path: string; bytes: number } {
  const events = SessionLog.load(opts.sessionPath);
  const format: ExportFormat = opts.format ?? 'markdown';
  const body = format === 'html' ? sessionToHtml(events, opts.meta) : sessionToMarkdown(events, opts.meta);
  const stamp = opts.meta.exportedAt.replace(/:/g, '-');
  const defaultOut = join(opts.workspaceRoot, 'exports', `shadow-${stamp}.${format === 'html' ? 'html' : 'md'}`);
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
  writeFileSync(outPath, body, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(outPath, 0o600);
  } catch {
    /* best-effort */
  }
  return { path: outPath, bytes: Buffer.byteLength(body, 'utf8') };
}

/** Export from a session file path (CLI). */
export function exportSessionFile(
  sessionPath: string,
  workspaceRoot: string,
  meta: Omit<ExportMeta, 'sessionPath' | 'exportedAt'>,
  outPath?: string,
  format: ExportFormat = 'markdown',
): { path: string; bytes: number } {
  return exportSession({
    sessionPath,
    workspaceRoot,
    outPath,
    format,
    meta: { ...meta, sessionPath, exportedAt: new Date().toISOString() },
  });
}