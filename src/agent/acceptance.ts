import { existsSync } from 'node:fs';
import { resolveWithin } from '../safety/workspaceJail.js';
import { inspectWorkArtifact } from '../state/workArtifacts.js';
import type { AcceptanceResult, AcceptanceSpec, CheckEvidence } from '../state/jobStore.js';

/** Deliberately small JSON Schema subset. Unsupported constraints are unverified,
 * never ignored to manufacture a pass. */
export function validateResultSchema(value: unknown, schema: Record<string, unknown>, depth = 0): 'passed' | 'failed' | 'unverified' {
  if (depth > 12) return 'unverified';
  const supported = new Set(['type', 'required', 'properties', 'items', 'enum', 'additionalProperties', 'minItems', 'maxItems', 'description']);
  if (Object.keys(schema).some((key) => !supported.has(key))) return 'unverified';
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) return 'failed';
  const type = schema.type;
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'failed';
    const record = value as Record<string, unknown>;
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    if (Array.isArray(schema.required) && schema.required.some((key) => typeof key !== 'string' || !(key in record))) return 'failed';
    if (schema.additionalProperties === false && Object.keys(record).some((key) => !properties?.[key])) return 'failed';
    for (const [key, child] of Object.entries(properties ?? {})) {
      if (!(key in record)) continue;
      if (!child || typeof child !== 'object' || Array.isArray(child)) return 'unverified';
      const status = validateResultSchema(record[key], child, depth + 1);
      if (status !== 'passed') return status;
    }
  } else if (type === 'array') {
    if (!Array.isArray(value)) return 'failed';
    if (typeof schema.minItems === 'number' && value.length < schema.minItems || typeof schema.maxItems === 'number' && value.length > schema.maxItems) return 'failed';
    if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
      for (const item of value) { const status = validateResultSchema(item, schema.items as Record<string, unknown>, depth + 1); if (status !== 'passed') return status; }
    }
  } else if (type === 'null') { if (value !== null) return 'failed'; }
  else if (type === 'integer') { if (!Number.isInteger(value)) return 'failed'; }
  else if (type === 'string' || type === 'number' || type === 'boolean') { if (typeof value !== type) return 'failed'; }
  else if (type !== undefined) return 'unverified';
  return 'passed';
}

export function evaluateAcceptance(workspaceRoot: string, spec: AcceptanceSpec, evidence: {
  artifactIds?: string[]; checks?: CheckEvidence[]; answer?: string; notBefore?: number; sourceHash?: string;
}): AcceptanceResult {
  const reasons: string[] = []; let failed = false; let unknown = false;
  const checks = evidence.checks ?? [];
  let conditions = 0;
  for (const path of spec.artifacts ?? []) {
    conditions++;
    let present = false;
    try {
      present = existsSync(resolveWithin(workspaceRoot, path));
      if (!present) for (const id of evidence.artifactIds ?? []) {
        const artifact = inspectWorkArtifact(workspaceRoot, id).artifact;
        if (artifact.changedFiles.includes(path) && existsSync(resolveWithin(artifact.worktreePath, path))) { present = true; break; }
      }
    } catch { /* an invalid path or inaccessible artifact is not verified */ }
    if (!present) { failed = true; reasons.push(`Expected artifact missing: ${path}`); }
  }
  for (const command of spec.checks ?? []) {
    conditions++;
    const check = [...checks].reverse().find((candidate) => candidate.command === command && candidate.recordedAt >= (evidence.notBefore ?? 0) && (!evidence.sourceHash || candidate.sourceHash === evidence.sourceHash));
    if (!check || check.exitCode === null || check.aborted || check.timedOut) { unknown = true; reasons.push(`Check is missing, interrupted or timed out: ${command}`); }
    else if (check.exitCode !== 0) { failed = true; reasons.push(`Check exited ${check.exitCode}: ${command}`); }
  }
  if (spec.resultSchema) {
    conditions++;
    try {
      const parsed = JSON.parse(evidence.answer ?? '');
      const status = validateResultSchema(parsed, spec.resultSchema);
      if (status === 'failed') { failed = true; reasons.push('Result does not satisfy the declared schema.'); }
      if (status === 'unverified') { unknown = true; reasons.push('Result schema contains unsupported constraints.'); }
    } catch { unknown = true; reasons.push('Result is not valid JSON for the declared schema.'); }
  }
  if (!conditions) { unknown = true; reasons.push('No acceptance conditions declared; model completion alone is not verification.'); }
  if (!failed && !unknown) reasons.push('All declared acceptance conditions have current evidence.');
  return { status: failed ? 'failed' : unknown ? 'unverified' : 'passed', reasons, checks, evaluatedAt: Date.now() };
}
