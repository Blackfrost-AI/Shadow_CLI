import { createHash } from 'node:crypto';
import {
  SKILL_CANDIDATE_SCHEMA_VERSION,
  type SkillCandidateSnapshot,
  type SkillValidationIssue,
  type SkillValidationReport,
} from './candidateTypes.js';

export const MAX_SKILL_CANDIDATE_BYTES = 256 * 1024;
export const MAX_CANDIDATE_METADATA_BYTES = 512 * 1024;

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2028\u2029]/;
const STATUSES = new Set(['draft', 'activated', 'rejected', 'archived']);
const EVIDENCE_KINDS = new Set(['session', 'artifact', 'test', 'review', 'other']);
const VERIFICATION_KINDS = new Set(['validation', 'replay']);

export function isSafeSkillName(name: unknown): name is string {
  return typeof name === 'string' && SAFE_ID.test(name);
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function cleanText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !CONTROL.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unquoteYamlScalar(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  if (/^[!&*{[]/.test(value)) return null;
  return value.replace(/\s+#.*$/, '').trim() || null;
}

function parseSkillFrontmatter(markdown: string): { name: string | null; description: string | null; body: string } | null {
  const front = markdown.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!front || Buffer.byteLength(front[1]!, 'utf8') > 16 * 1024) return null;
  const lines = front[1]!.split(/\r?\n/);
  const scalars = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1]!;
    let raw = match[2]!.trim();
    if (scalars.has(key)) return null;
    if (key === 'description' && /^[>|][+-]?$/.test(raw)) {
      const parts: string[] = [];
      for (const line of lines.slice(i + 1)) {
        if (line.trim() && !/^\s/.test(line)) break;
        parts.push(line.trim());
      }
      raw = parts.join(' ').trim();
    }
    const scalar = unquoteYamlScalar(raw);
    if (scalar !== null) scalars.set(key, scalar);
  }
  return {
    name: scalars.get('name') ?? null,
    description: scalars.get('description') ?? null,
    body: markdown.slice(front[0].length),
  };
}

export function validateSkillMarkdown(name: string, markdown: string): SkillValidationIssue[] {
  const issues: SkillValidationIssue[] = [];
  const bytes = typeof markdown === 'string' ? Buffer.byteLength(markdown, 'utf8') : 0;
  if (typeof markdown !== 'string' || bytes === 0) {
    issues.push({ code: 'skill.empty', message: 'SKILL.md content is required.' });
    return issues;
  }
  if (bytes > MAX_SKILL_CANDIDATE_BYTES) {
    issues.push({ code: 'skill.too_large', message: `SKILL.md exceeds ${MAX_SKILL_CANDIDATE_BYTES} bytes.` });
  }
  if (markdown.includes('\0')) issues.push({ code: 'skill.nul', message: 'SKILL.md contains a NUL byte.' });
  const front = parseSkillFrontmatter(markdown);
  if (!front) {
    issues.push({ code: 'skill.frontmatter', message: 'SKILL.md needs simple YAML frontmatter.' });
    return issues;
  }
  if (front.name !== name) {
    issues.push({ code: 'skill.name_mismatch', message: `Frontmatter name must exactly match "${name}".` });
  }
  if (!front.description || front.description.length > 1024 || CONTROL.test(front.description)) {
    issues.push({ code: 'skill.description', message: 'Frontmatter description must be a safe, non-empty scalar.' });
  }
  if (!front.body.trim()) issues.push({ code: 'skill.body', message: 'SKILL.md needs an instruction body.' });
  return issues;
}

function duplicateIds(items: Array<{ id: string }>): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) duplicates.add(item.id);
    seen.add(item.id);
  }
  return [...duplicates];
}

/** Structural checks are deterministic and local. They do not claim the skill is correct. */
export function validateCandidateStructure(candidate: SkillCandidateSnapshot): SkillValidationIssue[] {
  const issues = validateSkillMarkdown(candidate.name, candidate.skillMarkdown);
  if (candidate.schemaVersion !== SKILL_CANDIDATE_SCHEMA_VERSION) {
    issues.push({ code: 'candidate.schema', message: 'Unsupported candidate schema version.' });
  }
  if (!isSafeSkillName(candidate.name)) {
    issues.push({ code: 'candidate.name', message: 'Candidate name must be a lowercase filesystem-safe slug.' });
  }
  if (!Number.isSafeInteger(candidate.version) || candidate.version < 1) {
    issues.push({ code: 'candidate.version', message: 'Candidate version must be a positive integer.' });
  }
  if (!STATUSES.has(candidate.status)) issues.push({ code: 'candidate.status', message: 'Unknown candidate status.' });
  if (!cleanText(candidate.rationale, 4096)) {
    issues.push({ code: 'candidate.rationale', message: 'Candidate rationale is required and limited to 4096 characters.' });
  }
  if (!isIsoDate(candidate.createdAt) || !isIsoDate(candidate.updatedAt)) {
    issues.push({ code: 'candidate.timestamp', message: 'Candidate timestamps must be canonical ISO-8601 values.' });
  }
  if (!SHA256.test(candidate.contentDigest) || candidate.contentDigest !== sha256Text(candidate.skillMarkdown)) {
    issues.push({ code: 'candidate.digest', message: 'Candidate content digest does not match SKILL.md.' });
  }
  if (!Array.isArray(candidate.claims) || candidate.claims.length > 128) {
    issues.push({ code: 'claims.shape', message: 'Claims must be an array with at most 128 entries.' });
  }
  if (!Array.isArray(candidate.evidence) || candidate.evidence.length > 256) {
    issues.push({ code: 'evidence.shape', message: 'Evidence must be an array with at most 256 entries.' });
  }
  if (!Array.isArray(candidate.verificationResults) || candidate.verificationResults.length > 128) {
    issues.push({ code: 'verification.shape', message: 'Verification results must be an array with at most 128 entries.' });
  }
  if (issues.some((issue) => issue.code.endsWith('.shape'))) return issues;

  const validEvidence = candidate.evidence.filter((item) => isRecord(item)) as typeof candidate.evidence;
  const evidenceIds = new Set(validEvidence.map((item) => item.id));
  if (validEvidence.length !== candidate.evidence.length) {
    issues.push({ code: 'evidence.entry', message: 'Every evidence entry must be an object.' });
  }
  for (const duplicate of duplicateIds(validEvidence)) {
    issues.push({ code: 'evidence.duplicate', message: `Duplicate evidence id "${duplicate}".` });
  }
  for (const item of validEvidence) {
    if (!isSafeSkillName(item.id)) issues.push({ code: 'evidence.id', message: `Invalid evidence id "${item.id}".` });
    if (!EVIDENCE_KINDS.has(item.kind)) issues.push({ code: 'evidence.kind', message: `Invalid evidence kind for "${item.id}".` });
    if (!cleanText(item.reference, 4096) || !cleanText(item.summary, 4096)) {
      issues.push({ code: 'evidence.text', message: `Evidence "${item.id}" needs a safe reference and summary.` });
    }
    if (!isIsoDate(item.capturedAt)) issues.push({ code: 'evidence.timestamp', message: `Evidence "${item.id}" has an invalid timestamp.` });
    if (item.digest !== undefined && !SHA256.test(item.digest)) {
      issues.push({ code: 'evidence.digest', message: `Evidence "${item.id}" has an invalid SHA-256 digest.` });
    }
  }

  const validClaims = candidate.claims.filter((item) => isRecord(item)) as typeof candidate.claims;
  if (validClaims.length !== candidate.claims.length) {
    issues.push({ code: 'claims.entry', message: 'Every claim entry must be an object.' });
  }
  for (const duplicate of duplicateIds(validClaims)) {
    issues.push({ code: 'claims.duplicate', message: `Duplicate claim id "${duplicate}".` });
  }
  for (const claim of validClaims) {
    if (!isSafeSkillName(claim.id)) issues.push({ code: 'claims.id', message: `Invalid claim id "${claim.id}".` });
    if (!cleanText(claim.statement, 4096)) issues.push({ code: 'claims.statement', message: `Claim "${claim.id}" needs a safe statement.` });
    if (!Array.isArray(claim.evidenceRefs) || claim.evidenceRefs.length === 0) {
      issues.push({ code: 'claims.evidence', message: `Claim "${claim.id}" needs at least one evidence reference.` });
    } else {
      for (const ref of claim.evidenceRefs) {
        if (!evidenceIds.has(ref)) issues.push({ code: 'claims.evidence_missing', message: `Claim "${claim.id}" references unknown evidence "${ref}".` });
      }
    }
  }

  const validResults = candidate.verificationResults.filter((item) => isRecord(item)) as typeof candidate.verificationResults;
  if (validResults.length !== candidate.verificationResults.length) {
    issues.push({ code: 'verification.entry', message: 'Every verification result must be an object.' });
  }
  for (const duplicate of duplicateIds(validResults)) {
    issues.push({ code: 'verification.duplicate', message: `Duplicate verification id "${duplicate}".` });
  }
  for (const result of validResults) {
    if (!isSafeSkillName(result.id)) issues.push({ code: 'verification.id', message: `Invalid verification id "${result.id}".` });
    if (!VERIFICATION_KINDS.has(result.kind)) issues.push({ code: 'verification.kind', message: `Invalid verification kind for "${result.id}".` });
    if (typeof result.passed !== 'boolean') {
      issues.push({ code: 'verification.passed', message: `Verification "${result.id}" needs a boolean pass/fail result.` });
    }
    if (!cleanText(result.summary, 4096) || !cleanText(result.validator, 256)) {
      issues.push({ code: 'verification.text', message: `Verification "${result.id}" needs a safe validator and summary.` });
    }
    if (!isIsoDate(result.completedAt)) issues.push({ code: 'verification.timestamp', message: `Verification "${result.id}" has an invalid timestamp.` });
    if (!SHA256.test(result.resultDigest)) issues.push({ code: 'verification.digest', message: `Verification "${result.id}" needs a SHA-256 result digest.` });
    if (!Array.isArray(result.evidenceRefs) || result.evidenceRefs.length === 0) {
      issues.push({ code: 'verification.evidence', message: `Verification "${result.id}" needs evidence references.` });
    } else {
      for (const ref of result.evidenceRefs) {
        if (!evidenceIds.has(ref)) issues.push({ code: 'verification.evidence_missing', message: `Verification "${result.id}" references unknown evidence "${ref}".` });
      }
    }
  }

  if (candidate.source !== undefined) {
    if (!isRecord(candidate.source)) {
      issues.push({ code: 'source.shape', message: 'Candidate source must be an object.' });
    } else {
      if (candidate.source.sessionId !== undefined && !cleanText(candidate.source.sessionId, 256)) {
        issues.push({ code: 'source.session', message: 'Source session id must be a safe string.' });
      }
      if (candidate.source.workflow !== undefined && !cleanText(candidate.source.workflow, 1024)) {
        issues.push({ code: 'source.workflow', message: 'Source workflow must be a safe string.' });
      }
      if (
        candidate.source.turnIds !== undefined &&
        (!Array.isArray(candidate.source.turnIds) || candidate.source.turnIds.length > 256 ||
          !candidate.source.turnIds.every((turn) => cleanText(turn, 256)))
      ) {
        issues.push({ code: 'source.turns', message: 'Source turn ids must be a bounded array of safe strings.' });
      }
    }
  }

  if (candidate.status === 'draft' && candidate.decision !== undefined) {
    issues.push({ code: 'decision.draft', message: 'A draft candidate cannot carry a lifecycle decision.' });
  }
  if (candidate.status !== 'draft') {
    if (!isRecord(candidate.decision) || candidate.decision.kind !== candidate.status) {
      issues.push({ code: 'decision.missing', message: `A ${candidate.status} candidate needs a matching decision receipt.` });
    } else {
      if (!cleanText(candidate.decision.by, 256) || !isIsoDate(candidate.decision.at)) {
        issues.push({ code: 'decision.receipt', message: 'Candidate decision needs a safe caller and canonical timestamp.' });
      }
      if (candidate.decision.reason !== undefined && !cleanText(candidate.decision.reason, 4096)) {
        issues.push({ code: 'decision.reason', message: 'Candidate decision reason must be a safe, non-empty string.' });
      }
      if (candidate.decision.kind !== 'activated' && !cleanText(candidate.decision.reason, 4096)) {
        issues.push({ code: 'decision.reason_required', message: `${candidate.decision.kind} decision needs a reason.` });
      }
      if (
        candidate.decision.kind === 'activated' &&
        (!Number.isSafeInteger(candidate.decision.activeGeneration) || (candidate.decision.activeGeneration ?? 0) < 1)
      ) {
        issues.push({ code: 'decision.generation', message: 'Activation decision needs a positive active generation.' });
      }
    }
  }
  return issues;
}

export function validateCandidateForActivation(candidate: SkillCandidateSnapshot): SkillValidationIssue[] {
  const issues: SkillValidationIssue[] = [];
  if (candidate.status !== 'draft') {
    issues.push({ code: 'activation.status', message: 'Only a draft candidate can be activated.' });
  }
  if (candidate.evidence.length === 0) {
    issues.push({ code: 'activation.evidence', message: 'Activation requires at least one evidence reference.' });
  }
  if (candidate.claims.length === 0) {
    issues.push({ code: 'activation.claims', message: 'Activation requires at least one evidence-backed reusable claim.' });
  }
  const passed = candidate.verificationResults.filter((result) => result.passed);
  if (passed.length === 0) {
    issues.push({ code: 'activation.verification', message: 'Activation requires a passing validation or replay result.' });
  }
  const verifiedEvidence = new Set(passed.flatMap((result) => result.evidenceRefs));
  for (const claim of candidate.claims) {
    if (!claim.evidenceRefs.some((ref) => verifiedEvidence.has(ref))) {
      issues.push({
        code: 'activation.unverified_claim',
        message: `Claim "${claim.id}" is not linked to evidence used by a passing validation or replay.`,
      });
    }
  }
  return issues;
}

export function validateSkillCandidate(candidate: SkillCandidateSnapshot): SkillValidationReport {
  const issues = validateCandidateStructure(candidate);
  const activationIssues = issues.length === 0 ? validateCandidateForActivation(candidate) : [];
  return {
    valid: issues.length === 0,
    activationReady: issues.length === 0 && activationIssues.length === 0,
    issues,
    activationIssues,
  };
}

export class SkillCandidateValidationError extends Error {
  constructor(public readonly issues: SkillValidationIssue[]) {
    super(issues.map((issue) => issue.message).join(' '));
    this.name = 'SkillCandidateValidationError';
  }
}

export function assertValidCandidate(candidate: SkillCandidateSnapshot): void {
  const issues = validateCandidateStructure(candidate);
  if (issues.length > 0) throw new SkillCandidateValidationError(issues);
}

export function assertCandidateActivationReady(candidate: SkillCandidateSnapshot): void {
  const issues = [...validateCandidateStructure(candidate), ...validateCandidateForActivation(candidate)];
  if (issues.length > 0) throw new SkillCandidateValidationError(issues);
}
