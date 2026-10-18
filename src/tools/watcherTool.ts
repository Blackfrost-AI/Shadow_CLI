import { z } from 'zod';
import { WatcherError, type WatcherRecord, type WatcherRegistry } from '../agent/watcher.js';
import type { Tool } from './types.js';
import { fail, ok } from './types.js';

const inputSchema = z.object({
  action: z
    .enum(['start', 'list', 'stop', 'log'])
    .describe('start a watcher, list them all, stop one, or read one\'s recent output.'),
  name: z
    .string()
    .optional()
    .describe('Watcher handle (letters, digits, dot, underscore, dash). Required for start/stop/log.'),
  command: z
    .string()
    .optional()
    .describe('Shell command to run each interval. Required for start.'),
  interval_seconds: z
    .number()
    .optional()
    .describe('Seconds between runs (raised to a 10s floor). Required for start.'),
});

export type WatcherData =
  | { action: 'start'; watcher: WatcherRecord }
  | { action: 'list'; watchers: WatcherRecord[] }
  | { action: 'stop'; watcher: WatcherRecord }
  | { action: 'log'; name: string; log: string };

function describeWatcher(w: WatcherRecord): string {
  const age = Math.max(0, Math.round((Date.now() - w.startedAt) / 1000));
  return `${w.name} [${w.status}] every ${w.intervalSec}s since ${age}s — ${w.command}`;
}

/**
 * Watchers are the one form of work that must survive the turn that requested it, so this tool is
 * intentionally separate from `schedule_wakeup` (in-session, single-shot) and `run_shell`
 * `run_in_background` (dies with the session). Use it when the agent is asked to keep an eye on
 * something: CI, a deploy, a log file, a port.
 */
export function makeWatcherTool(registry: WatcherRegistry): Tool<z.infer<typeof inputSchema>, WatcherData> {
  return {
    name: 'watcher',
    description:
      'Manage background watchers — shell commands that repeat on an interval in a DETACHED process ' +
      'that outlives this session. Survives Shadow exiting; state and logs persist under .shadow/. ' +
      'Actions: start (name, command, interval_seconds), list, stop (name), log (name). Use this when ' +
      'the user asks you to watch, monitor, or poll for changes; use schedule_wakeup for a single ' +
      'in-session reminder and run_shell run_in_background for work that need not outlive the session.',
    risk: 'exec',
    inputSchema,
    async run(input) {
      const started = Date.now();
      try {
        switch (input.action) {
          case 'start': {
            if (!input.name) return fail('watcher', 'exec', Date.now() - started, 'bad_name', 'name is required for start.');
            if (!input.command) {
              return fail('watcher', 'exec', Date.now() - started, 'bad_command', 'command is required for start.');
            }
            if (input.interval_seconds === undefined) {
              return fail('watcher', 'exec', Date.now() - started, 'bad_interval', 'interval_seconds is required for start.');
            }
            const watcher = registry.start({
              name: input.name,
              command: input.command,
              intervalSec: input.interval_seconds,
            });
            if (watcher.status !== 'running') {
              return fail(
                'watcher',
                'exec',
                Date.now() - started,
                'spawn_failed',
                `Watcher '${watcher.name}' was recorded but its process did not start. Check ${watcher.logPath}.`,
              );
            }
            return ok(
              'watcher',
              'exec',
              Date.now() - started,
              `Watcher '${watcher.name}' started (pid ${watcher.pid}) every ${watcher.intervalSec}s. ` +
                'It runs detached and keeps going after this session ends.',
              { action: 'start' as const, watcher },
            );
          }
          case 'list': {
            const watchers = registry.list();
            const running = watchers.filter((w) => w.status === 'running').length;
            const summary = watchers.length
              ? `${watchers.length} watcher(s), ${running} running:\n${watchers.map(describeWatcher).join('\n')}`
              : 'No watchers are registered.';
            return ok('watcher', 'read', Date.now() - started, summary, { action: 'list' as const, watchers });
          }
          case 'stop': {
            if (!input.name) return fail('watcher', 'exec', Date.now() - started, 'bad_name', 'name is required for stop.');
            const watcher = registry.cancel(input.name);
            return ok('watcher', 'exec', Date.now() - started, `Watcher '${watcher.name}' stopped.`, {
              action: 'stop' as const,
              watcher,
            });
          }
          case 'log': {
            if (!input.name) return fail('watcher', 'read', Date.now() - started, 'bad_name', 'name is required for log.');
            const log = registry.logTail(input.name);
            return ok('watcher', 'read', Date.now() - started, log || '(no output yet)', {
              action: 'log' as const,
              name: input.name,
              log,
            });
          }
        }
      } catch (err) {
        if (err instanceof WatcherError) {
          return fail('watcher', 'exec', Date.now() - started, err.code, err.message);
        }
        return fail('watcher', 'exec', Date.now() - started, 'unknown', (err as Error).message);
      }
    },
  };
}
