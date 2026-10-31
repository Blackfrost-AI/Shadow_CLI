import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { EventBus } from '../src/agent/events.js';
import { Context } from '../src/agent/context.js';
import { parseArgs, VALUE_TAKING_FLAGS } from '../src/cli/flags.js';
import { AutomationOutput, exitCodeForStop, loadOutputSchema, readTaskInput, requestedMachineFormat } from '../src/cli/automation.js';
import { SessionLog } from '../src/state/session.js';
import { recordWorkCenterSnapshot } from '../src/state/workCenterPersistence.js';
import { WorkCenter } from '../src/app/workCenter.js';

const cli = resolve('src/index.ts');
const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href;

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'shadow-automation-'));
  const workspace = join(home, 'workspace');
  mkdirSync(workspace);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' };
  for (const key of Object.keys(env)) if (/^SHADOW_|^(OPENAI|ANTHROPIC|CODEX|CLAUDE)_/.test(key)) delete env[key];
  return { home, workspace, env, close: () => rmSync(home, { recursive: true, force: true }) };
}

function cliArgs(args: string[]) { return ['--import', loader, cli, ...args]; }

type SignalDelivery = 'native' | 'event';
const signalDelivery: SignalDelivery = process.platform === 'win32' ? 'event' : 'native';
function cancellationArgs(args: string[], home: string, delivery = signalDelivery): string[] {
  if (delivery === 'native') return cliArgs(args);
  // child.kill() on Windows force-terminates instead of delivering a console
  // signal. A test-only preload delivers the same process event over IPC so the
  // real CLI cancellation/abort/output handlers still run end-to-end. POSIX
  // continues to verify actual OS signal delivery. Nothing is added to the CLI.
  const bridge = join(home, 'signal-bridge.mjs');
  writeFileSync(bridge, `process.on('message', signal => {\n  if (signal === 'SIGINT' || signal === 'SIGTERM') process.emit(signal);\n});\nprocess.channel?.unref();\n`);
  return ['--import', pathToFileURL(bridge).href, ...cliArgs(args)];
}

async function cancelChild(child: ChildProcess, signal: 'SIGINT' | 'SIGTERM', delivery = signalDelivery): Promise<void> {
  if (delivery === 'native') { assert.equal(child.kill(signal), true); return; }
  await new Promise<void>((resolve, reject) => child.send(signal, (error) => error ? reject(error) : resolve()));
}

test('automation flags, early detection, and existing default output remain explicit', () => {
  assert.deepEqual(parseArgs([]), {});
  assert.equal(parseArgs(['--json']).outputFormat, 'jsonl');
  assert.equal(parseArgs(['--output-format=json']).outputFormat, 'json');
  assert.equal(parseArgs(['--output-schema', 'contract.json']).outputFormat, 'json');
  assert.equal(parseArgs(['--ephemeral']).ephemeral, true);
  for (const args of [['--output-format', 'xml'], ['--json', '--repl'], ['--json', '--web'], ['--output-schema', 'x', '--output-format', 'text']]) {
    assert.throws(() => parseArgs(args));
  }
  assert.equal(requestedMachineFormat(['--task', 'literal --json']), undefined);
  assert.equal(requestedMachineFormat(['--task', '--json']), undefined);
  assert.equal(requestedMachineFormat(['--output-schema', '--json', '--output-format', 'text']), undefined);
  assert.equal(requestedMachineFormat(['--', '--json']), undefined);
  assert.equal(requestedMachineFormat(['--output-format=broken']), 'json');
  assert.equal(requestedMachineFormat(['--json', '--output-format', 'text']), undefined);
  for (const flag of VALUE_TAKING_FLAGS) {
    assert.throws(() => parseArgs([flag]), new RegExp(`${flag} requires a value`));
  }
});

test('JSONL envelopes retain tool/job identities, omit private reasoning, and report checks honestly', () => {
  const lines: string[] = []; const bus = new EventBus();
  const out = new AutomationOutput('jsonl', (text) => lines.push(text));
  out.configure({ ephemeral: true }); const detach = out.attach(bus);
  bus.emit({ type: 'subagent_start', taskId: 'task-1', jobId: 'job-1', subagentType: 'research' });
  const call = { id: 'tool-1', name: 'acceptance_check', input: { jobId: 'job-1' }, signature: 'never-export-this' };
  bus.emit({ type: 'tool_start', call, risk: 'exec', subagent: 'task-1' });
  bus.emit({ type: 'tool_end', call, result: { ok: true, summary: 'unverified', data: { status: 'unverified' }, meta: { tool: call.name, risk: 'exec', durationMs: 1 } } });
  bus.emit({ type: 'thinking', delta: 'private stream' });
  bus.emit({ type: 'reasoning_done', text: 'private summary' });
  bus.emit({ type: 'stop', reason: 'end_turn', finalAnswer: 'Done' });
  assert.equal(out.finish(), 0); detach(); out.finish();
  const frames = lines.map((line) => JSON.parse(line));
  assert.equal(frames.filter((frame) => frame.type === 'result').length, 1);
  assert.deepEqual(frames.map((frame) => frame.sequence), frames.map((_, index) => index + 1));
  assert.equal(new Set(frames.map((frame) => frame.run_id)).size, 1);
  assert.ok(frames.every((frame) => frame.version === 1));
  assert.equal(frames.find((frame) => frame.type === 'subagent_start').job_id, 'job-1');
  assert.equal(frames.find((frame) => frame.type === 'tool_start').tool_call_id, 'tool-1');
  assert.equal(frames.find((frame) => frame.type === 'tool_start').task_id, 'task-1');
  assert.equal(frames.at(-1).checks[0].status, 'unverified');
  assert.doesNotMatch(lines.join(''), /never-export-this|private stream|private summary/);
});

test('schema validates only the final result, reports invalid JSON/shape, and never reruns work', () => {
  const f = fixture();
  try {
    const path = join(f.home, 'schema.json');
    writeFileSync(path, JSON.stringify({ type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } }, additionalProperties: false }));
    const schema = loadOutputSchema(path);
    for (const [answer, expected] of [['{"ok":true}', 0], ['{"ok":"yes"}', 4], ['```json\n{}\n```', 4]] as const) {
      const lines: string[] = []; const bus = new EventBus(); const output = new AutomationOutput('json', (text) => lines.push(text));
      output.configure({ schema }); output.attach(bus);
      bus.emit({ type: 'text', delta: 'intermediate commentary is not the final JSON' });
      bus.emit({ type: 'stop', reason: 'end_turn', finalAnswer: answer });
      assert.equal(output.finish(), expected);
      assert.equal(lines.length, 1);
      const result = JSON.parse(lines[0]!);
      assert.equal(result.exit_code, expected);
      assert.equal(result.result.structured?.ok, expected === 0 ? true : undefined);
    }
    writeFileSync(path, JSON.stringify({ $ref: 'https://example.invalid/schema.json' }));
    assert.throws(() => loadOutputSchema(path), /reference|resolve/i);
  } finally { f.close(); }
});

test('exit codes distinguish limits, runtime failure and cancellation', () => {
  assert.equal(exitCodeForStop('end_turn'), 0);
  assert.equal(exitCodeForStop('provider_error'), 1);
  assert.equal(exitCodeForStop('fatal_tool_error'), 1);
  for (const reason of ['max_tokens', 'max_iterations', 'budget', 'pause_turn', 'tool_use'] as const) assert.equal(exitCodeForStop(reason), 3);
  assert.equal(exitCodeForStop('interrupted'), 130);
  const lines: string[] = []; const bus = new EventBus(); const out = new AutomationOutput('json', (text) => lines.push(text));
  out.attach(bus);
  bus.emit({ type: 'finding', severity: 'warn', title: 'Completion remains unverified', body: 'A required check has not run.' });
  bus.emit({ type: 'stop', reason: 'end_turn', finalAnswer: 'The work is incomplete.' });
  assert.equal(out.finish(), 3);
  assert.equal(JSON.parse(lines[0]!).completion_verified, false);
});

test('ephemeral journal creates no files, sidecars, snapshots, or resumable record', () => {
  const f = fixture();
  try {
    const log = SessionLog.ephemeral(f.workspace);
    const context = new Context({ contextBudget: 10000, triggerRatio: 0.8, keepLastTurns: 4 });
    context.pinTask({ role: 'user', content: [{ type: 'text', text: 'secret conversation' }] });
    log.record({ kind: 'user', task: 'secret conversation' });
    log.recordSnapshot(context, 0);
    log.recordEvent({ type: 'assistant_done', text: 'private answer' });
    recordWorkCenterSnapshot(log, new WorkCenter().snapshot());
    assert.equal(log.persistent, false);
    assert.match(log.title, /secret conversation/i);
    assert.equal(log.lastError, undefined);
    assert.equal(existsSync(log.path), false);
    assert.deepEqual(readdirSync(f.workspace), []);
    log.close();
  } finally { f.close(); }
});

test('piped input is multiline, bounded, and cancellable before EOF', async () => {
  const pipe = new PassThrough(); const controller = new AbortController();
  const pending = readTaskInput(pipe, controller.signal);
  pipe.write('unfinished producer'); controller.abort(new Error('cancelled'));
  await assert.rejects(pending, /cancelled/);
  assert.equal(pipe.listenerCount('data'), 0); pipe.destroy();
  const complete = new PassThrough(); const read = readTaskInput(complete, new AbortController().signal);
  complete.end('one\ntwo\n'); assert.equal(await read, 'one\ntwo\n');
});

test('real CLI stdout is strict JSON/JSONL on success, schema failure, startup failure, and provider failure', { timeout: 45000 }, () => {
  const f = fixture();
  try {
    const cases = [
      { args: ['--task', 'print ok', '--provider', 'mock', '--output-format', 'json', '--ephemeral'], expected: 0 },
      { args: ['--task', 'print ok', '--provider', 'mock', '--json', '--ephemeral'], expected: 0 },
      { args: ['--task', 'print ok', '--provider', 'mock', '--json', '--bad-option'], expected: 2 },
      { args: ['--task', 'print ok', '--provider', 'mock', '--json'], expected: 1, env: { SHADOW_MOCK_ERROR: '1' } },
      { args: ['--task', 'print ok', '--json'], expected: 2 },
    ];
    for (const { args, expected, env } of cases) {
      const run = spawnSync(process.execPath, cliArgs(args), { cwd: f.workspace, env: { ...f.env, ...env }, encoding: 'utf8', timeout: 12000 });
      assert.equal(run.status, expected, `${args.join(' ')}\n${run.stderr}\n${run.stdout}`);
      const frames = run.stdout.trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(frames.at(-1).exit_code, expected);
      if (expected === 0) assert.equal(frames.at(-1).result.text, 'ok');
      assert.ok(frames.every((frame) => frame.version === 1));
      assert.doesNotMatch(run.stdout, /\x1b/);
    }
    const schema = join(f.home, 'schema.json'); writeFileSync(schema, '{"type":"object"}');
    const invalid = spawnSync(process.execPath, cliArgs(['--provider', 'mock', '--task', 'x', '--output-schema', schema, '--ephemeral']), { cwd: f.workspace, env: f.env, encoding: 'utf8', timeout: 12000 });
    assert.equal(invalid.status, 4, invalid.stderr);
    assert.equal(JSON.parse(invalid.stdout).errors[0].code, 'output_schema');
  } finally { f.close(); }
});

test('CLI ephemeral pipe preserves one multiline task and does not persist conversation or binding files', { timeout: 15000 }, () => {
  const f = fixture();
  try {
    const run = spawnSync(process.execPath, cliArgs(['--provider', 'mock', '--json', '--ephemeral']), {
      cwd: f.workspace, env: f.env, encoding: 'utf8', input: 'line one\nline two', timeout: 12000,
    });
    assert.equal(run.status, 0, run.stderr);
    const frames = run.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(frames.filter((frame) => frame.type === 'user').length, 1);
    assert.equal(frames.find((frame) => frame.type === 'user').data.text, 'line one\nline two');
    assert.equal(existsSync(join(f.workspace, '.shadow', 'sessions')), false);
    assert.equal(existsSync(join(f.home, '.shadow', 'session-harness-bindings')), false);
  } finally { f.close(); }
});

// Exercise the Windows event bridge on every host as well as real POSIX signals.
for (const delivery of (process.platform === 'win32' ? ['event'] : ['native', 'event']) as SignalDelivery[]) {
test(`CLI cancellation (${delivery}) interrupts a stalled provider and emits a final result without retry`, { timeout: 20000 }, async () => {
  const f = fixture(); let requests = 0;
  let received!: () => void; const requested = new Promise<void>((done) => { received = done; });
  const server = createServer((req, res) => {
    req.resume();
    if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404); res.end(); return; }
    requests++; res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n'); received();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const child = spawn(process.execPath, cancellationArgs(['--provider', 'openai', '--model', 'fixture', '--base-url', `http://127.0.0.1:${address.port}/v1`, '--task', 'fixture', '--json', '--ephemeral'], f.home, delivery), { cwd: f.workspace, env: { ...f.env, OPENAI_API_KEY: 'fixture-not-a-real-key' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  assert.ok(child.stdout && child.stderr);
  let stdout = ''; let stderr = ''; child.stdout.on('data', (data) => { stdout += data; }); child.stderr.on('data', (data) => { stderr += data; });
  const done = new Promise<number | null>((resolve) => child.once('close', resolve));
  const deadline = setTimeout(() => child.kill('SIGKILL'), 12000);
  try {
    await Promise.race([requested, done.then(() => { throw new Error(`child exited before request: ${stderr}`); })]);
    await cancelChild(child, 'SIGINT', delivery); assert.equal(await done, 130, stderr);
    const frames = stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(frames.at(-1).status, 'cancelled'); assert.equal(frames.at(-1).stop_reason, 'interrupted');
    assert.equal(requests, 1);
  } finally {
    clearTimeout(deadline); child.kill('SIGKILL'); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); f.close();
  }
});
}

test('CLI schema success returns a parsed structured value using a local fixture endpoint', { timeout: 15000 }, async () => {
  const f = fixture(); let requests = 0;
  const schema = join(f.home, 'schema.json'); writeFileSync(schema, '{"type":"object","required":["ok"],"properties":{"ok":{"const":true}},"additionalProperties":false}');
  const server = createServer((req, res) => {
    req.resume();
    if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404); res.end(); return; }
    requests++; res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"index":0,"delta":{"content":"{\\"ok\\":true}"}}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const child = spawn(process.execPath, cliArgs(['--provider', 'openai', '--model', 'fixture', '--base-url', `http://127.0.0.1:${address.port}/v1`, '--task', 'fixture', '--output-schema', schema, '--ephemeral']), { cwd: f.workspace, env: { ...f.env, OPENAI_API_KEY: 'fixture-not-a-real-key' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; child.stdout.on('data', (data) => { stdout += data; }); child.stderr.on('data', (data) => { stderr += data; });
  const done = new Promise<number | null>((resolve) => child.once('close', resolve)); const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    assert.equal(await done, 0, stderr);
    assert.deepEqual(JSON.parse(stdout).result.structured, { ok: true }); assert.equal(requests, 1);
  } finally { clearTimeout(deadline); child.kill('SIGKILL'); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); f.close(); }
});

test('CLI cancellation before piped EOF emits valid final JSON for SIGINT and SIGTERM', { timeout: 15000 }, async () => {
  for (const [signal, expected] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    const f = fixture();
    const child = spawn(process.execPath, cancellationArgs(['--provider', 'mock', '--json', '--ephemeral'], f.home), { cwd: f.workspace, env: f.env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    assert.ok(child.stdin && child.stdout && child.stderr);
    let stdout = ''; child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.resume();
    const done = new Promise<number | null>((resolve) => child.once('close', resolve));
    const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      // Layout is created after the machine transport is installed and before stdin is read.
      while (!existsSync(join(f.home, '.shadow')) && child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 20));
      child.stdin.write('still waiting for EOF'); await cancelChild(child, signal);
      assert.equal(await done, expected);
      const result = JSON.parse(stdout.trim()); assert.equal(result.status, 'cancelled'); assert.equal(result.exit_code, expected);
    } finally { clearTimeout(deadline); child.kill('SIGKILL'); f.close(); }
  }
});

test('ephemeral schema failure keeps an authorized file edit, writes no transcript, and never replays the action', { timeout: 15000 }, async () => {
  const f = fixture(); let requests = 0;
  const schema = join(f.home, 'schema.json'); writeFileSync(schema, '{"type":"object"}');
  const sessionOverride = join(f.home, 'external-transcripts');
  const frame = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  const server = createServer((req, res) => {
    req.resume();
    if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404); res.end(); return; }
    requests++; res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests === 1) {
      res.end(frame({ tool_calls: [{ index: 0, id: 'write-once', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'created.txt', content: 'keep this authorized output' }) } }] }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n');
    } else res.end(frame({ content: 'The file was written.' }) + frame({}, 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const child = spawn(process.execPath, cliArgs(['--provider', 'openai', '--model', 'fixture', '--base-url', `http://127.0.0.1:${address.port}/v1`, '--task', 'Create the requested fixture file', '--output-schema', schema, '--json', '--ephemeral']), {
    cwd: f.workspace, env: { ...f.env, OPENAI_API_KEY: 'fixture-not-a-real-key', SHADOW_SESSION_DIR: sessionOverride }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = ''; child.stdout.on('data', (data) => { stdout += data; }); child.stderr.on('data', (data) => { stderr += data; });
  const done = new Promise<number | null>((resolve) => child.once('close', resolve)); const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    assert.equal(await done, 4, stderr);
    assert.equal(requests, 2, 'one tool turn followed by one answer; schema failure must not trigger another attempt');
    assert.equal(readFileSync(join(f.workspace, 'created.txt'), 'utf8'), 'keep this authorized output');
    const frames = stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(frames.filter((item) => item.type === 'tool_start' && item.tool_call_id === 'write-once').length, 1);
    assert.equal(frames.at(-1).exit_code, 4);
    assert.equal(existsSync(join(f.workspace, '.shadow', 'sessions')), false);
    assert.equal(existsSync(sessionOverride), false);
    assert.equal(existsSync(join(f.home, '.shadow', 'session-harness-bindings')), false);
  } finally { clearTimeout(deadline); child.kill('SIGKILL'); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); f.close(); }
});
