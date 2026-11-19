/**
 * Canonical ops worker archetypes (plan §6). These exported constants — never
 * resolveAgentDef/loadAgentDefs — are the security source of truth for dispatch and the
 * policy gate. A workspace `.shadow/agents/<name>.md` may shadow the name for ordinary
 * agent-tool use, but ops_dispatch ignores it: the allowlist can never be widened.
 * No run_shell anywhere; the verifier executes only bound project_checks profiles.
 */
import type { AgentDef } from '../../agent/defs.js';
import type { Archetype } from './types.js';

export const BUILTIN_RECON: AgentDef = {
  name: 'recon',
  description: 'Ops reconnaissance worker: passive inventory and triage, anchored facts into the ops graph.',
  tools: ['read_file', 'grep', 'glob', 'repository_context', 'bin_recon', 'target_snapshot', 'ops_writeback'],
  maxIterations: 25,
  systemPrompt: [
    'You are an ops reconnaissance worker in the Shadow security harness.',
    'Map the assigned targets: register assets with ops_writeback register_asset (local',
    'enrichment queues automatically), then record facts anchored to those assets.',
    'Passive only — never modify or execute targets, never reach the network.',
    'Write-back contract: persist typed nodes; a run that writes nothing back is a failed run.',
    'Finish with ops_writeback finish_intent and a summary. Payloads ≤8 KiB, no credentials.',
    'Stop when the assigned surface is inventoried or a tool is denied twice — report what you recorded.',
  ].join(' '),
  builtin: true,
};

export const BUILTIN_AUDITOR: AgentDef = {
  name: 'auditor',
  description: 'Ops audit worker: code/dependency audit; findings into the evidence ledger and graph.',
  tools: ['read_file', 'grep', 'glob', 'repository_context', 'secrets_scan', 'sast_scan', 'osv_query', 'ops_writeback'],
  maxIterations: 25,
  systemPrompt: [
    'You are an ops audit worker in the Shadow security harness.',
    'Audit the anchored facts and code for the assigned intent. File findings with',
    'ops_writeback file_finding — it records into the evidence ledger AND the graph in one',
    'step and returns the ledger id. A finding is a claim until a live check verifies it;',
    'never describe unverified claims as confirmed.',
    'osv_query works only when the engagement scope carries the literal allow-network token.',
    'Write-back contract: persist typed nodes; a run that writes nothing back is a failed run.',
    'Finish with ops_writeback finish_intent and a summary of findings + evidence ids.',
    'Stop when the audit surface is covered or a tool is denied twice.',
  ].join(' '),
  builtin: true,
};

export const BUILTIN_VERIFIER: AgentDef = {
  name: 'verifier',
  description: 'Ops verification worker: retest findings via bound project_checks profiles ONLY.',
  tools: ['read_file', 'grep', 'glob', 'project_checks', 'ops_writeback'],
  maxIterations: 25,
  systemPrompt: [
    'You are an ops verification worker in the Shadow security harness.',
    'Retest the assigned findings by running ONLY the project_checks profiles bound to this',
    'engagement. Never run arbitrary shell. Verification requires a live passed check recorded',
    'in this session — imported or historical results cannot verify.',
    'Write-back contract: persist typed nodes; a run that writes nothing back is a failed run.',
    'Record the outcome as an anchored fact (check id, pass/fail, what it proves), then',
    'ops_writeback finish_intent with a summary. Payloads ≤8 KiB, no credentials.',
    'Stop after the bound profiles have run or a check is denied — report the honest result.',
  ].join(' '),
  builtin: true,
};

export const OPS_ARCHETYPES: Record<Archetype, AgentDef> = {
  recon: BUILTIN_RECON,
  auditor: BUILTIN_AUDITOR,
  verifier: BUILTIN_VERIFIER,
};

export const OPS_ARCHETYPE_NAMES: readonly string[] = Object.keys(OPS_ARCHETYPES);

/** Canonical allowlist for the policy gate — always the constant, never a resolved def. */
export function canonicalOpsTools(archetype: Archetype): string[] {
  return [...OPS_ARCHETYPES[archetype].tools];
}

/** Anti-fail-open assertion: a resolved def must exactly equal the canonical constant. */
export function matchesCanonical(def: AgentDef | null | undefined, archetype: Archetype): boolean {
  const canonical = OPS_ARCHETYPES[archetype];
  if (!def) return false;
  if (def.name !== canonical.name) return false;
  if (def.tools.length !== canonical.tools.length) return false;
  return canonical.tools.every((t, i) => def.tools[i] === t);
}