import type { PermissionAction, PermissionRule } from './rules.js';

export type PermissionCmdResult =
  | { ok: true; rules: PermissionRule[]; message: string }
  | { ok: false; message: string };

const ACTIONS = new Set<PermissionAction>(['deny', 'ask', 'allow']);

/** Parse `/permissions` subcommands. Pure — no I/O. */
export function applyPermissionCommand(
  rules: PermissionRule[],
  argLine: string,
): PermissionCmdResult {
  const trimmed = argLine.trim();
  if (!trimmed) {
    return {
      ok: true,
      rules,
      message: formatPermissionList(rules),
    };
  }

  const parts = trimmed.split(/\s+/);
  const verb = parts[0]!.toLowerCase();

  if (verb === 'list') {
    return { ok: true, rules, message: formatPermissionList(rules) };
  }

  if (verb === 'clear') {
    return { ok: true, rules: [], message: 'Cleared all permission rules.' };
  }

  if (verb === 'add') {
    const action = parts[1] as PermissionAction | undefined;
    const tool = parts[2];
    if (!action || !ACTIONS.has(action) || !tool) {
      return {
        ok: false,
        message: 'Usage: /permissions add <deny|ask|allow> <tool> [pattern]',
      };
    }
    let pattern: string | undefined;
    const last = parts[3];
    if (last) {
      const m = last.match(/^\/(.+)\/$/);
      pattern = m ? m[1] : last;
    }
    const next = [...rules, { action, tool, ...(pattern ? { pattern } : {}) }];
    return {
      ok: true,
      rules: next,
      message: `Added rule #${next.length - 1}: ${formatRule(next.at(-1)!)}`,
    };
  }

  if (verb === 'remove' || verb === 'rm') {
    const idx = Number(parts[1]);
    if (!Number.isInteger(idx) || idx < 0 || idx >= rules.length) {
      return { ok: false, message: `Usage: /permissions remove <index> (0–${Math.max(0, rules.length - 1)})` };
    }
    const next = rules.filter((_, i) => i !== idx);
    return { ok: true, rules: next, message: `Removed rule #${idx}.` };
  }

  if (verb === 'set') {
    const idx = Number(parts[1]);
    const action = parts[2] as PermissionAction | undefined;
    const tool = parts[3];
    if (!Number.isInteger(idx) || idx < 0 || idx >= rules.length) {
      return { ok: false, message: `Usage: /permissions set <index> <deny|ask|allow> <tool> [pattern]` };
    }
    if (!action || !ACTIONS.has(action) || !tool) {
      return { ok: false, message: 'Usage: /permissions set <index> <deny|ask|allow> <tool> [pattern]' };
    }
    let pattern: string | undefined;
    const last = parts[4];
    if (last) {
      const m = last.match(/^\/(.+)\/$/);
      pattern = m ? m[1] : last;
    }
    const next = rules.map((r, i) =>
      i === idx ? { action, tool, ...(pattern ? { pattern } : {}) } : r,
    );
    return { ok: true, rules: next, message: `Updated rule #${idx}: ${formatRule(next[idx]!)}` };
  }

  return {
    ok: false,
    message:
      'Usage: /permissions [list|add|remove|set|clear …] — e.g. /permissions add deny run_shell /rm -rf/',
  };
}

export function formatPermissionList(rules: PermissionRule[]): string {
  if (!rules.length) return 'No permission rules configured.';
  return rules.map((r, i) => `#${i} ${formatRule(r)}`).join('\n');
}

function formatRule(r: PermissionRule): string {
  return `${r.action.padEnd(5)} ${r.tool}${r.pattern ? ` /${r.pattern}/` : ''}`;
}