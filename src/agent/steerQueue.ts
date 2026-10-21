/**
 * FIFO bookkeeping shared by BOTH frontends for the steering protocol.
 *
 * A steering message stays in the host queue until the loop confirms it was injected into the
 * running turn (the `steer_applied` event). Only then may the queue drop it, or the same text
 * would run a second time as a fresh turn.
 *
 * The invariant that matters: remove EXACTLY ONE entry, not every entry with that text. Users
 * legitimately type the same short message twice ("yes", "continue"), and both are distinct
 * messages that must each be delivered. Filtering by text alone silently eats the second one.
 */
export function dropOneQueuedByText<T extends { text: string }>(queue: readonly T[], text: string): T[] | null {
  const index = queue.findIndex((entry) => entry.text === text);
  if (index < 0) return null; // nothing to drop — the caller must not re-render
  return [...queue.slice(0, index), ...queue.slice(index + 1)];
}

/**
 * Count the human messages that were submitted BEFORE the one being considered — the fairness
 * gate for steering.
 *
 * A steer injects into the RUNNING turn and immediately issues a new provider request, so it
 * would jump the queue. Queue order is the user's stated intent: a later message must never
 * overtake an earlier one, most importantly a pending `/compact`, which rewrites the very context
 * a new request would be built from.
 *
 * `queue` must already contain the entry being submitted as its LAST element (both frontends push
 * before asking).
 */
export function queuedAhead<T extends { text: string }>(queue: readonly T[]): number {
  return queue.slice(0, -1).filter((entry) => entry.text.trim()).length;
}
