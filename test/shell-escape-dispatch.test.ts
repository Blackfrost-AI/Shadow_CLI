import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShadowApp } from '../src/app/app.js';
import { composerOwner } from '../src/tui/keys/composerOwner.js';
import { runSlashCommand } from '../src/tui/slash.js';
import { findTerminalCommand } from '../src/tui/commandCatalog.js';

// Drive the REAL dispatch methods with controlled renderer state (the m-2 dispatch-test
// pattern): busy /! must be refused with a reason and never queued, unsafe payloads must be
// rejected with the usage/paste/multiline reason, and a valid escape must reach the native
// executor exactly once through the full policy pipeline.

interface NativeCall { name: string; input: { command?: string } }

function snowfall() {
  const app: any = Object.create(ShadowApp.prototype);
  const nativeCalls: NativeCall[] = [], lines: any[] = [];
  let draft = '', listener: (data: string) => any;
  let busy = false;
  Object.assign(app, {
    compacting: false, modelChecking: false, switcher: { isSwitching: false }, exiting: false, queued: [],
    opts: {
      runNativeTool: (name: string, input: unknown) => {
        nativeCalls.push({ name, input: input as { command?: string } });
        return Promise.resolve({ ok: true, summary: 'done' });
      },
      cfg: { budget: {}, priceTable: { mock: { input: 1, output: 1 } } },
    },
    current: { model: 'mock' },
    editor: { getText: () => draft, getExpandedText: () => draft, setText: (s: string) => { draft = s; }, addToHistory() {} },
    tui: { addInputListener: (fn: any) => { listener = fn; }, hasOverlay: () => false, requestRender() {} },
    loopRef: { hasPendingSteer: () => false, requestSteer: () => true },
    pushLine: (line: any) => lines.push(line), hudState: () => ({}), finishReasoning() {}, flushStreamToTranscript() {},
    closePicker() {}, commitBrandLine() {}, startTicker() {}, stopTicker() {}, endTurn() {}, featureError(e: unknown) { lines.push({ text: `  featureError: ${e}` }); },
  });
  Object.defineProperty(app, 'running', { get: () => busy, set: (v: boolean) => { busy = v; } });
  app.installInputHandling();
  return { app, nativeCalls, lines, enter: (text: string) => { draft = text; return listener!('\r'); } };
}

function ink() {
  const nativeCalls: NativeCall[] = [], lines: any[] = [];
  const ref = (current: any) => ({ current });
  const env: any = {
    goalColRef: ref(null), inputRef: ref(''), cursorRef: ref(0), tableRef: ref(null), argCtxRef: ref(null), customCommandsRef: ref([]),
    menuIndexRef: ref(0), rawKeyRef: ref(''), rawChunkRef: ref(''), pastingRef: ref(false), attachmentsRef: ref([]),
    modelSwitchingRef: ref(false), asyncCommandRef: ref(false), compactingRef: ref(false), runningRef: ref(false),
    queuedTasksRef: ref([]), pastesRef: ref([]), historyRef: ref([]), historyIndexRef: ref(-1), historyDraftRef: ref(''),
    kbConsume: () => false, slashMatches: () => [], findSlashCommand: () => null,
    setLine: (s: string) => { env.inputRef.current = s; }, setMenuIndex() {},
    setQueued: (q: any[]) => { env.queuedTasksRef.current = q; }, pushLine: (l: any) => lines.push(l),
    composerInnerWidth: () => 80,
    applyEdit: () => {}, moveCaret: () => {}, setComposer: () => {},
    histIdxRef: ref(0), pushUndo: () => {},
    setAutonomy: () => {}, planMode: null, autonomyRef: ref('manual'),
    loopRef: ref({ hasPendingSteer: () => false, requestSteer: () => true }),
    slashDispatchName: (cmd: any) => cmd.name,
  };
  return { env, nativeCalls, lines };
}

for (const renderer of ['Snowfall', 'Ink'] as const) {
  test(`${renderer}: busy /! is refused with a reason and never queued`, async () => {
    if (renderer === 'Snowfall') {
      const h = snowfall();
      h.app.running = true;
      h.enter('/! echo hi');
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(h.nativeCalls.length, 0);
      assert.deepEqual(h.app.queued, []);
      assert.ok(h.lines.some((l: any) => l.text.includes('Finish the current operation')));
    } else {
      const h = ink();
      const lines: any[] = [];
      const nativeCalls: NativeCall[] = [];
      const env = h.env;
      // The Ink composer intercepts the typed /! BEFORE any busy barrier: drive that seam.
      env.shellEscape = async (raw: string) => {
        const { runShellEscape } = await import('../src/tui/shellEscape.js');
        await runShellEscape({
          busy: () => env.runningRef.current,
          errorLine: (t) => lines.push(t),
          outcomeLine: (t, ok) => lines.push(`outcome:${t}:${ok}`),
          clearComposer: () => {},
          armAbort: () => {},
          acquireLock: () => Promise.resolve(() => {}),
          runNativeTool: (name, input) => { nativeCalls.push({ name, input: input as { command?: string } }); return Promise.resolve({ ok: true, summary: 'done' }); },
          newBudget: () => ({}),
        }, raw);
      };
      env.runningRef.current = true;
      // Drive the composer seam exactly as the TUI does on a typed line.
      env.inputRef.current = '/! echo hi';
      env.cursorRef.current = env.inputRef.current.length;
      const result = composerOwner.handle(env, '', { return: true } as never);
      assert.equal(result, true, 'the composer intercepts a typed /! before busy barriers');
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(nativeCalls.length, 0);
      assert.deepEqual(env.queuedTasksRef.current, []);
      assert.ok(lines.some((l) => l.includes('Finish the current operation')));
    }
  });
}

for (const renderer of ['Snowfall', 'Ink'] as const) {
  test(`${renderer}: unsafe /! payloads are refused with the specific reason and never dispatched`, async () => {
    if (renderer === 'Snowfall') {
      const h = snowfall();
      // Idle submissions in Snowfall belong to the editor callback; drive submit directly.
      h.app.submit('/!');
      h.app.submit('/! [Pasted text #1 +10 lines]');
      h.app.submit('/! echo one\necho two');
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(h.nativeCalls.length, 0);
      assert.ok(h.lines.some((l: any) => l.text.includes('Usage: /!')));
      assert.ok(h.lines.some((l: any) => l.text.includes('Pasted text cannot launch a shell')));
      assert.ok(h.lines.some((l: any) => l.text.includes('Multiline input cannot launch a shell')));
    } else {
      const h = ink();
      const lines: any[] = [];
      const nativeCalls: NativeCall[] = [];
      const env = h.env;
      env.shellEscape = async (raw: string) => {
        const { runShellEscape } = await import('../src/tui/shellEscape.js');
        await runShellEscape({
          busy: () => env.runningRef.current,
          errorLine: (t) => lines.push(t),
          outcomeLine: (t, ok) => lines.push(`outcome:${t}:${ok}`),
          clearComposer: () => {},
          armAbort: () => {},
          acquireLock: () => Promise.resolve(() => {}),
          runNativeTool: (name, input) => { nativeCalls.push({ name, input: input as { command?: string } }); return Promise.resolve({ ok: true, summary: 'done' }); },
          newBudget: () => ({}),
        }, raw);
      };
      for (const raw of ['/!', '/! [Pasted text #1 +10 lines]', '/! echo one\necho two']) {
        env.inputRef.current = raw;
        env.cursorRef.current = raw.length;
        composerOwner.handle(env, '', { return: true } as never);
      }
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(nativeCalls.length, 0);
      assert.ok(lines.some((l) => l.includes('Usage: /!')));
      assert.ok(lines.some((l) => l.includes('Pasted text cannot launch a shell')));
      assert.ok(lines.some((l) => l.includes('Multiline input cannot launch a shell')));
    }
  });
}

for (const renderer of ['Snowfall', 'Ink'] as const) {
  test(`${renderer}: a typed valid /! dispatches run_shell exactly once and never queues`, async () => {
    if (renderer === 'Snowfall') {
      const h = snowfall();
      // Idle submissions belong to the editor callback; drive submit directly.
      h.app.submit('/! echo once');
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(h.nativeCalls.length, 1);
      assert.equal(h.nativeCalls[0]!.name, 'run_shell');
      assert.equal(h.nativeCalls[0]!.input.command, 'echo once');
      assert.deepEqual(h.app.queued, []);
    } else {
      const h = ink();
      const lines: any[] = [];
      const nativeCalls: NativeCall[] = [];
      const env = h.env;
      env.shellEscape = async (raw: string) => {
        const { runShellEscape } = await import('../src/tui/shellEscape.js');
        await runShellEscape({
          busy: () => env.runningRef.current,
          errorLine: (t) => lines.push(t),
          outcomeLine: (t, ok) => lines.push(`outcome:${t}:${ok}`),
          clearComposer: () => {},
          armAbort: () => {},
          acquireLock: () => Promise.resolve(() => {}),
          runNativeTool: (name, input) => { nativeCalls.push({ name, input: input as { command?: string } }); return Promise.resolve({ ok: true, summary: 'done' }); },
          newBudget: () => ({}),
        }, raw);
      };
      env.inputRef.current = '/! echo once';
      env.cursorRef.current = env.inputRef.current.length;
      composerOwner.handle(env, '', { return: true } as never);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(nativeCalls.length, 1);
      assert.equal(nativeCalls[0]!.name, 'run_shell');
      assert.equal(nativeCalls[0]!.input.command, 'echo once');
      assert.deepEqual(env.queuedTasksRef.current, []);
    }
  });
}

test('a menu-completed bare /! routes through the same core and shows the usage reason (no unknown-command error)', async () => {
  const lines: any[] = [];
  const nativeCalls: NativeCall[] = [];
  // The REAL catalog entry: the handler id resolves to the /shell dispatch arm.
  const cmd = findTerminalCommand('/!');
  assert.ok(cmd, 'the /! catalog entry exists');
  await runSlashCommand({
    setLine: () => {}, setMenuIndex: () => {},
    shellEscape: async (raw: string) => {
      const { runShellEscape } = await import('../src/tui/shellEscape.js');
      await runShellEscape({
        busy: () => false,
        errorLine: (t) => lines.push(t),
        outcomeLine: (t, ok) => lines.push(`outcome:${t}:${ok}`),
        clearComposer: () => {},
        armAbort: () => {},
        acquireLock: () => Promise.resolve(() => {}),
        runNativeTool: (name, input) => { nativeCalls.push({ name, input: input as { command?: string } }); return Promise.resolve({ ok: true, summary: 'done' }); },
        newBudget: () => ({}),
      }, raw);
    },
  } as never, cmd as never, '/!');
  // runSlashCommand fires ctx.shellEscape without awaiting (fire-and-forget like the real
  // TUI late-bound seam); let the async rejection settle before asserting.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(nativeCalls.length, 0);
  assert.ok(lines.some((l) => l.includes('Usage: /!')));
});

for (const renderer of ['Snowfall', 'Ink'] as const) {
  test(`${renderer}: /! is never queued for later replay while busy`, async () => {
    if (renderer === 'Snowfall') {
      const h = snowfall();
      h.app.running = true;
      h.enter('/! echo hi');
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(h.app.queued, [], 'a shell command must never sit in the replay queue');
    } else {
      const h = ink();
      const lines: any[] = [];
      const env = h.env;
      env.shellEscape = async (raw: string) => {
        const { runShellEscape } = await import('../src/tui/shellEscape.js');
        await runShellEscape({
          busy: () => env.runningRef.current,
          errorLine: (t) => lines.push(t),
          outcomeLine: () => {},
          clearComposer: () => {},
          armAbort: () => {},
          acquireLock: () => Promise.resolve(() => {}),
          runNativeTool: () => Promise.resolve({ ok: true, summary: 'done' }),
          newBudget: () => ({}),
        }, raw);
      };
      env.runningRef.current = true;
      env.inputRef.current = '/! echo hi';
      env.cursorRef.current = env.inputRef.current.length;
      composerOwner.handle(env, '', { return: true } as never);
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(env.queuedTasksRef.current, [], 'a shell command must never sit in the replay queue');
    }
  });
}
