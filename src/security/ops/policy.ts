/**
 * Ops policy gate (plan §4) — PURE functions returning decisions only, no side effects, no I/O.
 * Call sites (dispatch, the opsGate loop hook) write the audit hint node (origin:'policy').
 * Default-deny everywhere: unknown scope, unmatched allowlist, malformed input, any thrown
 * error → deny with a reason. The gate can only subtract from what Shadow's safety pipeline
 * already permits; it never grants.
 */
import { isAbsolute } from 'node:path';
import { DEFAULT_MAX_WORKERS, OpsError, type Archetype, type IntentNode, type Run } from './types.js';

export interface OpsPolicy {
  engagementId: string;
  /** hosts/CIDRs/absolute paths parsed from engagement scope (conservative, §12.2). */
  scopeTargets: string[];
  /** Positive allowlist from the CANONICAL archetype (§6), never a resolved/shadowed def. */
  allowedTools: string[];
  /** project_checks profile ids bound at dispatch (verifier execution path). */
  allowedCheckProfiles: string[];
  /** true ONLY if scope contains the literal token `allow-network` (exact, case-sensitive). */
  allowNetwork: boolean;
  /** default 3; hard cap = session subagentConcurrency (enforced at dispatch). */
  maxWorkers: number;
}

export type Decision = { allow: true } | { allow: false; reason: string };

const deny = (reason: string): Decision => ({ allow: false, reason });

/**
 * Tools that touch a target and therefore require explicit, in-scope intent targets.
 * Everything else on an archetype allowlist is workspace-read or write-back.
 */
const TARGET_TOUCHING = new Set([
  'run_shell',
  'bin_recon',
  'target_snapshot',
  'patch_bytes',
  'sample_run',
  'project_checks',
]);
// osv_query is deliberately NOT target-touching: it sends package identity only (no
// path/target input) to a fixed advisory endpoint and is gated by allow-network instead.

/** Tools that reach the network at all (only reachable when allow-network is literal). */
const NETWORK_TOUCHING = new Set(['osv_query', 'web_fetch', 'web_search']);

/**
 * Conservative scope parser (§12.2): whitespace/comma/semicolon-separated tokens that are
 * EXACTLY an absolute path, an IPv4/IPv6 CIDR, a bare IPv4, or a hostname. Anything else is
 * ignored — unparseable scope yields an empty list, which denies all target-touching work.
 * The literal token `allow-network` (exact, case-sensitive) is the ONLY network opt-in.
 */
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV4_CIDR = /^(?:\d{1,3}\.){3}\d{1,3}\/(?:[0-9]|[12][0-9]|3[0-2])$/;
const IPV6_CIDR = /^[0-9a-fA-F:]+\/(?:[0-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$/;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;

function validIpv4(s: string): boolean {
  return IPV4.test(s) && s.split('.').every((o) => Number(o) <= 255);
}

export function parseScope(scopeText: string): { targets: string[]; allowNetwork: boolean } {
  if (typeof scopeText !== 'string') return { targets: [], allowNetwork: false };
  const tokens = scopeText.split(/[\s,;]+/).filter(Boolean);
  const targets = new Set<string>();
  let allowNetwork = false;
  for (const raw of tokens) {
    if (raw === 'allow-network') {
      allowNetwork = true;
      continue;
    }
    const t = raw.replace(/[<>()[\]{}"']+$/g, '').replace(/^[<>()[\]{}"']+/g, '');
    if (t.startsWith('/') && isAbsolute(t) && !t.includes('..')) targets.add(t.replace(/\/+$/, '') || '/');
    else if (IPV4_CIDR.test(t) && validIpv4(t.split('/')[0]!)) targets.add(t);
    else if (validIpv4(t)) targets.add(t);
    else if (IPV6_CIDR.test(t) && t.includes(':')) targets.add(t);
    else if (HOSTNAME.test(t)) targets.add(t.toLowerCase());
    // Anything else (URLs with schemes, prose, globs, relative paths) is deliberately ignored.
  }
  return { targets: [...targets].sort(), allowNetwork };
}

/** Build the dispatch-bound policy from engagement scope + canonical archetype allowlist. */
export function policyFromScope(
  engagementId: string,
  scopeText: string,
  allowedTools: string[],
  allowedCheckProfiles: string[] = [],
  maxWorkers: number = DEFAULT_MAX_WORKERS,
): OpsPolicy {
  const { targets, allowNetwork } = parseScope(scopeText);
  return { engagementId, scopeTargets: targets, allowedTools: [...allowedTools], allowedCheckProfiles: [...allowedCheckProfiles], allowNetwork, maxWorkers };
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) | Number(o), 0) >>> 0;
}

function inCidr(ip: string, cidr: string): boolean {
  const [net, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  if (!net || !validIpv4(net) || !validIpv4(ip)) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(net) & mask);
}

/** A target matches scope iff equal to a scope entry, under a scope path prefix, or inside a scope CIDR. */
export function targetInScope(target: string, scopeTargets: string[]): boolean {
  if (typeof target !== 'string' || target.trim() === '') return false;
  const t = target.trim();
  for (const s of scopeTargets) {
    if (t === s) return true;
    if (s.startsWith('/')) {
      if (t.startsWith('/') && !t.includes('..') && (t === s || t.startsWith(s === '/' ? '/' : s + '/'))) return true;
    } else if (s.includes('/') && s.includes('.') && validIpv4(t) && inCidr(t, s)) {
      return true;
    }
  }
  return false;
}

function targetsOf(intent: IntentNode): string[] | null {
  const raw = intent.payload?.targets;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (!raw.every((t) => typeof t === 'string' && t.trim() !== '')) return null;
  return raw as string[];
}

/**
 * Pre-dispatch gate (§4a). Requires an active run bound to the policy's engagement, a valid
 * intent payload, every planned tool on the allowlist, and — when any planned tool touches a
 * target — explicit targets that ALL match scope. Advisory-only network tools (osv_query)
 * are gated by the literal allow-network token instead. run_shell is denied for ops workers, always.
 */
export function checkDispatch(p: OpsPolicy, intent: IntentNode, toolPlan: string[]): Decision {
  try {
    if (!p || !p.engagementId) return deny('No bound engagement.');
    if (!intent || intent.kind !== 'intent') return deny('Dispatch requires an intent node.');
    if (typeof intent.payload?.prompt !== 'string' || !intent.payload.prompt.trim()) return deny('Intent payload missing prompt.');
    const archetype = intent.payload.archetype as Archetype | undefined;
    if (archetype !== 'recon' && archetype !== 'auditor' && archetype !== 'verifier') return deny(`Unknown archetype: ${String(archetype)}.`);
    if (!Array.isArray(toolPlan) || toolPlan.length === 0) return deny('Empty tool plan.');
    for (const tool of toolPlan) {
      if (tool === 'run_shell') return deny('run_shell is denied for all ops workers. The verifier executes only bound project_checks profiles.');
      if (!p.allowedTools.includes(tool)) return deny(`Tool ${tool} is not on the archetype allowlist.`);
      if (NETWORK_TOUCHING.has(tool) && !p.allowNetwork) return deny(`Tool ${tool} needs network; scope lacks the literal allow-network token.`);
    }
    if (toolPlan.includes('project_checks') && p.allowedCheckProfiles.length === 0) return deny('Verifier dispatch requires bound check profiles.');
    // Advisory-only plans (osv_query) carry package identity, not targets — they are gated
    // by the allow-network check above and must not force explicit target declaration.
    const touchesTarget = toolPlan.some((t) => TARGET_TOUCHING.has(t) && !NETWORK_TOUCHING.has(t));
    if (touchesTarget) {
      const targets = targetsOf(intent);
      if (!targets) return deny('Target-touching dispatch requires explicit intent targets.');
      for (const t of targets) if (!targetInScope(t, p.scopeTargets)) return deny(`Target out of scope: ${t}`);
    }
    return { allow: true };
  } catch (e) {
    return deny(`Policy validation error: ${(e as Error).message}`);
  }
}

/**
 * Per-call gate (§4b) — consulted inside the worker loop after alias canonicalization and
 * before permissions/classifier, and inside executeProjectCheck before the inner shell.
 * Only subtracts: an allow here still faces the full Shadow safety pipeline.
 */
export function checkToolCall(p: OpsPolicy, call: { name: string; input: unknown }): Decision {
  try {
    if (!p || !p.engagementId) return deny('No bound engagement.');
    if (!call || typeof call.name !== 'string' || !call.name) return deny('Malformed tool call.');
    const name = call.name;
    if (name === 'run_shell') return deny('run_shell is denied for all ops workers.');
    if (!p.allowedTools.includes(name)) return deny(`Tool ${name} is not on the archetype allowlist.`);
    if (NETWORK_TOUCHING.has(name) && !p.allowNetwork) return deny(`Tool ${name} needs network; scope lacks the literal allow-network token.`);
    const input = (call.input ?? {}) as Record<string, unknown>;
    if (name === 'project_checks') {
      if (input.action === 'run') {
        const id = input.id;
        if (typeof id !== 'string' || !p.allowedCheckProfiles.includes(id)) return deny(`Check profile ${String(id)} is not bound to this engagement.`);
      }
      return { allow: true };
    }
    if (TARGET_TOUCHING.has(name)) {
      // target_snapshot baselines a path; bin_recon inspects a path; both must be in scope.
      const path = input.path ?? input.target;
      if (typeof path !== 'string' || !targetInScope(path, p.scopeTargets)) return deny(`Target out of scope: ${String(path)}`);
    }
    return { allow: true };
  } catch (e) {
    return deny(`Policy validation error: ${(e as Error).message}`);
  }
}

/** Dispatch-time run binding check shared by ops_dispatch (pure). */
export function checkRunBinding(p: OpsPolicy, run: Run | undefined): Decision {
  if (!run) return deny('No active ops run. Start one with ops_dispatch start_run.');
  if (run.status !== 'active') return deny(`Run ${run.id} is ${run.status}.`);
  if (run.engagementId !== p.engagementId) return deny('Run is bound to a different engagement.');
  return { allow: true };
}

export { OpsError };