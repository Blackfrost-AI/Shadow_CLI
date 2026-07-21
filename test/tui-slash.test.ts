import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { TuiApp, type TuiOpts, applyTheme, paletteSnapshot, runStatusLine, imageMediaType } from '../src/tui.js';
import { EventBus } from '../src/agent/events.js';
import { Context } from '../src/agent/context.js';
import { PlanModeState } from '../src/agent/planMode.js';
import { TodoList } from '../src/agent/todo.js';

function makeOpts(over: Partial<TuiOpts> = {}): TuiOpts {
  return {
    provider: {} as TuiOpts['provider'],
    registry: {} as TuiOpts['registry'],
    bus: new EventBus(),
    context: new Context({ contextBudget: 1000, triggerRatio: 0.75, keepLastTurns: 6 }),
    sessionLog: { record() {} } as unknown as TuiOpts['sessionLog'],
    system: '',
    workspaceRoot: '/tmp',
    cfg: { provider: 'mock', model: 'm' } as unknown as TuiOpts['cfg'],
    autonomy: 'auto-edit',
    bypass: false,
    version: '9.9.9',
    ...over,
  };
}
const tick = () => new Promise((r) => setTimeout(r, 60));
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const strip = (s: string | undefined) => (s ?? '').replace(ANSI, '');

test('typing "/" opens the command menu with descriptions', async () => {
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts: makeOpts() }));
  await tick();
  stdin.write('/');
  await tick();
  let f = strip(lastFrame());
  assert.match(f, /\/help/);
  assert.match(f, /\/clear/);
  assert.match(f, /\/provider/);
  assert.match(f, /Show keybindings/, 'shows a description for each command');
  // The command list is capped to keep the menu short; filter to reach a late one.
  stdin.write('q'); // input → "/q"
  await tick();
  f = strip(lastFrame());
  assert.match(f, /\/quit/);
  unmount();
});

test('typing "/cl" filters the menu down to /clear', async () => {
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts: makeOpts() }));
  await tick();
  stdin.write('/');
  await tick();
  stdin.write('cl');
  await tick();
  const f = strip(lastFrame());
  assert.match(f, /\/clear/);
  // /autonomy is a non-matching command (and, unlike /help or /model, is not named in the
  // welcome card's tip line) so its absence cleanly proves the menu filtered it out.
  assert.doesNotMatch(f, /\/autonomy/, 'non-matching commands are filtered out');
  unmount();
});

test('left arrow moves the caret so input inserts mid-word', async () => {
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts: makeOpts() }));
  await tick();
  stdin.write('abc');
  await tick();
  stdin.write('\x1b[D'); // ← left
  await tick();
  stdin.write('\x1b[D'); // ← left  (caret now between 'a' and 'b')
  await tick();
  stdin.write('X');
  await tick();
  assert.match(strip(lastFrame()), /aXbc/, 'X inserted at the caret, not appended');
  unmount();
});

test('selecting a command from the menu executes it (Enter runs /help)', async () => {
  const { stdin, frames, unmount } = render(React.createElement(TuiApp, { opts: makeOpts() }));
  await tick();
  stdin.write('/help');
  await tick();
  stdin.write('\r'); // Enter runs the selected command (not sent to the agent)
  await tick();
  // The help block is taller than the short test viewport, so the transcript auto-follows
  // to the bottom — assert on the final help line (reliably visible) to prove /help ran.
  const out = strip(frames.join('\n'));
  assert.match(out, /Approvals:/, '/help executed and printed its output');
  unmount();
});

test('/keybindings renders the binding listing (no longer an alias for /help)', async () => {
  const { stdin, frames, unmount } = render(React.createElement(TuiApp, { opts: makeOpts() }));
  await tick();

  stdin.write('/keybindings');
  await tick();
  stdin.write('\r');
  await tick();
  const out = strip(frames.join('\n'));
  assert.match(out, /ctrl\+o\s+transcript:toggleFoldLatest/, 'lists the migrated default binding');
  assert.match(out, /Hardcoded \(not rebindable\)/, 'notes the hardcoded keys');

  stdin.write('/version');
  await tick();
  stdin.write('\r');
  await tick();
  assert.match(strip(frames.join('\n')), /Shadow 9\.9\.9/, '/version prints the TUI version');
  unmount();
});

test('/session and /tasks render session state without sending a prompt', async () => {
  const todos = new TodoList();
  todos.write([
    { subject: 'Map command surface', status: 'completed' },
    { subject: 'Polish transcript output', status: 'in_progress' },
  ]);
  const sessionPath = join(tmpdir(), '.shadow', 'sessions', '2026-06-28T12-00-00.000Z.jsonl');
  const { stdin, frames, unmount } = render(
    React.createElement(TuiApp, {
      opts: makeOpts({
        todoList: todos,
        sessionLog: { path: sessionPath, record() {} } as unknown as TuiOpts['sessionLog'],
      }),
    }),
  );
  await tick();

  stdin.write('/session');
  await tick();
  stdin.write('\r');
  await tick();
  assert.match(strip(frames.join('\n')), /2026-06-28T12-00-00\.000Z/, '/session shows the session id');

  stdin.write('/tasks');
  await tick();
  stdin.write('\r');
  await tick();
  const out = strip(frames.join('\n'));
  assert.match(out, /\[done\] Map command surface/);
  assert.match(out, /\[active\] Polish transcript output/);
  unmount();
});

test('/files, /branch, and /login expose safe operational state', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'shadow-tui-git-'));
  execFileSync('git', ['init'], { cwd: ws, stdio: 'ignore' });
  writeFileSync(join(ws, 'note.txt'), 'hi\n');
  const { stdin, frames, unmount } = render(React.createElement(TuiApp, { opts: makeOpts({ workspaceRoot: ws }) }));
  await tick();

  stdin.write('/files');
  await tick();
  stdin.write('\r');
  await tick();
  assert.match(strip(frames.join('\n')), /\?\? note\.txt/, '/files shows changed files');

  stdin.write('/branch');
  await tick();
  stdin.write('\r');
  await tick();
  assert.match(strip(frames.join('\n')), /branch:/, '/branch shows branch state');

  stdin.write('/login');
  await tick();
  stdin.write('\r');
  await tick();
  assert.match(strip(frames.join('\n')), /shadow onboard/, '/login points users to onboarding for API keys');
  unmount();
});

test('/mcp subviews and /config get expose details safely', async () => {
  const cfg = {
    provider: 'mock',
    model: 'm',
    fastMode: true,
    mcpServers: {
      remote: { url: 'https://example.test/mcp', headers: { Authorization: 'secret' } },
      local: { command: 'node', args: ['server.js'] },
    },
  } as unknown as TuiOpts['cfg'];
  const { stdin, frames, unmount } = render(React.createElement(TuiApp, { opts: makeOpts({ cfg }) }));
  await tick();

  stdin.write('/mcp');
  await tick();
  stdin.write('\r');
  await tick();
  assert.match(strip(frames.join('\n')), /remote\s+http/, '/mcp lists configured servers');

  stdin.write('/mcp get remote');
  await tick();
  stdin.write('\r');
  await tick();
  const out = strip(frames.join('\n'));
  assert.match(out, /url: https:\/\/example\.test\/mcp/);
  assert.match(out, /headers: Authorization/);
  assert.doesNotMatch(out, /secret/, 'header values are not rendered');

  stdin.write('/config get fastMode');
  await tick();
  stdin.write('\r');
  await tick();
  assert.match(strip(frames.join('\n')), /fastMode: true/);

  stdin.write('/config set baseUrl http://bad.example');
  await tick();
  stdin.write('\r');
  await tick();
  assert.match(strip(frames.join('\n')), /not editable here/, 'unsafe config keys are rejected');
  unmount();
});

// A two-model config for the picker tests.
const multiModelCfg = {
  provider: 'mock',
  model: 'm',
  models: [
    { label: 'alpha', provider: 'mock', model: 'm1' },
    { label: 'beta', provider: 'mock', model: 'm2' },
  ],
} as unknown as TuiOpts['cfg'];

test('/model with multiple models opens the picker listing each entry', async () => {
  const { stdin, lastFrame, unmount } = render(
    React.createElement(TuiApp, { opts: makeOpts({ cfg: multiModelCfg }) }),
  );
  await tick();
  stdin.write('/model');
  await tick();
  stdin.write('\r'); // Enter runs /model → opens the picker (multiple models)
  await tick();
  const f = strip(lastFrame());
  assert.match(f, /Select a model/, 'picker header is shown');
  assert.match(f, /alpha\s+mock\/m1/, 'lists the first model');
  assert.match(f, /beta\s+mock\/m2/, 'lists the second model');
  assert.match(f, /Esc cancel/, 'shows the picker key hints');
  unmount();
});

test('/model list and /provider show provider/model management state', async () => {
  const cfg = {
    provider: 'openai',
    model: 'local-reasoner',
    baseUrl: 'http://127.0.0.1:8001/v1',
    models: [
      { label: 'Local RED-APEX', provider: 'openai', model: 'local-reasoner', baseUrl: 'http://127.0.0.1:8001/v1' },
      { label: 'Gemini Flash', provider: 'openai', model: 'gemini-2.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', disabled: true },
    ],
  } as unknown as TuiOpts['cfg'];
  const { stdin, frames, unmount } = render(React.createElement(TuiApp, { opts: makeOpts({ cfg }) }));
  await tick();

  stdin.write('/model list');
  await tick();
  stdin.write('\r');
  await tick();
  let out = strip(frames.join('\n'));
  assert.match(out, /\* Local RED-APEX/);
  assert.match(out, /Gemini Flash \[disabled\]/);

  stdin.write('/provider');
  await tick();
  stdin.write('\r');
  await tick();
  out = strip(frames.join('\n'));
  assert.match(out, /openai\/local-reasoner/);
  assert.match(out, /endpoint: http:\/\/10\.80\.10\.24:8001\/v1/);
  assert.match(out, /presets: 2 configured · 1 disabled/);
  unmount();
});

test('/skills, /workflows, and /plugins expose extension status', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'shadow-extensions-'));
  mkdirSync(join(ws, '.shadow', 'skills', 'demo'), { recursive: true });
  mkdirSync(join(ws, '.shadow', 'workflows'), { recursive: true });
  writeFileSync(join(ws, '.shadow', 'skills', 'demo', 'SKILL.md'), '# Demo\n\nUse for demo work.\n');
  writeFileSync(join(ws, '.shadow', 'workflows', 'build.md'), 'build steps\n');
  const { stdin, frames, unmount } = render(React.createElement(TuiApp, { opts: makeOpts({ workspaceRoot: ws }) }));
  await tick();

  stdin.write('/skills');
  await tick();
  stdin.write('\r');
  await tick();
  assert.match(strip(frames.join('\n')), /demo/);

  stdin.write('/workflows');
  await tick();
  stdin.write('\r');
  await tick();
  assert.match(strip(frames.join('\n')), /build\.md/);

  stdin.write('/plugins');
  await tick();
  stdin.write('\r');
  await tick();
  assert.match(strip(frames.join('\n')), /Plugin manager: not installed/);
  unmount();
});

test('Esc cancels the model picker without switching', async () => {
  const { stdin, lastFrame, frames, unmount } = render(
    React.createElement(TuiApp, { opts: makeOpts({ cfg: multiModelCfg }) }),
  );
  await tick();
  stdin.write('/model');
  await tick();
  stdin.write('\r'); // open picker
  await tick();
  stdin.write('\x1b'); // Esc cancels
  await tick();
  assert.match(strip(frames.join('\n')), /Model unchanged/, 'reports the cancel');
  assert.doesNotMatch(strip(lastFrame()), /Select a model/, 'picker is dismissed');
  assert.match(strip(lastFrame()), /mock\/m/, 'composer footer still shows the active model');
  unmount();
});

test('applyTheme swaps the active palette in place', () => {
  // Palette values are the WCAG-AA/AAA set (see THEMES): fg is white/high-contrast, dim is an explicit
  // readable gray, accents are brightened past the 4.5:1 floor.
  applyTheme('matrix');
  assert.equal(paletteSnapshot().fg, '#5cff9f', 'matrix theme sets the phosphor-green fg');
  applyTheme('pipboy');
  assert.equal(paletteSnapshot().fg, '#e6ffcf', 'pipboy theme sets a readable phosphor fg');
  applyTheme('cyberpunk');
  assert.equal(paletteSnapshot().cyan, '#4fe0ff', 'cyberpunk theme sets electric cyan accents');
  applyTheme('pink');
  assert.equal(paletteSnapshot().purple, '#ff9fd4', 'pink alias maps to coder-chick');
  applyTheme('light');
  assert.equal(paletteSnapshot().fg, '#0a0a0a', 'light theme sets a near-black fg');
  applyTheme('dark'); // legacy alias restores the OG default so other tests/snapshots are unaffected
  assert.equal(paletteSnapshot().fg, '#ffffff', 'dark alias restores the OG white (high contrast)');
  assert.equal(paletteSnapshot().dim, '#b6bcc3', 'dim is an explicit AA-compliant gray, not the faint attribute');
});

test('accessible themes: colorblind (Okabe–Ito) + high-contrast, with aliases; every theme carries every role token', () => {
  // colorblind: user (sky) vs accent (orange) is the CVD-safe pairing — distinguishable under
  // deuteranopia, protanopia, and tritanopia; the ▌ bar shape carries user turns regardless.
  applyTheme('colorblind');
  assert.equal(paletteSnapshot().user, '#56b4e9', 'colorblind user bar is Okabe–Ito sky blue');
  assert.equal(paletteSnapshot().accent, '#e69f00', 'colorblind assistant bullet is Okabe–Ito orange');
  applyTheme('cb');
  assert.equal(paletteSnapshot().user, '#56b4e9', 'cb alias maps to colorblind');
  applyTheme('high-contrast');
  assert.equal(paletteSnapshot().fg, '#ffffff', 'high-contrast fg is pure white');
  assert.equal(paletteSnapshot().dim, '#dcdcdc', 'high-contrast quiet tier stays bright (~15:1)');
  applyTheme('hc');
  assert.equal(paletteSnapshot().yellow, '#ffff00', 'hc alias maps to high-contrast');
  // Role-token contract: every theme must define every token — a theme missing `user`/`accent`/
  // `body`/`codeBg` would silently freeze part of the UI in the previous theme's colors.
  const TOKENS = ['fg', 'body', 'bright', 'dim', 'cyan', 'green', 'red', 'yellow', 'purple', 'user', 'accent', 'codeBg'];
  for (const name of ['og', 'pipboy', 'cyberpunk', 'coder-chick', 'matrix', 'mono', 'light', 'colorblind', 'high-contrast']) {
    applyTheme(name);
    const snap = paletteSnapshot();
    for (const tok of TOKENS) {
      assert.match(snap[tok] ?? '', /^#[0-9a-f]{6}$/i, `theme ${name} defines ${tok}`);
    }
  }
  applyTheme('og'); // restore the default for the rest of the suite
});

test('fuzzy command matching: "/thm" finds /theme (prefix-only matching is gone)', async () => {
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts: makeOpts() }));
  await tick();
  stdin.write('/thm');
  await tick();
  assert.match(strip(lastFrame()), /\/theme/, 'subsequence match reaches /theme');
  unmount();
});

test('argument menu: "/theme " lists themes with descriptions and a ✓ current marker', async () => {
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts: makeOpts() }));
  await tick();
  stdin.write('/theme ');
  await tick();
  const f = strip(lastFrame());
  assert.match(f, /\/theme — pick an argument/, 'header names the command in argument mode');
  assert.match(f, /colorblind/, 'theme names are offered');
  assert.match(f, /Okabe/, 'argument rows carry their descriptions');
  assert.match(f, /✓ current/, 'the active value is marked (og — no lastTheme in test cfg)');
  unmount();
});

test('argument fuzzy + Enter: "/image cl" ⏎ runs /image clear', async () => {
  const { stdin, frames, unmount } = render(React.createElement(TuiApp, { opts: makeOpts() }));
  await tick();
  stdin.write('/image cl');
  await tick();
  stdin.write('\r');
  await tick();
  assert.match(strip(frames.join('\n')), /Image attachments cleared\./, 'the completed argument executed');
  unmount();
});

test('hint-only guard: "/goal " ⏎ submits the bare command — never auto-runs the first completion', async () => {
  const { stdin, frames, unmount } = render(React.createElement(TuiApp, { opts: makeOpts() }));
  await tick();
  stdin.write('/goal ');
  await tick();
  stdin.write('\r'); // no partial typed, no navigation — the menu is only a hint here
  await tick();
  const out = strip(frames.join('\n'));
  assert.match(out, /No goal set/, 'bare /goal ran (status readout)');
  assert.doesNotMatch(out, /Goal cleared/, '"clear" did NOT fire itself');
  unmount();
});

test('argument navigation + Enter: "/autonomy " ↓ ⏎ runs the selected level', async () => {
  const { stdin, frames, unmount } = render(React.createElement(TuiApp, { opts: makeOpts() }));
  await tick();
  stdin.write('/autonomy ');
  await tick();
  stdin.write('\x1b[B'); // ↓ — explicit selection is intent, unlike the bare-space case above
  await tick();
  stdin.write('\r');
  await tick();
  assert.match(strip(frames.join('\n')), /Autonomy → auto-read/, 'second row (manual, auto-read, …) executed');
  unmount();
});

test('/autonomy and /style accept a direct argument; invalid values error instead of silently cycling', async () => {
  const { stdin, frames, unmount } = render(React.createElement(TuiApp, { opts: makeOpts() }));
  await tick();
  stdin.write('/autonomy full');
  await tick();
  stdin.write('\r');
  await tick();
  assert.match(strip(frames.join('\n')), /Autonomy → full/, 'valid arg jumps straight to the level');
  // Invalid style: previously the arg was IGNORED and the style cycled — now it errors.
  // (The valid-arg path persists lastStyle to the real ~/.shadow, so tests exercise only this branch.)
  stdin.write('/style banana');
  await tick();
  stdin.write('\r');
  await tick();
  assert.match(strip(frames.join('\n')), /Unknown style "banana"/, 'bad style is rejected, not silently cycled');
  unmount();
});

test('typo submits get a did-you-mean: "/modle" suggests /model', async () => {
  const { stdin, frames, unmount } = render(React.createElement(TuiApp, { opts: makeOpts() }));
  await tick();
  stdin.write('/modle');
  await tick();
  stdin.write('\r');
  await tick();
  assert.match(strip(frames.join('\n')), /Did you mean \/model\?/, 'transposition typo gets a suggestion');
  unmount();
});

test('alias rows fold out of the bare "/" browse list but still match when typed', async () => {
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts: makeOpts() }));
  await tick();
  stdin.write('/');
  await tick();
  assert.doesNotMatch(strip(lastFrame()), /alias for/i, 'no pure-alias rows in browse mode');
  stdin.write('stats');
  await tick();
  assert.match(strip(lastFrame()), /\/stats/, 'typed alias still matches and is runnable');
  unmount();
});

test('typing "/theme" surfaces it in the command menu', async () => {
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts: makeOpts() }));
  await tick();
  stdin.write('/theme');
  await tick();
  const f = strip(lastFrame());
  assert.match(f, /\/theme/);
  assert.match(f, /Switch color theme/, 'shows the /theme description');
  unmount();
});

test('/theme list and preview expose the expanded themes without applying them', async () => {
  applyTheme('og');
  const { stdin, frames, unmount } = render(React.createElement(TuiApp, { opts: makeOpts({ cfg: { provider: 'mock', model: 'm', lastTheme: 'og' } as unknown as TuiOpts['cfg'] }) }));
  await tick();

  stdin.write('/theme list');
  await tick();
  stdin.write('\r');
  await tick();
  let out = strip(frames.join('\n'));
  assert.match(out, /pipboy/);
  assert.match(out, /cyberpunk/);
  assert.match(out, /coder-chick/);

  stdin.write('/theme preview coder-chick');
  await tick();
  stdin.write('\r');
  await tick();
  out = strip(frames.join('\n'));
  assert.match(out, /Theme preview: coder-chick/);
  assert.match(out, /Use \/theme coder-chick to apply/);
  assert.equal(paletteSnapshot().fg, '#ffffff', 'preview does not mutate the active palette (OG white)');
  unmount();
});

test('typing "/output-style" surfaces it in the command menu', async () => {
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts: makeOpts() }));
  await tick();
  stdin.write('/output-style');
  await tick();
  const f = strip(lastFrame());
  assert.match(f, /\/output-style/);
  assert.match(f, /alias for \/style/, 'shows the alias description');
  unmount();
});

test('typing "/add-dir" surfaces it in the command menu', async () => {
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts: makeOpts() }));
  await tick();
  stdin.write('/add-dir');
  await tick();
  const f = strip(lastFrame());
  assert.match(f, /\/add-dir/);
  assert.match(f, /Grant an extra directory/, 'shows the /add-dir description');
  unmount();
});

test('/add-dir grants a real directory, lists it, and rejects a missing one', async () => {
  const granted = mkdtempSync(join(tmpdir(), 'adddir-'));
  const { stdin, frames, lastFrame, unmount } = render(
    React.createElement(TuiApp, { opts: makeOpts({ workspaceRoot: tmpdir() }) }),
  );
  await tick();
  // Grant an existing directory.
  stdin.write(`/add-dir ${granted}`);
  await tick();
  stdin.write('\r');
  await tick();
  assert.match(strip(frames.join('\n')), /Granted \(this session\)/, 'confirms the grant');

  // No-arg lists the granted root.
  stdin.write('/add-dir');
  await tick();
  stdin.write('\r');
  await tick();
  assert.match(strip(lastFrame()), new RegExp(granted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'lists the granted dir');

  // A missing path is rejected.
  stdin.write('/add-dir /no/such/dir/xyzzy');
  await tick();
  stdin.write('\r');
  await tick();
  assert.match(strip(frames.join('\n')), /No such directory/, 'rejects a non-existent path');
  unmount();
});

function statusLineOnce(cmd: string, ctx: Parameters<typeof runStatusLine>[1]): Promise<string> {
  return new Promise((resolve) => runStatusLine(cmd, ctx, resolve));
}
const slCtx = { model: 'm', provider: 'mock', cwd: '/tmp', autonomy: 'auto-edit' };

test('runStatusLine returns the first stdout line, exposes SHADOW_* env, and fails soft', async () => {
  assert.equal(await statusLineOnce('echo hello-strip', slCtx), 'hello-strip', 'first stdout line');
  assert.equal(await statusLineOnce('printf "a\\nb\\n"', slCtx), 'a', 'only the first line is used');
  assert.equal(await statusLineOnce('echo "$SHADOW_MODEL@$SHADOW_AUTONOMY"', slCtx), 'm@auto-edit', 'SHADOW_* env is passed');
  assert.equal(await statusLineOnce('exit 7', slCtx), '', 'a failing command yields empty output');
  assert.equal(await statusLineOnce('nonexistent_cmd_xyzzy_123', slCtx), '', 'a missing command yields empty output');
});

test('a configured statusLine renders as a footer line', async () => {
  const cfg = { provider: 'mock', model: 'm', statusLine: 'echo STATUSLINE_OK' } as unknown as TuiOpts['cfg'];
  const { lastFrame, unmount } = render(React.createElement(TuiApp, { opts: makeOpts({ cfg }) }));
  // The mount effect spawns the command; give the subprocess time to finish + repaint.
  await new Promise((r) => setTimeout(r, 400));
  assert.match(strip(lastFrame()), /STATUSLINE_OK/, 'custom status line output is shown in the footer');
  unmount();
});

test('typing "/statusline" surfaces it in the command menu', async () => {
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts: makeOpts() }));
  await tick();
  stdin.write('/statusline');
  await tick();
  const f = strip(lastFrame());
  assert.match(f, /\/statusline/);
  assert.match(f, /custom footer line/, 'shows the /statusline description');
  unmount();
});

test('typing "/vim" surfaces it in the command menu', async () => {
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts: makeOpts() }));
  await tick();
  stdin.write('/vim');
  await tick();
  const f = strip(lastFrame());
  assert.match(f, /\/vim/);
  assert.match(f, /modal .*editing/i, 'shows the /vim description');
  unmount();
});

test('vim mode: INSERT types, Esc→NORMAL, motions/edits work, i→INSERT', async () => {
  const cfg = { provider: 'mock', model: 'm', vimMode: true } as unknown as TuiOpts['cfg'];
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts: makeOpts({ cfg }) }));
  await tick();
  // Starts in INSERT → text types normally.
  stdin.write('hello');
  await tick();
  assert.match(strip(lastFrame()), /hello/, 'INSERT mode types text');
  assert.match(strip(lastFrame()), /-- INSERT --/, 'footer shows INSERT');

  // Esc → NORMAL.
  stdin.write('\x1b');
  await tick();
  assert.match(strip(lastFrame()), /-- NORMAL --/, 'Esc enters NORMAL');

  // In NORMAL, plain letters are commands, not text — "zzz" must not insert.
  stdin.write('zzz');
  await tick();
  assert.doesNotMatch(strip(lastFrame()), /hellozzz/, 'NORMAL keys do not insert text');

  // "0" to line start, "x" deletes the first char.
  stdin.write('0x');
  await tick();
  assert.match(strip(lastFrame()), /ello/, '0 then x deletes the first char');
  assert.doesNotMatch(strip(lastFrame()), /hello/);

  // "i" re-enters INSERT and typing resumes.
  stdin.write('i');
  await tick();
  assert.match(strip(lastFrame()), /-- INSERT --/, 'i re-enters INSERT');
  stdin.write('Q');
  await tick();
  assert.match(strip(lastFrame()), /Qello/, 'typing inserts at the caret in INSERT');
  unmount();
});

test('imageMediaType maps extensions and rejects non-images', () => {
  assert.equal(imageMediaType('/x/a.png'), 'image/png');
  assert.equal(imageMediaType('a.JPG'), 'image/jpeg');
  assert.equal(imageMediaType('a.jpeg'), 'image/jpeg');
  assert.equal(imageMediaType('a.webp'), 'image/webp');
  assert.equal(imageMediaType('a.gif'), 'image/gif');
  assert.equal(imageMediaType('a.txt'), null);
  assert.equal(imageMediaType('noext'), null);
});

test('/image attaches a file (footer shows 📎), rejects bad types, and clears', async () => {
  const png = join(mkdtempSync(join(tmpdir(), 'img-')), 'pic.png');
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])); // bytes are opaque to the attach path
  const { stdin, frames, lastFrame, unmount } = render(React.createElement(TuiApp, { opts: makeOpts({ workspaceRoot: tmpdir() }) }));
  await tick();

  // Attach a real png → confirmation + footer indicator.
  stdin.write(`/image ${png}`);
  await tick();
  stdin.write('\r');
  await tick();
  assert.match(strip(frames.join('\n')), /Attached/, 'confirms the attachment');
  assert.match(strip(lastFrame()), /📎 1/, 'footer shows one queued image');

  // A non-image extension is rejected.
  stdin.write('/image /tmp/notes.txt');
  await tick();
  stdin.write('\r');
  await tick();
  assert.match(strip(frames.join('\n')), /Unsupported image type/, 'rejects a non-image');

  // Clear drops the queue.
  stdin.write('/image clear');
  await tick();
  stdin.write('\r');
  await tick();
  assert.match(strip(frames.join('\n')), /cleared/i, 'clears the queue');
  assert.doesNotMatch(strip(lastFrame()), /📎/, 'footer indicator is gone');
  unmount();
});

test('typing "/image" surfaces it in the command menu', async () => {
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts: makeOpts() }));
  await tick();
  stdin.write('/image');
  await tick();
  const f = strip(lastFrame());
  assert.match(f, /\/image/);
  assert.match(f, /Attach an image/, 'shows the /image description');
  unmount();
});

test('Shift+Tab folds plan mode into the autonomy ring (full → plan → manual)', async () => {
  const bus = new EventBus();
  const planMode = new PlanModeState(false); // start in implement mode
  planMode.onUpdate((plan) => bus.emit({ type: 'plan_mode', plan })); // production wires this in index.ts
  const { stdin, lastFrame, unmount } = render(
    React.createElement(TuiApp, { opts: makeOpts({ bus, planMode, autonomy: 'full' }) }),
  );
  await tick();
  assert.equal(planMode.active, false, 'starts in implement mode');

  stdin.write('\x1b[Z'); // Shift+Tab — from the top of the autonomy ring (full) step into plan
  await tick();
  assert.equal(planMode.active, true, 'Shift+Tab from full enters plan mode');
  assert.match(strip(lastFrame()), /plan: planning/, 'status bar reflects plan mode');

  stdin.write('\x1b[Z'); // Shift+Tab again — leaving plan restarts the ring at manual
  await tick();
  assert.equal(planMode.active, false, 'Shift+Tab leaves plan mode');
  assert.match(strip(lastFrame()), /mode: manual/, 'ring restarts at the most cautious level');
  unmount();
});
