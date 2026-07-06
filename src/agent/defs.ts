import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AgentDef {
  name: string;
  description: string;
  tools: string[];
  model?: string;
  maxIterations?: number;
  systemPrompt: string;
  builtin?: boolean;
}

const BUILTIN_EXPLORE: AgentDef = {
  name: 'explore',
  description: 'Fast read-only codebase exploration',
  tools: ['read_file', 'grep', 'glob'],
  maxIterations: 12,
  systemPrompt:
    'You are an exploration sub-agent. Search and read the codebase only — do not edit files, ' +
    'run shell commands, or make network requests. Return a concise report of findings.',
  builtin: true,
};

const BUILTIN_REVIEWER: AgentDef = {
  name: 'reviewer',
  description: 'Careful self-review and critique sub-agent. Read/search focused.',
  tools: ['read_file', 'grep', 'glob'],
  maxIterations: 10,
  systemPrompt: [
    'You are a reviewer sub-agent in the Shadow harness.',
    'Review the delegated task, code, plan or changes with fresh eyes.',
    'Focus on correctness, edges, risks, conventions. Provide evidence-based report.',
    'Do not edit files or run destructive commands. Be direct.',
    'Recommend improvements; the main agent will integrate.',
  ].join(' '),
  builtin: true,
};

function agentDirs(workspaceRoot: string): string[] {
  return [join(homedir(), '.shadow', 'agents'), join(workspaceRoot, '.shadow', 'agents')];
}

function parseFrontmatter(md: string): { attrs: Record<string, string | string[]>; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { attrs: {}, body: md.trim() };
  const attrs: Record<string, string | string[]> = {};
  let key: string | null = null;
  let listKey: string | null = null;
  for (const line of m[1].split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('- ') && listKey) {
      const item = trimmed.slice(2).trim();
      const arr = (attrs[listKey] as string[] | undefined) ?? [];
      arr.push(item);
      attrs[listKey] = arr;
      continue;
    }
    const kv = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    key = kv[1]!;
    const raw = kv[2]!.trim();
    if (raw === '' || raw === '|' || raw === '>') {
      listKey = key;
      attrs[key] = [];
      continue;
    }
    listKey = null;
    if (raw.startsWith('[') && raw.endsWith(']')) {
      attrs[key] = raw
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    } else {
      attrs[key] = raw.replace(/^['"]|['"]$/g, '');
    }
  }
  return { attrs, body: m[2].trim() };
}

function coerceDef(name: string, attrs: Record<string, string | string[]>, body: string, builtin = false): AgentDef | null {
  const toolsRaw = attrs.tools;
  const tools = Array.isArray(toolsRaw) ? toolsRaw : typeof toolsRaw === 'string' ? [toolsRaw] : [];
  if (!tools.length && !builtin) return null;
  const description =
    (typeof attrs.description === 'string' ? attrs.description : undefined) ?? `Agent ${name}`;
  const maxIterations =
    typeof attrs.maxIterations === 'string' ? Number(attrs.maxIterations) : undefined;
  const model = typeof attrs.model === 'string' ? attrs.model : undefined;
  return {
    name,
    description,
    tools,
    model,
    maxIterations: Number.isFinite(maxIterations) ? maxIterations : undefined,
    systemPrompt: body || description,
    builtin,
  };
}

function loadFromFile(path: string, fallbackName: string): AgentDef | null {
  try {
    const md = readFileSync(path, 'utf8');
    const { attrs, body } = parseFrontmatter(md);
    const name = (typeof attrs.name === 'string' ? attrs.name : undefined) ?? fallbackName;
    return coerceDef(name, attrs, body);
  } catch {
    return null;
  }
}

/** Load agent definitions from `~/.shadow/agents` and `<workspace>/.shadow/agents`. */
export function loadAgentDefs(workspaceRoot: string): AgentDef[] {
  const byName = new Map<string, AgentDef>();
  for (const dir of agentDirs(workspaceRoot)) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }
    for (const file of files) {
      const def = loadFromFile(join(dir, file), file.replace(/\.md$/, ''));
      if (def) byName.set(def.name, def);
    }
  }
  if (!byName.has('explore')) byName.set('explore', BUILTIN_EXPLORE);
  if (!byName.has('reviewer')) byName.set('reviewer', BUILTIN_REVIEWER);
  return [...byName.values()];
}

/** Resolve an agent definition by type name. Built-in `explore` is always available. */
export function resolveAgentDef(type: string, workspaceRoot: string): AgentDef | null {
  const key = type.trim().toLowerCase();
  if (key === 'explore' || key === 'general-purpose' || key === 'general_purpose') {
    if (key === 'explore') return BUILTIN_EXPLORE;
    return null;
  }
  for (const def of loadAgentDefs(workspaceRoot)) {
    if (def.name.toLowerCase() === key) return def;
  }
  return null;
}