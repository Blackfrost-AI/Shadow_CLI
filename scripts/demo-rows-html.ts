// Emits the Phase-A demo transcript as an HTML file with the REAL ADA colors, so the redesign can
// be eyeballed without a terminal. Run: npx tsx scripts/demo-rows-html.ts <outpath>
import { writeFileSync } from 'node:fs';
import { flattenItem } from '../src/tui/flatten.js';
import type { FlattenItem, StyledSpan } from '../src/tui/flatten.js';

const THEME = {
  fg: '#ffffff', dim: '#b6bcc3', green: '#22c55e', cyan: '#38bdf8',
  yellow: '#eab308', red: '#ef4444', purple: '#a78bfa',
};
const COLS = 92;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const spanHtml = (s: StyledSpan) => {
  const st: string[] = [];
  if (s.color) st.push(`color:${s.color}`);
  if (s.bold) st.push('font-weight:700');
  if (s.italic) st.push('font-style:italic');
  return `<span style="${st.join(';')}">${esc(s.text) || '&nbsp;'}</span>`;
};

const items: { item: FlattenItem; collapsed?: boolean }[] = [
  { item: { id: 1, kind: 'banner', text: 'Shadow', brand: { version: '1.0.0-rc.11', providerModel: 'openai/LUMIX-35B', workspace: '~/projects/app', help: '/help · /model · Shift+Tab mode', yolo: true } } },
  { item: { id: 2, kind: 'user', text: '❯ add a health-check endpoint and run the tests' } },
  { item: { id: 3, kind: 'reasoning', text: 'The user wants a /health route.\nAdd it to the router, then run the suite.' }, collapsed: true },
  { item: { id: 4, kind: 'assistant', text: "I'll add a `GET /health` route and verify.\n\n1. Register the handler\n2. Return `{ status: 'ok' }`\n3. Run the tests" } },
  { item: { id: 5, kind: 'tool', text: '', tool: { name: 'edit', arg: 'src/router.ts', ok: true, durationMs: 120, summary: '+8 −0' } } },
  { item: { id: 6, kind: 'tool', text: '', tool: { name: 'run_shell', arg: 'npm test', ok: true, durationMs: 10200, summary: '644 pass' } } },
  { item: { id: 7, kind: 'tool', text: '', meta: 'output', lines: Array.from({ length: 29 }, (_, i) => ({ text: `line ${i}` })) }, collapsed: true },
  { item: { id: 8, kind: 'tool', text: '', tool: { name: 'web_fetch', arg: 'example.com/api', ok: false, durationMs: 400, summary: '404 Not Found' } } },
  { item: { id: 9, kind: 'assistant', text: 'Done — the endpoint is live and all **644** tests pass.' } },
];

const rows: string[] = [];
for (const { item, collapsed } of items)
  for (const row of flattenItem(item, COLS, collapsed ?? false, THEME))
    rows.push(`<div class="ln">${row.spans.map(spanHtml).join('') || '&nbsp;'}</div>`);

const html = `<div style="background:#0d1117;padding:20px 24px;border-radius:10px;font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;color:${THEME.fg};overflow-x:auto"><div style="color:#6b7280;font-size:12px;margin-bottom:12px">Shadow TUI v2 — Phase A (brand · tools · reasoning), rendered through flattenItem → the pinned renderer path</div>${rows.join('')}</div>`;
writeFileSync(process.argv[2] || 'phaseA.html', html);
console.log('wrote', process.argv[2]);
