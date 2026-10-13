import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { ProjectCheckStore } from './store.js';
import type { ToolRegistry } from '../tools/registry.js';
import { makeProjectChecksTool } from '../tools/projectChecks.js';

const stores = new WeakMap<ToolRegistry, Map<string, ProjectCheckStore>>();
/** A registry owns session selections; separate worktrees never share required checks. */
export function checksForRegistry(registry: ToolRegistry, workspace: string): ProjectCheckStore {
  let workspaces = stores.get(registry);
  if (!workspaces) { workspaces = new Map(); stores.set(registry, workspaces); }
  let path = resolve(workspace);
  try { path = realpathSync(path); } catch { /* A not-yet-created workspace is keyed by its absolute path. */ }
  let store = workspaces.get(path);
  if (!store) { store = new ProjectCheckStore(path); workspaces.set(path, store); }
  return store;
}
export function attachProjectChecks(registry: ToolRegistry): void {
  registry.register(makeProjectChecksTool((workspace: string) => checksForRegistry(registry, workspace)));
}
