import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShadowApp } from '../src/app/app.js';
import { composerOwner } from '../src/tui/keys/composerOwner.js';
import { findSlashCommand, runSlashCommand } from '../src/tui/slash.js';
import { dispatchPromptControl } from '../src/tui/promptControl.js';
import { mergeKeybindings } from '../src/tui/keybindings/loader.js';
import { resolveKeystroke } from '../src/tui/keybindings/resolver.js';
import { parseKeystroke } from '../src/tui/keybindings/parser.js';

// Drive the real methods without constructing a terminal or contacting a provider.
function snowfall() {
  const app: any = Object.create(ShadowApp.prototype);
  const calls: unknown[] = [], turns: string[] = [], lines: any[] = [], history: string[] = [];
  let draft = '', listener: (data: string) => any;
  Object.assign(app, {
    running: true, compacting: false, modelChecking: false, switcher: { isSwitching: false }, queued: [],
    editor: { getText: () => draft, getExpandedText: () => draft, setText: (s: string) => { draft = s; }, addToHistory: (s: string) => history.push(s) },
    tui: { addInputListener: (fn: any) => { listener = fn; }, hasOverlay: () => false, requestRender() {} },
    loopRef: { hasPendingSteer: () => false, requestSteer: (...args: unknown[]) => { calls.push(args); return true; } },
    pushLine: (line: any) => lines.push(line), hudState: () => ({}), finishReasoning() {}, flushStreamToTranscript() {},
    startTurn: (s: string) => { turns.push(s); app.running = true; },
  });
  app.installInputHandling();
  return { app, calls, turns, lines, history, enter: (text: string) => { draft = text; return listener!('\r'); } };
}

function ink(menu = false) {
  const calls: unknown[] = [], turns: string[] = [], lines: any[] = [];
  const ref = (current: any) => ({ current });
  const env: any = {
    goalColRef: ref(null), inputRef: ref(''), cursorRef: ref(0), tableRef: ref(null), argCtxRef: ref(null), customCommandsRef: ref([]),
    menuIndexRef: ref(0), rawKeyRef: ref(''), rawChunkRef: ref(''), pastingRef: ref(false), attachmentsRef: ref([]),
    modelSwitchingRef: ref(false), asyncCommandRef: ref(false), compactingRef: ref(false), runningRef: ref(true),
    queuedTasksRef: ref([]), pastesRef: ref([]), historyRef: ref([]), historyIndexRef: ref(-1), historyDraftRef: ref(''),
    kbConsume: () => false, slashMatches: () => menu ? [findSlashCommand('/queue')] : [], findSlashCommand,
    setLine: (s: string) => { env.inputRef.current = s; }, setMenuIndex() {},
    setQueued: (q: any[]) => { env.queuedTasksRef.current = q; }, pushLine: (l: any) => lines.push(l),
    startTurn: (s: string) => turns.push(s),
    composerInnerWidth: () => 80,
    applyEdit: () => {}, moveCaret: () => {}, setComposer: () => {},
    histIdxRef: ref(0), pushUndo: () => {},
    setAutonomy: () => {}, planMode: null, autonomyRef: ref('manual'),
    loopRef: ref({ hasPendingSteer: () => false, requestSteer: (...args: unknown[]) => { calls.push(args); return true; } }),
    slashDispatchName: (cmd: any) => cmd.name,
  };
  env.runSlash = (cmd: any, text: string) => runSlashCommand({
    setLine: env.setLine, setMenuIndex: env.setMenuIndex,
    promptControl: (mode: any, payload: string) => dispatchPromptControl(env, mode, payload),
  } as any, cmd, text);
  return { env, calls, turns, lines, enter: (text: string) => {
    env.inputRef.current = text;
    env.cursorRef.current = text.length;
    return composerOwner.handle(env, '', { return: true } as any);
  } };
}

for (const renderer of ['Snowfall', 'Ink'] as const) {
  const make = renderer === 'Snowfall' ? snowfall : ink;
  test(`${renderer}: busy Enter decodes /queue without steering; multiline FIFO survives`, () => {
    const h: any = make();
    h.enter('/queue first\n  second');
    h.enter('/queue last');
    assert.deepEqual(h.calls, []);
    const texts = h.app ? h.app.queued : h.env.queuedTasksRef.current.map((q: any) => q.text);
    assert.deepEqual(texts, ['first\n  second', 'last']);
  });
  test(`${renderer}: /steer injects payload, backlog yields, pending steer is not overwritten`, () => {
    const h: any = make();
    h.enter('/steer first\nnext');
    assert.deepEqual(h.calls, [['first\nnext']]);
    const loop = h.app ? h.app.loopRef : h.env.loopRef.current;
    loop.hasPendingSteer = () => true;
    h.enter('/steer later');
    assert.equal(h.calls.length, 1);
    loop.hasPendingSteer = () => false;
    h.enter('/steer last');
    assert.deepEqual(h.calls, [['first\nnext'], []]);
  });
  test(`${renderer}: idle steer rejected, idle queue starts normal turn; nested commands rejected`, () => {
    const h: any = make();
    if (h.app) h.app.running = false; else h.env.runningRef.current = false;
    h.enter('/steer nope'); // Snowfall idle submission belongs to the editor callback.
    if (h.app) h.app.submit('/steer nope');
    assert.equal(h.turns.length, 0);
    assert.ok(h.lines.some((l: any) => l.text.includes('No active turn')));
    if (h.app) h.app.submit('/queue /quit'); else h.enter('/queue /quit');
    assert.equal(h.turns.length, 0);
    if (h.app) h.app.submit('/queue normal\nturn'); else h.enter('/queue normal\nturn');
    assert.deepEqual(h.turns, ['normal\nturn']);
  });
  test(`${renderer}: compaction, capability check and model switch decode before deferring`, () => {
    for (const barrier of ['compact', 'check', 'switch']) {
      const h: any = make();
      if (h.app) {
        if (barrier === 'compact') h.app.compacting = true;
        if (barrier === 'check') h.app.modelChecking = true;
        if (barrier === 'switch') h.app.switcher.isSwitching = true;
      } else {
        h.env[{ compact: 'compactingRef', check: 'asyncCommandRef', switch: 'modelSwitchingRef' }[barrier]!].current = true;
      }
      h.enter('/steer message');
      h.enter('/queue next');
      assert.deepEqual(h.calls, []);
      assert.deepEqual(h.app ? h.app.queued : h.env.queuedTasksRef.current.map((q: any) => q.text), ['message', 'next']);
    }
  });
}

test('Ink: busy slash-menu control executes handler, never queues literal command', () => {
  const h = ink(true);
  h.enter('/que');
  assert.deepEqual(h.env.queuedTasksRef.current, []);
  assert.ok(h.lines.some(l => l.text.includes('Provide message text')));
});

test('Ink: expanded multiline paste is data, nested slash paste rejected', () => {
  const h = ink();
  h.env.pastesRef.current = [{ id: 1, content: 'line one\nline two', lines: 2 }];
  h.enter('/queue [Pasted text #1 +2 lines]');
  assert.equal(h.calls.length, 0);
  assert.equal(h.env.queuedTasksRef.current[0].text, 'line one\nline two');
  h.env.pastesRef.current[0].content = '/quit';
  h.enter('/queue [Pasted text #1 +2 lines]');
  assert.equal(h.env.queuedTasksRef.current.length, 1);
  assert.ok(h.lines.some(l => l.text.includes('nested slash')));
});

test('Snowfall: cancellation/completion drains queued payload once in FIFO order', () => {
  const h = snowfall();
  h.enter('/queue first'); h.enter('/queue second');
  h.app.running = false; h.app.flushQueue();
  assert.deepEqual(h.turns, ['first']);
  h.app.running = false; h.app.flushQueue();
  assert.deepEqual(h.turns, ['first', 'second']);
  assert.deepEqual(h.app.queued, []);
});

test('Ink keyboard controls are opt-in, configurable, and reserved keys stay protected', () => {
  const defaults = mergeKeybindings(null);
  assert.ok(!defaults.bindings.some(b => b.action === 'chat:steer' || b.action === 'chat:queue'));
  const configured = mergeKeybindings([{ context: 'Chat', bindings: { 'alt+j': 'chat:queue', 'alt+s': 'chat:steer' } }]);
  assert.deepEqual(configured.warnings, []);
  for (const [key, action] of [['alt+j', 'chat:queue'], ['alt+s', 'chat:steer']]) {
    const result = resolveKeystroke(parseKeystroke(key!)!, ['Chat', 'Global'], configured.bindings, []);
    assert.equal(result.type, 'match');
    if (result.type === 'match') assert.equal(result.action, action);
  }
  assert.ok(mergeKeybindings([{ context: 'Chat', bindings: { 'ctrl+c': 'chat:queue' } }]).warnings.some(w => w.kind === 'reserved'));
});
