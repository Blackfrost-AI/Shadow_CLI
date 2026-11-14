// Regression contract for the 11.7.0 grouped command menu (F4, OMP parity):
//   - menuTree data model: categories, repository submenu, path resolution, breadcrumb
//   - MenuOverlay navigation: drill-in, back, dispatch, close
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMenuTree, resolveMenuPath, menuBreadcrumb, type MenuNode } from '../src/app/menuTree.js';
import { MenuOverlay } from '../src/app/menuOverlay.js';
import { findTerminalCommand } from '../src/tui/commandCatalog.js';

const ENTER = '\r';
const ESC = '\x1b';
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const LEFT = '\x1b[D';

function fakeTui() {
  const calls = { renders: 0, hidden: 0 };
  const tui = {
    requestRender: () => { calls.renders++; },
    showOverlay: () => ({ hide: () => { calls.hidden++; } }),
  };
  return { tui: tui as never, calls };
}

// ── Data model ────────────────────────────────────────────────────────────────
test('menu tree has the expected top-level categories', () => {
  const root = buildMenuTree();
  const ids = root.filter((n): n is Extract<MenuNode, { kind: 'submenu' }> => n.kind === 'submenu').map((n) => n.id);
  for (const expected of ['repository', 'session', 'models', 'work', 'planning', 'config', 'help']) {
    assert.ok(ids.includes(expected), `missing category ${expected}`);
  }
});

test('every command leaf maps to a real catalog command', () => {
  const walk = (nodes: MenuNode[]): void => {
    for (const n of nodes) {
      if (n.kind === 'submenu') walk(n.children);
      else assert.ok(findTerminalCommand(n.command), `menu command ${n.command} not in catalog`);
    }
  };
  walk(buildMenuTree());
});

test('repository submenu contains the file browser + git actions', () => {
  const repo = resolveMenuPath(buildMenuTree(), ['repository']);
  assert.ok(repo);
  const commands = repo!.filter((n) => n.kind === 'command').map((n) => (n as { command: string }).command);
  assert.deepEqual(commands, ['/repo', '/diff', '/review']);
});

test('resolveMenuPath returns undefined for a bad path', () => {
  assert.equal(resolveMenuPath(buildMenuTree(), ['nope']), undefined);
  assert.equal(resolveMenuPath(buildMenuTree(), ['repository', 'nope']), undefined);
});

test('menuBreadcrumb builds root-to-current labels', () => {
  assert.deepEqual(menuBreadcrumb(buildMenuTree(), []), ['Menu']);
  assert.deepEqual(menuBreadcrumb(buildMenuTree(), ['repository']), ['Menu', 'Repository']);
});

// ── Overlay navigation ────────────────────────────────────────────────────────
test('Enter on a submenu drills in; Esc goes back; Esc at root closes', () => {
  const { tui, calls } = fakeTui();
  const dispatched: string[] = [];
  const menu = new MenuOverlay(tui, (c) => dispatched.push(c));
  menu.show();
  // Root: first item is Repository (a submenu). Enter drills in.
  menu.handleInput(ENTER);
  assert.match(menu.render(80).join('\n'), /Menu › Repository/);
  // Esc goes back to root.
  menu.handleInput(ESC);
  assert.match(menu.render(80).join('\n'), /Repository/);
  assert.doesNotMatch(menu.render(80).join('\n'), /Menu › Repository/);
  // Esc at root closes.
  menu.handleInput(ESC);
  assert.equal(calls.hidden, 1);
  assert.deepEqual(dispatched, []);
});

test('Enter on a command leaf dispatches it and closes the menu', () => {
  const { tui, calls } = fakeTui();
  const dispatched: string[] = [];
  const menu = new MenuOverlay(tui, (c) => dispatched.push(c));
  menu.show();
  menu.handleInput(ENTER); // into Repository
  menu.handleInput(ENTER); // first leaf = /repo
  assert.deepEqual(dispatched, ['/repo']);
  assert.equal(calls.hidden, 1);
});

test('arrow navigation moves the selection and dispatches the right command', () => {
  const { tui } = fakeTui();
  const dispatched: string[] = [];
  const menu = new MenuOverlay(tui, (c) => dispatched.push(c));
  menu.show();
  menu.handleInput(ENTER); // into Repository
  menu.handleInput(DOWN); // /repo -> /diff
  menu.handleInput(DOWN); // /diff -> /review
  menu.handleInput(ENTER);
  assert.deepEqual(dispatched, ['/review']);
});

test('left arrow goes back a level', () => {
  const { tui } = fakeTui();
  const menu = new MenuOverlay(tui, () => {});
  menu.show();
  menu.handleInput(ENTER); // into Repository
  assert.match(menu.render(80).join('\n'), /Menu › Repository/);
  menu.handleInput(LEFT); // back to root
  assert.doesNotMatch(menu.render(80).join('\n'), /Menu › Repository/);
});

test('up at the top stays at index 0 (no wrap)', () => {
  const { tui } = fakeTui();
  const dispatched: string[] = [];
  const menu = new MenuOverlay(tui, (c) => dispatched.push(c));
  menu.show();
  menu.handleInput(ENTER); // into Repository
  menu.handleInput(UP); // already at 0
  menu.handleInput(ENTER); // still /repo
  assert.deepEqual(dispatched, ['/repo']);
});