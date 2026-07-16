// Renders a full-coverage markdown sample through the REAL pipeline (parseMarkdown → flattenItem →
// spans) to HTML, so we can audit every element's rendering + contrast. Run: npx tsx scripts/demo-markdown.ts <out>
import { writeFileSync } from 'node:fs';
import { flattenItem } from '../src/tui/flatten.js';
import type { StyledSpan } from '../src/tui/flatten.js';

const T = { fg: '#e6edf3', dim: '#9aa4b2', green: '#3fb950', cyan: '#58c8f2', yellow: '#e3b341', red: '#f85149', purple: '#bc8cff', codeBg: '#2d333b' };
const COLS = 78;

const SAMPLE = `# Heading level 1
## Heading level 2
### Heading level 3

A normal paragraph with **bold**, *italic*, \`inline code\`, and a [link](https://example.com) in it. It wraps across the available width so we can see how reflow looks against the left margin.

- First bullet item
- Second bullet, a bit longer so it wraps to a second line and we can check the hanging indent
  - Nested bullet A
  - Nested bullet B
- Third bullet

1. First numbered step
2. Second numbered step
3. Third numbered step

> A blockquote line about something important.
> It continues onto a second line.

\`\`\`ts
function greet(name: string): string {
  // say hello
  return \`Hello, \${name}!\`;
}
\`\`\`

| Feature | Status | Notes |
|---------|:------:|------:|
| Tables  | ✅ done | aligned |
| Lists   | ✅ done | nested  |

---

A closing paragraph after a horizontal rule.`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const span = (s: StyledSpan) => {
  const st: string[] = [];
  if (s.color) st.push(`color:${s.color}`);
  if (s.bg) st.push(`background:${s.bg};border-radius:3px`);
  if (s.bold) st.push('font-weight:700');
  if (s.italic) st.push('font-style:italic');
  return `<span style="${st.join(';')}">${esc(s.text) || '&nbsp;'}</span>`;
};

const rows = flattenItem({ id: 1, kind: 'assistant', text: SAMPLE }, COLS, false, T);
const body = rows.map((r) => `<div class="ln">${r.spans.map(span).join('') || '&nbsp;'}</div>`).join('');

const page = `<style>
  .wrap { max-width:820px; margin:0 auto; }
  .lead { color:#8b949e; font:14px/1.6 -apple-system,system-ui,sans-serif; margin:0 0 16px; }
  .term { background:#0d1117; border-radius:9px; padding:18px 20px; font:14px/1.55 ui-monospace,Menlo,monospace; color:${T.fg}; overflow-x:auto; box-shadow:0 8px 28px rgba(0,0,0,.45); }
  .ln { white-space:pre; }
  .src { background:#161b22; border-radius:9px; padding:14px 18px; margin-top:18px; font:12px/1.5 ui-monospace,Menlo,monospace; color:#8b949e; white-space:pre-wrap; }
</style>
<div class="wrap">
  <p class="lead">Current markdown rendering — every element through the real <code>flattenItem</code> pipeline (pinned renderer). Audit target: headings, lists (incl. nested), blockquote, code block, inline code, links, table, and the horizontal rule.</p>
  <div class="term">${body}</div>
</div>`;
writeFileSync(process.argv[2] || 'markdown.html', page);
console.log('wrote', process.argv[2]);
