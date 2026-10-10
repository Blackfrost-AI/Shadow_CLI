import { z } from 'zod';
import { SkillCandidateStore } from '../skills/candidateStore.js';
import type { Tool } from './types.js';
import { fail, ok } from './types.js';

const evidenceSchema = z.object({
  id: z.string(),
  kind: z.enum(['session', 'artifact', 'test', 'review', 'other']),
  reference: z.string(),
  summary: z.string(),
  capturedAt: z.string().optional(),
  digest: z.string().optional(),
});

const claimSchema = z.object({
  id: z.string(),
  statement: z.string(),
  evidenceRefs: z.array(z.string()),
});

const verificationSchema = z.object({
  id: z.string(),
  kind: z.enum(['validation', 'replay']),
  passed: z.boolean(),
  summary: z.string(),
  validator: z.string(),
  completedAt: z.string().optional(),
  evidenceRefs: z.array(z.string()),
  resultDigest: z.string(),
});

const sourceSchema = z.object({
  sessionId: z.string().optional(),
  turnIds: z.array(z.string()).optional(),
  workflow: z.string().optional(),
});

const inputSchema = z.object({
  action: z.enum(['draft', 'update', 'list', 'inspect', 'validate']),
  name: z.string().optional(),
  expectedVersion: z.number().int().positive().optional(),
  rationale: z.string().optional(),
  skillMarkdown: z.string().optional(),
  claims: z.array(claimSchema).optional(),
  evidence: z.array(evidenceSchema).optional(),
  verificationResults: z.array(verificationSchema).optional(),
  source: sourceSchema.optional(),
});

type SkillManageInput = z.infer<typeof inputSchema>;

/**
 * Host-mediated authoring surface. Deliberately excludes activate/reject/rollback: a model can
 * prepare and validate a candidate, but only an explicit local user command may change the active
 * skill catalog.
 */
export function makeSkillManageTool(store = new SkillCandidateStore()): Tool<SkillManageInput, unknown> {
  return {
    name: 'skill_manage',
    description:
      'Draft, update, inspect, list, or validate an evidence-backed learned-skill candidate. ' +
      'This tool cannot activate a skill. Link every reusable claim to local evidence and a ' +
      'passing validation or replay; the user reviews and activates candidates explicitly.',
    risk: 'write',
    inputSchema,
    async run(input) {
      const start = Date.now();
      try {
        if (input.action === 'list') {
          const candidates = store.listCandidates();
          return ok('skill_manage', 'write', Date.now() - start, `${candidates.length} learned-skill candidate(s).`, { candidates });
        }
        const name = input.name?.trim();
        if (!name) return fail('skill_manage', 'write', Date.now() - start, 'invalid_input', `${input.action} requires name.`);
        if (input.action === 'inspect') {
          const candidate = store.inspectCandidate(name, input.expectedVersion);
          return ok('skill_manage', 'write', Date.now() - start, `Candidate ${name} v${candidate.version} (${candidate.status}).`, { candidate });
        }
        if (input.action === 'validate') {
          const report = store.validateCandidate(name, input.expectedVersion);
          return ok(
            'skill_manage',
            'write',
            Date.now() - start,
            report.activationReady ? `Candidate ${name} is ready for user activation.` : `Candidate ${name} is not activation-ready.`,
            { report },
          );
        }
        if (input.action === 'draft') {
          if (!input.rationale || !input.skillMarkdown) {
            return fail('skill_manage', 'write', Date.now() - start, 'invalid_input', 'draft requires rationale and skillMarkdown.');
          }
          const candidate = store.draftCandidate({
            name,
            rationale: input.rationale,
            skillMarkdown: input.skillMarkdown,
            claims: input.claims,
            evidence: input.evidence,
            verificationResults: input.verificationResults,
            source: input.source,
          });
          return ok('skill_manage', 'write', Date.now() - start, `Drafted learned-skill candidate ${name} v${candidate.version}.`, { candidate });
        }
        if (input.expectedVersion == null) {
          return fail('skill_manage', 'write', Date.now() - start, 'invalid_input', 'update requires expectedVersion.');
        }
        const candidate = store.updateCandidate(name, input.expectedVersion, {
          rationale: input.rationale,
          skillMarkdown: input.skillMarkdown,
          claims: input.claims,
          evidence: input.evidence,
          verificationResults: input.verificationResults,
          source: input.source,
        });
        return ok('skill_manage', 'write', Date.now() - start, `Updated learned-skill candidate ${name} to v${candidate.version}.`, { candidate });
      } catch (error) {
        return fail('skill_manage', 'write', Date.now() - start, 'candidate_error', (error as Error).message);
      }
    },
  };
}
