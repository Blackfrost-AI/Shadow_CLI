/**
 * Hierarchical command menu for the Snowfall `/menu` overlay (11.7.0, OMP parity).
 *
 * OMP's repository menu / submenus come from a native docked-picker tree. Shadow's `/`
 * autocomplete stays the fast type-and-filter path; this module adds a browsable, grouped
 * menu with drill-in submenus on top of the same command catalog. The tree is pure data so
 * it can be unit-tested without a terminal; the overlay (menuOverlay.ts) renders it.
 *
 * Leaf nodes carry a `command` that is dispatched through the existing runSlash path, so
 * every menu action reuses the exact handler the typed slash command uses — no parallel
 * implementation to drift.
 */
import { findTerminalCommand } from '../tui/commandCatalog.js';

export interface MenuLeaf {
  kind: 'command';
  /** Slash command dispatched via runSlash, e.g. '/model'. */
  command: string;
  label: string;
  detail?: string;
}

export interface MenuBranch {
  kind: 'submenu';
  id: string;
  label: string;
  detail?: string;
  children: MenuNode[];
}

export type MenuNode = MenuLeaf | MenuBranch;

/** Build a command leaf, pulling the description from the catalog when present. */
function cmd(name: string, labelOverride?: string): MenuLeaf {
  const s = findTerminalCommand(name);
  return {
    kind: 'command',
    command: name,
    label: labelOverride ?? name,
    detail: s?.desc,
  };
}

function branch(id: string, label: string, detail: string, children: MenuNode[]): MenuBranch {
  return { kind: 'submenu', id, label, detail, children };
}

/**
 * The root menu. Categories mirror how operators think about the tool, not the flat
 * alphabetical catalog. The Repository submenu is the OMP-parity centerpiece: a file
 * browser plus the git actions Shadow already ships (/diff, /review).
 */
export function buildMenuTree(): MenuNode[] {
  return [
    branch('repository', 'Repository', 'Browse files, diff, and review changes', [
      cmd('/repo', 'Browse files…'),
      cmd('/diff', 'Diff & branch'),
      cmd('/review', 'Review changes'),
    ]),
    branch('session', 'Session', 'Resume, export, rewind, and compact', [
      cmd('/resume'),
      cmd('/sessions'),
      cmd('/export'),
      cmd('/rewind'),
      cmd('/compact'),
      cmd('/clear'),
    ]),
    branch('models', 'Models & effort', 'Switch model, role, and reasoning effort', [
      cmd('/model'),
      cmd('/role', 'Model role…'),
      cmd('/effort'),
      cmd('/fast'),
      cmd('/provider'),
    ]),
    branch('work', 'Work & agents', 'Background jobs, tasks, and collaboration', [
      cmd('/work'),
      cmd('/jobs'),
      cmd('/tasks'),
      cmd('/team'),
      cmd('/consult'),
    ]),
    branch('planning', 'Planning', 'Goal mode and plan mode', [
      cmd('/goal'),
      cmd('/plan'),
    ]),
    branch('config', 'Config & safety', 'Autonomy, permissions, hooks, and privacy', [
      cmd('/autonomy'),
      cmd('/permissions'),
      cmd('/hooks'),
      cmd('/plugins'),
      cmd('/mcp'),
      cmd('/connections'),
    ]),
    branch('help', 'Help & info', 'Cost, status, and diagnostics', [
      cmd('/cost'),
      cmd('/stats'),
      cmd('/doctor'),
      cmd('/help'),
    ]),
  ];
}

/** Resolve a node by id path (e.g. ['repository']) from the root. Returns undefined if missing. */
export function resolveMenuPath(root: MenuNode[], path: string[]): MenuNode[] | undefined {
  let level = root;
  for (const id of path) {
    const next = level.find((n) => n.kind === 'submenu' && n.id === id);
    if (!next || next.kind !== 'submenu') return undefined;
    level = next.children;
  }
  return level;
}

/** Breadcrumb labels for a path (root → … → current), for the overlay header. */
export function menuBreadcrumb(root: MenuNode[], path: string[]): string[] {
  const crumbs = ['Menu'];
  let level = root;
  for (const id of path) {
    const next = level.find((n) => n.kind === 'submenu' && n.id === id);
    if (!next || next.kind !== 'submenu') break;
    crumbs.push(next.label);
    level = next.children;
  }
  return crumbs;
}