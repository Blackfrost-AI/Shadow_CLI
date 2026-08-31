export type PlanMode = 'planning' | 'implement';

export interface PlanSnapshot {
  mode: PlanMode;
  title?: string;
  path?: string;
  /** Implementation steps from plan_write — seeded into the mission on approval. */
  tasks?: string[];
}

export type PlanModeListener = (snapshot: PlanSnapshot) => void;

export class PlanModeState {
  private snapshotValue: PlanSnapshot;
  /** Set by a non-approved exit() (Shift+Tab, /clear); the loop consumes it once. */
  private exitedUnapproved = false;
  private readonly listeners = new Set<PlanModeListener>();

  constructor(enabled = false) {
    this.snapshotValue = { mode: enabled ? 'planning' : 'implement' };
  }

  get active(): boolean {
    return this.snapshotValue.mode === 'planning';
  }

  snapshot(): PlanSnapshot {
    return { ...this.snapshotValue };
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

  block(): string {
    if (!this.active) return '';
    const planLine = this.snapshotValue.path
      ? `\nCurrent plan file: ${this.snapshotValue.path}`
      : '';
    return [
      '',
      '',
      '## Plan mode',
      'You are currently in plan mode. Explore and read freely, write or update the plan with plan_write, then call exit_plan_mode when the plan is ready for user approval.',
      'Do not call write_file, edit_file, run_shell, web_fetch, or web_search until plan mode exits.',
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
