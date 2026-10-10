import { createHash } from 'node:crypto';
import { discoverHarnessCatalog } from './catalog.js';
import { HARNESS_ID_RE } from './manifest.js';
import {
  HARNESS_CONTENT_DIR_NAMES,
  type HarnessCapabilityReadiness,
  type HarnessContentKind,
  type HarnessFoundation,
  type HarnessPackage,
  type HarnessRuntimeReadiness,
  type HarnessRuntimeReadinessOptions,
  type ResolveHarnessOptions,
  type ResolvedHarnessStack,
} from './types.js';

const FOUNDATION_INSTRUCTION = `You are Shadow, a provider-neutral security engineering agent. Focus first on security analysis, defensive operations, incident response, code and infrastructure review, and authorized security testing. Keep the user's scope and authority explicit, preserve evidence, distinguish observations from conclusions, and make completion depend on verifiable results. Prefer reversible, auditable actions and record material assumptions. The user controls the model, provider, endpoint, credentials, and deployment environment; a harness add-on may shape workflow and add compiled capabilities, but it never changes those choices or bypasses Shadow's approval and permission boundaries.`;

export const MAX_SELECTED_HARNESS_ADDONS = 16;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export const SHADOW_SECURITY_FOUNDATION: HarnessFoundation = Object.freeze({
  id: 'shadow-security',
  version: '1',
  title: 'Shadow Security',
  description: 'Provider-neutral, evidence-first security engineering foundation.',
  instruction: FOUNDATION_INSTRUCTION,
  digest: sha256(`shadow-security-foundation-v1\n${FOUNDATION_INSTRUCTION}`),
});

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Native wrapper tools must not become an indirect route back to a capability the harness removed.
 * `acceptance_check` executes its declared check through run_shell; `bash_output` and `kill_shell`
 * address processes that only run_shell can create; and `collaborate` invokes the agent tool. Keep
 * the closure small and explicit so new wrappers require an intentional review.
 */
export function expandHarnessToolRemovals(names: readonly string[]): string[] {
  const expanded: string[] = [];
  const add = (name: string): void => {
    if (!expanded.includes(name)) expanded.push(name);
  };
  for (const name of names) {
    add(name);
    if (name === 'run_shell') {
      add('acceptance_check');
      add('bash_output');
      add('kill_shell');
    }
    if (name === 'agent') add('collaborate');
    // Entering plan mode without both completion controls pins the model behind a write gate it
    // cannot satisfy. Hide model-triggered entry whenever either required control is removed;
    // the user-facing toggle is separately disabled by PlanModeState for the same session.
    if (name === 'plan_write' || name === 'exit_plan_mode') add('enter_plan_mode');
  }
  return expanded;
}

function capabilityReadiness(
  required: string[],
  registry: ResolveHarnessOptions['adapterRegistry'] | ResolveHarnessOptions['availableTools'],
  denied: ReadonlySet<string> = new Set(),
): HarnessCapabilityReadiness {
  const available: string[] = [];
  const missing: string[] = [];
  for (const id of required) {
    if (!denied.has(id) && registry?.has(id)) available.push(id);
    else missing.push(id);
  }
  return { required, available, missing };
}

function selectPackages(selectedIds: string[], options: ResolveHarnessOptions): HarnessPackage[] {
  const catalog = options.catalog ?? discoverHarnessCatalog(options);
  const installed = new Map(catalog.packages.map((pkg) => [pkg.id, pkg]));
  const issues = new Map(catalog.issues.filter((issue) => issue.directory).map((issue) => [issue.directory!, issue]));
  const selected: HarnessPackage[] = [];
  for (const id of selectedIds) {
    const pkg = installed.get(id);
    if (pkg) {
      selected.push(pkg);
      continue;
    }
    const issue = issues.get(id);
    if (issue) throw new Error(`harness "${id}" is invalid: ${issue.message}`);
    throw new Error(`harness "${id}" is not installed`);
  }
  return selected;
}

/** Resolve the immutable security foundation plus the selected add-ons for a new session. */
export function resolveHarnessStack(
  requestedIds: readonly string[] = [],
  options: ResolveHarnessOptions = {},
): ResolvedHarnessStack {
  const selectedIds: string[] = [];
  for (const raw of requestedIds) {
    const id = raw.trim();
    if (id === 'security' || id === SHADOW_SECURITY_FOUNDATION.id) continue;
    if (!HARNESS_ID_RE.test(id)) throw new Error(`invalid harness id: ${raw}`);
    if (!selectedIds.includes(id)) {
      if (selectedIds.length >= MAX_SELECTED_HARNESS_ADDONS) {
        throw new Error(`at most ${MAX_SELECTED_HARNESS_ADDONS} harness add-ons may be selected`);
      }
      selectedIds.push(id);
    }
  }
  const addons = selectPackages(selectedIds, options);

  const instructions: ResolvedHarnessStack['instructions'] = [
    {
      source: 'foundation',
      id: SHADOW_SECURITY_FOUNDATION.id,
      text: SHADOW_SECURITY_FOUNDATION.instruction,
      sha256: sha256(SHADOW_SECURITY_FOUNDATION.instruction),
    },
  ];
  for (const addon of addons) {
    for (const instruction of addon.instructions) {
      instructions.push({
        source: 'addon',
        id: addon.id,
        path: instruction.path,
        text: instruction.text,
        sha256: instruction.sha256,
      });
    }
  }

  const contentDirs = {} as Record<HarnessContentKind, string[]>;
  for (const kind of Object.keys(HARNESS_CONTENT_DIR_NAMES) as HarnessContentKind[]) contentDirs[kind] = [];
  for (const addon of addons) {
    for (const kind of Object.keys(HARNESS_CONTENT_DIR_NAMES) as HarnessContentKind[]) {
      const dir = addon.contentDirs[kind];
      if (dir) contentDirs[kind].push(dir);
    }
  }

  const requiredAdapters = unique(addons.flatMap((addon) => addon.manifest.requiredAdapters));
  const requiredTools = unique(addons.flatMap((addon) => addon.manifest.tools.add));
  const removedTools = expandHarnessToolRemovals(
    unique(addons.flatMap((addon) => addon.manifest.tools.remove)),
  );
  const removedSet = new Set(removedTools);
  const conflicts = requiredTools.filter((name) => removedSet.has(name));
  const adapters = capabilityReadiness(requiredAdapters, options.adapterRegistry);
  const tools = {
    ...capabilityReadiness(requiredTools, options.availableTools, removedSet),
    remove: removedTools,
    conflicts,
  };

  const instructionText = instructions
    .map((instruction) => {
      if (instruction.source === 'foundation') {
        return `## ${SHADOW_SECURITY_FOUNDATION.title}\n\n${instruction.text.trim()}`;
      }
      const addon = addons.find((candidate) => candidate.id === instruction.id)!;
      return `## Harness add-on: ${addon.manifest.title} (${addon.id}@${addon.manifest.version})\n` +
        `Source: ${instruction.path}\n\n${instruction.text.trim()}`;
    })
    .join('\n\n');

  const digest = sha256(
    `shadow-harness-stack-v1\n${JSON.stringify({
      foundation: SHADOW_SECURITY_FOUNDATION.digest,
      addons: addons.map((addon) => [addon.id, addon.digest]),
    })}`,
  );

  return {
    foundation: SHADOW_SECURITY_FOUNDATION,
    addons,
    selectedIds,
    instructionText,
    instructions,
    skills: addons.flatMap((addon) => addon.skills),
    contentDirs,
    adapters,
    tools,
    ready: adapters.missing.length === 0 && tools.missing.length === 0 && conflicts.length === 0,
    digest,
  };
}

/** Fail closed before session bootstrap if a selected add-on is not runnable. */
export function assertHarnessReady(stack: ResolvedHarnessStack): void {
  if (stack.ready) return;
  const reasons: string[] = [];
  if (stack.adapters.missing.length > 0) reasons.push(`missing compiled adapters: ${stack.adapters.missing.join(', ')}`);
  if (stack.tools.missing.length > 0) reasons.push(`missing required tools: ${stack.tools.missing.join(', ')}`);
  if (stack.tools.conflicts.length > 0) {
    reasons.push(`tools are both required and removed: ${stack.tools.conflicts.join(', ')}`);
  }
  throw new Error(`harness stack is not ready — ${reasons.join('; ')}`);
}

/**
 * Check a structurally-loaded stack against one concrete runtime host.
 *
 * Resolution intentionally happens before all host tools exist: the terminal
 * adds orchestration tools later, while web sessions have a smaller native
 * surface and may add MCP tools during connection. Call this only after the
 * selected host has finished registering the tools it will expose.
 */
export function evaluateHarnessRuntimeReadiness(
  stack: ResolvedHarnessStack,
  options: HarnessRuntimeReadinessOptions,
): HarnessRuntimeReadiness {
  const adapters = options.adapterRegistry
    ? capabilityReadiness(stack.adapters.required, options.adapterRegistry)
    : stack.adapters;
  const tools = {
    ...capabilityReadiness(stack.tools.required, options.availableTools, new Set(stack.tools.remove)),
    remove: [...stack.tools.remove],
    conflicts: [...stack.tools.conflicts],
  };
  return {
    adapters,
    tools,
    ready: adapters.missing.length === 0 && tools.missing.length === 0 && tools.conflicts.length === 0,
  };
}

/** Fail closed once the host's real tool registry is complete. */
export function assertHarnessRuntimeReady(
  stack: ResolvedHarnessStack,
  options: HarnessRuntimeReadinessOptions,
): void {
  const runtime = evaluateHarnessRuntimeReadiness(stack, options);
  if (runtime.ready) return;
  const reasons: string[] = [];
  if (runtime.adapters.missing.length > 0) {
    reasons.push(`missing compiled adapters: ${runtime.adapters.missing.join(', ')}`);
  }
  if (runtime.tools.missing.length > 0) {
    reasons.push(`missing required tools: ${runtime.tools.missing.join(', ')}`);
  }
  if (runtime.tools.conflicts.length > 0) {
    reasons.push(`tools are both required and removed: ${runtime.tools.conflicts.join(', ')}`);
  }
  throw new Error(`harness stack is not ready — ${reasons.join('; ')}`);
}
