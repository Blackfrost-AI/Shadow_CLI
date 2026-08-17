/**
 * The Trajectory tab: the session's activity as a vertical timeline — one compact row per
 * meaningful event (prompts, tool calls, answers, errors), dot-coded by outcome, timestamps in
 * the gutter. It reads the SAME session model as the transcript, so the two views cannot
 * disagree; it renders nothing of its own state.
 *
 * Refresh policy: cheap rows rebuilt wholesale on notify while the tab is VISIBLE (a hidden
 * tab re-renders once when shown — see app.js calling refresh() on mode switch).
 */

import { el } from './dom.js';
import { fmtMs, fmtTok, oneLine } from './util.js';
import { argOf } from './render.js';

/** Compact one-line digest per row kind → { tone, text } (tone: 'ok'|'run'|'error'|'muted'). */
function digest(row) {
  switch (row.kind) {
    case 'user':
      return { tone: 'ok', text: `→ ${oneLine(row.text)}` };
    case 'assistant':
      return {
        tone: 'ok',
        text: `${row.streaming ? '… ' : ''}${oneLine(row.text).slice(0, 140) || '(empty answer)'}`,
      };
    case 'think':
      return { tone: 'muted', text: row.streaming ? 'thinking…' : 'thought' };
    case 'tool': {
      const bits = [row.subagent ? `↳ ${row.name}` : row.name];
      const arg = row.summary || argOf(row.args);
      if (arg) bits.push(oneLine(String(arg)).slice(0, 90));
      if (row.status === 'running') bits.push('…');
      else if (row.durationMs != null) bits.push(fmtMs(row.durationMs));
      return { tone: row.status === 'error' ? 'error' : row.status === 'running' ? 'run' : 'ok', text: bits.join(' · ') };
    }
    case 'error':
      return { tone: 'error', text: oneLine(row.text) };
    case 'finding':
      return { tone: 'muted', text: `${row.severity ?? 'info'} · ${row.title}` };
    case 'stats': {
      const s = row.stats ?? {};
      const seg = [];
      if (s.steps) seg.push(`${s.steps} step${s.steps === 1 ? '' : 's'}`);
      if (s.inputTokens || s.outputTokens) seg.push(`in ${fmtTok(s.inputTokens ?? 0)} · out ${fmtTok(s.outputTokens ?? 0)}`);
      if (s.costUSD > 0) seg.push(`$${s.costUSD.toFixed(4)}`);
      return { tone: 'muted', text: seg.join(' · ') || 'turn complete' };
    }
    case 'approval_outcome':
      return { tone: 'muted', text: `approval ${row.outcome ?? ''}`.trim() };
    case 'subagent':
      return { tone: row.queued ? 'muted' : 'run', text: `◇ ${row.queued ? 'queued' : 'started'} ${row.type}${row.description ? ` — ${oneLine(row.description)}` : ''}` };
    case 'subagent_end':
      return { tone: row.ok ? 'ok' : 'error', text: `◇ ${row.type} ${row.ok ? 'finished' : 'failed'}` };
    case 'task':
      return { tone: 'ok', text: `◆ ${row.from ?? 'task'} answered` };
    case 'status':
    case 'trimmed':
      return { tone: 'muted', text: oneLine(row.text) };
    default:
      return null;
  }
}

const hhmmss = (ts) => {
  const d = new Date(ts ?? Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/**
 * @param {Element} host the .con-body trajectory container
 * @param {Object} model the session model
 */
export function createTrajectory(host, model) {
  const inner = el('div', { class: 'traj-inner' }, []);
  host.replaceChildren(el('div', { class: 'traj' }, [inner]));

  const refresh = () => {
    const { rows } = model.snapshot();
    const kids = [];
    for (const row of rows) {
      const d = digest(row);
      if (!d) continue;
      kids.push(
        el(
          'div',
          { class: `traj-row is-${d.tone === 'run' ? 'running' : d.tone === 'error' ? 'error' : d.tone === 'muted' ? '' : 'ok'}` },
          [el('span', { class: 'traj-dot' }), el('span', { class: 'traj-time num' }, [hhmmss(row.ts)]), el('span', { class: 'sum' }, [d.text])],
        ),
      );
    }
    inner.replaceChildren(
      ...(kids.length
        ? kids
        : [el('div', { class: 'traj-empty' }, ['Nothing yet — this turn-by-turn timeline fills as the session works.'])]),
    );
  };
  refresh();
  return { refresh };
}
