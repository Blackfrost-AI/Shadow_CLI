/**
 * Tool-name aliases. Models trained on other harnesses call tools by their OWN names.
 * `registry.get` maps a foreign name to Shadow's canonical tool, and the loop canonicalizes
 * `call.name` so the denylist / permission rules / schema all see the real tool.
 *
 * IMPORTANT: aliasing only remaps the NAME, not the argument SHAPE. So we keep only aliases
 * whose foreign args line up with Shadow's tool (shell tools all take `command`; the rest are
 * just naming variants of Shadow's own tools). Schema-incompatible aliases (e.g. `str_replace`
 * with `old_str`/`new_str` vs edit_file's `old_string`/`new_string`, or `create_file`) are
 * deliberately omitted — name-mapping them only produces a zod validation error.
 */
const ALIASES: Record<string, string> = {
  // shell — every variant takes `command`
  bash: 'run_shell',
  shell: 'run_shell',
  sh: 'run_shell',
  run_bash: 'run_shell',
  run_command: 'run_shell',
  execute_command: 'run_shell',
  shell_command: 'run_shell',
  // patch — takes `patch`
  applypatch: 'apply_patch',
  'apply-patch': 'apply_patch',
  // naming variants of Shadow's own tools (same arg shape)
  multiedit: 'multi_edit',
  websearch: 'web_search',
  webfetch: 'web_fetch',
  todowrite: 'todo_write',
  update_plan: 'todo_write',
  // Claude/Codex casing variants (same arg shape after foreignAdapter maps fields)
  read: 'read_file',
  write: 'write_file',
  edit: 'edit_file',
};

/** Canonical Shadow tool name for `name`, or `name` itself when it isn't a known alias. */
export function canonicalToolName(name: string): string {
  return ALIASES[name] ?? ALIASES[name.toLowerCase()] ?? name;
}
