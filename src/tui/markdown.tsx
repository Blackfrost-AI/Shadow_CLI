// src/tui/markdown.tsx — live Markdown preview renderer (extracted from tui.tsx, plan 2.4).
// Committed transcript items render through flatten.ts/FlatItem; this is the streaming preview.
import React from 'react';
import { Box, Text } from 'ink';
import { parseMarkdown, renderTableLines, wrapSpans, type MdSpan } from '../util/markdown.js';
import { highlight, type CodeRole } from '../util/highlight.js';
import { CHART_LANGS, parseChartSpec, renderChart } from '../util/chart.js';
import { C } from './theme.js';

/** Inline run: bold / italic / inline-code spans rendered within one line. */
function Inline({ spans, color, dim, bold }: { spans: MdSpan[]; color?: string; dim?: boolean; bold?: boolean }) {
  return (
    <Text color={dim ? C.dim : color} bold={bold}>
      {spans.map((s, i) => (
        <Text key={i} color={s.code ? C.cyan : dim ? C.dim : color} bold={bold || s.bold} italic={s.italic}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

/** Map a highlighter token role to a canvas color (comments are dimmed separately). */
function codeRoleColor(role: CodeRole): string | undefined {
  switch (role) {
    case 'keyword':
      return C.purple;
    case 'string':
      return C.green;
    case 'number':
      return C.yellow;
    case 'comment':
      return C.dim; // ADA-readable gray (was Ink dimColor faint, which blended into the bg)
    case 'plain':
    default:
      return undefined; // default foreground (white)
  }
}

/** Cap assistant prose to a readable measure so lines don't run edge-to-edge on wide terminals,
 *  and cap it IDENTICALLY for the streaming and committed renders so a finished turn never reflows.
 *  The `width` prop now constrains the whole block (previously it only reached table layout, so prose
 *  wrapped at the full pane width). */
export const PROSE_MAX_COLS = 100;

export function Markdown({ source, color = C.fg, width = PROSE_MAX_COLS }: { source: string; color?: string; width?: number }) {
  const blocks = parseMarkdown(source);
  return (
    <Box flexDirection="column" width={width}>
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'heading':
            return (
              <Box key={i} marginTop={i === 0 ? 0 : 1}>
                <Inline spans={b.spans} color={C.purple} bold />
              </Box>
            );
          case 'paragraph':
            return (
              <Box key={i} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
                {wrapSpans(b.spans, width).map((ln, k) => (
                  <Inline key={k} spans={ln} color={color} />
                ))}
              </Box>
            );
          case 'list': {
            // Mirror flatten.ts's list rendering so the LIVE preview matches the committed block: a
            // dedicated ordinal advances only for top-level ordered items (a nested bullet must not
            // inflate the next number), and depth drives the bullet glyph + indent.
            const bullets = ['•', '◦', '▪', '‣'];
            let ordinal = b.start ?? 1;
            return (
              <Box key={i} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
                {b.items.map((it, j) => {
                  const depth = b.depths?.[j] ?? 0;
                  const indent = '  '.repeat(depth);
                  const marker =
                    b.ordered && depth === 0
                      ? `${ordinal++}. `
                      : `${bullets[Math.min(depth, bullets.length - 1)]} `;
                  const lead = indent + marker;
                  const wrapped = wrapSpans(it, Math.max(1, width - lead.length));
                  return (
                    <Box key={j} flexDirection="column">
                      {wrapped.map((ln, k) => (
                        <Box key={k}>
                          <Text color={color}>{k === 0 ? lead : ' '.repeat(lead.length)}</Text>
                          <Inline spans={ln} color={color} />
                        </Box>
                      ))}
                    </Box>
                  );
                })}
              </Box>
            );
          }
          case 'quote':
            return (
              <Box key={i} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
                {wrapSpans(b.spans, Math.max(1, width - 2)).map((ln, k) => (
                  <Box key={k}>
                    <Text color={C.yellow}>│ </Text>
                    <Inline spans={ln} color={color} dim />
                  </Box>
                ))}
              </Box>
            );
          case 'code': {
            // Closed ```chart|graph|spark fences preview as the real chart (same renderer as
            // the committed path); an open fence or unparseable spec stays a code block.
            if (b.closed && CHART_LANGS.has((b.lang || '').toLowerCase())) {
              const spec = parseChartSpec(b.code);
              if (spec) {
                const chartRows = renderChart(spec, Math.min(width, 72));
                return (
                  <Box key={i} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
                    {chartRows.map((spans, j) => (
                      <Text key={j} wrap="truncate">
                        {spans.map((s, k) => (
                          <Text
                            key={k}
                            color={s.role === 'title' ? C.bright : s.role === 'label' ? C.fg : s.role === 'bar' ? C.cyan : C.dim}
                            bold={s.role === 'title'}
                          >
                            {s.text}
                          </Text>
                        ))}
                      </Text>
                    ))}
                  </Box>
                );
              }
            }
            // Quiet code — mirrors flatten.ts: dim lang label + │ gutter, NO Ink round border
            // (design law: one border in the app = the composer). Live preview ≡ committed.
            // Line-by-line so multi-line fences wrap correctly (role colors stay per token).
            const sourceLines = (b.code || ' ').split('\n');
            return (
              <Box key={i} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
                {b.lang ? <Text color={C.dim} italic>{b.lang}</Text> : null}
                {sourceLines.map((line, j) => {
                  const lineSpans = highlight(line || ' ', b.lang);
                  return (
                    <Box key={j}>
                      <Text color={C.dim}>{'│ '}</Text>
                      <Text>
                        {lineSpans.map((s, k) => (
                          <Text key={k} color={codeRoleColor(s.role)}>
                            {s.text}
                          </Text>
                        ))}
                      </Text>
                    </Box>
                  );
                })}
              </Box>
            );
          }
          case 'rule':
            return (
              <Box key={i} marginTop={i === 0 ? 0 : 1}>
                <Text color={C.dim}>{'─'.repeat(Math.max(1, width))}</Text>
              </Box>
            );
          case 'table': {
            // Live preview: full grid with dim chrome (same as committed flatten path). Large-table
            // folding is a committed-transcript concern (Ctrl-O); the live slot is already ≤2 rows.
            const lines = renderTableLines(b, width);
            const isGrid = /^[╭┌]/.test(lines[0] ?? '');
            const sepIdx = isGrid ? lines.findIndex((l) => l.startsWith('├')) : -1;
            return (
              <Box key={i} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
                {lines.map((l, j) => {
                  const isHeader = isGrid && j > 0 && (sepIdx < 0 || j < sepIdx);
                  if (l.startsWith('—') || /^[╭┌├╰└]/.test(l)) {
                    return <Text key={j} color={C.dim}>{l}</Text>;
                  }
                  if (!l.includes('│')) {
                    return <Text key={j} color={color} bold={isHeader}>{l}</Text>;
                  }
                  // Dim │ pipes; bold+bright header cells, body in answer color.
                  const parts: React.ReactNode[] = [];
                  let k = 0;
                  let pi = 0;
                  while (k < l.length) {
                    if (l[k] === '│') {
                      parts.push(<Text key={pi++} color={C.dim}>│</Text>);
                      k++;
                    } else {
                      let e = k;
                      while (e < l.length && l[e] !== '│') e++;
                      const cell = l.slice(k, e);
                      parts.push(
                        <Text key={pi++} color={isHeader ? C.fg : color} bold={isHeader}>
                          {cell}
                        </Text>,
                      );
                      k = e;
                    }
                  }
                  return <Text key={j}>{parts}</Text>;
                })}
              </Box>
            );
          }
        }
      })}
    </Box>
  );
}
