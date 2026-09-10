import React, { useCallback, useRef, useState } from 'react';
import { Box, Text, type Key } from 'ink';
import {
  ActivityHistory,
  activityLabel,
  type ActivityEntry,
  type ActivitySummary,
} from './activity.js';
import { takeByWidth } from '../util/width.js';
import { wrapSpans } from './flatten.js';
import { C } from './theme.js';
import { PAGE_MARGIN } from './chrome.js';

interface View {
  level: 'groups' | 'entries' | 'body';
  groups: ActivitySummary[];
  groupIndex: number;
  entries: ActivityEntry[];
  entryIndex: number;
  body: string[];
  offset: number;
}

/** A frozen snapshot while reading. New events never move selection or the reading position. */
export function useActivityView(history: ActivityHistory, cols: number, rows: number) {
  const [view, setView] = useState<View | null>(null);
  const ref = useRef(view);
  const set = useCallback((next: View | null) => {
    ref.current = next;
    setView(next);
  }, []);
  const dismiss = useCallback(() => set(null), [set]);
  const open = useCallback(
    (groupId?: number, latest = false) => {
      const groups = history.list();
      const found =
        groupId === undefined ? groups.length - 1 : groups.findIndex((g) => g.id === groupId);
      if (groupId !== undefined && found < 0) return false;
      const groupIndex = Math.max(0, found);
      const entries = groups[groupIndex] ? history.entries(groups[groupIndex]!.id) : [];
      const entryIndex = Math.max(0, entries.length - 1);
      set({
        level: latest && entries.length ? 'body' : groupId === undefined ? 'groups' : 'entries',
        groups,
        groupIndex,
        entries,
        entryIndex,
        offset: 0,
        body:
          latest && entries[entryIndex] ? history.read(entries[entryIndex]!.id).split('\n') : [],
      });
      return true;
    },
    [history, set],
  );
  const handleKey = useCallback(
    (ch: string, key: Key): boolean => {
      const v = ref.current;
      if (!v) return false;
      if (ch === 'q' || (key.ctrl && ch === 'o')) {
        dismiss();
        return true;
      }
      if (key.escape || key.leftArrow) {
        if (v.level === 'groups') dismiss();
        else set({ ...v, level: v.level === 'body' ? 'entries' : 'groups', offset: 0, body: [] });
        return true;
      }
      // Refresh is explicit; the current pane otherwise remains a stable snapshot.
      if (ch === 'r' && v.level === 'groups') {
        open();
        return true;
      }
      if (key.return || key.rightArrow) {
        if (v.level === 'groups' && v.groups[v.groupIndex]) {
          const entries = history.entries(v.groups[v.groupIndex]!.id);
          set({ ...v, entries, entryIndex: 0, level: 'entries', offset: 0 });
        } else if (v.level === 'entries' && v.entries[v.entryIndex]) {
          set({
            ...v,
            body: history.read(v.entries[v.entryIndex]!.id).split('\n'),
            level: 'body',
            offset: 0,
          });
        }
        return true;
      }
      const page = Math.max(1, rows - 6);
      const step = key.pageDown
        ? page
        : key.pageUp
          ? -page
          : key.downArrow || ch === 'j' || (key.tab && !key.shift)
            ? 1
            : key.upArrow || ch === 'k' || key.tab
              ? -1
              : 0;
      const start = ch === 'g';
      const end = ch === 'G';
      if (step || start || end) {
        if (v.level === 'body') {
          const length = detailLines(v.body, cols).length;
          set({
            ...v,
            offset: Math.max(
              0,
              Math.min(Math.max(0, length - page), end ? length : start ? 0 : v.offset + step),
            ),
          });
        } else {
          const field = v.level === 'groups' ? 'groupIndex' : 'entryIndex';
          const length = v.level === 'groups' ? v.groups.length : v.entries.length;
          set({
            ...v,
            [field]: Math.max(
              0,
              Math.min(length - 1, end ? length - 1 : start ? 0 : v[field] + step),
            ),
          });
        }
      }
      return true; // typing in details never edits or submits the composer draft
    },
    [cols, rows, history, dismiss, open, set],
  );
  return { view, ref, open, dismiss, handleKey };
}

// Reuse the width-aware terminal wrapper. Cache a viewed document's width variants so scrolling
// doesn't parse/wrap thousands of lines on every keystroke. Only the open body is retained.
const wrappedBodies = new WeakMap<string[], { width: number; lines: string[] }>();
function detailLines(body: string[], cols: number): string[] {
  const width = Math.max(1, cols - PAGE_MARGIN - 4);
  const cached = wrappedBodies.get(body);
  if (cached?.width === width) return cached.lines;
  const lines = body.flatMap((line) =>
    wrapSpans([{ text: line }], width).map((spans) => spans.map((s) => s.text).join('')),
  );
  wrappedBodies.set(body, { width, lines });
  return lines;
}

export function ActivityOverlay({ view, cols, rows }: { view: View; cols: number; rows: number }) {
  const page = Math.max(1, rows - 6);
  const group = view.groups[view.groupIndex];
  const title =
    view.level === 'groups'
      ? 'Activity'
      : view.level === 'entries'
        ? `Activity ${group?.id ?? ''}`
        : (view.entries[view.entryIndex]?.title ?? 'Output');
  const items =
    view.level === 'groups'
      ? view.groups.map(
          (g) =>
            `${g.id}. [${g.closed ? (g.failed ? 'FAILED' : 'DONE') : 'RUNNING'}] ${activityLabel(g)}${g.thoughts ? ` · ${g.thoughts} thinking steps` : ''}`,
        )
      : view.entries.map((e) => e.title);
  const selected = view.level === 'groups' ? view.groupIndex : view.entryIndex;
  const body = view.level === 'body' ? detailLines(view.body, cols) : items;
  const start =
    view.level === 'body'
      ? Math.min(view.offset, Math.max(0, body.length - page))
      : Math.max(0, selected - page + 1);
  const lines: { text: string; focused?: boolean; heading?: boolean }[] = [
    { text: title, heading: true },
    { text: 'Snapshot · work continues while you read' },
    ...body
      .slice(start, start + page)
      .map((text, i) => ({
        text: `${view.level !== 'body' && start + i === selected ? '> ' : '  '}${text}`,
        focused: view.level !== 'body' && start + i === selected,
      })),
    ...(body.length ? [] : [{ text: 'No activity yet.' }]),
    {
      text: `${body.length ? start + 1 : 0}–${Math.min(body.length, start + page)} of ${body.length} · ↑/↓ scroll · Enter open`,
    },
    { text: 'Esc back · q close · PgUp/PgDn page · g/G first/last · r refresh list' },
  ];
  return (
    <Box flexDirection="column" paddingLeft={PAGE_MARGIN}>
      {lines.slice(0, Math.max(1, rows - 1)).map((line, i) => (
        <Text
          key={i}
          wrap="truncate"
          bold={line.heading || line.focused}
          color={line.heading || line.focused ? C.fg : C.dim}
          backgroundColor={line.focused ? C.menuSelBg : undefined}
        >
          {takeByWidth(line.text, Math.max(1, cols - PAGE_MARGIN - 1)).head}
        </Text>
      ))}
    </Box>
  );
}
