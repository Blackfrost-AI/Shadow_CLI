/**
 * Lightweight rule-based permission classifier stub (NOT LLM-backed).
 * Gated by `autoClassifier` config — when enabled, runs before coarse autonomy
 * checks and can allow, soft-deny (require confirmation), or hard-deny a call.
 */
import type { ToolCall } from '../provider/provider.js';
import type { ToolRisk } from '../tools/types.js';
import { isBashReadOnly } from './bashReadOnly.js';
import { resolvePermissionRule, type PermissionRule } from './rules.js';
import type { ShadowConfig } from '../config.js';

export type ClassifierVerdict = 'allow' | 'soft_deny' | 'hard_deny';

export interface ClassifyRequest {
  call: ToolCall;
  preview: string;
  risk: ToolRisk;
  permissionRules?: PermissionRule[];
}

export interface ClassifyResult {
  verdict: ClassifierVerdict;
  reason: string;
}

/** Whether the optional classifier should run for this session. */
export function shouldUseClassifier(cfg: Pick<ShadowConfig, 'autoClassifier'>): boolean {
  return cfg.autoClassifier === true;
}

/**
 * Rule-based + optional LLM-backed classifier.
 * When provider passed (from loop when autoClassifier), attempts a direct LLM classify for verdict.
 * Safeguard: LLM call uses no-tools prompt, separate from agent loop, short output, timeout.
 */
export async function classifyToolCall(req: ClassifyRequest & { provider?: any; model?: string }): Promise<ClassifyResult> {
  const { call, preview, risk, permissionRules } = req;

  if (permissionRules && permissionRules.length > 0) {
    const rule = resolvePermissionRule(call, preview, permissionRules);
    if (rule === 'deny') return { verdict: 'hard_deny', reason: `permission rule denied: ${call.name}` };
    if (rule === 'ask') return { verdict: 'soft_deny', reason: `permission rule requires confirmation for ${call.name}` };
    if (rule === 'allow') return { verdict: 'allow', reason: `permission rule allowed: ${call.name}` };
  }

  if (call.name === 'run_shell') {
    const cmd = shellCommandOf(call.input);
    if (cmd && DESTRUCTIVE_SHELL_RE.test(cmd)) {
      return { verdict: 'hard_deny', reason: 'destructive shell command blocked by classifier' };
    }
    // A subshell / command substitution cannot ride a read-only-looking prefix
    // into an auto-allow: isBashReadOnly declines it (see bashReadOnly.ts) so it
    // falls through to the gate, where the denylist still sees the full string.
    // We deliberately do NOT blanket hard-deny `$(...)`/backticks — they are
    // ordinary shell and the agent uses them constantly.
    if (cmd && isBashReadOnly(cmd)) {
      return { verdict: 'allow', reason: 'read-only shell command' };
    }
  }

  // Production LLM path first (when provider given) for finer non-hard verdicts; raw no-tools call, safe no recursion.
  if (req.provider && req.model) {
    try {
      const classifyPrompt = `Classify the following tool call for the Shadow autonomous agent permission system.
Follow the bash-risk policy for run_shell (detect injection patterns like subshells, pipes to sh, etc.).
Tool: ${call.name}
Preview: ${preview}
Risk: ${risk}
Respond with exactly one line: ALLOW or SOFT_DENY or HARD_DENY | short reason (max 60 chars).`;
      let text = '';
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 8000);
      try {
        for await (const ev of req.provider.send({ model: req.model, system: 'You are a strict permission classifier for Shadow harness. Use the bash-risk policy and general safety. Only output the classification line.', messages: [{role:'user', content:[{type:'text', text: classifyPrompt}]}], tools: [], maxOutputTokens: 32, signal: ac.signal })) {
          if (ev.type === 'text') text += ev.delta;
          if (ev.type === 'done') break;
        }
      } finally { clearTimeout(t); }
      const m = text.trim().match(/^(ALLOW|SOFT_DENY|HARD_DENY)\s*\|\s*(.+)$/i);
      if (m) {
        const v = m[1].toLowerCase() === 'allow' ? 'allow' : m[1].toLowerCase() === 'hard_deny' ? 'hard_deny' : 'soft_deny';
        return { verdict: v as ClassifierVerdict, reason: `llm: ${m[2].trim()}` };
      }
    } catch { /* fallback to rules */ }
  }

  if (risk === 'read') return { verdict: 'allow', reason: 'read risk' };
  if (risk === 'network') return { verdict: 'soft_deny', reason: 'network access requires confirmation' };
  if (risk === 'write') return { verdict: 'soft_deny', reason: 'write requires confirmation' };
  if (risk === 'exec') return { verdict: 'soft_deny', reason: 'exec requires confirmation' };

  return { verdict: 'soft_deny', reason: 'unknown risk — confirmation required' };
}

const DESTRUCTIVE_SHELL_RE =
  /\b(rm\s+-[a-z]*r|rm\s+-[a-z]*f|mkfs|dd\s+if=|>\s*\/dev\/|chmod\s+-R\s+777|curl\s+.*\|\s*(ba)?sh)\b/i;

function shellCommandOf(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const cmd = (input as { command?: unknown }).command;
  return typeof cmd === 'string' ? cmd : null;
}