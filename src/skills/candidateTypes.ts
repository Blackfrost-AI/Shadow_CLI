/**
 * Durable types for learned-skill candidates.
 *
 * Candidates are deliberately separate from active skills. A model may help compose a
 * `DraftSkillCandidateInput`, but the input type has no status or activation field and the
 * store ignores unknown properties. Promotion is only possible through the explicit
 * `activateCandidate()` API and its caller-supplied approval receipt.
 */

export const SKILL_CANDIDATE_SCHEMA_VERSION = 1 as const;

export type SkillCandidateStatus = 'draft' | 'activated' | 'rejected' | 'archived';
export type SkillEvidenceKind = 'session' | 'artifact' | 'test' | 'review' | 'other';
export type SkillVerificationKind = 'validation' | 'replay';

export interface SkillEvidenceReference {
  /** Candidate-local stable identifier used by claims and verification results. */
  id: string;
  kind: SkillEvidenceKind;
  /** Opaque local locator. The candidate store never opens it or sends it anywhere. */
  reference: string;
  summary: string;
  capturedAt: string;
  /** Optional SHA-256 of an immutable evidence artifact. */
  digest?: string;
}

export interface SkillClaim {
  id: string;
  statement: string;
  /** Evidence supporting this specific reusable claim. */
  evidenceRefs: string[];
}

export interface SkillVerificationResult {
  id: string;
  kind: SkillVerificationKind;
  passed: boolean;
  summary: string;
  validator: string;
  completedAt: string;
  /** Evidence exercised or inspected by this validation/replay. */
  evidenceRefs: string[];
  /** SHA-256 of the result, receipt, or replay output. */
  resultDigest: string;
}

export interface SkillCandidateSource {
  sessionId?: string;
  turnIds?: string[];
  workflow?: string;
}

export interface SkillCandidateDecision {
  kind: 'activated' | 'rejected' | 'archived';
  by: string;
  at: string;
  reason?: string;
  activeGeneration?: number;
}

export interface SkillCandidateSnapshot {
  schemaVersion: typeof SKILL_CANDIDATE_SCHEMA_VERSION;
  name: string;
  version: number;
  status: SkillCandidateStatus;
  rationale: string;
  skillMarkdown: string;
  contentDigest: string;
  claims: SkillClaim[];
  evidence: SkillEvidenceReference[];
  verificationResults: SkillVerificationResult[];
  source?: SkillCandidateSource;
  createdAt: string;
  updatedAt: string;
  decision?: SkillCandidateDecision;
}

type EvidenceInput = Omit<SkillEvidenceReference, 'capturedAt'> & { capturedAt?: string };
type VerificationInput = Omit<SkillVerificationResult, 'completedAt'> & { completedAt?: string };

export interface DraftSkillCandidateInput {
  name: string;
  rationale: string;
  skillMarkdown: string;
  claims?: SkillClaim[];
  evidence?: EvidenceInput[];
  verificationResults?: VerificationInput[];
  source?: SkillCandidateSource;
}

export interface UpdateSkillCandidateInput {
  rationale?: string;
  skillMarkdown?: string;
  claims?: SkillClaim[];
  evidence?: EvidenceInput[];
  verificationResults?: VerificationInput[];
  source?: SkillCandidateSource;
}

export interface CandidateDecisionInput {
  expectedVersion: number;
  by: string;
  reason: string;
}

/** The literal confirmation cannot be supplied through candidate content. */
export interface SkillActivationApproval {
  expectedVersion: number;
  approvedBy: string;
  confirmation: 'activate';
  /** Optional optimistic guard when replacing an already active managed skill. */
  expectedActiveGeneration?: number;
}

/** The literal confirmation makes rollback a distinct, explicit caller action too. */
export interface SkillRollbackApproval {
  expectedGeneration: number;
  targetGeneration: number;
  approvedBy: string;
  confirmation: 'rollback';
}

export interface ActiveSkillRecord {
  schemaVersion: 1;
  name: string;
  generation: number;
  contentDigest: string;
  candidateVersion: number;
  activatedAt: string;
  approvedBy: string;
  claimIds: string[];
  evidenceRefs: string[];
  verificationResultIds: string[];
  restoredFromGeneration?: number;
}

export interface ActiveSkill extends ActiveSkillRecord {
  skillMarkdown: string;
}

export interface SkillCandidateSummary {
  name: string;
  version: number;
  status: SkillCandidateStatus;
  rationale: string;
  updatedAt: string;
  contentDigest: string;
}

export interface SkillValidationIssue {
  code: string;
  message: string;
}

export interface SkillValidationReport {
  valid: boolean;
  activationReady: boolean;
  issues: SkillValidationIssue[];
  activationIssues: SkillValidationIssue[];
}
