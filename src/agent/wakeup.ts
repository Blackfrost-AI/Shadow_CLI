/** In-session schedule_wakeup queue (Claude ScheduleWakeup parity baseline). */
export interface WakeupJob {
  id: string;
  delaySec: number;
  reason: string;
  task: string;
  at: number;
}

export type WakeupHandler = (task: string, reason: string) => void;

export class WakeupScheduler {
  private jobs = new Map<string, ReturnType<typeof setTimeout>>();
  private idSeq = 0;

  schedule(delaySec: number, reason: string, task: string, onFire: WakeupHandler): WakeupJob {
    const id = `wakeup-${++this.idSeq}`;
    const job: WakeupJob = { id, delaySec, reason, task, at: Date.now() + delaySec * 1000 };
    const timer = setTimeout(() => {
      this.jobs.delete(id);
      onFire(task, reason);
    }, delaySec * 1000);
    this.jobs.set(id, timer);
    return job;
  }

  cancel(id: string): boolean {
    const t = this.jobs.get(id);
    if (!t) return false;
    clearTimeout(t);
    this.jobs.delete(id);
    return true;
  }

  clear(): void {
    for (const t of this.jobs.values()) clearTimeout(t);
    this.jobs.clear();
  }
}