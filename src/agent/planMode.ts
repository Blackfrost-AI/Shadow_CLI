export type PlanMode = 'planning' | 'implement';

export interface PlanSnapshot {
  mode: PlanMode;
  title?: string;
  path?: string;
  /** Implementation steps from plan_write — seeded into the mission on approval. */
  tasks?: string[];
}

export type PlanModeListener = (snapshot: PlanSnapshot) => void;

/** Minimal effective-tool view shared with prompt composition without coupling this state to a registry. */
export interface PlanModeCapabilities {
  has(name: string): boolean;
}

const ALL_PLAN_CAPABILITIES: PlanModeCapabilities = Object.freeze({ has: () => true });
export const PLAN_MODE_REQUIRED_TOOLS = Object.freeze(['plan_write', 'exit_plan_mode'] as const);

export function missingPlanModeControls(
  capabilities: PlanModeCapabilities = ALL_PLAN_CAPABILITIES,
): string[] {
  return PLAN_MODE_REQUIRED_TOOLS.filter((name) => !capabilities.has(name));
}

export class PlanModeState {
  private snapshotValue: PlanSnapshot;
  /** Set by a non-approved exit() (Shift+Tab, /clear); the loop consumes it once. */
  private exitedUnapproved = false;
  private readonly listeners = new Set<PlanModeListener>();

  constructor(
    enabled = false,
    private readonly capabilities: PlanModeCapabilities = ALL_PLAN_CAPABILITIES,
  ) {
    if (enabled && !this.available) {
      throw new Error(`plan mode requires available controls: ${this.missingControls.join(', ')}`);
    }
    this.snapshotValue = { mode: enabled ? 'planning' : 'implement' };
  }

  /** Plan mode cannot be entered unless the model can both write and submit its plan. */
  get available(): boolean {
    return this.missingControls.length === 0;
  }

  get missingControls(): string[] {
    return missingPlanModeControls(this.capabilities);
  }

  get unavailableReason(): string | undefined {
    const missing = this.missingControls;
    return missing.length > 0 ? `required controls are hidden: ${missing.join(', ')}` : undefined;
  }

  get active(): boolean {
    return this.snapshotValue.mode === 'planning';
  }

  snapshot(): PlanSnapshot {
    return { ...this.snapshotValue, ...(this.snapshotValue.tasks ? { tasks: [...this.snapshotValue.tasks] } : {}) };
  }

  /** Resume a recorded mode without synthesizing a user approval or side-door exit. */
  assertRestorable(raw: PlanSnapshot): void {
    if (raw?.mode === 'planning' && !this.available) {
      throw new Error(`cannot restore active plan mode; ${this.unavailableReason}`);
    }
  }

  /** Resume a recorded mode without synthesizing a user approval or side-door exit. */
  restore(raw: PlanSnapshot): PlanSnapshot {
    this.assertRestorable(raw);
    this.exitedUnapproved = false;
    this.snapshotValue = {
      mode: raw?.mode === 'planning' ? 'planning' : 'implement',
      ...(typeof raw?.title === 'string' ? { title: raw.title } : {}),
      ...(typeof raw?.path === 'string' ? { path: raw.path } : {}),
      ...(Array.isArray(raw?.tasks) ? { tasks: raw.tasks.filter((item): item is string => typeof item === 'string') } : {}),
    };
    this.emit();
    return this.snapshot();
  }

  recordPlan(title: string, path: string, tasks?: string[]): PlanSnapshot {
    this.snapshotValue = tasks && tasks.length > 0 ? { mode: 'planning', title, path, tasks } : { mode: 'planning', title, path };
    this.emit();
    return this.snapshot();
  }

  /** Enter plan mode from the UI (Shift+Tab), preserving any plan already recorded — tasks
   *  included, so a `/goal` begun after a plan_write still seeds its mission task list on
   *  approval (the toggle must never silently drop recorded work). */
  enter(): PlanSnapshot {
    // Defense in depth for embedders and UI paths: a harness may intentionally hide the
    // control pair. Entering anyway would pin an instruction the model can never complete.
    if (!this.available) return this.snapshot();
    this.exitedUnapproved = false; // re-entering re-arms the planning phase cleanly
    this.snapshotValue = {
      mode: 'planning',
      title: this.snapshotValue.title,
      path: this.snapshotValue.path,
      ...(this.snapshotValue.tasks ? { tasks: this.snapshotValue.tasks } : {}),
    };
    this.emit();
    return this.snapshot();
  }

  /** Leave plan mode. `{ approved: true }` marks the exit_plan_mode approval route; every
   *  other caller (Shift+Tab ring, /clear) is a side door the loop may need to react to. */
  exit(opts?: { approved?: boolean }): PlanSnapshot {
    this.exitedUnapproved = opts?.approved !== true;
    this.snapshotValue = {
      mode: 'implement',
      title: this.snapshotValue.title,
      path: this.snapshotValue.path,
      // Tasks survive the exit too: the mission's side-door seed (loop.ts) reads the
      // snapshot AFTER the mode flip, and a Shift+Tab must not orphan recorded work.
      ...(this.snapshotValue.tasks ? { tasks: this.snapshotValue.tasks } : {}),
    };
    this.emit();
    return this.snapshot();
  }

  /** One-shot side-door signal: returns the snapshot after a NON-approved exit() (and
   *  re-arms), null otherwise. The loop reads it once per turn so a stale latch can never
   *  flip a mission begun much later — only a real exit-then-planning overlap un-sticks. */
  consumeUnapprovedExit(): PlanSnapshot | null {
    if (!this.exitedUnapproved) return null;
    this.exitedUnapproved = false;
    return this.snapshot();
  }

  block(capabilities: PlanModeCapabilities = this.capabilities): string {
    if (!this.active) return '';
    const planLine = this.snapshotValue.path
      ? `\nCurrent plan file: ${this.snapshotValue.path}`
      : '';
    const canWritePlan = capabilities.has('plan_write');
    const canExitPlan = capabilities.has('exit_plan_mode');
    const blocked = ['write_file', 'edit_file', 'run_shell', 'web_fetch', 'web_search']
      .filter((name) => capabilities.has(name));
    const action = canWritePlan && canExitPlan
      ? 'Explore and read freely, write or update the plan with plan_write, then call exit_plan_mode when the plan is ready for user approval.'
      : canExitPlan
        ? 'Explore and read freely, then call exit_plan_mode when the plan is ready for user approval.'
        : 'Plan-mode exit is unavailable. Tell the user that this session cannot continue in plan mode.';
    const blockedList = blocked.length > 1
      ? `${blocked.slice(0, -1).join(', ')}, or ${blocked.at(-1)}`
      : blocked[0];
    const restriction = blockedList
      ? `Do not call ${blockedList} until plan mode exits.`
      : 'Do not begin implementation until plan mode exits.';
    return [
      '',
      '',
      '## Plan mode',
      `You are currently in plan mode. ${action}`,
      restriction,
      planLine,
    ].join('\n');
  }

  onUpdate(fn: PlanModeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) {
      try {
        fn(snap);
      } catch {
        // listeners must not break plan state transitions
      }
    }
  }
}
