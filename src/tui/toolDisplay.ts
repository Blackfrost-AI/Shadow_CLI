// src/tui/toolDisplay.ts — calm, human-facing tool presentation for the TUI.
//
// Models speak internal names (`read_file`, `edit_file`, `run_shell`). The transcript
// speaks the reference-client vocabulary (`Read`, `Update`, `Bash`) and collapses the
// noise (reads/searches) while leaving the signal (edits/writes/shell) as one-row
// markers. Pure helpers — no Ink, no side effects.

/** Tools whose results are pure reconnaissance — safe to fold into a group. */
const COLLAPSIBLE = new Set([
  'read_file',
  'grep',
  'glob',
  'view_image',
  'tool_search',
  'memory', // list/get facts is noise; writes stay visible via non-collapsible fallbacks if needed
]);

/** Kind of collapsible activity for Claude-style "Read 3 files, Grep 2 patterns" lines. */
export type CollapseKind = 'read' | 'search' | 'list' | 'view' | 'other';

/** True when this tool should fold into a consecutive read/search group. */
export function isCollapsibleTool(name: string): boolean {
  return COLLAPSIBLE.has(name);
}

/** Classify a collapsible tool for the stack summary. Non-collapsible → 'other'. */
export function collapseKind(name: string): CollapseKind {
  switch (name) {
    case 'read_file':
      return 'read';
    case 'grep':
    case 'web_search': // only if ever folded; default non-collapsible
      return 'search';
    case 'glob':
      return 'list';
    case 'view_image':
      return 'view';
    default:
      return 'other';
  }
}

/**
 * One-word display name (bold in the tool row). Matches the reference client's calm verbs:
 * Read / Update / Write / Bash / Grep / Glob — never the snake_case protocol name.
 */
export function displayToolName(name: string): string {
  switch (name) {
    case 'read_file':
      return 'Read';
    case 'write_file':
      return 'Write';
    case 'edit_file':
    case 'multi_edit':
    case 'apply_patch':
      return 'Update';
    case 'run_shell':
      return 'Bash';
    case 'bash_output':
      return 'BashOut';
    case 'kill_shell':
      return 'Kill';
    case 'grep':
      return 'Grep';
    case 'glob':
      return 'Glob';
    case 'web_fetch':
      return 'Fetch';
    case 'web_search':
      return 'WebSearch';
    case 'view_image':
      return 'Read';
    case 'todo_write':
      return 'Todo';
    case 'tool_search':
      return 'Tools';
    case 'memory':
      return 'Memory';
    case 'agent':
      return 'Agent';
    case 'ask_user_question':
      return 'Ask';
    case 'describe_media':
      return 'See';
    case 'worktree_create':
    case 'worktree_remove':
    case 'worktree_list':
      return 'Worktree';
    case 'plan_write':
    case 'enter_plan_mode':
    case 'exit_plan_mode':
      return 'Plan';
    default:
      // MCP / unknown: Title-case the last segment of "server__tool" or snake_case.
      const bare = name.includes('__') ? name.split('__').pop()! : name;
      return bare
        .split(/[_-]+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join('') || name;
  }
}

/** True for tools that mutate the workspace (edits/writes) — used to prefer +N −M summaries. */
export function isWriteTool(name: string): boolean {
  return name === 'edit_file' || name === 'multi_edit' || name === 'write_file' || name === 'apply_patch';
}

/**
 * Clean a live/committed arg for display: strip a leading `$ ` from shell previews
 * (the display name is already `Bash`), collapse whitespace, middle-truncate.
 */
export function displayToolArg(arg: string | undefined, max = 56): string {
  if (!arg) return '';
  let a = arg.replace(/^\$\s+/, '').replace(/\s+/g, ' ').trim();
  // Protocol strip for URLs (same as rows.shortArg).
  a = a.replace(/^https?:\/\//, '');
  if (a.length > max) a = `${a.slice(0, Math.ceil(max * 0.62))}…${a.slice(a.length - Math.floor(max * 0.34))}`;
  return a;
}

/** Noun for a collapse kind + count (`1 file` / `3 files`). */
export function collapseNoun(kind: CollapseKind, count: number): string {
  const plural = count === 1 ? '' : 's';
  switch (kind) {
    case 'read':
      return count === 1 ? 'file' : 'files';
    case 'search':
      return count === 1 ? 'pattern' : 'patterns';
    case 'list':
      return count === 1 ? 'path' : 'paths';
    case 'view':
      return count === 1 ? 'image' : 'images';
    default:
      return count === 1 ? 'call' : 'calls';
  }
}

/** Verb for a collapse kind (`Read` / `Grep` / `Glob`) — committed / past tense. */
export function collapseVerb(kind: CollapseKind): string {
  switch (kind) {
    case 'read':
      return 'Read';
    case 'search':
      return 'Grep';
    case 'list':
      return 'Glob';
    case 'view':
      return 'Viewed';
    default:
      return 'Ran';
  }
}

/** Progressive verb while recon is still mid-flight (`Reading` / `Grepping`). */
export function collapseVerbLive(kind: CollapseKind): string {
  switch (kind) {
    case 'read':
      return 'Reading';
    case 'search':
      return 'Grepping';
    case 'list':
      return 'Listing';
    case 'view':
      return 'Viewing';
    default:
      return 'Running';
  }
}

/**
 * Claude-style recon headline from per-kind counts.
 * `live: true` → Reading/Grepping; committed → Read/Grep.
 */
export function formatReconSummary(
  kinds: Partial<Record<CollapseKind, number>>,
  opts: { live?: boolean; fallbackLen?: number } = {},
): string {
  const parts: string[] = [];
  const order: CollapseKind[] = ['read', 'search', 'list', 'view', 'other'];
  for (const k of order) {
    const n = kinds[k] ?? 0;
    if (n > 0) {
      const verb = opts.live ? collapseVerbLive(k) : collapseVerb(k);
      parts.push(`${verb} ${n} ${collapseNoun(k, n)}`);
    }
  }
  if (parts.length > 0) return parts.join(', ');
  const n = opts.fallbackLen ?? 0;
  return n > 0 ? `${n} tool${n === 1 ? '' : 's'}` : 'tools';
}

/** Total collapsible calls in a kinds map. */
export function reconCount(kinds: Partial<Record<CollapseKind, number>>): number {
  return Object.values(kinds).reduce((a, n) => a + (n ?? 0), 0);
}
