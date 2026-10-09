// TUI visual demo — the founder-sign-off eyeball pass. Renders one representative
// transcript through the REAL renderer path (flattenItem → ANSI) under each theme
// that matters, so every visual claim in a TUI change can be checked in one look:
// ▌ user bars vs ⏺ answers, ✗ failed tools, rounded tables with ledger alignment,
// unicode charts (bar / braille line / spark), and the colorblind / high-contrast
// palettes. Run: npx tsx scripts/demo-tui.ts   (supersedes the retired demo-rows.ts,
// which drove the removed pinned renderer).
import { flattenItem, computeToolRuns } from '../src/tui/flatten.js';
import type { FlattenItem, StyledSpan, ViewportTheme } from '../src/tui/flatten.js';
import { applyTheme, paletteSnapshot, THEME_NAMES } from '../src/tui.js';

const COLS = Math.min(process.stdout.columns ?? 80, 92);

function sgr(s: StyledSpan): string {
  const codes: string[] = [];
  const rgb = (hex: string): string => {
    const n = parseInt(hex.slice(1), 16);
    return `${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}`;
  };
  if (s.bold) codes.push('1');
  if (s.italic) codes.push('3');
  if (s.dim) codes.push('2');
  if (s.color?.startsWith('#')) codes.push(`38;2;${rgb(s.color)}`);
  if (s.bg?.startsWith('#')) codes.push(`48;2;${rgb(s.bg)}`);
  if (!codes.length) return s.text;
  return `\x1b[${codes.join(';')}m${s.text}\x1b[0m`;
}

const ANSWER = [
  '# Deploy summary',
  '',
  'The `p95` spike traced to one region. Hold **ap-south**, continue elsewhere.',
  '',
  '## Hotfix',
  '',
  '```ts',
  'if (region === "ap-south") holdRollout = true;',
  'log.warn("holding ap-south");',
  '```',
  '',
  '| Region | Requests | Errors | Status |',
  '| --- | --- | --- | :--- |',
  '| us-east | 41,240 | 12 | ok |',
  '| eu-west | 8,890 | 3 | ok |',
  '| ap-south | 1,431 | 122 | degraded |',
  '',
  '```chart',
  'title: Requests by region',
  'us-east: 41,240',
  'eu-west: 8,890',
  'ap-south: 1,431',
  '```',
  '',
  '```chart',
  'type: line',
  'title: p95 latency (ms)',
  '120 140 180 320 900 640 380 260 200 180 170 165',
  '```',
  '',
  '```chart',
  'type: spark',
  '3 8 4 12 9 14 6 2 11 15 9 4',
  '```',
  '',
  'Full rollback steps in the [deploy runbook](https://example.com/runbook).',
  '',
  '> ap-south error budget is 61% consumed — hold the rollout there.',
].join('\n');

const ITEMS: { item: FlattenItem; collapsed?: boolean }[] = [
  { item: { id: 1, kind: 'user', text: '❯ why did latency spike after the deploy?\nand which regions are safe to continue?' } },
  { item: { id: 2, kind: 'reasoning', text: 'Check per-region metrics first.\nThen correlate with the deploy window.', durationMs: 9400 }, collapsed: true },
  // Recon burst: collapses to ONE "Read 2 files, Grep 1 pattern" row (Ctrl-O expands).
  { item: { id: 10, kind: 'tool', text: '', tool: { name: 'read_file', arg: 'src/metrics.ts', ok: true, durationMs: 40, summary: '412 lines' } } },
  { item: { id: 11, kind: 'tool', text: '', tool: { name: 'read_file', arg: 'src/deploy.ts', ok: true, durationMs: 35, summary: '280 lines' } } },
  { item: { id: 12, kind: 'tool', text: '', tool: { name: 'grep', arg: 'p95', ok: true, durationMs: 90, summary: '6 matches' } } },
  // Edit ALWAYS stays visible — never buried inside a tool stack.
  { item: { id: 13, kind: 'tool', text: '', meta: 'diff', tool: { name: 'edit_file', arg: 'src/deploy.ts', ok: true, durationMs: 120, summary: '+12 −3' }, lines: [
    { text: '- holdRollout = false', color: '#ef4444' },
    { text: '+ holdRollout = region === "ap-south"', color: '#22c55e' },
    { text: '+ log.warn("holding ap-south")', color: '#22c55e' },
  ] } },
  { item: { id: 3, kind: 'tool', text: '', tool: { name: 'run_shell', arg: 'shadow-metrics --by-region', ok: true, durationMs: 2300, summary: '3 regions' } } },
  { item: { id: 4, kind: 'tool', text: '', tool: { name: 'web_fetch', arg: 'status.internal/api', ok: false, durationMs: 400, summary: '404 Not Found' } } },
  // A delegated sub-agent renders distinctly (▸ type · description) instead of anonymous agent(…),
  // and its full answer is a foldable body (⌄ answer N lines · ^O) — no longer truncated away.
  { item: { id: 6, kind: 'tool', text: '', meta: 'answer', tool: { name: 'agent', arg: 'Correlate the deploy window with per-region error logs', ok: true, durationMs: 18400, summary: 'ap-south deploy lines up with the spike', agent: { subagentType: 'explore', description: 'Trace the deploy→error correlation' } }, lines: [
    { text: 'Correlated the 14:02 UTC deploy against per-region error logs:', dimColor: true },
    { text: '• us-east: errors flat (12 → 11) — deploy not causal.', dimColor: true },
    { text: '• eu-west: errors flat (3 → 3) — deploy not causal.', dimColor: true },
    { text: '• ap-south: errors 3 → 122 within 90s of the deploy.', dimColor: true },
    { text: '  Spike is bounded to ap-south and time-correlated to the rollout.', dimColor: true },
    { text: 'Recommend holding the rollout in ap-south; safe to continue elsewhere.', dimColor: true },
  ] } },
  { item: { id: 5, kind: 'assistant', text: ANSWER } },
  // Inline image (a fetched markdown ![](url) or /image echo): placeholder + terminal-native pixels.
  { item: { id: 8, kind: 'image', text: '🖼 deploy diagram', image: { bytes: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', mediaType: 'image/png', alt: 'deploy diagram', source: 'markdown' } } },
  // Per-task timer: total wall-clock the agent worked on this turn.
  { item: { id: 7, kind: 'system', text: '⏺ done · 47s', dimColor: true } },
];

const SHOW: string[] = ['og', 'colorblind', 'high-contrast', 'mono'];
for (const name of SHOW) {
  if (!(THEME_NAMES as readonly string[]).includes(name)) continue;
  applyTheme(name);
  const c = paletteSnapshot();
  const theme: ViewportTheme = {
    fg: c.body ?? c.fg!,
    bright: c.bright,
    dim: c.dim!,
    green: c.green!,
    cyan: c.cyan!,
    yellow: c.yellow!,
    red: c.red!,
    purple: c.purple!,
    user: c.user,
    accent: c.accent,
    codeBg: c.codeBg,
  };
  process.stdout.write(`\n\x1b[1m━━━ theme: ${name} ${'━'.repeat(Math.max(1, COLS - name.length - 12))}\x1b[0m\n`);
  // Read/search stacking defaults COLLAPSED (product default): recon becomes one
  // `Read N files, Grep M patterns` line; Update/Bash stay as their own rows. Ctrl-O expands.
  const runs = computeToolRuns(ITEMS.map((x) => x.item), false);
  ITEMS.forEach(({ item, collapsed }, i) => {
    for (const row of flattenItem(item, COLS, collapsed ?? true, theme, false, true, runs.get(i))) {
      process.stdout.write(row.spans.map(sgr).join('') + '\n');
    }
  });
}
applyTheme('og');
process.stdout.write('\n');
