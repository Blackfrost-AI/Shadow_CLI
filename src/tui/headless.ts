// src/tui/headless.ts — the headless renderer for one-shot / piped runs (`shadow -p`, --task,
// --repl, piped stdin): raw ANSI straight to stdout. Extracted from tui.tsx (plan 2.4).
import type { EventBus } from '../agent/events.js';
import { friendlyDeniedReason } from '../util/deniedReason.js';
import { stripCtl, oneLine } from './format.js';
import { sanitizeAssistantText } from './sanitize.js';
import { clampLiveRest } from './streamCommit.js';
import { splitStreamToolIntentCapped } from './streamIntent.js';

// ── Headless renderer (one-shot / piped) — raw ANSI straight to stdout ───────
//
// Colour is emitted only for a real terminal that has not asked for plain output. This path is
// taken by `--task` and `--repl` as well as by piped runs (index.ts: `headless = !!flags.task ||
// !!flags.repl || !interactive`), so gating on "headless" would wrongly strip colour from an
// interactive `--task` in a terminal — the gate has to be isTTY + NO_COLOR, like every other CLI.
// Without it, `shadow --task ... > out.txt` wrote raw SGR into the file.
const COLOR = !!process.stdout.isTTY && !process.env.NO_COLOR;
const c = (seq: string): string => (COLOR ? seq : '');
const A = {
  reset: c('\x1b[0m'),
  dim: c('\x1b[2m'),
  green: c('\x1b[38;2;16;185;129m'),
  red: c('\x1b[38;2;239;68;68m'),
  yellow: c('\x1b[38;2;245;158;11m'),
  cyan: c('\x1b[36m'),
};

export function attachRenderer(bus: EventBus, _opts?: { animate: boolean }): () => void {
  // Sub-agent taskId → type, so a delegated tool line can name its agent instead of a bare taskId.
  const subagentType = new Map<string, string>();
  // F11-02: the uncommitted stream tail. The TUI withholds a suspicious tool-intent suffix while
  // streaming (splitStreamToolIntentCapped) and sanitizes the leftover at turn end; this renderer
  // used to print every delta verbatim, so a raw textual tool-call envelope hit stdout BEFORE the
  // loop's sniffToolCalls recovery decided its fate. Same contract here: recovered into a tool
  // invocation (never printed) or stripped at turn end. `liveRest` is safe-but-uncommitted text
  // (a trailing partial line, held so a marker split across two deltas cannot leak); `held` is
  // the capped intent-suspicious tail.
  let liveRest = '';
  let held = '';
  const flushRest = (): void => {
    const rest = liveRest + held;
    liveRest = '';
    held = '';
    if (!rest) return;
    // The exact TUI display chain (stripTextualToolIntent + patch scrub + scrubForDisplay);
    // scrubForDisplay trims, so the leftover is one block that closes its own line.
    const display = sanitizeAssistantText(rest);
    if (display) process.stdout.write(stripCtl(display) + '\n');
  };
  return bus.on((e) => {
    switch (e.type) {
      case 'text':
        if (e.delta) {
          const split = splitStreamToolIntentCapped(liveRest + held + e.delta);
          // Commit complete lines only: a marker opener that straddles two deltas stays in the
          // buffer until it resolves, exactly like the TUI's line-granular commit.
          const nl = split.visible.lastIndexOf('\n');
          if (nl >= 0) process.stdout.write(stripCtl(split.visible.slice(0, nl + 1)));
          liveRest = split.visible.slice(nl + 1);
          held = split.held;
          // Same bound as the TUI's live region (P1A-11): a never-closing construct must not
          // grow the retained buffer without limit. Oldest bytes are released as ordinary text.
          const clamped = clampLiveRest(liveRest);
          if (clamped.commit !== null) {
            process.stdout.write(stripCtl(clamped.commit) + '\n');
            liveRest = clamped.rest;
          }
        }
        break;
      case 'subagent_start':
        subagentType.set(e.taskId, e.subagentType);
        // F06-10: a queued announcement reads as queued; the admission re-announcement then prints
        // the normal started line — two honest lines instead of one misleading one.
        if (e.queued) {
          process.stdout.write(`\n${A.dim}▸ sub-agent ${e.subagentType}${e.description ? ` · ${stripCtl(e.description)}` : ''} queued — waiting for a concurrency slot${e.background ? ' (background)' : ''}${A.reset}\n`);
        } else {
          process.stdout.write(`\n${A.cyan}▸ sub-agent ${e.subagentType}${e.description ? ` · ${stripCtl(e.description)}` : ''} started${e.background ? ' (background)' : ''}${A.reset}\n`);
        }
        break;
      case 'subagent_end':
        process.stdout.write(`${e.ok ? A.dim : A.yellow}▸ sub-agent ${e.subagentType ?? subagentType.get(e.taskId) ?? 'agent'} ${e.ok ? 'finished' : 'failed'}${A.reset}\n`);
        break;
      case 'tool_start': {
        // A forwarded sub-agent tool is tagged with e.subagent (taskId); attribute it so headless
        // output distinguishes delegated activity from the parent's own (BUG 3 headless half).
        const who = e.subagent ? `${A.cyan}[${subagentType.get(e.subagent) ?? 'agent'}]${A.dim} ` : '';
        process.stdout.write(`\n${A.dim}↳ ${who}${e.call.name} ${stripCtl(previewOf(e.call.input))}${A.reset}\n`);
        break;
      }
      case 'tool_end': {
        const mark = e.result.ok ? `${A.green}ok${A.reset}` : `${A.red}err${A.reset}`;
        process.stdout.write(`  ${mark} ${stripCtl(oneLine(e.result.summary))}\n`);
        break;
      }
      case 'tool_denied':
        process.stdout.write(`  ${A.yellow}blocked${A.reset} ${stripCtl(friendlyDeniedReason(e.reason))}\n`);
        break;
      case 'reasoning_done':
        process.stdout.write(`\n${A.dim}▸ Reasoning${A.reset}\n${A.dim}${stripCtl(e.text)}${A.reset}\n`);
        break;
      case 'finding': {
        const color = e.severity === 'error' ? A.red : e.severity === 'warn' ? A.yellow : A.cyan;
        process.stdout.write(`\n${color}▣ ${stripCtl(e.title)}${A.reset}\n${stripCtl(e.body)}\n`);
        break;
      }
      case 'shell_output':
        process.stdout.write(stripCtl(e.chunk));
        break;
      case 'shell_pid':
        if (e.warn) process.stderr.write(`  ${A.yellow}⚠ shell pid ${e.pid}: ${e.warn} — kill manually if needed${A.reset}\n`);
        break;
      case 'model_fallback':
        process.stdout.write(`  ${A.dim}model fallback: ${e.from} → ${e.to}${A.reset}\n`);
        break;
      case 'compaction':
        process.stdout.write(
          e.degraded
            ? `  ${A.yellow}⟳ context reclaimed locally — summarizer unavailable${A.reset}\n`
            : `  ${A.dim}⟳ context compacted — earlier turns summarized${A.reset}\n`,
        );
        break;
      case 'retry':
        process.stdout.write(`  retry ${e.attempt} in ${e.delayMs}ms (${oneLine(e.reason)})\n`);
        break;
      case 'error':
        process.stdout.write(`  ${A.red}${e.message}${A.reset}\n`);
        break;
      case 'assistant_done':
        // The turn's text is complete: the loop has already recovered any textual tool call and
        // cleaned turn.text, so whatever is still held is either a recovered envelope's leftover
        // (sanitized away) or ordinary text that never reached a line break (print it now).
        flushRest();
        break;
      case 'stop': {
        // Covers the paths with NO assistant_done: an interrupted turn (Ctrl-C) or a provider
        // error mid-stream still holds a partial envelope — sanitize it away like the TUI does.
        flushRest();
        const empty = e.reason === 'max_tokens' && !e.finalAnswer.trim();
        if (e.reason === 'provider_error' || e.reason === 'fatal_tool_error' || empty) {
          const msg = empty ? 'max_tokens (no output produced)' : e.reason;
          process.stderr.write(`  ${A.red}stopped: ${msg}${A.reset}\n`);
        }
        break;
      }
      default:
        break;
    }
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function previewOf(input: unknown): string {
  const o = input as Record<string, unknown> | undefined;
  if (o && typeof o === 'object') {
    if (typeof o.command === 'string') {
      // Collapse a multi-line command (e.g. a python -c heredoc) to one line and cap it, so the live
      // "↳ run_shell $ …" preview can't fill the window while the command runs.
      const cmd = o.command.replace(/\s+/g, ' ').trim();
      return `$ ${cmd.length > 120 ? cmd.slice(0, 119) + '…' : cmd}`;
    }
    if (typeof o.path === 'string') return o.path;
    if (typeof o.url === 'string') return o.url;
    if (typeof o.pattern === 'string') return o.pattern;
  }
  return '';
}