import type { EndpointRegistryState, SavedEndpoint, SessionBinding } from './types.js';

export interface PreparedSwitch<T> {
  readonly generation: number;
  readonly endpoint: SavedEndpoint;
  readonly binding: SessionBinding;
  readonly value: T;
}

export interface SwitchControllerOptions<T> {
  getRegistry: () => EndpointRegistryState;
  getBinding: () => SessionBinding | undefined;
  isRunning: () => boolean;
  prepare: (endpoint: SavedEndpoint, signal: AbortSignal) => Promise<{ value: T; binding: SessionBinding }>;
  commit: (prepared: PreparedSwitch<T>) => void | Promise<void>;
  abort?: (prepared: PreparedSwitch<T>, reason: unknown) => void | Promise<void>;
}

export type SwitchResult<T> =
  | { ok: true; prepared: PreparedSwitch<T> }
  | { ok: false; reason: 'running' | 'superseded' | 'aborted' | 'failed'; error?: unknown };

/**
 * Shared two-phase switch guard. Preparation may perform I/O, but only commit mutates the live
 * session. A newer request or an abort signal invalidates older preparation before commit.
 */
export class EndpointSwitchController<T> {
  private generation = 0;
  private active?: { generation: number; controller: AbortController };

  constructor(private readonly options: SwitchControllerOptions<T>) {}

  get currentGeneration(): number {
    return this.generation;
  }

  cancel(): void {
    this.generation += 1;
    this.active?.controller.abort();
    this.active = undefined;
  }

  async switchTo(endpoint: SavedEndpoint, signal?: AbortSignal): Promise<SwitchResult<T>> {
    if (this.options.isRunning()) return { ok: false, reason: 'running' };
    const generation = ++this.generation;
    this.active?.controller.abort();
    const controller = new AbortController();
    this.active = { generation, controller };
    const onAbort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const current = this.options.getRegistry();
      const binding = this.options.getBinding();
      if (binding && current.endpoints.every((candidate) => candidate.id !== endpoint.id)) {
        return { ok: false, reason: 'failed', error: new Error(`endpoint is not in registry: ${endpoint.id}`) };
      }
      const preparedValue = await this.options.prepare(endpoint, controller.signal);
      if (controller.signal.aborted || this.generation !== generation || this.active?.generation !== generation) {
        return { ok: false, reason: controller.signal.aborted ? 'aborted' : 'superseded' };
      }
      const prepared: PreparedSwitch<T> = { generation, endpoint, binding: preparedValue.binding, value: preparedValue.value };
      await this.options.commit(prepared);
      return { ok: true, prepared };
    } catch (error) {
      if (controller.signal.aborted || this.generation !== generation) return { ok: false, reason: 'aborted', error };
      return { ok: false, reason: 'failed', error };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (this.active?.generation === generation) this.active = undefined;
    }
  }
}
