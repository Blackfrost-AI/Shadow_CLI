/**
 * F11-02 regression: the headless renderer (attachRenderer — `shadow -p` / --task / piped
 * stdio) must not print raw textual tool-call XML verbatim. The TUI withholds a suspicious
 * tool-intent suffix while streaming (splitStreamToolIntentCapped) and sanitizes the leftover
 * at turn end (sanitizeAssistantText); the headless path used to write every delta verbatim,
 * so a raw tool_call XML envelope hit stdout BEFORE the loop's recovery layer (sniffToolCalls)
 * decided its fate. These tests pin the headless renderer to the same contract: the envelope
 * is either recovered into a tool invocation (never printed) or stripped from display.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const OPEN = '<' + 'tool_call>';
const CLOSE = '</' + 'tool_call>';

/** Run a bus-event script against a freshly attached headless renderer; return all stdout. */
async function captureHeadless(
  emit: (bus: { emit: (e: Record<string, unknown>) => void }) => void,
): Promise<string> {
  const { EventBus } = await import('../src/agent/events.js');
  const { attachRenderer } = await import('../src/tui.js');
  const bus = new EventBus();
  const written: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (c: string) => boolean }).write = (chunk: string) => {
    written.push(String(chunk));
    return true;
  };
  let detach = (): void => {};
  try {
    detach = attachRenderer(bus, { animate: false });
    emit(bus as unknown as { emit: (e: Record<string, unknown>) => void });
  } finally {
    detach();
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = realWrite;
  }
  return written.join('');
}

test('F11-02: headless does not print a raw tool_call XML envelope (recovered-call shape)', async () => {
  const prose = 'Let me check that file.';
  const envelope = `${OPEN}{"name":"read_file","arguments":{"path":"src/index.ts"}}${CLOSE}`;
  const full = `${prose}\n${envelope}\n`;
  const out = await captureHeadless((bus) => {
    // One character at a time — the worst-case delta granularity.
    for (const ch of full) bus.emit({ type: 'text', delta: ch });
    // The loop emits assistant_done AFTER sniffToolCalls recovered the call and cleaned
    // turn.text; the envelope must never have reached stdout by then.
    bus.emit({ type: 'assistant_done', text: prose });
    bus.emit({ type: 'stop', reason: 'end_turn', finalAnswer: prose });
  });
  assert.ok(out.includes(prose), `prose must print, got: ${JSON.stringify(out)}`);
  assert.equal(out.includes(OPEN), false, `raw XML leaked into headless output: ${JSON.stringify(out)}`);
  assert.equal(out.includes('read_file'), false, `envelope body leaked into headless output: ${JSON.stringify(out)}`);
});

test('F11-02: headless does not print an UNRECOVERABLE raw tool_call envelope', async () => {
  // A tool name that is not registered: sniffToolCalls cannot recover it, so the loop keeps
  // the raw text — but the DISPLAY contract (scrub.ts) still strips the scaffolding.
  const prose = 'Here is the result.';
  const envelope = `${OPEN}{"name":"totally_made_up_tool","arguments":{}}${CLOSE}`;
  const out = await captureHeadless((bus) => {
    bus.emit({ type: 'text', delta: `${prose}\n${envelope}` });
    bus.emit({ type: 'assistant_done', text: `${prose}\n${envelope}` });
    bus.emit({ type: 'stop', reason: 'end_turn', finalAnswer: prose });
  });
  assert.ok(out.includes(prose), `prose must print, got: ${JSON.stringify(out)}`);
  assert.equal(out.includes(OPEN), false, `raw XML leaked into headless output: ${JSON.stringify(out)}`);
});

test('F11-02: an interrupted turn still strips a half-written envelope from headless output', async () => {
  // Ctrl-C mid-stream: no assistant_done (turnIncomplete), only `stop`. The held suffix holds
  // an envelope whose closing tag never arrived — it must not leak.
  const prose = 'Working on it.';
  const partial = `${OPEN}{"name":"write_file","arguments":{"path":"a.txt","content":"ha`;
  const out = await captureHeadless((bus) => {
    bus.emit({ type: 'text', delta: prose + '\n' });
    bus.emit({ type: 'text', delta: partial });
    bus.emit({ type: 'stop', reason: 'interrupted', finalAnswer: prose });
  });
  assert.ok(out.includes(prose), `prose must print, got: ${JSON.stringify(out)}`);
  assert.equal(out.includes(OPEN), false, `half-written XML leaked: ${JSON.stringify(out)}`);
});

test('headless streaming prints ordinary prose and code fences without loss', async () => {
  // Guard against over-stripping: the intent hold must not swallow legitimate output.
  const text = 'Answer line one.\n```python\nprint("hi")\n```\nDone.\n';
  const out = await captureHeadless((bus) => {
    for (const ch of text) bus.emit({ type: 'text', delta: ch });
    bus.emit({ type: 'assistant_done', text });
    bus.emit({ type: 'stop', reason: 'end_turn', finalAnswer: text });
  });
  assert.ok(out.includes('Answer line one.'), out);
  assert.ok(out.includes('print("hi")'), out);
  assert.ok(out.includes('Done.'), out);
});
