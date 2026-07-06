export type PlanMode = 'planning' | 'implement';

export interface PlanSnapshot {
  mode: PlanMode;
  title?: string;
  path?: string;
}

export type PlanModeListener = (snapshot: PlanSnapshot) => void;

export class PlanModeState {
  private snapshotValue: PlanSnapshot;
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

  recordPlan(title: string, path: string): PlanSnapshot {
    this.snapshotValue = { mode: 'planning', title, path };
    this.emit();
    return this.snapshot();
  }

  /** Enter plan mode from the UI (Shift+Tab), preserving any plan already recorded. */
  enter(): PlanSnapshot {
    this.snapshotValue = {
      mode: 'planning',
      title: this.snapshotValue.title,
      path: this.snapshotValue.path,
    };
    this.emit();
    return this.snapshot();
  }

  exit(): PlanSnapshot {
    this.snapshotValue = {
      mode: 'implement',
      title: this.snapshotValue.title,
      path: this.snapshotValue.path,
    };
    this.emit();
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
