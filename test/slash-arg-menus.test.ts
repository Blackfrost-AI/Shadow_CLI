import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { TuiApp, type TuiOpts } from '../src/tui.js';
import { EventBus } from '../src/agent/events.js';

/**
 * Argument menus, driven through the REAL <TuiApp>: typing `/cmd ` must open an arrow-key list of
 * that command's arguments. Static vocabularies are a table; the interesting ones are DYNAMIC
 * (your model presets, your sessions, your turns), which is why a completion may be a function of
 * the live session rather than a constant.
 */
function makeOpts(over: Partial<TuiOpts> = {}): TuiOpts {
  return {
    provider: {} as TuiOpts['provider'],
    registry: {} as TuiOpts['registry'],
    bus: new EventBus(),
    context: {} as TuiOpts['context'],
    sessionLog: { record() {} } as unknown as TuiOpts['sessionLog'],
    system: '',
    workspaceRoot: '/tmp/ws-no-sessions',
    cfg: {
      provider: 'mock',
      model: 'm',
      mouse: false,
      models: [
        { label: 'Opus', provider: 'anthropic', model: 'claude-opus-4-8' },
        { label: 'MyLocalMlx', provider: 'openai', model: '/models/x', mlx: '/models/x' },
        { label: 'Retired', provider: 'openai', model: 'old', disabled: true },
      ],
    } as unknown as TuiOpts['cfg'],
    autonomy: 'auto-edit',
    bypass: false,
    version: '9.9.9',
    ...over,
  };
}

const FLUSH_MS = 90;

async function mount(t: { after: (fn: () => void) => void }, over: Partial<TuiOpts> = {}) {
  const { lastFrame, stdin, unmount } = render(React.createElement(TuiApp, { opts: makeOpts(over) }));
  await new Promise((r) => setTimeout(r, 120)); // let the welcome card settle
  const type = async (s: string): Promise<string> => {
    stdin.write(s);
    await new Promise((r) => setTimeout(r, FLUSH_MS));
    return (lastFrame() ?? '').replace(/\x1b\[[0-9;]*m/g, '');
  };
  t.after(() => unmount());
  return { type };
}

test('/vim opens an on/off menu and marks which way it currently points', async (t) => {
  const { type } = await mount(t);
  const frame = await type('/vim ');
  assert.match(frame, /\/vim on/, 'offers on');
  assert.match(frame, /\/vim off/, 'offers off');
  assert.match(frame, /✓ current/, 'shows the live setting as a status readout');
});

test('/fast gets the on/off treatment', async (t) => {
  const b = await mount(t);
  assert.match(await b.type('/fast '), /\/fast on[\s\S]*\/fast off/);
});

test('there is deliberately NO /mouse command', async (t) => {
  // Mouse reporting steals the wheel from the terminal, and native scrollback is not negotiable
  // in this TUI. It shipped on-by-default in 3.6.0 and stranded terminals in reporting mode; the
  // toggle is gone entirely rather than left as a foot-gun. Opt in per-run with SHADOW_MOUSE=1.
  const { type } = await mount(t);
  const frame = await type('/mou');
  assert.doesNotMatch(frame, /\/mouse/, 'the command must not appear in the slash menu');
});

test('/permissions offers its real verbs — no invented ones', async (t) => {
  const { type } = await mount(t);
  const frame = await type('/permissions ');
  // These are exactly the verbs applyPermissionCommand accepts; a completion the command then
  // rejects is worse than no completion at all.
  for (const verb of ['list', 'add', 'remove', 'set', 'clear']) {
    assert.match(frame, new RegExp(`/permissions ${verb}\\b`), `offers ${verb}`);
  }
});

test('/model lists your configured presets, and hides disabled ones', async (t) => {
  const { type } = await mount(t);
  const frame = await type('/model ');
  assert.match(frame, /\/model list/, 'keeps the verbs');
  assert.match(frame, /\/model Opus/, 'offers a real preset by label');
  assert.match(frame, /\/model MyLocalMlx/, 'including local ones');
  assert.doesNotMatch(frame, /\/model Retired/, 'a disabled preset is not selectable');
});

test('/local offers its registered local models by name', async (t) => {
  const { type } = await mount(t);
  const frame = await type('/local ');
  assert.match(frame, /\/local add/, 'keeps the verbs');
  // The whole point: `/local use <name>` should never need the name typed from memory — that is
  // what made a hash-labelled preset effectively unreachable.
  assert.match(frame, /\/local use MyLocalMlx/);
  assert.doesNotMatch(frame, /\/local use Opus/, 'a cloud preset is not a local model');
});

test('/rewind with no turns yet shows a hint row instead of a bogus turn list', async (t) => {
  const { type } = await mount(t);
  const frame = await type('/rewind ');
  assert.match(frame, /Nothing to rewind to yet/);
  // The hint must not present itself as a completable value.
  assert.doesNotMatch(frame, /\/rewind 0\b/);
});

test('/resume with no prior sessions shows a hint, not an empty box', async (t) => {
  const { type } = await mount(t);
  const frame = await type('/resume ');
  assert.match(frame, /No prior sessions in this workspace yet/);
});

test('a command with no argument vocabulary opens no argument menu', async (t) => {
  const { type } = await mount(t);
  const frame = await type('/status ');
  assert.doesNotMatch(frame, /pick an argument/);
});

test('typing a partial filters the argument menu', async (t) => {
  const { type } = await mount(t);
  const frame = await type('/permissions cl');
  assert.match(frame, /\/permissions clear/);
  assert.doesNotMatch(frame, /\/permissions add/, 'non-matching verbs are filtered out');
});
