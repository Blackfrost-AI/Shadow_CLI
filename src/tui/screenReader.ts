import type { EventBus } from '../agent/events.js';
import { ActivityHistory, activityLabel, isRoutineCall } from './activity.js';
import { sanitizeAssistantText } from './sanitize.js';
import { sanitizeTerminalEscapes } from '../util/scrub.js';
import { displayToolArg, displayToolName } from './toolDisplay.js';
import { previewOf } from './headless.js';

/** Stable text output for the readline interface. No cursor addressing, spinner, raw reasoning,
 * token-by-token announcements, or color-dependent labels. Questions still use the real gate.
 */
export function attachScreenReader(
  bus: EventBus,
  opts: { model: string; write?: (text: string) => void },
) {
  const history = new ActivityHistory();
  const write = (text: string) =>
    (opts.write ?? ((s) => process.stdout.write(s)))(sanitizeTerminalEscapes(text, false));
  let model = opts.model;
  let chunks: string[] = [];
  let working = false;
  const close = () => {
    const group = history.close();
    if (group)
      write(
        `[${group.failed ? 'FAILED' : 'DONE'}] ${activityLabel(group)}. Details: /activity ${group.id}\n`,
      );
  };
  const answer = (source: string) => {
    close();
    const visible = sanitizeAssistantText(source);
    if (visible.trim()) write(`\nSHADOW · ${model}\n${visible}\n`);
    chunks = [];
  };
  const detach = bus.on((e) => {
    switch (e.type) {
      case 'mode':
        if (e.mode !== 'idle' && !working) {
          write('\n[RUNNING] Shadow is working. Ctrl+C interrupts.\n');
          working = true;
        }
        break;
      case 'text':
        chunks.push(e.delta);
        break;
      case 'reasoning_done':
        history.reasoning(e.text, 0);
        break;
      case 'tool_start':
        if (!e.subagent && !isRoutineCall(e.call.name, e.call.input)) {
          close();
          write(
            `[RUNNING] ${displayToolName(e.call.name)} ${displayToolArg(previewOf(e.call.input), 90)}\n`,
          );
        }
        break;
      case 'tool_end':
        if (!e.subagent) {
          const routine =
            e.result.ok && !e.result.meta?.diff?.length && isRoutineCall(e.call.name, e.call.input);
          if (!routine) close();
          history.tool(e);
          if (!routine) {
            const group = history.close()!;
            write(
              `[${e.result.ok ? 'DONE' : 'FAILED'}] ${displayToolName(e.call.name)}: ${e.result.summary}. Details: /activity ${group.id}\n`,
            );
          }
        }
        break;
      case 'tool_denied':
        close();
        write(`[BLOCKED] ${e.call.name}: ${e.reason}\n`);
        break;
      case 'assistant_done':
        answer(e.text || chunks.join(''));
        break;
      case 'finding':
        close();
        write(`[${(e.severity ?? 'info').toUpperCase()}] ${e.title}\n${e.body}\n`);
        break;
      case 'error':
        close();
        write(`[ERROR] ${e.message}\n`);
        break;
      case 'retry':
        write(`[RETRY] Attempt ${e.attempt}: ${e.reason}\n`);
        break;
      case 'model_fallback':
        model = e.to;
        write(`[MODEL] ${e.from} → ${e.to}\n`);
        break;
      case 'subagent_start':
        write(`[AGENT] ${e.subagentType}: ${e.queued ? 'queued' : 'started'}\n`);
        break;
      case 'subagent_end':
        write(`[AGENT] ${e.subagentType ?? 'Agent'}: ${e.ok ? 'done' : 'failed'}\n`);
        break;
      case 'stop':
        answer(chunks.join(''));
        write(e.reason === 'end_turn' ? '[DONE] Turn complete.\n' : `[STOPPED] ${e.reason}\n`);
        working = false;
        break;
      default:
        break;
    }
  });
  return {
    dispose() {
      detach();
      history.reset();
    },
    /** Inspection is a local command, never forwarded to the model as a prompt. */
    command(input: string): boolean {
      if (input === '/help') {
        write(
          'Screen-reader text mode. Type a task, or exit to leave.\n/activity lists work; /activity GROUP lists its entries; /activity GROUP ENTRY prints full output.\nCtrl+C interrupts a running turn. Approvals and questions are prompted in text.\n',
        );
        return true;
      }
      if (!/^\/activity(?:\s|$)/.test(input)) return false;
      const args = input.trim().split(/\s+/).slice(1);
      if (args.length > 2 || args.some((a) => !/^\d+$/.test(a))) {
        write('Use /activity [group [entry]].\n');
        return true;
      }
      const groups = history.list();
      if (!args.length) {
        write(
          groups.length
            ? groups.map((g) => `${g.id}. ${activityLabel(g)}`).join('\n') + '\n'
            : 'No activity yet.\n',
        );
      } else {
        const entries = history.entries(Number(args[0]));
        if (args.length === 1)
          write(
            entries.length
              ? entries.map((e, i) => `${i + 1}. ${e.title}`).join('\n') + '\n'
              : 'No matching activity.\n',
          );
        else {
          const entry = entries[Number(args[1]) - 1];
          write(entry ? history.read(entry.id) + '\n' : 'No matching entry.\n');
        }
      }
      return true;
    },
  };
}
