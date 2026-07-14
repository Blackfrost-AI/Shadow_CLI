/**
 * Presentation helpers for GFM tables in the TUI.
 * Keeps border chrome (┌─┤│└) dim while header/body cell text stays readable.
 */

export type TableSegKind = 'border' | 'text';

export interface TableLineSeg {
  kind: TableSegKind;
  text: string;
}

/** True for full horizontal rule rows of a box-drawing grid. */
export function isTableRuleLine(line: string): boolean {
  return /^[┌├└]/.test(line);
}

/**
 * Split a rendered table line into border vs text segments so the flattener / Ink
 * path can color pipes and rules dim without dimming cell content.
 * Vertical-fallback lines (`— row N —`, `key: value`) are a single text segment.
 */
export function segmentTableLine(line: string): TableLineSeg[] {
  if (isTableRuleLine(line)) return [{ kind: 'border', text: line }];
  if (!line.includes('│')) return [{ kind: 'text', text: line }];
  const segs: TableLineSeg[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '│') {
      segs.push({ kind: 'border', text: '│' });
      i++;
      continue;
    }
    let j = i;
    while (j < line.length && line[j] !== '│') j++;
    segs.push({ kind: 'text', text: line.slice(i, j) });
    i = j;
  }
  return segs;
}

/** Body-row count above this folds to a one-line summary (Ctrl-O expands). */
export const TABLE_COLLAPSE_THRESHOLD = 8;
