export interface TranscriptStore {
  apply(event: unknown): void;
  hydrate(events: unknown[]): void;
  reset(): void;
  snapshot(): unknown[];
  hudState(): unknown;
  subscribe(listener: () => void): () => boolean;
}

export function createStore(): TranscriptStore;
