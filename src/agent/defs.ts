import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync, renameSync, chmodSync, mkdirSync } from 'node:fs';
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

// ── write side (web UI / future `shadow agent` CLI) ──────────────────────────

/**
 * Names that may never be written or deleted — they are hardcoded built-ins. A user can still
 * shadow `explore` by dropping a file in the agents dir (the loader prefers user files), but
 * the write API refuses to touch the reserved names so the built-ins always remain restorable.
 */
const BUILTIN_NAMES = new Set(['explore', 'reviewer']);

/** Validate an agent name. Matches the credRef slug rule so filenames stay filesystem-safe. */
export function isValidAgentName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name);
}

/** Light tool-name validation: lowercase snake_case. Existence is enforced later by the registry. */
export function isValidToolName(name: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(name) && name.length <= 64;
}

/**
 * Serialize an AgentDef back to the markdown-with-frontmatter form `parseFrontmatter` reads.
 * Round-trips: save → load yields the same def. The body is the systemPrompt; scalar fields
 * go in YAML frontmatter; tools is a YAML list.
 */
export function serializeAgentDef(def: AgentDef): string {
  const lines: string[] = ['---'];
  lines.push(`name: ${def.name}`);
  lines.push(`description: ${def.description}`);
  if (def.model) lines.push(`model: ${def.model}`);
  if (def.maxIterations !== undefined) lines.push(`maxIterations: ${def.maxIterations}`);
  if (def.tools.length > 0) {
    lines.push('tools:');
    for (const t of def.tools) lines.push(`  - ${t}`);
  } else {
    // An empty tools list would make coerceDef reject it on reload; emit a sentinel that
    // rounds back to []. We don't write such files in practice (the API requires ≥1 tool).
    lines.push('tools: []');
  }
  lines.push('---');
  lines.push('');
  lines.push(def.systemPrompt);
  return `${lines.join('\n')}\n`;
}

/** The user-global agents dir. Writes go here (workspace-local is read-only for now). */
function globalAgentsDir(): string {
  return join(homedir(), '.shadow', 'agents');
}

/**
 * Persist an agent definition to `~/.shadow/agents/<name>.md`. Atomic: temp file + chmod 0600
 * + rename, mirroring `writeJsonAtomic` in globalStore. Refuses builtin names. Returns the
 * path written, or throws on invalid input.
 */
export function saveAgentDef(def: AgentDef): string {
  if (!isValidAgentName(def.name)) {
    throw new Error(`Invalid agent name "${def.name}". Use lowercase letters, digits, . _ -, max 64 chars.`);
  }
  if (BUILTIN_NAMES.has(def.name)) {
    throw new Error(`"${def.name}" is a built-in agent and cannot be overwritten.`);
  }
  if (!def.description.trim()) throw new Error('description is required');
  if (!def.systemPrompt.trim()) throw new Error('systemPrompt is required');
  if (!def.tools.every(isValidToolName)) {
    throw new Error('tools must be snake_case names (e.g. read_file, grep, run_shell)');
  }

  const dir = globalAgentsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${def.name}.md`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, serializeAgentDef(def), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return path;
}

/** Delete `~/.shadow/agents/<name>.md`. Returns true if a file was removed. Refuses builtins. */
export function deleteAgentDef(name: string): boolean {
  if (!isValidAgentName(name)) throw new Error(`Invalid agent name "${name}".`);
  if (BUILTIN_NAMES.has(name)) throw new Error(`"${name}" is a built-in agent and cannot be deleted.`);
  const path = join(globalAgentsDir(), `${name}.md`);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}