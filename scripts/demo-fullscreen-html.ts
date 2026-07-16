// The FULL VISION — renders the entire redesigned Shadow screen (brand + transcript + pinned chrome)
// in two states, so the design reads as one coherent picture. Transcript rows come from the REAL
// flattenItem path; the chrome (composer/status/tail) is authored to the v2 spec. The page uses the
// SAME flex layout as the pinned renderer: a scroll area that shows its BOTTOM, chrome pinned below.
// Run: npx tsx scripts/demo-fullscreen-html.ts <outpath>
import { writeFileSync } from 'node:fs';
import { flattenItem } from '../src/tui/flatten.js';
import type { FlattenItem, StyledSpan } from '../src/tui/flatten.js';

const T = { fg: '#e6edf3', dim: '#9aa4b2', green: '#3fb950', cyan: '#58c8f2', yellow: '#e3b341', red: '#f85149', purple: '#bc8cff' };
const COLS = 84;
const SHADOW_ART = [
  '  ██████╗ ██╗  ██╗ █████╗ ██████╗  ██████╗ ██╗    ██╗',
  '  ██╔════╝ ██║  ██║██╔══██╗██╔══██╗██╔═══██╗██║    ██║',
  '  ██████╗  ███████║███████║██║  ██║██║   ██║██║ █╗ ██║',
  '  ╚════██╗ ██╔══██║██╔══██║██║  ██║██║   ██║██║███╗██║',
  '  ██████╔╝ ██║  ██║██║  ██║██████╔╝╚██████╔╝╚███╔███╔╝',
  '  ╚═════╝  ╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝  ╚═════╝  ╚══╝╚══╝ ',
];
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const span = (s: StyledSpan) => {
  const st: string[] = [];
  if (s.color) st.push(`color:${s.color}`);
  if (s.bold) st.push('font-weight:700');
  if (s.italic) st.push('font-style:italic');
  return `<span style="${st.join(';')}">${esc(s.text) || '&nbsp;'}</span>`;
};
const line = (spans: StyledSpan[]) => `<div class="ln">${spans.map(span).join('') || '&nbsp;'}</div>`;
const raw = (html: string) => `<div class="ln">${html}</div>`;

// ── shared transcript (rendered through the real flattenItem) ──
const history: { item: FlattenItem; collapsed?: boolean }[] = [
  { item: { id: 1, kind: 'banner', text: 'Shadow', brand: { version: '1.0.0-rc.11', providerModel: 'openai/LUMIX-35B', workspace: '~/projects/app', help: '/help · /model · Shift+Tab mode', yolo: true, art: SHADOW_ART } } },
  { item: { id: 2, kind: 'user', text: '❯ run the full suite and fix any failures' } },
  { item: { id: 3, kind: 'reasoning', text: 'Run the tests first to see what fails, then read the failing spec and patch it.' }, collapsed: true },
  { item: { id: 4, kind: 'assistant', text: "I'll run the suite, then fix whatever breaks." } },
  { item: { id: 5, kind: 'tool', text: '', tool: { name: 'run_shell', arg: 'npm test', ok: false, durationMs: 9800, summary: '1 failing — parser.test.ts' } } },
  { item: { id: 6, kind: 'tool', text: '', meta: 'output', lines: Array.from({ length: 18 }, (_, i) => ({ text: `x ${i}` })) }, collapsed: true },
  { item: { id: 7, kind: 'assistant', text: 'The failure is an off-by-one in `parseHeading` — it drops the last `#`. One-line fix.' } },
  { item: { id: 8, kind: 'tool', text: '', tool: { name: 'edit', arg: 'src/parser.ts', ok: true, durationMs: 90, summary: '+1 −1' } } },
  { item: { id: 9, kind: 'tool', text: '', tool: { name: 'run_shell', arg: 'npm test', ok: true, durationMs: 10200, summary: '644 pass' } } },
  { item: { id: 10, kind: 'assistant', text: 'Fixed — the off-by-one is gone and all **644** tests pass. ✅' } },
];
const histRows: string[] = [];
for (const { item, collapsed } of history)
  for (const r of flattenItem(item, COLS, collapsed ?? false, T)) histRows.push(line(r.spans));

// ── authored v2 chrome ──
const D = (t: string) => `<span style="color:${T.dim}">${esc(t)}</span>`;
const box = (inner: string) =>
  raw(D('╭' + '─'.repeat(COLS - 2) + '╮')) +
  raw(D('│ ') + inner + D(' '.repeat(Math.max(1, COLS - 4 - stripLen(inner))) + '│')) +
  raw(D('╰' + '─'.repeat(COLS - 2) + '╯'));
function stripLen(html: string): number { return html.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').length; }

const composerIdle = box(`<span style="color:${T.green};font-weight:700">❯ </span><span style="color:${T.dim}">write a prompt, or / for commands</span>`);
const stripIdle = raw(D('  /help · ') + `<span style="color:${T.fg}">openai/LUMIX-35B</span>` + D(' · ⏵ full (yolo) · ↑ high · ctx 42% · $0.00'));

const composerWork = box(`<span style="color:${T.green};font-weight:700">❯ </span><span style="color:${T.fg}">add caching to the fetch layer</span><span style="color:${T.dim}">▏</span>`);
const tail = [
  raw(D('Looking at the fetch layer now. I\'ll add an in-memory LRU keyed by')),
  raw(D('the request URL, with a 60s TTL, and thread it through the client so')),
  raw(D('repeated calls in a turn hit the cache instead of the network…')),
];
const statusRow = raw(
  `<span style="color:${T.yellow}">◐</span>` +
  D(' working · 47s · ') + `<span style="color:${T.cyan}">⚙ run_shell</span>` + D(' npm test · ') +
  `<span style="color:${T.fg}">esc</span>` + D(' to interrupt'),
);
const stripWork = raw(D('  openai/LUMIX-35B · ⏵ full (yolo) · ↑ high · 36.0k tokens · ctx 51% · $0.00'));

const screen = (label: string, transcriptRows: string[], chromeRows: string[]) => `
<div class="win">
  <div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><span class="tt">Shadow — ~/projects/app</span></div>
  <div class="body">
    <div class="scroll">${transcriptRows.join('')}</div>
    <div class="chrome">${chromeRows.join('')}</div>
  </div>
  <div class="cap">${label}</div>
</div>`;

const page = `
<style>
  .wrap { font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; color:${T.fg}; max-width:920px; margin:0 auto; }
  .lead { color:#8b949e; font:14px/1.6 -apple-system,system-ui,sans-serif; margin:0 0 20px; }
  .lead b { color:#e6edf3; }
  .win { margin:0 0 34px; border-radius:11px; overflow:hidden; box-shadow:0 12px 40px rgba(0,0,0,.5); background:#0d1117; }
  .bar { background:#161b22; padding:9px 13px; display:flex; align-items:center; gap:7px; border-bottom:1px solid #21262d; }
  .dot { width:11px; height:11px; border-radius:50%; display:inline-block; } .dot.r{background:#ff5f56}.dot.y{background:#ffbd2e}.dot.g{background:#27c93f}
  .tt { color:#6b7280; font-size:12px; margin-left:9px; }
  .body { height:430px; display:flex; flex-direction:column; padding:14px 16px 0; }
  .scroll { flex:1; overflow:hidden; display:flex; flex-direction:column; justify-content:flex-end; -webkit-mask-image:linear-gradient(to bottom, transparent 0, #000 46px); mask-image:linear-gradient(to bottom, transparent 0, #000 46px); }
  .chrome { padding:8px 0 12px; }
  .ln { white-space:pre; }
  .cap { background:#161b22; color:#7d8590; font:12px/1 -apple-system,system-ui,sans-serif; padding:9px 14px; border-top:1px solid #21262d; }
  .note { color:#8b949e; font:13px/1.6 -apple-system,system-ui,sans-serif; border-left:3px solid ${T.cyan}; padding:2px 0 2px 14px; margin:0 0 26px; }
  .note b { color:#e6edf3; }
</style>
<div class="wrap">
  <p class="lead">Shadow TUI — <b>the full vision</b>. One screen: the <b>SHADOW</b> wordmark scrolls away into native history at the top, the conversation flows up through the scroll region, and the input bar is <b>physically pinned to the bottom</b> — it never moves. Two states below: at rest, and mid-turn.</p>
  <div class="note">The <b>faded top edge</b> of each window is the scroll region — older lines fade up into your terminal's real scrollback (wheel, PgUp, find, select all keep working). Everything below the last transcript line is the <b>pinned chrome</b>: it's the only thing Ink draws, and it can't drift.</div>
  ${screen('State 1 — idle · input resting at the bottom, one clean border, status merged into the hint', histRows, [composerIdle, stripIdle])}
  ${screen('State 2 — working · streaming preview + status line appear ABOVE the composer; the bar has not moved', histRows.slice(6), [...tail, statusRow, composerWork, stripWork])}
</div>`;
writeFileSync(process.argv[2] || 'fullscreen.html', page);
console.log('wrote', process.argv[2]);
