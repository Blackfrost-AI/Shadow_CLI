import { z } from 'zod';
import { EvidenceStore, currentFindingRetest, findingInputSchema } from '../security/evidence.js';
import type { ProjectCheckStore } from '../checks/store.js';
import { fail, ok, type Tool } from './types.js';

const schema = z.object({
  action: z.enum(['list', 'show', 'scope', 'import', 'record', 'update', 'attach', 'retest', 'export']),
  id: z.string().optional(), path: z.string().optional(), note: z.string().max(16000).optional(),
  status: z.enum(['open', 'triaged', 'remediated', 'accepted']).optional(), finding: findingInputSchema.optional(), checkId: z.string().optional(),
}).strict();
export function makeSecurityFindingsTool(checks?: (workspaceRoot: string) => ProjectCheckStore): Tool<z.infer<typeof schema>> {
  return {
  name: 'security_findings', risk: 'write', deferred: true,
  searchAliases: [
    'security', 'finding', 'findings', 'vuln', 'vulnerability', 'vulnerabilities', 'bug',
    'issue', 'evidence', 'sarif', 'report', 'triage', 'remediation', 'remediate', 'retest',
    'verify', 'verification', 'cve', 'risk', 'assessment', 'audit', 'compliance', 'export',
    'import', 'track', 'tracking',
  ],
  inputSchema: schema,
  description: 'Manage a local security evidence workspace. Import SARIF 2.1.0 or finding JSON, record scoped observations, attach redacted local text evidence, track remediation and retest using a current project_checks run id from this session, or export a local Markdown report. Never scans targets, executes commands or sends data. Historical/imported JSON check results cannot verify a finding. Verified requires a current recorded passed check; findings remain claims with evidence limitations.',
  async run(input, ctx) {
    if (ctx.dryRun && !['list', 'show'].includes(input.action)) return ok('security_findings', 'write', 0, `Dry run: would ${input.action} local security evidence.`);
    let store: EvidenceStore | undefined;
    try {
      ctx.signal?.throwIfAborted();
      store = new EvidenceStore(ctx.workspaceRoot);
      const require = (value: string | undefined, name: string): string => { if (!value) throw new Error(`${input.action} requires ${name}.`); return value; };
      let data: unknown;
      switch (input.action) {
        case 'list': data = store.list(); break;
        case 'show': data = store.get(require(input.id, 'id')); break;
        case 'scope': data = store.scope(input.note); break;
        case 'import': data = store.importFile(require(input.path, 'path')); break;
        case 'record': if (!input.finding) throw new Error('record requires finding.'); data = store.importFindings([input.finding]); break;
        case 'update': if (!input.status) throw new Error('update requires status.'); data = store.update(require(input.id, 'id'), input.status, require(input.note, 'note')); break;
        case 'attach': data = store.attach(require(input.id, 'id'), require(input.path, 'path'), input.note ?? ''); break;
        case 'retest': {
          if (!checks) throw new Error('Retest requires the live project check registry. Run /checks in this Shadow session.');
          data = store.retest(require(input.id, 'id'), currentFindingRetest(checks(ctx.workspaceRoot), require(input.checkId, 'checkId'))); break;
        }
        case 'export': data = { path: store.exportReport() }; break;
      }
      return ok('security_findings', 'write', 0, JSON.stringify(data, null, 2).slice(0, 24000), data);
    } catch (error) { return fail('security_findings', 'write', 0, 'evidence_error', (error as Error).message); }
    finally { store?.close(); }
  },
  };
}
