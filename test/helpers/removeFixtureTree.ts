import { rm } from 'node:fs/promises';

/** After stopping fixture children, allow Windows to release their cwd/file
 * handles. Only transient filesystem errors are retried; a persistent leak fails. */
export async function removeFixtureTree(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
