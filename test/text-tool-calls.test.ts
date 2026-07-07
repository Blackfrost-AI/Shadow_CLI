import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sniffToolCalls } from '../src/provider/textToolCalls.js';

const known = (n: string) => ['write_file', 'run_shell', 'read_file'].includes(n);

test('recovers a <tool_call> span and removes it from the text', () => {
  const r = sniffToolCalls(
    'sure<tool_call>{"name":"write_file","arguments":{"path":"a.txt","content":"hi"}}</tool_call>',
    known,
  );
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0]!.name, 'write_file');
  assert.deepEqual(r.calls[0]!.input, { path: 'a.txt', content: 'hi' });
  assert.equal(r.cleaned, 'sure');
});

test('recovers the call:NAME{…} form', () => {
  const r = sniffToolCalls('call:run_shell{"command":"echo hi"}', known);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0]!.name, 'run_shell');
  assert.deepEqual(r.calls[0]!.input, { command: 'echo hi' });
});

test('recovers a {"tool_calls":[…]} envelope', () => {
  const r = sniffToolCalls('{"tool_calls":[{"name":"write_file","args":{"path":"x","content":"y"}}]}', known);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0]!.name, 'write_file');
  assert.deepEqual(r.calls[0]!.input, { path: 'x', content: 'y' });
});

test('XML form: a dropped </parameter> after the first arg does NOT swallow the next arg (ENAMETOOLONG bug)', () => {
  // Kali-4B emitted exactly this shape: no </parameter> after `path`, so the whole CSS body used to
  // be captured as `path` → the write failed with ENAMETOOLONG and the CSS leaked into the transcript.
  const css = '/* housebreak.css */\nbody { margin: 0; }\n.hero { display: flex; }';
  const r = sniffToolCalls(`<function=write_file><parameter=path>styles.css<parameter=content>${css}</parameter></function>`, known);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0]!.name, 'write_file');
  assert.deepEqual(r.calls[0]!.input, { path: 'styles.css', content: css });
  assert.doesNotMatch(r.cleaned, /housebreak|parameter>/); // no leaked CSS or tag fragments
});

test('XML form: a missing </function> still recovers the call', () => {
  const r = sniffToolCalls('<function=write_file><parameter=path>a.txt</parameter><parameter=content>hi there</parameter>', known);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0]!.input, { path: 'a.txt', content: 'hi there' });
});

test('XML form: a well-formed call still parses and is fully removed from the text', () => {
  const r = sniffToolCalls('ok <function=write_file><parameter=path>a.txt</parameter><parameter=content>hi</parameter></function> done', known);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0]!.input, { path: 'a.txt', content: 'hi' });
  assert.doesNotMatch(r.cleaned, /parameter|function/); // tags scrubbed
});

test('recovers the nested {writables:[{tool_calls:[…]}]} envelope with single quotes', () => {
  const r = sniffToolCalls(
    `{'writables':[{'role':'assistant','tool_calls':[{'name':'write_file','args':{'path':'p','content':'c'}}]}]}`,
    known,
  );
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0]!.name, 'write_file');
  assert.deepEqual(r.calls[0]!.input, { path: 'p', content: 'c' });
});

test('recovers DeepSeek native token tool-call form and strips its control tokens', () => {
  const text =
    'Let me create the file:<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>write_file\n' +
    '```json\n{"path": "prime.py", "content": "print(1)"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
  const r = sniffToolCalls(text, known);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0]!.name, 'write_file');
  assert.deepEqual(r.calls[0]!.input, { path: 'prime.py', content: 'print(1)' });
  assert.ok(!/tool▁|tool▁sep|｜/.test(r.cleaned), 'DeepSeek control tokens must be scrubbed from cleaned text');
  assert.equal(r.cleaned, 'Let me create the file:');
});

test('recovers MULTIPLE DeepSeek calls in one envelope', () => {
  const text =
    '<｜tool▁calls▁begin｜>' +
    '<｜tool▁call▁begin｜>function<｜tool▁sep｜>write_file\n```json\n{"path":"a","content":"x"}\n```<｜tool▁call▁end｜>' +
    '<｜tool▁call▁begin｜>function<｜tool▁sep｜>read_file\n```json\n{"path":"a"}\n```<｜tool▁call▁end｜>' +
    '<｜tool▁calls▁end｜>';
  const r = sniffToolCalls(text, known);
  assert.equal(r.calls.length, 2);
  assert.deepEqual(r.calls.map((c) => c.name), ['write_file', 'read_file']);
});

test('recovers a TRUNCATED DeepSeek call (missing closing token)', () => {
  const text = '<｜tool▁call▁begin｜>function<｜tool▁sep｜>run_shell\n```json\n{"command":"echo hi"}\n```';
  const r = sniffToolCalls(text, known);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0]!.name, 'run_shell');
  assert.deepEqual(r.calls[0]!.input, { command: 'echo hi' });
});

test('ignores unknown tool names and plain prose (no false positives)', () => {
  assert.equal(sniffToolCalls('<tool_call>{"name":"nope","arguments":{}}</tool_call>', known).calls.length, 0);
  assert.equal(sniffToolCalls('I will use write_file to save the result.', known).calls.length, 0);
});

test('recovers the Hermes/Qwen <function>/<parameter> XML form inside <tool_call> (the stall case)', () => {
  const r = sniffToolCalls(
    'Let me check.\n<tool_call><function=run_shell><parameter=command>find ~/Library -name "*.plist" 2>/dev/null</parameter></function></tool_call>',
    known,
  );
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0]!.name, 'run_shell');
  assert.deepEqual(r.calls[0]!.input, { command: 'find ~/Library -name "*.plist" 2>/dev/null' });
  assert.equal(r.cleaned, 'Let me check.');
});

test('recovers a bare <function> XML call with multiple <parameter>s (no <tool_call> wrapper)', () => {
  const r = sniffToolCalls(
    '<function=write_file><parameter=path>a.txt</parameter><parameter=content>hello world</parameter></function>',
    known,
  );
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0]!.name, 'write_file');
  assert.deepEqual(r.calls[0]!.input, { path: 'a.txt', content: 'hello world' });
});

test('XML form: accepts the name="..." attribute style too', () => {
  const r = sniffToolCalls('<function name="read_file"><parameter name="path">x.ts</parameter></function>', known);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0]!.name, 'read_file');
  assert.deepEqual(r.calls[0]!.input, { path: 'x.ts' });
});

test('XML form: no false positive on an unknown tool name', () => {
  assert.equal(
    sniffToolCalls('<tool_call><function=nope><parameter=x>1</parameter></function></tool_call>', known).calls.length,
    0,
  );
});

test('XML value containing </function> / </parameter> is preserved, not truncated (data-loss fix)', () => {
  const content = 'doc line\n</function> and </parameter> shown literally here\nlast line';
  const r = sniffToolCalls(
    `<function=write_file><parameter=path>a.txt</parameter><parameter=content>${content}</parameter></function>`,
    known,
  );
  assert.equal(r.calls.length, 1, 'the call is recovered');
  assert.equal((r.calls[0]!.input as { content?: string }).content, content, 'the full value survives inner tag-like text');
});

test('a JSON tool-call printed as a prose EXAMPLE is not executed (over-recovery fix)', () => {
  const r = sniffToolCalls(
    'To write a file, you emit: {"name":"write_file","input":{"path":"demo.txt","content":"hello"}} — that would run write_file.',
    known,
  );
  assert.equal(r.calls.length, 0, 'a bare {name,input} embedded in explanatory prose must NOT run the tool');
});
