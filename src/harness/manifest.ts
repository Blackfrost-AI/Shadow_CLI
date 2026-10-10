import { z } from 'zod';
import { canonicalToolName } from '../tools/aliases.js';
import { HARNESS_SCHEMA_VERSION, type HarnessManifest } from './types.js';

export const HARNESS_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const HARNESS_ADAPTER_ID_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
export const HARNESS_TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

const CONTROL_OR_DIRECTIONAL_RE = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

/**
 * Manifest keys that would let an add-on choose a model/provider, alter the
 * approval boundary, or point Shadow at executable code. Unknown keys are
 * rejected by the strict schema too; this pass gives security-sensitive keys
 * an explicit, stable error even when they are nested.
 */
const FORBIDDEN_KEYS = new Set([
  'provider',
  'providers',
  'model',
  'models',
  'endpoint',
  'endpoints',
  'baseurl',
  'apiurl',
  'url',
  'auth',
  'authentication',
  'oauth',
  'credential',
  'credentials',
  'apikey',
  'token',
  'secret',
  'password',
  'autonomy',
  'permission',
  'permissions',
  'approval',
  'approvals',
  'hook',
  'hooks',
  'mcp',
  'mcpserver',
  'mcpservers',
  'executable',
  'execute',
  'exec',
  'command',
  'script',
  'scripts',
  'bin',
  'entrypoint',
  'postinstall',
  'runtime',
  'module',
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[-_.\s]/g, '');
}

function findForbiddenKey(value: unknown, path: string[] = []): string | null {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findForbiddenKey(value[i], [...path, String(i)]);
      if (found) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const next = [...path, key];
    if (FORBIDDEN_KEYS.has(normalizedKey(key))) return next.join('.');
    const found = findForbiddenKey(child, next);
    if (found) return found;
  }
  return null;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

const SafeText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !CONTROL_OR_DIRECTIONAL_RE.test(value), 'control/directional characters are not allowed');

const InstructionPath = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((value) => !value.includes('\\'), 'use forward slashes in instruction paths')
  .refine((value) => {
    if (value.startsWith('/') || !value.toLowerCase().endsWith('.md')) return false;
    const parts = value.split('/');
    return parts.every(
      (part) =>
        part !== '.' &&
        part !== '..' &&
        /^[a-z0-9][a-z0-9._ -]{0,127}$/i.test(part) &&
        !CONTROL_OR_DIRECTIONAL_RE.test(part),
    );
  }, 'must be a safe relative Markdown path');

const AdapterId = z
  .string()
  .trim()
  .max(128)
  .regex(HARNESS_ADAPTER_ID_RE, 'use a canonical compiled adapter ID');

const ToolName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value), 'invalid tool name')
  .transform((value, ctx) => {
    const canonical = canonicalToolName(value);
    if (!HARNESS_TOOL_NAME_RE.test(canonical)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'use a canonical Shadow tool name' });
      return z.NEVER;
    }
    return canonical;
  });

const ToolPolicySchema = z
  .object({
    add: z.array(ToolName).max(128).default([]).transform(unique),
    remove: z.array(ToolName).max(128).default([]).transform(unique),
  })
  .strict()
  .default({ add: [], remove: [] })
  .superRefine((policy, ctx) => {
    const removed = new Set(policy.remove);
    for (const name of policy.add) {
      if (removed.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['remove'],
          message: `tool "${name}" cannot be both added and removed`,
        });
      }
    }
  });

const HarnessManifestSchema = z
  .object({
    schemaVersion: z.literal(HARNESS_SCHEMA_VERSION),
    id: z.string().regex(HARNESS_ID_RE, 'lowercase letters/digits/._- only, max 64 characters'),
    version: SafeText(64),
    title: SafeText(120),
    description: SafeText(500),
    instructions: z.array(InstructionPath).max(32).default([]).transform(unique),
    requiredAdapters: z.array(AdapterId).max(64).default([]).transform(unique),
    tools: ToolPolicySchema,
  })
  .strict();

/** Parse a strict schema-v1 `harness.json`. */
export function parseHarnessManifest(raw: string): HarnessManifest {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`harness.json is not valid JSON: ${(err as Error).message}`);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('harness.json must be a JSON object');
  }
  const forbidden = findForbiddenKey(json);
  if (forbidden) {
    throw new Error(
      `harness.json contains forbidden field "${forbidden}"; harnesses cannot configure providers, ` +
        'models, endpoints, credentials, autonomy, permissions, hooks, MCP, or executable code',
    );
  }
  const parsed = HarnessManifestSchema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`harness.json invalid — ${detail}`);
  }
  return parsed.data;
}
