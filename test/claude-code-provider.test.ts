import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeProvider } from '../src/provider/claudeCode.js';
import { claudeCodeEnvironment, claudeCodeStatus, type ClaudeCodeRuntime } from '../src/auth/claudeCode.js';
import { setOfflineMode } from '../src/safety/egress.js';
import type { CompletionRequest, ProviderEvent } from '../src/provider/provider.js';

const flags = '--safe-mode --restricted --tools --strict-mcp-config --mcp-config --disable-slash-commands --no-chrome --no-session-persistence --json-schema --output-format --include-partial-messages --permission-prompts';
const fixtureScript = `
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const mode = process.env.CC_TEST_CASE;
if (args.includes('--version')) { console.log('2.1.277 (Claude Code)'); process.exit(0); }
if (args.includes('--help')) { console.log(mode === 'unsupported' ? '--tools' : ${JSON.stringify(flags)}); process.exit(0); }
if (args.includes('status')) { console.log(JSON.stringify({ loggedIn: mode !== 'logged-out', authMethod: mode === 'api' ? 'api_key' : 'claude.ai', email: 'private@example.invalid', token: 'TEST-SECRET-DO-NOT-SHOW' })); process.exit(mode === 'logged-out' ? 1 : 0); }
let input = '';
for await (const part of process.stdin) input += part;
fs.writeFileSync(process.env.CC_TEST_CAPTURE, JSON.stringify({ args, input, env: process.env, pid: process.pid }));
const emit = (x) => process.stdout.write(JSON.stringify(x) + '\\n');
const envelope = JSON.parse(process.env.CC_TEST_ENVELOPE || '{"text":"Final answer","toolCalls":[]}');
if (mode === 'hang' || mode === 'child') {
  process.on('SIGTERM', () => { if (mode === 'child') process.exit(0); });
  if (mode === 'child') {
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); process.send("ready"); setInterval(()=>{},1000)'], { stdio: ['ignore','ignore','ignore','ipc'] });
    child.once('message', () => fs.writeFileSync(process.env.CC_TEST_CHILD, String(child.pid)));
  }
  setInterval(() => {}, 1000);
} else if (mode === 'overflow') { process.stdout.write('x'.repeat(5 * 1024 * 1024)); }
else {
  emit({type:'stream_event',event:{type:'message_start',message:{id:'message-one',usage:{input_tokens:7,output_tokens:0}}}});
  emit({type:'stream_event',event:{type:'message_delta',usage:{output_tokens:3}}});
  emit({type:'assistant',message:{id:'message-one',usage:{input_tokens:7,output_tokens:3},content:[]}});
  emit({type:'stream_event', event:{delta:{type:'text_delta',text:'RAW ENVELOPE MUST NOT RENDER'}}});
  emit({type:'stream_event', event:{delta:{type:'thinking_delta',thinking:'Checking the request.'}}});
  if (mode === 'engine-tool') emit({type:'assistant',message:{content:[{type:'tool_use',name:'Bash',input:{command:'never execute'}}]}});
  if (mode === 'malformed') process.stdout.write('not-json\\n');
  else if (mode !== 'missing') {
    emit({type:'result', subtype: mode === 'result-error' ? 'error_max_structured_output_retries' : 'success', structured_output: mode === 'no-envelope' ? undefined : envelope, usage:{input_tokens:17,output_tokens:9,cache_read_input_tokens:4,cache_creation_input_tokens:2}});
    if (mode === 'duplicate') emit({type:'result',subtype:'success',structured_output:envelope});
  }
  if (mode === 'exit-failure') { console.error('TEST-SECRET-DO-NOT-SHOW'); process.exitCode = 1; }
}
`;

async function fixture(mode = 'ok', envelope?: unknown) {
  const dir = await mkdtemp(join(tmpdir(), 'shadow-claude-fixture-'));
  const script = join(dir, 'claude-fixture.mjs');
  await writeFile(script, fixtureScript);
  const runtime: ClaudeCodeRuntime = { executable: process.execPath, argsPrefix: [script], cwd: dir, killGraceMs: 30, env: { ...process.env, CC_TEST_CASE: mode, CC_TEST_CAPTURE: join(dir, 'capture.json'), CC_TEST_CHILD: join(dir, 'child.pid'), ...(envelope ? { CC_TEST_ENVELOPE: JSON.stringify(envelope) } : {}) } };
  const capture = async () => JSON.parse(await readFile(join(dir, 'capture.json'), 'utf8'));
  const waitForCapture = async () => {
    let lastError: unknown;
    for (let i = 0; i < 1000; i++) {
      try { return await capture(); }
      catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    throw lastError;
  };
  return { runtime, dir, cleanup: () => rm(dir, { recursive: true, force: true }), capture, waitForCapture };
}
const request = (extra: Partial<CompletionRequest> = {}): CompletionRequest => ({ model: 'sonnet', system: 'Shadow system', messages: [{ role: 'user', content: [{ type: 'text', text: 'Read the file' }] }], tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', required: ['path'], additionalProperties: false, properties: { path: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 5 } } } }], maxOutputTokens: 1000, ...extra });
async function collect(provider: ClaudeCodeProvider, req = request()): Promise<ProviderEvent[]> { const result: ProviderEvent[] = []; for await (const event of provider.send(req)) result.push(event); return result; }
const calls = (events: ProviderEvent[]) => events.filter((event) => event.type === 'tool_call');

test('Claude Code returns validated Shadow intents, full history, unique IDs and no raw JSON', async () => {
  const f = await fixture('ok', { text: 'Reading.', toolCalls: [{ name: 'read_file', input: { path: 'one.ts', limit: 2 } }] });
  try {
    f.runtime.env = { ...f.runtime.env, ANTHROPIC_API_KEY: 'api-secret', ANTHROPIC_AUTH_TOKEN: 'bearer-secret', ANTHROPIC_BASE_URL: 'https://gateway.invalid', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret' };
    const provider = new ClaudeCodeProvider({ model: 'sonnet' }, f.runtime);
    const req = request({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Original question' }] }, { role: 'assistant', content: [{ type: 'tool_use', id: 'old-id', name: 'read_file', input: { path: 'old.ts' } }] }, { role: 'tool', content: [{ type: 'tool_result', toolCallId: 'old-id', ok: true, content: 'recorded prior result' }] }] });
    const events = await collect(provider, req);
    assert.equal(provider.name, 'anthropic'); assert.equal(provider.allowAutomaticFallback, false);
    assert.deepEqual(events.filter((event) => event.type === 'text'), [{ type: 'text', delta: 'Reading.' }]);
    assert.deepEqual(events.find((event) => event.type === 'usage'), { type: 'usage', billing: 'subscription', inputTokens: 17, outputTokens: 9, cacheReadTokens: 4, cacheWriteTokens: 2 });
    assert.equal(calls(events).length, 1); assert.deepEqual(events.at(-1), { type: 'done', stopReason: 'tool_use' });
    const second = await collect(provider, req);
    assert.notEqual(calls(events)[0]!.call.id, calls(second)[0]!.call.id);
    const captured = await f.capture();
    assert.match(captured.input, /recorded prior result/); assert.match(captured.input, /Original question/); assert.match(captured.input, /old-id/);
    assert.equal(captured.args[captured.args.indexOf('--tools') + 1], '');
    for (const flag of ['--safe-mode', '--restricted', '--no-session-persistence', '--strict-mcp-config']) assert.ok(captured.args.includes(flag));
    assert.deepEqual(JSON.parse(captured.args[captured.args.indexOf('--mcp-config') + 1]), { mcpServers: {} });
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(captured.env[key], undefined);
    assert.equal(captured.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '1000'); assert.equal(captured.env.MAX_STRUCTURED_OUTPUT_RETRIES, '1');
    assert.equal(JSON.stringify(events).includes('RAW ENVELOPE'), false);
  } finally { await f.cleanup(); }
});

test('Claude Code refuses every incomplete/error terminal outcome without executing or displaying proposals', async (t) => {
  for (const mode of ['exit-failure', 'result-error', 'missing', 'no-envelope', 'duplicate', 'malformed', 'engine-tool', 'overflow']) await t.test(mode, async () => {
    const f = await fixture(mode, { text: 'Never show this', toolCalls: [{ name: 'read_file', input: { path: 'a.ts' } }] });
    try {
      const events = await collect(new ClaudeCodeProvider({ model: 'sonnet' }, f.runtime));
      assert.equal(calls(events).length, 0); assert.equal(events.some((event) => event.type === 'text' || event.type === 'done'), false);
      assert.equal(events.at(-1)?.type, 'error'); assert.equal(JSON.stringify(events).includes('TEST-SECRET'), false);
      assert.ok(events.filter((event) => event.type === 'usage').every((event) => event.billing === 'subscription'));
    } finally { await f.cleanup(); }
  });
});

test('Claude Code validates declared tool names, schema constraints and all toolChoice modes', async (t) => {
  const valid = { name: 'read_file', input: { path: 'a.ts' } };
  const scenarios: Array<{ name: string; toolCalls: unknown[]; req?: Partial<CompletionRequest> }> = [
    { name: 'unknown tool', toolCalls: [{ name: 'run_shell', input: { command: 'no' } }] },
    { name: 'required field', toolCalls: [{ name: 'read_file', input: {} }] },
    { name: 'empty string', toolCalls: [{ name: 'read_file', input: { path: '' } }] },
    { name: 'integer bound', toolCalls: [{ name: 'read_file', input: { path: 'a', limit: 6 } }] },
    { name: 'extra property', toolCalls: [{ name: 'read_file', input: { path: 'a', surprise: true } }] },
    { name: 'none', toolCalls: [valid], req: { toolChoice: { type: 'none' } } },
    { name: 'any', toolCalls: [], req: { toolChoice: { type: 'any' } } },
    { name: 'forced', toolCalls: [], req: { toolChoice: { type: 'tool', name: 'read_file' } } },
    { name: 'no parallel', toolCalls: [valid, valid], req: { toolChoice: { type: 'auto', disableParallelToolUse: true } } },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async () => {
    const f = await fixture('ok', { text: '', toolCalls: scenario.toolCalls });
    try { const events = await collect(new ClaudeCodeProvider({ model: 'sonnet' }, f.runtime), request(scenario.req)); assert.equal(calls(events).length, 0); assert.equal(events.at(-1)?.type, 'error'); }
    finally { await f.cleanup(); }
  });
});

test('Claude Code explicitly rejects image content, unsupported CLIs and non-subscription authentication', async (t) => {
  for (const mode of ['unsupported', 'api', 'logged-out']) await t.test(mode, async () => {
    const f = await fixture(mode);
    try { const events = await collect(new ClaudeCodeProvider({ model: 'sonnet' }, f.runtime)); assert.equal(events.at(-1)?.type, 'error'); await assert.rejects(f.capture()); }
    finally { await f.cleanup(); }
  });
  const f = await fixture();
  try {
    const events = await collect(new ClaudeCodeProvider({ model: 'sonnet' }, f.runtime), request({ messages: [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'not-sent' }] }] }));
    assert.equal(events.at(-1)?.type, 'error'); assert.equal((events.at(-1) as any).code, 'claude_code_images_unsupported'); await assert.rejects(f.capture());
  } finally { await f.cleanup(); }
});

test('Claude Code status exposes only safe metadata; environment preserves official config, not billing credentials', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await claudeCodeStatus({ runtime: f.runtime }), { installed: true, supported: true, version: '2.1.277', loggedIn: true, authMethod: 'claude.ai' });
    const env = claudeCodeEnvironment({ HOME: '/user-home', CLAUDE_CONFIG_DIR: '/official-config', NODE_OPTIONS: '--require bad.js', ANTHROPIC_API_KEY: 'secret' });
    assert.equal(env.HOME, '/user-home'); assert.equal(env.CLAUDE_CONFIG_DIR, '/official-config'); assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.ANTHROPIC_API_KEY, undefined); assert.equal(env.DISABLE_TELEMETRY, '1');
  } finally { await f.cleanup(); }
});

test('Claude Code records observed subscription usage once when a terminal result is missing', async () => {
  const f = await fixture('missing');
  try {
    const events = await collect(new ClaudeCodeProvider({ model: 'sonnet' }, f.runtime));
    assert.deepEqual(events.filter((event) => event.type === 'usage'), [{ type: 'usage', billing: 'subscription', inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 }]);
    assert.equal(events.at(-1)?.type, 'error');
  } finally { await f.cleanup(); }
});

test('Claude Code timeout and user abort terminate the process and emit no completed response', async (t) => {
  for (const userAbort of [false, true]) await t.test(userAbort ? 'abort' : 'deadline', async () => {
    const f = await fixture('hang'); const controller = new AbortController();
    try {
      const running = collect(new ClaudeCodeProvider({ model: 'sonnet', timeoutMs: userAbort ? 5000 : 100 }, f.runtime), request({ signal: controller.signal }));
      const captured = userAbort ? await f.waitForCapture() : undefined;
      if (userAbort) controller.abort();
      const events = await running;
      assert.equal(events.at(-1)?.type, 'error'); assert.equal(events.some((event) => event.type === 'done'), false);
      assert.equal((events.at(-1) as any).code, userAbort ? 'aborted' : 'claude_code_timeout');
      const completedCapture = captured ?? await f.capture();
      assert.throws(() => process.kill(completedCapture.pid, 0), { code: 'ESRCH' });
    } finally { controller.abort(); await f.cleanup(); }
  });
});

test('Claude Code cancellation kills an ignoring descendant even after its leader exits', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture('child'); const controller = new AbortController();
  try {
    const running = collect(new ClaudeCodeProvider({ model: 'sonnet', timeoutMs: 5000 }, f.runtime), request({ signal: controller.signal }));
    let pid = 0;
    for (let i = 0; i < 200 && !pid; i++) {
      try { pid = Number(await readFile(join(f.dir, 'child.pid'), 'utf8')); } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    assert.ok(pid > 0); controller.abort();
    const events = await running;
    assert.equal((events.at(-1) as any).code, 'aborted');
    // Init may need a short interval to reap a terminated orphan on some hosts.
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 10)); } catch { alive = false; }
    }
    assert.equal(alive, false, 'the descendant must not outlive interruption');
  } finally { controller.abort(); await f.cleanup(); }
});

test('Claude Code honors the offline wall before launching the official process', async () => {
  const f = await fixture();
  try {
    setOfflineMode(true);
    const events = await collect(new ClaudeCodeProvider({ model: 'sonnet' }, f.runtime));
    assert.equal((events.at(-1) as any).code, 'offline'); await assert.rejects(f.capture());
  } finally { setOfflineMode(false); await f.cleanup(); }
});
