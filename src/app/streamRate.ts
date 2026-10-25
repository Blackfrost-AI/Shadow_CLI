// Live output throughput. Provider tokenizers are unavailable at the streaming boundary, so
// this is a documented ~4 characters/token estimate, not provider-reported billing telemetry.
const ACTIVE_WINDOW_MS = 3_000;
const MAX_ACTIVE_TAIL_MS = 500;
const MIN_ACTIVE_MS = 200;
const MIN_OUTPUT_CHARS = 16;

interface RateSample {
  activeMs: number;
  outputChars: number;
}

/**
 * A sliding window of active decode time. Idle/tool/setup gaps are excluded, not allowed to
 * age out useful samples. Reads are pure: the 160 ms HUD tick cannot mutate the measurement.
 */
export class StreamRate {
  private samples: RateSample[] = [];
  private lastDeltaAt: number | null = null;
  private pendingStart = 0;
  private pendingChars = 0;
  private frozen: number | null | undefined;

  reset(): void {
    this.samples = [];
    this.lastDeltaAt = null;
    this.pendingStart = 0;
    this.pendingChars = 0;
    this.frozen = undefined;
  }

  append(delta: string, now: number): void {
    if (!delta || this.frozen !== undefined) return;
    const at = Math.max(this.lastDeltaAt ?? now, now);
    if (this.lastDeltaAt !== null && at - this.lastDeltaAt > MAX_ACTIVE_TAIL_MS) {
      this.sealPending();
      this.pendingStart = at;
    } else if (this.pendingChars === 0) this.pendingStart = at;
    this.pendingChars += delta.length;
    this.lastDeltaAt = at;
  }

  read(now: number, running: boolean): number | null {
    if (this.frozen !== undefined) return this.frozen;
    if (!running || this.lastDeltaAt === null) return null;
    const tailMs = Math.min(MAX_ACTIVE_TAIL_MS, Math.max(0, now - this.lastDeltaAt));
    const samples = [...this.samples];
    if (this.pendingChars > 0) {
      samples.push({ activeMs: Math.max(0, this.lastDeltaAt - this.pendingStart) + tailMs, outputChars: this.pendingChars });
    }
    // A burst is sealed exactly once, when a subsequent delta proves the gap was idle. It is
    // then present only in `samples`, never duplicated as both a sealed and a pending sample.
    let remaining = ACTIVE_WINDOW_MS;
    let activeMs = 0;
    let outputChars = 0;
    for (let i = samples.length - 1; i >= 0 && remaining > 0; i--) {
      const sample = samples[i]!;
      if (sample.activeMs <= 0) {
        if (i === samples.length - 1) outputChars += sample.outputChars;
        continue;
      }
      const visibleMs = Math.min(remaining, sample.activeMs);
      activeMs += visibleMs;
      outputChars += sample.outputChars * (visibleMs / sample.activeMs);
      remaining -= visibleMs;
    }
    if (activeMs < MIN_ACTIVE_MS || outputChars < MIN_OUTPUT_CHARS) return null;
    return (outputChars / 4) / (activeMs / 1000);
  }

  finish(now: number): number | null {
    const final = this.read(now, true);
    this.frozen = final;
    return final;
  }

  private sealPending(): void {
    if (this.pendingChars > 0 && this.lastDeltaAt !== null) {
      this.samples.push({
        activeMs: Math.max(0, this.lastDeltaAt - this.pendingStart) + MAX_ACTIVE_TAIL_MS,
        outputChars: this.pendingChars,
      });
    }
    this.pendingChars = 0;
    this.lastDeltaAt = null;
  }
}

export function formatTokPerSec(rate: number | null | undefined): string {
  return rate === null || rate === undefined || !Number.isFinite(rate) ? '—' : `${Math.max(1, Math.round(rate))} tok/s`;
}
