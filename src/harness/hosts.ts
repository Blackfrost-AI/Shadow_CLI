/**
 * Native tools registered by the terminal host after shared session bootstrap.
 * Bootstrap may defer only these known names; final runtime verification still
 * proves that every promised tool was actually registered before the first turn.
 */
export const CLI_LATE_NATIVE_HARNESS_TOOLS = Object.freeze([
  'send_notification',
  'schedule_wakeup',
  'agent',
  'project_jobs',
  'project_room',
  'acceptance_check',
  'collaborate',
] as const);

/** Tools constructed inside shared session bootstrap on both terminal and web hosts. */
export const SHARED_SESSION_HARNESS_TOOLS = Object.freeze([
  'read_file',
  'view_image',
  'write_file',
  'edit_file',
  'multi_edit',
  'apply_patch',
  'grep',
  'glob',
  'run_shell',
  'bash_output',
  'kill_shell',
  'worktree_create',
  'worktree_remove',
  'worktree_list',
  'memory',
  'todo_write',
  'plan_write',
  'exit_plan_mode',
  'enter_plan_mode',
  'mission_update',
  'ask_user_question',
  'skill',
  'skill_manage',
  'repository_context',
  'tool_search',
] as const);

/**
 * Pre-hook capability plan. Dynamic connector names are intentionally absent:
 * a dropped package cannot make session startup depend on an MCP side effect.
 */
export function plannedSessionHarnessTools(options: {
  offline: boolean;
  vision: boolean;
  deferred?: readonly string[];
}): Set<string> {
  const names = new Set<string>([
    ...SHARED_SESSION_HARNESS_TOOLS,
    ...(options.deferred ?? []),
  ]);
  if (!options.offline) {
    names.add('web_fetch');
    names.add('web_search');
    if (options.vision) names.add('describe_media');
  }
  return names;
}
