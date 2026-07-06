/**
 * Normalize foreign harness tool names + argument shapes to Shadow canonical tools.
 * Pure — no I/O. Used by the agent loop before schema validation.
 */
import { canonicalToolName } from './aliases.js';

export interface ForeignToolCall {
  name: string;
  input: unknown;
}

export interface NormalizedToolCall {
  name: string;
  input: unknown;
}

const CASE_ALIASES: Record<string, string> = {
  read: 'read_file',
  write: 'write_file',
  edit: 'edit_file',
  bash: 'run_shell',
  shell: 'run_shell',
  shell_command: 'run_shell',
  str_replace: 'edit_file',
  str_replace_based_edit_tool: 'edit_file',
  update_plan: 'todo_write',
  list_dir: 'glob',
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Recover Codex unified-exec `{"command":["apply_patch","*** Begin Patch…"]}`. */
export function recoverCommandArrayPatch(input: unknown): string | null {
  const o = asRecord(input);
  if (!o) return null;
  const cmd = o.command;
  if (!Array.isArray(cmd) || cmd.length < 2) return null;
  if (String(cmd[0]).toLowerCase().replace(/-/g, '_') !== 'apply_patch') return null;
  const patch = String(cmd[1] ?? '');
  return patch.includes('*** Begin Patch') ? patch : null;
}

function mapShellCommand(input: Record<string, unknown>): Record<string, unknown> {
  const command =
    (typeof input.command === 'string' ? input.command : undefined) ??
    (typeof input.cmd === 'string' ? input.cmd : undefined);
  if (!command) return input;
  const workdir =
    (typeof input.workdir === 'string' ? input.workdir : undefined) ??
    (typeof input.working_directory === 'string' ? input.working_directory : undefined);
  const out: Record<string, unknown> = { ...input, command };
  if (workdir) {
    const escaped = workdir.replace(/'/g, `'\\''`);
    out.command = `cd '${escaped}' && ${command}`;
  }
  delete out.workdir;
  delete out.working_directory;
  delete out.cmd;
  return out;
}

function mapEditForeign(input: Record<string, unknown>): Record<string, unknown> {
  const path = input.path ?? input.file_path ?? input.file;
  const old_string = input.old_string ?? input.old_str ?? input.oldString;
  const new_string = input.new_string ?? input.new_str ?? input.newString;
  const out: Record<string, unknown> = { ...input };
  if (typeof path === 'string') out.path = path;
  if (typeof old_string === 'string') out.old_string = old_string;
  if (typeof new_string === 'string') out.new_string = new_string;
  return out;
}

function mapReadForeign(input: Record<string, unknown>): Record<string, unknown> {
  const path = input.path ?? input.file_path ?? input.file;
  return typeof path === 'string' ? { ...input, path } : input;
}

function mapWriteForeign(input: Record<string, unknown>): Record<string, unknown> {
  const path = input.path ?? input.file_path ?? input.file;
  const content = input.content ?? input.contents ?? input.text;
  const out: Record<string, unknown> = { ...input };
  if (typeof path === 'string') out.path = path;
  if (typeof content === 'string') out.content = content;
  return out;
}

function mapUpdatePlan(input: Record<string, unknown>): Record<string, unknown> {
  const items = input.plan ?? input.items ?? input.steps;
  if (!Array.isArray(items)) return { todos: [] };
  const todos = items.map((it, i) => {
    const row = asRecord(it) ?? {};
    const statusRaw = String(row.status ?? 'pending').toLowerCase();
    const status =
      statusRaw === 'completed' || statusRaw === 'done'
        ? 'completed'
        : statusRaw === 'in_progress' || statusRaw === 'in-progress'
          ? 'in_progress'
          : 'pending';
    return {
      id: String(row.id ?? `plan-${i}`),
      subject: String(row.subject ?? row.content ?? row.description ?? row.step ?? `item ${i}`),
      status,
    };
  });
  return { todos };
}

/** Map foreign name + args to canonical Shadow tool call. */
export function normalizeForeignTool(call: ForeignToolCall): NormalizedToolCall {
  const lower = call.name.toLowerCase();
  const canonical = CASE_ALIASES[lower] ?? CASE_ALIASES[call.name] ?? canonicalToolName(call.name);
  const input = call.input;

  const patch = recoverCommandArrayPatch(input);
  if (patch) return { name: 'apply_patch', input: { patch } };

  const o = asRecord(input);
  if (!o) return { name: canonical, input };

  switch (canonical) {
    case 'run_shell':
      return { name: canonical, input: mapShellCommand(o) };
    case 'edit_file':
      return { name: canonical, input: mapEditForeign(o) };
    case 'read_file':
      return { name: canonical, input: mapReadForeign(o) };
    case 'write_file':
      return { name: canonical, input: mapWriteForeign(o) };
    case 'todo_write':
      if (lower === 'update_plan' || call.name === 'update_plan') {
        return { name: 'todo_write', input: mapUpdatePlan(o) };
      }
      return { name: canonical, input: o };
    default:
      return { name: canonical, input: o };
  }
}