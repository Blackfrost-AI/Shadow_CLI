import type { EndpointReadiness, ObservedEndpoint, SavedEndpoint } from './types.js';

export interface EndpointWatchResult {
  endpoint: SavedEndpoint;
  observation: ObservedEndpoint;
}

export interface EndpointWatcherOptions {
  intervalMs?: number;
  concurrency?: number;
  probe: (endpoint: SavedEndpoint, signal: AbortSignal) => Promise<ObservedEndpoint>;
  onResult: (result: EndpointWatchResult) => void | Promise<void>;
  onError?: (endpoint: SavedEndpoint, error: unknown) => void | Promise<void>;
}

/** Bounded selected-endpoint watcher. It never discovers targets; it probes only supplied entries. */
export class EndpointWatcher {
  private readonly intervalMs: number;
  private readonly concurrency: number;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private generation = 0;
  private running = false;
  private selected: SavedEndpoint[] = [];

  constructor(private readonly options: EndpointWatcherOptions) {
    this.intervalMs = Math.max(250, Math.min(300_000, Math.round(options.intervalMs ?? 10_000)));
    this.concurrency = Math.max(1, Math.min(16, Math.round(options.concurrency ?? 2)));
  }

  setSelected(endpoints: readonly SavedEndpoint[]): void {
    this.selected = [...endpoints];
  }

  start(endpoints = this.selected): void {
    this.setSelected(endpoints);
    this.stop();
    this.running = true;
    this.generation += 1;
    const generation = this.generation;
    this.controller = new AbortController();
    void this.sweep(generation, this.controller.signal);
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    this.controller?.abort();
    this.controller = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  get isRunning(): boolean {
    return this.running;
  }

  private async sweep(generation: number, signal: AbortSignal): Promise<void> {
    const selected = [...this.selected];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (signal.aborted || generation !== this.generation) return;
        const index = cursor++;
        if (index >= selected.length) return;
        const endpoint = selected[index];
        try {
          const observation = await this.options.probe(endpoint, signal);
          if (!signal.aborted && generation === this.generation) await this.options.onResult({ endpoint, observation });
        } catch (error) {
          if (!signal.aborted && generation === this.generation) await this.options.onError?.(endpoint, error);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, selected.length) }, () => worker()));
    if (this.running && !signal.aborted && generation === this.generation) {
      this.timer = setTimeout(() => void this.sweep(generation, signal), this.intervalMs);
    }
  }
}

export function readinessFromProbe(ok: boolean, loading = false): EndpointReadiness {
  if (loading) return 'loading';
  return ok ? 'ready' : 'down';
}
