// osv_query — known-vulnerability lookup for a package/version via OSV.dev.
//
// Lets vuln hunters and reviewers check whether a dependency version is already
// covered by a published advisory (CVE/GHSA) before reporting it as novel, and triage
// upgrade priority. This is a USER-INITIATED query to a fixed public API — not
// telemetry: the model supplies only package identity (ecosystem/name/version or a
// purl), never workspace contents, and every request flows through the egress broker
// (offline wall, SSRF re-validation, append-only receipt). No manifest auto-upload.
//
// Endpoint is a hardcoded constant; the model cannot redirect it. Offline mode and
// the quarantine allowlist apply automatically via shadowFetch.

import { z } from 'zod';
import { shadowFetch } from '../safety/egress.js';
import { envelopUntrusted } from '../safety/envelope.js';
import { clamp } from './util.js';
import { fail, ok, type Tool, type ToolResult } from './types.js';

const OSV_QUERY_URL = 'https://api.osv.dev/v1/query';
const TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 2_000_000;
const MAX_VULNS = 50;
const MAX_OUTPUT_CHARS = 14_000;

const ECOSYSTEMS = [
  'npm', 'PyPI', 'Go', 'Maven', 'crates.io', 'NuGet', 'RubyGems', 'Packagist',
  'Hex', 'Pub', 'CRAN', 'SwiftURL', 'Bitnami', 'GitHub Actions', 'Linux', 'OSS-Fuzz',
  'GSD', 'Malicious Packages', 'Android', 'ConanCenter', 'Hackage', 'Wolfi',
] as const;

const schema = z
  .object({
    ecosystem: z.enum(ECOSYSTEMS).optional().describe('Package ecosystem (e.g. npm, PyPI, Go, Maven, crates.io).'),
    name: z.string().min(1).max(256).optional().describe('Package name within the ecosystem.'),
    version: z.string().min(1).max(128).optional().describe('Exact package version to check.'),
    purl: z.string().min(1).max(512).optional().describe('Package URL (e.g. pkg:npm/lodash@4.17.20). Overrides ecosystem/name/version when given.'),
  })
  .refine((v) => v.purl || (v.ecosystem && v.name && v.version), {
    message: 'Provide either purl, or all of ecosystem + name + version.',
  });
export type OsvQueryInput = z.input<typeof schema>;

interface OsvVuln {
  id: string;
  aliases: string[];
  summary: string;
  severity: string[];
  fixed: string[];
  published?: string;
  modified?: string;
}

export interface OsvQueryData {
  query: { ecosystem?: string; name?: string; version?: string; purl?: string };
  vulnCount: number;
  vulns: OsvVuln[];
  truncated: boolean;
}

function extractSeverity(v: Record<string, unknown>): string[] {
  const out: string[] = [];
  const sev = v['severity'];
  if (Array.isArray(sev)) {
    for (const s of sev) {
      if (s && typeof s === 'object') {
        const score = (s as Record<string, unknown>)['score'];
        const type = (s as Record<string, unknown>)['type'];
        if (typeof score === 'string') out.push(typeof type === 'string' ? `${type}: ${score}` : score);
      }
    }
  }
  const dbSpecific = v['database_specific'] as Record<string, unknown> | undefined;
  if (dbSpecific && typeof dbSpecific['severity'] === 'string') out.push(dbSpecific['severity']);
  return out;
}

function extractFixed(v: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const affected = v['affected'];
  if (Array.isArray(affected)) {
    for (const a of affected) {
      const ranges = (a as Record<string, unknown>)['ranges'];
      if (!Array.isArray(ranges)) continue;
      for (const r of ranges) {
        const events = (r as Record<string, unknown>)['events'];
        if (!Array.isArray(events)) continue;
        for (const e of events) {
          const fixed = (e as Record<string, unknown>)['fixed'];
          if (typeof fixed === 'string') out.add(fixed);
        }
      }
      const versions = (a as Record<string, unknown>)['versions'];
      // "last_affected" is not a fix; only explicit `fixed` events count.
      void versions;
    }
  }
  return [...out];
}

export const osvQuery: Tool<OsvQueryInput, OsvQueryData> = {
  name: 'osv_query',
  risk: 'network',
  deferred: true,
  searchAliases: [
    'cve', 'ghsa', 'advisory', 'osv', 'dependency', 'vulnerability', 'vuln', 'known-vulnerability',
    'package', 'npm-audit', 'sca', 'software-composition', 'security-advisory', 'patch', 'upgrade',
    'exploit-db', 'nvd',
  ],
  inputSchema: schema,
  description:
    'Check whether a package version has known published vulnerabilities (CVE/GHSA) via the OSV.dev API. ' +
    'Provide ecosystem+name+version (e.g. npm/lodash/4.17.20) or a purl. Returns advisory ids, aliases, ' +
    'severity, and fixed versions. User-initiated query to a fixed public endpoint through the egress broker ' +
    '(offline wall + receipts apply); only package identity is sent, never workspace contents. Use to ' +
    'de-duplicate findings against known advisories and triage upgrades.',
  async run(input: OsvQueryInput, ctx): Promise<ToolResult<OsvQueryData>> {
    const start = Date.now();
    const failNow = (code: string, message: string) => fail('osv_query', 'network', Date.now() - start, code, message);
    const query: OsvQueryData['query'] = input.purl
      ? { purl: input.purl }
      : { ecosystem: input.ecosystem, name: input.name, version: input.version };
    try {
      const body = input.purl
        ? { package: { purl: input.purl } }
        : { package: { ecosystem: input.ecosystem, name: input.name }, version: input.version };

      // Bound the request with our own deadline, composed with the caller's signal.
      const deadline = AbortSignal.timeout(TIMEOUT_MS);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, deadline]) : deadline;
      const resp = await shadowFetch(
        OSV_QUERY_URL,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
          signal,
        },
        { purpose: 'osv', origin: 'user' },
      );
      if (!resp.ok) {
        return failNow('http_error', `OSV API returned HTTP ${resp.status}.`);
      }
      // Reject an advertised oversize body before buffering it (the post-read cap below
      // remains the authority when content-length is absent or dishonest).
      const advertised = Number(resp.headers.get('content-length') ?? '');
      if (Number.isFinite(advertised) && advertised > MAX_BODY_BYTES) {
        return failNow('too_large', 'OSV response exceeded the size cap.');
      }
      const text = await resp.text();
      if (text.length > MAX_BODY_BYTES) {
        return failNow('too_large', 'OSV response exceeded the size cap.');
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return failNow('bad_response', 'OSV API returned non-JSON content.');
      }
      const rawVulns = Array.isArray(parsed['vulns']) ? (parsed['vulns'] as Record<string, unknown>[]) : [];
      const vulns: OsvVuln[] = [];
      let truncated = false;
      for (const v of rawVulns) {
        if (vulns.length >= MAX_VULNS) {
          truncated = true;
          break;
        }
        const id = typeof v['id'] === 'string' ? v['id'] : '';
        if (!id) continue;
        vulns.push({
          id,
          aliases: Array.isArray(v['aliases']) ? (v['aliases'] as unknown[]).filter((a): a is string => typeof a === 'string') : [],
          summary: typeof v['summary'] === 'string' ? clamp(v['summary'], 500) : '',
          severity: extractSeverity(v),
          fixed: extractFixed(v),
          ...(typeof v['published'] === 'string' ? { published: v['published'] } : {}),
          ...(typeof v['modified'] === 'string' ? { modified: v['modified'] } : {}),
        });
      }
      const data: OsvQueryData = { query, vulnCount: vulns.length, vulns, truncated };
      // Advisory text is third-party content — envelope it as untrusted data.
      const payload = clamp(JSON.stringify(data), MAX_OUTPUT_CHARS - 2048);
      const summary = envelopUntrusted({ tool: 'osv_query', source: OSV_QUERY_URL, content: payload });
      return ok('osv_query', 'network', Date.now() - start, summary, data);
    } catch (e) {
      const msg = (e as Error).message || 'OSV query failed.';
      if (/offline/i.test(msg)) return failNow('offline', msg);
      if (/denied|blocked|quarantine|allowlist/i.test(msg)) return failNow('egress_denied', msg);
      if (/abort/i.test(msg) || ctx.signal?.aborted) return failNow('cancelled', 'Query cancelled.');
      return failNow('query_error', msg);
    }
  },
};