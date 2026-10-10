import { SkillCandidateStore } from './candidateStore.js';

const REVIEW_ITEM_LIMIT = 32;
const REVIEW_INLINE_LIMIT = 1_024;
const REVIEW_BODY_LIMIT = 16 * 1024;
const REVIEW_BODY_LINE_LIMIT = 240;

function safeInline(value: string, limit = REVIEW_INLINE_LIMIT): string {
  const clean = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

function safeBodyPreview(markdown: string): string[] {
  const clean = markdown
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2028\u2029]/g, '')
    .replace(/\t/g, '  ');
  const clipped = clean.length > REVIEW_BODY_LIMIT ? clean.slice(0, REVIEW_BODY_LIMIT) : clean;
  const sourceLines = clipped.split('\n');
  const lines = sourceLines
    .slice(0, REVIEW_BODY_LINE_LIMIT)
    .map((line) => line.length > REVIEW_INLINE_LIMIT ? `${line.slice(0, REVIEW_INLINE_LIMIT)}…` : line);
  if (clean.length > clipped.length || sourceLines.length > REVIEW_BODY_LINE_LIMIT) {
    lines.push(`… SKILL.md preview truncated (${Buffer.byteLength(markdown, 'utf8')} bytes total)`);
  }
  return lines;
}

function boundedItems<T>(items: T[]): { shown: T[]; omitted: number } {
  return {
    shown: items.slice(0, REVIEW_ITEM_LIMIT),
    omitted: Math.max(0, items.length - REVIEW_ITEM_LIMIT),
  };
}

function safeRefs(refs: string[]): string {
  const shown = refs.slice(0, 16).map((ref) => safeInline(ref, 128));
  return `${shown.join(', ')}${refs.length > shown.length ? `, … +${refs.length - shown.length}` : ''}`;
}

function actorName(): string {
  return process.env.USER || process.env.USERNAME || 'local-operator';
}

export function pendingSkillLines(store = new SkillCandidateStore()): string[] {
  const candidates = store.listCandidates({ statuses: ['draft'] });
  if (candidates.length === 0) return ['No learned-skill candidates.'];
  return candidates.map(
    (candidate) =>
      `${candidate.name} v${candidate.version} [${candidate.status}] — ${candidate.rationale}`,
  );
}

export function inspectSkillCandidateLines(name: string, store = new SkillCandidateStore()): string[] {
  const candidate = store.inspectCandidate(name);
  const report = store.validateCandidate(name, candidate.version);
  const lines = [
    `${candidate.name} v${candidate.version} [${candidate.status}]`,
    `rationale: ${safeInline(candidate.rationale, 2_048)}`,
    `digest: ${candidate.contentDigest}`,
    `claims: ${candidate.claims.length} · evidence: ${candidate.evidence.length} · verification results: ${candidate.verificationResults.length}`,
    report.activationReady
      ? 'activation: ready for explicit operator activation'
      : `activation: blocked — ${report.activationIssues.map((issue) => issue.message).join(' ') || report.issues.map((issue) => issue.message).join(' ')}`,
  ];

  if (candidate.source) {
    lines.push('', 'source:');
    if (candidate.source.sessionId) lines.push(`  session: ${safeInline(candidate.source.sessionId, 256)}`);
    if (candidate.source.turnIds?.length) lines.push(`  turns: ${safeRefs(candidate.source.turnIds)}`);
    if (candidate.source.workflow) lines.push(`  workflow: ${safeInline(candidate.source.workflow)}`);
  }

  const claims = boundedItems(candidate.claims);
  lines.push('', 'claims:');
  for (const claim of claims.shown) {
    lines.push(`  [${safeInline(claim.id, 128)}] ${safeInline(claim.statement)}`);
    lines.push(`    evidence: ${safeRefs(claim.evidenceRefs)}`);
  }
  if (claims.omitted) lines.push(`  … ${claims.omitted} more claim(s) omitted`);

  const evidence = boundedItems(candidate.evidence);
  lines.push('', 'evidence:');
  for (const item of evidence.shown) {
    lines.push(`  [${safeInline(item.id, 128)}] ${safeInline(item.kind, 64)} · ${safeInline(item.capturedAt, 64)}`);
    lines.push(`    reference: ${safeInline(item.reference)}`);
    lines.push(`    summary: ${safeInline(item.summary)}`);
    if (item.digest) lines.push(`    digest: ${item.digest}`);
  }
  if (evidence.omitted) lines.push(`  … ${evidence.omitted} more evidence item(s) omitted`);

  const receipts = boundedItems(candidate.verificationResults);
  lines.push('', 'verification receipts:');
  for (const receipt of receipts.shown) {
    lines.push(
      `  [${safeInline(receipt.id, 128)}] ${receipt.passed ? 'PASS' : 'FAIL'} ${safeInline(receipt.kind, 64)} · ` +
        `${safeInline(receipt.validator, 256)} · ${safeInline(receipt.completedAt, 64)}`,
    );
    lines.push(`    evidence: ${safeRefs(receipt.evidenceRefs)}`);
    lines.push(`    summary: ${safeInline(receipt.summary)}`);
    lines.push(`    result digest: ${receipt.resultDigest}`);
  }
  if (receipts.omitted) lines.push(`  … ${receipts.omitted} more verification receipt(s) omitted`);

  lines.push('', 'SKILL.md preview:', ...safeBodyPreview(candidate.skillMarkdown).map((line) => `  ${line}`));
  return lines;
}

export function validateSkillCandidateLines(name: string, store = new SkillCandidateStore()): string[] {
  const candidate = store.inspectCandidate(name);
  const report = store.validateCandidate(name, candidate.version);
  return [
    `${name} v${candidate.version}: ${report.valid ? 'structurally valid' : 'invalid'}; ` +
      `${report.activationReady ? 'activation ready' : 'activation blocked'}`,
    ...report.issues.map((issue) => `${issue.code}: ${issue.message}`),
    ...report.activationIssues.map((issue) => `${issue.code}: ${issue.message}`),
  ];
}

export function activateSkillCandidate(name: string, store = new SkillCandidateStore()): string {
  const candidate = store.inspectCandidate(name);
  const active = store.readActiveSkill(name);
  const result = store.activateCandidate(name, {
    expectedVersion: candidate.version,
    approvedBy: actorName(),
    confirmation: 'activate',
    expectedActiveGeneration: active?.generation ?? 0,
  });
  return `Activated ${name} generation ${result.active.generation}. Start a new session to advertise it in the skill catalog.`;
}

export function rejectSkillCandidate(name: string, reason: string, store = new SkillCandidateStore()): string {
  if (!reason.trim()) throw new Error('reject requires a reason.');
  const candidate = store.inspectCandidate(name);
  const rejected = store.rejectCandidate(name, {
    expectedVersion: candidate.version,
    by: actorName(),
    reason: reason.trim(),
  });
  return `Rejected ${name} candidate v${rejected.version}.`;
}

export function rollbackActiveSkill(name: string, targetGeneration: number, store = new SkillCandidateStore()): string {
  const active = store.readActiveSkill(name);
  if (!active) throw new Error(`Active skill "${name}" was not found.`);
  const restored = store.rollbackActiveSkill(name, {
    expectedGeneration: active.generation,
    targetGeneration,
    approvedBy: actorName(),
    confirmation: 'rollback',
  });
  return `Rolled ${name} back to archived generation ${targetGeneration}; active generation is now ${restored.generation}. Start a new session to load it.`;
}
