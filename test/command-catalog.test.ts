import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TERMINAL_COMMANDS,
  findTerminalCommand,
  terminalCommandsFor,
  type TerminalRenderer,
} from '../src/tui/commandCatalog.js';

const RENDERERS = ['ink', 'pi'] as const satisfies readonly TerminalRenderer[];

function switchCases(relativePath: string): Set<string> {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  return new Set([...source.matchAll(/case\s+['"]\/([^'"]+)['"]\s*:/g)].map((match) => match[1]!));
}

test('terminal command names are unique and aliases resolve to compatible targets', () => {
  const names = TERMINAL_COMMANDS.map((command) => command.name);
  assert.equal(new Set(names).size, names.length, 'command names must be unique');

  for (const command of TERMINAL_COMMANDS) {
    if (!command.dispatch) continue;
    assert.notEqual(command.dispatch, command.name, `${command.name} cannot alias itself`);
    const target = findTerminalCommand(command.dispatch);
    assert.ok(target, `${command.name} aliases missing target ${command.dispatch}`);
    for (const renderer of RENDERERS) {
      assert.equal(
        command.renderers[renderer].handler,
        target.renderers[renderer].handler,
        `${command.name} and ${command.dispatch} must dispatch alike in ${renderer}`,
      );
    }
  }
});

test('every command declares exactly one capability outcome per renderer', () => {
  for (const command of TERMINAL_COMMANDS) {
    for (const renderer of RENDERERS) {
      const capability = command.renderers[renderer];
      const hasHandler = typeof capability.handler === 'string' && capability.handler.trim().length > 0;
      const hasUnavailable =
        typeof capability.unavailable === 'string' && capability.unavailable.trim().length > 0;
      assert.notEqual(
        hasHandler,
        hasUnavailable,
        `${command.name} must declare exactly one of handler or unavailable for ${renderer}`,
      );
    }
  }
});

test('every advertised handler has a concrete renderer switch route', () => {
  const routes: Record<TerminalRenderer, Set<string>> = {
    ink: switchCases('../src/tui/slash.ts'),
    pi: switchCases('../src/app/app.ts'),
  };
  for (const renderer of RENDERERS) {
    const handlers = new Set(
      terminalCommandsFor(renderer).map((command) => command.renderers[renderer].handler!),
    );
    for (const handler of handlers) {
      assert.ok(routes[renderer].has(handler), `${renderer} advertises /${handler} without a switch route`);
    }
  }
});

test('pi advertises the daily command surface and the fork/editor decisions', () => {
  const piNames = new Set(terminalCommandsFor('pi').map((command) => command.name));
  const expected = [
    '/compact',
    '/config',
    '/model',
    '/provider',
    '/local',
    '/mcp',
    '/plugins',
    '/memory',
    '/status',
    '/doctor',
    '/sessions',
    '/fork',
    '/editor',
    '/keybindings',
  ];
  for (const name of expected) assert.ok(piNames.has(name), `${name} must be reachable in pi`);
});

test('pi rejects Ink-only commands and documents the table collaboration migration', () => {
  const piNames = new Set(terminalCommandsFor('pi').map((command) => command.name));
  for (const name of ['/vim', '/statusline']) {
    const command = findTerminalCommand(name);
    assert.ok(command, `${name} must remain documented in the shared catalog`);
    assert.equal(command.renderers.pi.handler, undefined);
    assert.match(command.renderers.pi.unavailable ?? '', /Ink-only/);
    assert.equal(piNames.has(name), false, `${name} must not appear as a supported pi command`);
  }
  const table = findTerminalCommand('/table')!;
  assert.equal(table.renderers.pi.handler, 'table');
  assert.equal(table.renderers.ink.handler, 'table');
  assert.match(table.desc, /Snowfall presets.*Ink roundtable/);
  for (const name of ['/table', '/team', '/consult']) assert.ok(piNames.has(name), `${name} is offered in Snowfall`);
  assert.match(findTerminalCommand('/team')!.renderers.ink.unavailable ?? '', /native|collaborate/);
});

test('/session has one catalog entry and /act is a reachable activity alias', () => {
  assert.equal(TERMINAL_COMMANDS.filter((command) => command.name === '/session').length, 1);

  const act = findTerminalCommand('/act');
  assert.ok(act);
  assert.equal(act.dispatch, '/activity');
  assert.equal(act.renderers.pi.handler, 'activity');
  assert.ok(terminalCommandsFor('pi').some((command) => command.name === '/act'));
});
