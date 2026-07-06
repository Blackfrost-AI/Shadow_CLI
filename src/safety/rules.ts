import type { ToolCall } from '../provider/provider.js';

export type PermissionAction = 'deny' | 'ask' | 'allow';

export interface PermissionRule {
  tool: string;
  pattern?: string;
  action: PermissionAction;
}

/**
 * Evaluate configured permission rules against a tool call.
 * Returns null when no rule matches — caller falls through to autonomy levels.
 */
export function resolvePermissionRule(
  call: ToolCall,
  preview: string,
  rules: PermissionRule[],
): PermissionAction | null {
  for (const rule of rules) {
    if (rule.tool !== '*' && rule.tool !== call.name) continue;
    if (rule.pattern) {
      try {
        const re = new RegExp(rule.pattern, 'i');
        const hay = `${preview} ${safeJson(call.input) ?? ''}`;
        if (!re.test(hay)) continue;
      } catch {
        continue;
      }
    }
    return rule.action;
  }
  return null;
}

function safeJson(v: unknown): string | null {
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}