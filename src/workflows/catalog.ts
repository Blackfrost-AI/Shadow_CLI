import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { collaborationSchema, type CollaborationInput } from '../agent/collaboration.js';
import { resolveWithin } from '../safety/workspaceJail.js';
import { redactString } from '../util/redact.js';

const name = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
export const workflowSchema = z.object({
  version: z.literal(1), id: name, title: z.string().min(1).max(120), description: z.string().max(1000).default(''),
  parameters: z.record(name, z.object({ description: z.string().max(500), required: z.boolean().default(true),
    default: z.string().max(8000).optional(), choices: z.array(z.string().max(1000)).min(1).max(30).optional() }).strict()).default({}),
  task: z.string().min(1).max(32000), preset: collaborationSchema.shape.preset.default('second-opinion'),
  profiles: z.array(z.string().min(1).max(100)).max(4).optional(),
  steps: z.array(z.object({ task: z.string().min(1).max(16000), role: z.string().optional(), profile: z.string().optional() }).strict()).max(4).optional(),
  checks: z.array(z.string().min(1).max(4000)).max(4).default([]),
  expectedArtifacts: z.array(z.string().min(1).max(500)).max(20).default([]),
  deadlineSeconds: z.number().int().min(5).max(1800).default(300), maxTokens: z.number().int().min(1).max(1_000_000).default(100_000),
  concurrency: z.number().int().min(1).max(3).default(2),
}).strict();
export type Workflow = z.infer<typeof workflowSchema>;
export interface WorkflowEntry { workflow: Workflow; source: string; digest: string }
export interface WorkflowReference { path: string; label: string }
export interface WorkflowCatalog { entries: WorkflowEntry[]; references: WorkflowReference[]; errors: string[] }
export interface PreparedWorkflow { entry: WorkflowEntry; values: Record<string, string>; input: CollaborationInput; digest: string; preview: string }

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function validateExecutionContract(workflow: Workflow): void {
  if (workflow.preset === 'pipeline' && !workflow.steps?.length) throw new Error('Pipeline workflows require one to four explicit steps before they can be previewed or launched.');
  if (workflow.preset !== 'implement-review' && (workflow.checks.length || workflow.expectedArtifacts.length)) {
    throw new Error('Workflow checks and expectedArtifacts currently require preset implement-review. Other presets do not execute an acceptance stage; remove those fields or choose implement-review.');
  }
}
function checked(value: unknown, source: string, bytes?: string): WorkflowEntry {
  const workflow = workflowSchema.parse(value);
  validateExecutionContract(workflow);
  // Inputs are prompt data, never command fragments. Checks/artifact paths are static.
  for (const command of [...workflow.checks, ...workflow.expectedArtifacts]) {
    if (/\{\{/.test(command)) throw new Error('Checks and artifact paths cannot contain parameter substitutions.');
  }
  for (const path of workflow.expectedArtifacts) {
    if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split(/[\\/]/).includes('..')) throw new Error('Artifact paths must stay inside the workspace.');
  }
  return { workflow, source, digest: hash(bytes ?? JSON.stringify(workflow)) };
}
const BUILTINS = [
  { id: 'repository-review', title: 'Repository review', description: 'Read-only review with evidence and verification limits.', preset: 'second-opinion', task: 'Review {{scope}}. Identify concrete bugs and security concerns. Cite files and evidence; separate hypotheses from verified results. Do not modify files.' },
  { id: 'release-readiness', title: 'Release readiness', description: 'Inspect release preparation without publishing.', preset: 'second-opinion', task: 'Assess release readiness for {{scope}}. Inspect changes, existing test evidence, documentation and release configuration. Report blockers and unverified checks. Do not publish or alter version numbers.' },
  { id: 'configuration-audit', title: 'Configuration audit', description: 'Inspect configuration and privacy boundaries.', preset: 'second-opinion', task: 'Audit {{scope}} for configuration errors, exposed secrets and unintended network behavior. Do not reveal secret values. Cite evidence and propose scoped corrections without changing configuration.' },
  { id: 'log-triage', title: 'Log triage', description: 'Investigate local logs with evidence and redaction.', preset: 'second-opinion', task: 'Triage {{scope}}. Identify failures, a supported timeline and likely causes. Distinguish observations from hypotheses. Redact secrets and do not modify logs or restart processes.' },
] as const;

/** Explicit roots only. JSON is data; discovery never executes code or makes requests. */
export function discoverWorkflows(roots: Array<{ label: string; dir: string }>): WorkflowCatalog {
  const entries: WorkflowEntry[] = []; const references: WorkflowReference[] = []; const errors: string[] = []; const ids = new Set<string>();
  for (const root of roots) {
    let files: string[];
    try { files = readdirSync(root.dir).filter((file) => /\.(json|md)$/i.test(file)).sort().slice(0, 100); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(`${root.label}: ${(error as Error).message}`); continue; }
    for (const file of files) {
      try {
        const path = resolveWithin(root.dir, file);
        if (!statSync(path).isFile() || statSync(path).size > 256 * 1024) throw new Error('Workflow must be a JSON manifest or Markdown reference under 256 KiB.');
        if (/\.md$/i.test(file)) { references.push({ path, label: `${root.label}/${file}` }); continue; }
        const bytes = readFileSync(path, 'utf8'); const entry = checked(JSON.parse(bytes), path, bytes);
        if (ids.has(entry.workflow.id)) { errors.push(`${root.label}/${file}: duplicate id ${entry.workflow.id}; earlier source takes precedence.`); continue; }
        ids.add(entry.workflow.id); entries.push(entry);
      } catch (error) { errors.push(`${root.label}/${file}: ${(error as Error).message}`); }
    }
  }
  for (const builtin of BUILTINS) if (!ids.has(builtin.id)) entries.push(checked({ version: 1, ...builtin,
    parameters: { scope: { description: 'Files, directory, or investigation scope', default: 'the current workspace' } } }, `builtin:${builtin.id}`));
  return { entries, references, errors };
}

export function prepareWorkflow(entry: WorkflowEntry, supplied: Record<string, string>, workspace: string): PreparedWorkflow {
  const w = entry.workflow; const values: Record<string, string> = {};
  validateExecutionContract(w);
  for (const key of Object.keys(supplied)) if (!Object.hasOwn(w.parameters, key)) throw new Error(`Unknown workflow input: ${key}`);
  for (const [key, param] of Object.entries(w.parameters)) {
    const value = supplied[key] ?? param.default ?? '';
    if (typeof value !== 'string' || value.length > 8000 || /[\0\x1b]/.test(value)) throw new Error(`Invalid workflow input: ${key}`);
    if (param.required && !value.trim()) throw new Error(`Missing required input: ${key} (${param.description})`);
    if (param.choices && !param.choices.includes(value)) throw new Error(`${key} must be one of: ${param.choices.join(', ')}`);
    values[key] = value;
  }
  const expand = (text: string): string => text.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => {
    if (!Object.hasOwn(values, key)) throw new Error(`Unknown template parameter: ${key}`);
    return values[key]!;
  });
  for (const path of w.expectedArtifacts) resolveWithin(workspace, path);
  const input = collaborationSchema.parse({ preset: w.preset, prompt: expand(w.task), profiles: w.profiles,
    steps: w.steps?.map((step) => ({ ...step, task: expand(step.task) })), checks: w.checks, expectedArtifacts: w.expectedArtifacts,
    deadlineSeconds: w.deadlineSeconds, maxTokens: w.maxTokens, concurrency: w.concurrency });
  const digest = hash(JSON.stringify({ sourceDigest: entry.digest, input, values }));
  const preview = redactString([
    w.title, w.description, `Source: ${entry.source}`, `Source SHA-256: ${entry.digest}`, `Run SHA-256: ${digest}`,
    `Preset: ${w.preset}`, `Profiles: ${w.profiles?.join(', ') || 'current profile'}`,
    `Limits: ${w.deadlineSeconds}s · ${w.maxTokens} tokens · concurrency ${w.concurrency}`,
    'Permissions: current Shadow tool gates. Outputs/worktrees are retained for review.',
    w.preset === 'implement-review' ? 'Repair: at most one repair after failed checks, within the shared budget.' : 'Retries: no automatic workflow replay; incomplete steps remain inspectable.',
    `Inputs: ${JSON.stringify(values, null, 2)}`, `Task:\n${input.prompt}`,
    ...(input.steps ?? []).map((step, i) => `Step ${i + 1}: ${step.task}`),
    `Checks: ${w.checks.join('\n') || '(none — acceptance may be unverified)'}`,
    `Expected artifacts: ${w.expectedArtifacts.join(', ') || '(none declared)'}`,
    'Preview has made no model/tool calls. Run explicitly to begin.',
  ].join('\n\n'));
  return { entry, input, values, digest, preview };
}

export function assertWorkflowUnchanged(prepared: PreparedWorkflow): void {
  if (!prepared.entry.source.startsWith('builtin:') && hash(readFileSync(prepared.entry.source, 'utf8')) !== prepared.entry.digest) {
    throw new Error('Workflow changed after preview. Reopen it before running.');
  }
}

export function workflowRoots(workspace: string, globalDir: string, pluginDirs: string[]): Array<{ label: string; dir: string }> {
  return [{ label: 'workspace', dir: join(workspace, '.shadow', 'workflows') }, ...pluginDirs.map((dir) => ({ label: `plugin:${basename(dirname(dir))}`, dir })), { label: 'global', dir: join(globalDir, 'workflows') }];
}
