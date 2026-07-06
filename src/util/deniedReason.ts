/** Human-readable denial messages for transcript, export, and headless renderers. */
export function friendlyDeniedReason(reason: string): string {
  if (reason.startsWith('plan mode blocks ')) {
    return 'Plan mode is active. Approve exit_plan_mode before implementation tools run.';
  }
  if (reason === 'denied by user') return 'Not approved. Choose another approach or revise the request.';
  if (reason === 'plan mode exit denied by user') return 'Plan exit not approved. Continue planning or revise the plan.';
  if (reason.startsWith('permission rule denied')) return reason.replace('permission rule denied: ', 'Blocked by permission rule: ');
  return reason;
}