import type { IncomingMessage } from 'node:http';
import { readJsonBody, type ApiContext, type RouteFn } from '../router.js';
import { loadGlobalConfig, saveGlobalConfig } from '../../state/globalStore.js';

/**
 * Hook management over the host API. Hooks are shell commands the engine runs on lifecycle
 * events. They are GLOBAL config only (config.ts marks `hooks` project-untrusted), and the
 * running server snapshots config at boot — a save here applies to sessions built after an
 * engine restart, which the UI states explicitly.
 *
 * The write is a full replace of the hooks object, validated event by event. No project file can
 * reach this route (the host has no project-config write path), matching the MCP posture.
 */

export const HOOK_EVENTS = [
  'pre_tool_use',
  'post_tool_use',
  'session_start',
  'session_end',
  'user_prompt_submit',
  'pre_compact',
  'post_compact',
  'stop',
  'subagent_stop',
  'notification',
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export type HookEntry = { command: string; matcher?: string };
export type Hooks = Record<HookEvent, HookEntry[]>;

const MAX_ENTRIES = 20;
const MAX_COMMAND = 4000;
const MAX_MATCHER = 500;

function emptyHooks(): Hooks {
  const hooks = {} as Hooks;
  for (const event of HOOK_EVENTS) hooks[event] = [];
  return hooks;
}

function normalizeEntry(raw: unknown): HookEntry | null {
  if (typeof raw === 'string') {
    const command = raw.trim();
    return command ? { command: command.slice(0, MAX_COMMAND) } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const command = typeof record.command === 'string' ? record.command.trim() : '';
  if (!command) return null;
  const matcher =
    typeof record.matcher === 'string' && record.matcher.trim()
      ? record.matcher.trim().slice(0, MAX_MATCHER)
      : undefined;
  return matcher
    ? { command: command.slice(0, MAX_COMMAND), matcher }
    : { command: command.slice(0, MAX_COMMAND) };
}

/** Read the current hooks, tolerating the v1 bare-string form and malformed entries. */
export function readHooks(): Hooks {
  const raw = loadGlobalConfig().hooks;
  const hooks = emptyHooks();
  if (!raw || typeof raw !== 'object') return hooks;
  for (const event of HOOK_EVENTS) {
    const entries = (raw as Record<string, unknown>)[event];
    if (!Array.isArray(entries)) continue;
    hooks[event] = entries
      .map(normalizeEntry)
      .filter((entry): entry is HookEntry => entry !== null)
      .slice(0, MAX_ENTRIES);
  }
  return hooks;
}

function validateHooks(
  raw: unknown,
): { ok: true; hooks: Hooks } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { ok: false, message: 'hooks must be an object keyed by event' };
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!(HOOK_EVENTS as readonly string[]).includes(key))
      return { ok: false, message: `unknown hook event "${key}"` };
  }
  const hooks = emptyHooks();
  for (const event of HOOK_EVENTS) {
    const entries = input[event];
    if (entries === undefined) continue;
    if (!Array.isArray(entries))
      return { ok: false, message: `${event} must be an array` };
    if (entries.length > MAX_ENTRIES)
      return { ok: false, message: `${event} supports at most ${MAX_ENTRIES} hooks` };
    const normalized: HookEntry[] = [];
    for (const entry of entries) {
      const parsed = normalizeEntry(entry);
      if (!parsed)
        return { ok: false, message: `${event} has an entry with no command` };
      if (parsed.command.length > MAX_COMMAND)
        return { ok: false, message: `${event} command is too long` };
      if ((parsed.matcher ?? '').length > MAX_MATCHER)
        return { ok: false, message: `${event} matcher is too long` };
      normalized.push(parsed);
    }
    hooks[event] = normalized;
  }
  return { ok: true, hooks };
}

export function registerHookRoutes(route: RouteFn, _ctx: ApiContext): void {
  route('GET', /^\/api\/hooks$/, () => ({
    status: 200,
    body: { hooks: readHooks(), events: [...HOOK_EVENTS] },
  }));

  route('PUT', /^\/api\/hooks$/, async (req: IncomingMessage) => {
    const body = (await readJsonBody(req)) as { hooks?: unknown } | null;
    if (!body || body.hooks === undefined)
      return { status: 400, body: { error: 'hooks (object) is required' } };
    const valid = validateHooks(body.hooks);
    if (!valid.ok) return { status: 400, body: { error: valid.message } };
    saveGlobalConfig({ hooks: valid.hooks });
    return { status: 200, body: { hooks: valid.hooks } };
  });
}