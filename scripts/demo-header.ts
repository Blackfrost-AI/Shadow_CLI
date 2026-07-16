// Header preview at multiple widths — shows the wordmark hard-left with the info/version block
// right-aligned to the screen edge, resizing with the terminal. Run: npx tsx scripts/demo-header.ts <out>
import { writeFileSync } from 'node:fs';
import { flattenItem } from '../src/tui/flatten.js';
import type { StyledSpan } from '../src/tui/flatten.js';

const T = { fg: '#e6edf3', dim: '#9aa4b2', green: '#3fb950', cyan: '#58c8f2', yellow: '#e3b341', red: '#f85149', purple: '#bc8cff' };
const SHADOW_ART = `███████╗██╗  ██╗ █████╗ ██████╗  ██████╗ ██╗    ██╗
██╔════╝██║  ██║██╔══██╗██╔══██╗██╔═══██╗██║    ██║
███████╗███████║███████║██║  ██║██║   ██║██║ █╗ ██║
╚════██║██╔══██║██╔══██║██║  ██║██║   ██║██║███╗██║
███████║██║  ██║██║  ██║██████╔╝╚██████╔╝╚███╔███╔╝
╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝  ╚═════╝  ╚══╝╚══╝`.split('\n');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const spanHtml = (s: StyledSpan) => {
  const st: string[] = [];
  if (s.color) st.push(`color:${s.color}`);
  if (s.bold) st.push('font-weight:700');
  return `<span style="${st.join(';')}">${esc(s.text) || '&nbsp;'}</span>`;
};
const brand = { version: '1.0.0-rc.11', providerModel: 'openai/RED-QW3N-35B', workspace: '~/Documents/Shadow War-Machine', help: '/help · /model · Shift+Tab mode', yolo: true, art: SHADOW_ART };

function render(cols: number): string {
  const rows = flattenItem({ id: 1, kind: 'banner', text: 'Shadow', brand }, cols, false, T);
  const inner = rows.map((r) => `<div class="ln">${r.spans.map(spanHtml).join('') || '&nbsp;'}</div>`).join('');
  return `<div class="term"><div class="w">${cols} cols</div>${inner}<div class="ln">&nbsp;</div><div class="ln"><span style="color:${T.dim}">╭${'─'.repeat(cols - 2)}╮</span></div><div class="ln"><span style="color:${T.dim}">│ </span><span style="color:${T.green};font-weight:700">❯ </span><span style="color:${T.dim}">write a prompt, or / for commands${'&nbsp;'.repeat(Math.max(0, cols - 38))}│</span></div><div class="ln"><span style="color:${T.dim}">╰${'─'.repeat(cols - 2)}╯</span></div></div>`;
}

const page = `<style>
  .wrap { max-width:1100px; margin:0 auto; font:13px/1.5 ui-monospace,Menlo,monospace; }
  .lead { color:#8b949e; font:14px/1.6 -apple-system,system-ui,sans-serif; margin:0 0 22px; } .lead b{color:#e6edf3;}
  .term { background:#0d1117; border-radius:9px; padding:16px 18px; margin:0 0 22px; overflow-x:auto; box-shadow:0 8px 28px rgba(0,0,0,.45); position:relative; }
  .w { position:absolute; top:8px; right:12px; color:#4b5563; font-size:11px; }
  .ln { white-space:pre; color:${T.fg}; }
</style>
<div class="wrap">
  <p class="lead">Header redesign — the <b>SHADOW</b> wordmark stays hard-left; the <b>info + version block moves to the far right</b> and hugs the screen edge. As the terminal widens, the block slides right with it. Two widths shown; the composer border is drawn for context.</p>
  ${render(120)}
  ${render(96)}
  ${render(72)}
</div>`;
writeFileSync(process.argv[2] || 'header.html', page);
console.log('wrote', process.argv[2]);
