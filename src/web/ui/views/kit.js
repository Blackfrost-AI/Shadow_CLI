import { el, mount } from '../dom.js';
import { viewShell, blockHead, statusBadge, dotEl } from '../parts.js';

/**
 * The component kit — a living showcase of the shared design system every other view reuses.
 * The colour swatches, buttons, and badges here render the SAME classes the real views use, so
 * this page is an honest mirror: if a token or badge drifts, it drifts here too. The lower
 * sections (trigger menu, console states, plan drawer) document states/patterns and use inline
 * styles, since they are one-off illustrations rather than reused classes.
 */

const SWATCHES = ['accent', 'ok', 'warn', 'err', 'info', 'risk-exec', 'risk-net', 'panel', 'panel2', 'border', 'text', 'muted'];
const STATUSES = ['idle', 'initializing', 'queued', 'running', 'error', 'closed'];
const RISKS = [['read', 'read'], ['write', 'write'], ['exec', 'exec'], ['network', 'net']];
const SEVERITIES = [['info', 'sev-info'], ['warn', 'sev-warn'], ['error', 'sev-error']];
const CONNS = [['connecting', 'warn', false], ['live', 'ok', true], ['reconnecting…', 'warn', true], ['disconnected', 'err', false]];

function section(title, ...children) {
  return el('div', {}, [el('div', { class: 'kit-head' }, [title]), ...children]);
}

/** A connection pill — dot + label, matching the console header's live/reconnecting/… states. */
function connPill(label, color, pulse) {
  return el('span', { class: 'conn-pill' }, [dotEl(color, pulse), el('span', {}, [label])]);
}

export function kitView(host) {
  const swatches = el('div', { class: 'kit-swatches' }, SWATCHES.map((n) =>
    el('div', { class: 'swatch' }, [
      el('span', { class: 'swatch-box', style: `background:var(--${n})` }),
      el('span', { class: 'swatch-name' }, [`--${n}`]),
    ]),
  ));

  const buttons = el('div', { class: 'kit-row' }, [
    el('button', { class: 'btn primary' }, ['Primary']),
    el('button', { class: 'btn' }, ['Default']),
    el('button', { class: 'btn danger' }, ['Danger']),
    el('button', { class: 'btn-mini' }, ['small']),
    el('button', { class: 'btn', disabled: 'true' }, ['Disabled']),
    el('button', { class: 'btn' }, [el('span', { class: 'spinner' }), ' Loading']),
  ]);

  const badges = el('div', { class: 'kit-badges' }, [
    el('div', {}, STATUSES.map(statusBadge)),
    el('div', {}, RISKS.map(([label, cls]) => el('span', { class: `badge risk-${cls}` }, [label]))),
    el('div', {}, SEVERITIES.map(([label, cls]) => el('span', { class: `badge ${cls}` }, [label]))),
    el('div', {}, CONNS.map(([label, color, pulse]) => connPill(label, color, pulse))),
  ]);

  // ── one-off showcase pieces (inline styles; not reused classes) ──
  const mono = "font-family:var(--mono)";
  const trigger = el('div', { style: 'max-width:480px;border:1px solid var(--border);border-radius:10px;background:var(--panel);box-shadow:var(--shadow);overflow:hidden' }, [
    el('div', { style: `padding:8px 12px;border-bottom:1px solid var(--border);${mono};font-size:12px;color:var(--muted)` }, [
      '@str', el('span', { style: 'color:var(--accent);animation:sh-blink 1s infinite' }, ['▊']),
    ]),
    el('div', { style: `display:flex;align-items:center;gap:8px;padding:7px 12px;background:var(--sel);${mono};font-size:12px` }, [
      el('span', { style: 'color:var(--muted)' }, ['▢']), 'src/web/', el('strong', {}, ['str']), 'eam.js',
      el('span', { style: 'margin-left:auto;font-size:10px;color:var(--faint)' }, ['↵']),
    ]),
    el('div', { style: `display:flex;align-items:center;gap:8px;padding:7px 12px;${mono};font-size:12px;color:var(--muted)` }, [
      el('span', {}, ['▢']), 'src/render/', el('strong', {}, ['str']), 'uct.js',
    ]),
    el('div', { style: `display:flex;align-items:center;gap:8px;padding:7px 12px;${mono};font-size:12px;color:var(--muted)` }, [
      el('span', {}, ['▢']), 'test/', el('strong', {}, ['str']), 'eam.test.js',
    ]),
    el('div', { style: `padding:5px 12px;border-top:1px solid var(--border);font-size:10px;color:var(--faint);${mono}` }, [
      '↑↓ navigate · ↵ insert · esc dismiss',
    ]),
  ]);

  const stateCard = (title, inner) =>
    el('div', { style: 'border:1px solid var(--border);border-radius:10px;background:var(--panel);padding:12px 14px' }, [
      el('div', { style: 'font-weight:600;font-size:12px;margin-bottom:6px' }, [title]),
      inner,
    ]);
  const states = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px' }, [
    stateCard('Empty session', el('div', { style: 'text-align:center;padding:18px 8px;color:var(--muted)' }, [
      el('div', { style: `${mono};font-size:20px;color:var(--faint);margin-bottom:6px` }, ['❯ _']),
      el('div', { style: 'font-size:12px' }, ['New session — describe a task to start the agent.']),
    ])),
    stateCard('Disconnected', el('div', { style: 'border:1px solid var(--err);background:var(--err-bg);border-radius:8px;padding:9px 12px;font-size:12px;display:flex;gap:8px;align-items:center' }, [
      dotEl('err'), 'Stream disconnected — retry 3 in 4s',
      el('a', { href: '#', style: 'margin-left:auto', onclick: (e) => e.preventDefault() }, ['retry now']),
    ])),
    stateCard('Rejoined mid-turn', el('div', { style: 'border:1px solid var(--border);background:var(--info-bg);border-radius:8px;padding:9px 12px;font-size:12px;display:flex;gap:8px;align-items:center' }, [
      el('span', { style: 'color:var(--info)' }, ['↻']), 'Rejoined a running turn — replaying from event 8412',
      el('span', { style: `margin-left:auto;${mono};font-size:10px;color:var(--faint)` }, ['stream_gap']),
    ])),
    stateCard('Error row', el('div', { style: 'border:1px solid var(--err);border-left:3px solid var(--err);background:var(--err-bg);border-radius:8px;padding:9px 12px;font-size:12px' }, [
      el('strong', { style: 'color:var(--err)' }, ['error']), ' · model endpoint unreachable (ECONNREFUSED 127.0.0.1:8080)',
    ])),
    stateCard('Stop line', el('div', { style: `${mono};font-size:11px;color:var(--faint);text-align:center;padding:10px 0` }, [
      '— stopped · end_turn · $0.04 · 12.8k tok —',
    ])),
  ]);

  mount(host, [
    viewShell(
      blockHead('Component kit', 'The shared system every view reuses. Tokens are CSS custom properties; both themes ship first-class.'),
      [
        el('div', { class: 'kit' }, [
          section('Color tokens', swatches),
          section('Buttons', buttons),
          section('Badges — session status · risk · severity · connection', badges),
          section('Trigger menu — @ files (same treatment for / $ #)', trigger),
          section('Console states', states),
        ]),
      ],
    ),
  ]);
  return () => {};
}
