process.env.NODE_ENV = 'test'; // __resetRunLock is test-gated; set before importing the lock

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { RpcPeer } from '../src/acp/jsonrpc.js';
import { createAcpServer, toAcpStopReason, type AcpServer } from '../src/acp/server.js';
import { createSessionRegistry } from '../src/web/registry.js';
import type { AgentBuilder, JailCapability, TurnRunner, WebSession } from '../src/web/registry.js';
import { runLock, __resetRunLock } from '../src/web/runLock.js';
import type { AgentSession } from '../src/agent/bootstrap.js';
import type { StopReasonExt } from '../src/agent/events.js';
import type { ToolResult } from '../src/tools/types.js';
import type { RequestPermissionResult } from '../src/acp/protocol.js';

/**
 * The ACP server end-to-end over a REAL RpcPeer wire (fed JSON lines, captured JSON lines), with
 * the registry's designed injection seam: a fake builder (no credentials/MCP/model) and scripted
 * turn runners. Pins the handshake, the allowlist trust boundary, unsupported-method errors,
 * prompt streaming + stopReason mapping, cancel, busy handling, run-lock queueing, and the
 * full editor round-trip for tool approvals.
 */

const JAIL: JailCapability = { workspaceRoot: '/tmp/ws', additionalRoots: [] };
const ALLOWED = '/tmp/ws';

function makeAgent(): AgentSession {
  return { bg: { killAll: () => {} }, wakeup: { clear: () => {} } } as unknown as AgentSession;
}

function makeBuilder(): AgentBuilder {
  return async () => ({ agent: makeAgent(), mcp: [], jail: JAIL });
}

/** The allowlist boundary, injected: only ALLOWED resolves; everything else is refused. */
function fakeResolve(root: string): JailCapability {
  if (root === ALLOWED) return JAIL;
  throw new Error(`"${root}" is not an allowlisted project`);
}

interface Harness {
  server: AcpServer;
  registry: ReturnType<typeof createSessionRegistry>;
  lines: string[];
  messages(): Array<Record<string, any>>;
  send(msg: Record<string, unknown>): void;
  rpc(method: string, params?: unknown): Promise<number>;
  responseFor(id: number): Record<string, any> | undefined;
  updates(): Array<Record<string, any>>;
  close(): Promise<void>;
}

function makeHarness(runTurn: TurnRunner): Harness {
  const lines: string[] = [];
  // Server ↔ peer reference each other; `server` starts null only to break the construction
  // cycle — it is bound before any feed() can arrive.
  let server: AcpServer | null = null;
  const peer = new RpcPeer(
    (line) => lines.push(line),
    {
      request: (m, p) => server!.handleRequest(m, p),
      notification: (m, p) => server!.handleNotification(m, p),
    },
  );
  const registry = createSessionRegistry({ builder: makeBuilder(), runTurn });
  server = createAcpServer({
    registry,
    resolveJail: fakeResolve,
    version: '9.9.9-test',
    notify: (m, p) => peer.notify(m, p),
    askPermission: async (params, signal) => {
      try {
        return (await peer.request('session/request_permission', params, signal ? { signal } : undefined)) as RequestPermissionResult;
      } catch {
        return undefined;
      }
    },
  });
  let nextId = 1000;
  const h: Harness = {
    server,
    registry,
    lines,
    messages: () => lines.map((l) => JSON.parse(l.replace(/\n$/, '')) as Record<string, any>),
    send: (msg) => peer.feed(`${JSON.stringify(msg)}\n`),
    async rpc(method, params) {
      const id = nextId++;
      h.send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
      return id;
    },
    responseFor: (id) => h.messages().find((m) => m.id === id && m.method === undefined),
    updates: () => h.messages().filter((m) => m.method === 'session/update'),
    close: () => server!.close(),
  };
  return h;
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2));
  if (!cond()) throw new Error('condition never became true');
}

/** A turn runner that runs a script against the session, then emits a terminal stop frame. */
const scripted =
  (script: (s: WebSession, prompt: string) => void, reason: StopReasonExt = 'end_turn'): TurnRunner =>
  async (s, prompt) => {
    script(s, prompt);
    s.bus.emit({ type: 'stop', reason, finalAnswer: '' });
  };

beforeEach(() => __resetRunLock());

test('initialize advertises protocol v1, no auth, text-only prompts, no loadSession', async () => {
  const h = makeHarness(scripted(() => {}));
  const id = await h.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
  await until(() => Boolean(h.responseFor(id)));
  assert.deepEqual(h.responseFor(id)!.result, {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: false,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
    },
    authMethods: [],
    agentInfo: { name: 'Shadow CLI', version: '9.9.9-test' },
  });
  await h.close();
});

test('unknown method → -32601', async () => {
  const h = makeHarness(scripted(() => {}));
  const id = await h.rpc('session/teleport', {});
  await until(() => Boolean(h.responseFor(id)));
  assert.equal(h.responseFor(id)!.error.code, -32601);
  await h.close();
});

test('authenticate / session/load / set_mode / set_model → unsupported (-32601) errors', async () => {
  const h = makeHarness(scripted(() => {}));
  const ids: number[] = [];
  ids.push(await h.rpc('authenticate', { methodId: 'x' }));
  ids.push(await h.rpc('session/load', { sessionId: 'x' }));
  ids.push(await h.rpc('session/set_mode', { sessionId: 'x', modeId: 'm' }));
  ids.push(await h.rpc('session/set_model', { sessionId: 'x', modelId: 'm' }));
  await until(() => ids.every((i) => Boolean(h.responseFor(i))));
  for (const i of ids) {
    const err = h.responseFor(i)!.error;
    assert.equal(err.code, -32601);
    assert.match(err.message, /not supported/);
  }
  await h.close();
});

test('session/new against an allowlisted cwd creates an "acp" session with empty modes/models', async () => {
  const h = makeHarness(scripted(() => {}));
  const id = await h.rpc('session/new', { cwd: ALLOWED });
  await until(() => Boolean(h.responseFor(id)));
  const result = h.responseFor(id)!.result;
  assert.equal(typeof result.sessionId, 'string');
  assert.deepEqual(result.modes, { modes: [] });
  assert.deepEqual(result.models, { models: [] });
  const session = h.registry.get(result.sessionId);
  assert.ok(session);
  assert.equal(session.origin, 'acp');
  assert.equal(session.title, 'ws');
  assert.equal(session.autonomy(), 'auto-edit');
  await h.close();
});

test('session/new outside the allowlist is refused with remediation text', async () => {
  const h = makeHarness(scripted(() => {}));
  const id = await h.rpc('session/new', { cwd: '/some/other/dir' });
  await until(() => Boolean(h.responseFor(id)));
  const err = h.responseFor(id)!.error;
  assert.equal(err.code, -32602);
  assert.match(err.message, /not an allowlisted project/);
  assert.match(err.message, /shadow acp --add-project/);
  await h.close();
});

test('session/prompt streams bus events as session/update and resolves with the mapped stopReason', async () => {
  const seen: string[] = [];
  const h = makeHarness(
    scripted((s, prompt) => {
      seen.push(prompt);
      s.bus.emit({ type: 'text', delta: 'Hello ' });
      s.bus.emit({ type: 'text', delta: 'world' });
      s.bus.emit({
        type: 'tool_start',
        call: { id: 'tc-1', name: 'read_file', input: { path: 'a.txt' } },
        risk: 'read',
      });
      s.bus.emit({
        type: 'tool_end',
        call: { id: 'tc-1', name: 'read_file', input: { path: 'a.txt' } },
        result: { ok: true, summary: 'read 3 lines', meta: { tool: 'read_file', durationMs: 1, risk: 'read' } } as ToolResult,
      });
      s.bus.emit({ type: 'todo', items: [{ id: 'todo-1', subject: 'done thing', status: 'completed' }] });
    }),
  );
  const newId = await h.rpc('session/new', { cwd: ALLOWED });
  await until(() => Boolean(h.responseFor(newId)));
  const sessionId = h.responseFor(newId)!.result.sessionId as string;

  const promptId = await h.rpc('session/prompt', { sessionId, content: [{ type: 'text', text: 'do the thing' }] });
  await until(() => Boolean(h.responseFor(promptId)));
  assert.deepEqual(h.responseFor(promptId)!.result, { stopReason: 'end_turn' });
  assert.deepEqual(seen, ['do the thing']);

  const updates = h.updates().map((u) => u.params.update.sessionUpdate);
  assert.deepEqual(updates, [
    'agent_message_chunk',
    'agent_message_chunk',
    'tool_call',
    'tool_call_update',
    'plan',
  ]);
  const toolCall = h.updates().find((u) => u.params.update.sessionUpdate === 'tool_call')!.params.update;
  assert.equal(toolCall.toolCallId, 'tc-1');
  assert.equal(toolCall.kind, 'read');
  assert.equal(toolCall.status, 'in_progress');
  // Every update names its session.
  for (const u of h.updates()) assert.equal(u.params.sessionId, sessionId);
  await h.close();
});

test('multi-block text prompts are joined; non-text blocks, empty content, and blank prompts are typed errors', async () => {
  const seen: string[] = [];
  const h = makeHarness(scripted((_s, p) => seen.push(p)));
  const newId = await h.rpc('session/new', { cwd: ALLOWED });
  await until(() => Boolean(h.responseFor(newId)));
  const sessionId = h.responseFor(newId)!.result.sessionId as string;

  const ok = await h.rpc('session/prompt', {
    sessionId,
    content: [
      { type: 'text', text: 'part one' },
      { type: 'text', text: 'part two' },
    ],
  });
  await until(() => Boolean(h.responseFor(ok)));
  assert.equal(h.responseFor(ok)!.error, undefined);
  assert.deepEqual(seen, ['part one\npart two']);

  const img = await h.rpc('session/prompt', { sessionId, content: [{ type: 'image', data: 'x' }] });
  await until(() => Boolean(h.responseFor(img)));
  assert.equal(h.responseFor(img)!.error.code, -32602);
  assert.match(h.responseFor(img)!.error.message, /text only/);

  const empty = await h.rpc('session/prompt', { sessionId, content: [] });
  await until(() => Boolean(h.responseFor(empty)));
  assert.equal(h.responseFor(empty)!.error.code, -32602);

  const blank = await h.rpc('session/prompt', { sessionId, content: [{ type: 'text', text: '   ' }] });
  await until(() => Boolean(h.responseFor(blank)));
  assert.equal(h.responseFor(blank)!.error.code, -32602);
  await h.close();
});

test('session/prompt accepts the ACP v1 `prompt` field (the spec spelling) and prefers it over legacy `content`', async () => {
  const seen: string[] = [];
  const h = makeHarness(scripted((_s, p) => seen.push(p)));
  const newId = await h.rpc('session/new', { cwd: ALLOWED });
  await until(() => Boolean(h.responseFor(newId)));
  const sessionId = h.responseFor(newId)!.result.sessionId as string;

  // Spec shape: ContentBlock[] under `prompt`, no `content` key at all.
  const specId = await h.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'spec shape' }] });
  await until(() => Boolean(h.responseFor(specId)));
  assert.equal(h.responseFor(specId)!.error, undefined);

  // Both present: the spec field wins.
  const bothId = await h.rpc('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'from prompt' }],
    content: [{ type: 'text', text: 'from content' }],
  });
  await until(() => Boolean(h.responseFor(bothId)));
  assert.equal(h.responseFor(bothId)!.error, undefined);
  assert.deepEqual(seen, ['spec shape', 'from prompt']);
  await h.close();
});

test('secrets on the bus are scrubbed at the bus→wire seam — the ACP wire redacts like the web stream', async () => {
  const h = makeHarness(
    scripted((s) => {
      s.bus.emit({ type: 'text', delta: 'the key is sk-ant-0123456789abcdef0123456789abcdef' });
      s.bus.emit({
        type: 'tool_start',
        call: { id: 'tc-s', name: 'run_shell', input: { command: 'export API_TOKEN=ghp_0123456789abcdefghijklmn' } },
        risk: 'exec',
      });
      s.bus.emit({
        type: 'tool_end',
        call: { id: 'tc-s', name: 'run_shell', input: { command: 'x' } },
        result: { ok: true, summary: 'ran with sk-ant-0123456789abcdef0123456789abcdef', meta: { tool: 'run_shell', durationMs: 1, risk: 'exec' } } as ToolResult,
      });
    }),
  );
  const newId = await h.rpc('session/new', { cwd: ALLOWED });
  await until(() => Boolean(h.responseFor(newId)));
  const sessionId = h.responseFor(newId)!.result.sessionId as string;

  const promptId = await h.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go' }] });
  await until(() => Boolean(h.responseFor(promptId)));

  const wire = JSON.stringify(h.updates());
  assert.ok(!wire.includes('sk-ant-0123456789abcdef'), 'no raw provider key on the wire');
  assert.ok(!wire.includes('ghp_0123456789abcdef'), 'no raw GitHub token on the wire');
  assert.ok(wire.includes('[REDACTED]'), 'the scrub marker replaces them');
  await h.close();
});

test('prompt to an unknown session → -32602', async () => {
  const h = makeHarness(scripted(() => {}));
  const id = await h.rpc('session/prompt', { sessionId: 'ghost', content: [{ type: 'text', text: 'hi' }] });
  await until(() => Boolean(h.responseFor(id)));
  assert.equal(h.responseFor(id)!.error.code, -32602);
  await h.close();
});

test('session/cancel interrupts the turn → stopReason cancelled', async () => {
  // Mirrors the real loop: on abort, emit the interrupted stop frame and return (no throw).
  const runTurn: TurnRunner = async (s) => {
    await new Promise<void>((resolveRun) => {
      const onAbort = (): void => {
        s.bus.emit({ type: 'stop', reason: 'interrupted', finalAnswer: '' });
        resolveRun();
      };
      if (s.abort?.signal.aborted) return onAbort();
      s.abort?.signal.addEventListener('abort', onAbort, { once: true });
    });
  };
  const h = makeHarness(runTurn);
  const newId = await h.rpc('session/new', { cwd: ALLOWED });
  await until(() => Boolean(h.responseFor(newId)));
  const sessionId = h.responseFor(newId)!.result.sessionId as string;

  const promptId = await h.rpc('session/prompt', { sessionId, content: [{ type: 'text', text: 'long job' }] });
  await until(() => Boolean(h.registry.get(sessionId)?.abort));
  h.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
  await until(() => Boolean(h.responseFor(promptId)));
  assert.deepEqual(h.responseFor(promptId)!.result, { stopReason: 'cancelled' });
  await h.close();
});

test('a second prompt while the first is in flight is refused as busy', async () => {
  let release!: () => void;
  const runTurn: TurnRunner = (s) =>
    new Promise<void>((resolveRun) => {
      release = () => {
        s.bus.emit({ type: 'stop', reason: 'end_turn', finalAnswer: '' });
        resolveRun();
      };
    });
  const h = makeHarness(runTurn);
  const newId = await h.rpc('session/new', { cwd: ALLOWED });
  await until(() => Boolean(h.responseFor(newId)));
  const sessionId = h.responseFor(newId)!.result.sessionId as string;

  const first = await h.rpc('session/prompt', { sessionId, content: [{ type: 'text', text: 'one' }] });
  await until(() => h.registry.get(sessionId)?.status === 'running');
  const second = await h.rpc('session/prompt', { sessionId, content: [{ type: 'text', text: 'two' }] });
  await until(() => Boolean(h.responseFor(second)));
  assert.equal(h.responseFor(second)!.error.code, -32603);
  assert.match(h.responseFor(second)!.error.message, /busy/);
  release();
  await until(() => Boolean(h.responseFor(first)));
  assert.deepEqual(h.responseFor(first)!.result, { stopReason: 'end_turn' });
  await h.close();
});

test('turns serialize through the process-wide run lock across sessions (FIFO queueing)', async () => {
  const order: string[] = [];
  let releaseA!: () => void;
  const runTurn: TurnRunner = async (s) => {
    if (s.title === 'A') {
      order.push('A-start');
      await new Promise<void>((resolveRun) => {
        releaseA = () => {
          order.push('A-end');
          s.bus.emit({ type: 'stop', reason: 'end_turn', finalAnswer: '' });
          resolveRun();
        };
      });
    } else {
      order.push('B');
      s.bus.emit({ type: 'stop', reason: 'end_turn', finalAnswer: '' });
    }
  };
  const h = makeHarness(runTurn);

  // Two allowlisted sessions — the fake resolve roots both in the same jail.
  const aId = await h.rpc('session/new', { cwd: ALLOWED });
  await until(() => Boolean(h.responseFor(aId)));
  h.registry.get(h.responseFor(aId)!.result.sessionId)!.title = 'A';
  const bId = await h.rpc('session/new', { cwd: ALLOWED });
  await until(() => Boolean(h.responseFor(bId)));
  h.registry.get(h.responseFor(bId)!.result.sessionId)!.title = 'B';
  const a = h.responseFor(aId)!.result.sessionId as string;
  const b = h.responseFor(bId)!.result.sessionId as string;

  const promptA = await h.rpc('session/prompt', { sessionId: a, content: [{ type: 'text', text: 'a' }] });
  await until(() => h.registry.get(a)?.status === 'running');
  const promptB = await h.rpc('session/prompt', { sessionId: b, content: [{ type: 'text', text: 'b' }] });
  await until(() => h.registry.get(b)?.status === 'queued');

  // B must NOT run while A holds the lock.
  assert.deepEqual(order, ['A-start']);
  assert.equal(runLock.state().holder, a);
  releaseA();
  await until(() => Boolean(h.responseFor(promptA)) && Boolean(h.responseFor(promptB)));
  assert.deepEqual(order, ['A-start', 'A-end', 'B']);
  assert.deepEqual(h.responseFor(promptB)!.result, { stopReason: 'end_turn' });
  await h.close();
});

test('tool approvals make a full round-trip through session/request_permission', async () => {
  const decisions: string[] = [];
  const h = makeHarness(async (s) => {
    const gate = h.server.gateFor(s);
    s.bus.emit({ type: 'tool_start', call: { id: 'tc-1', name: 'run_shell', input: { command: 'ls' } }, risk: 'exec' });
    const d = await gate.request({
      id: 'ap_1',
      kind: 'permission',
      call: { id: 'tc-1', name: 'run_shell', input: { command: 'ls' } },
      risk: 'exec',
      reason: 'wants to run a shell command',
      preview: 'ls',
      signal: s.abort?.signal,
    });
    decisions.push(JSON.stringify(d));
    s.bus.emit({ type: 'stop', reason: 'end_turn', finalAnswer: '' });
  });
  const newId = await h.rpc('session/new', { cwd: ALLOWED });
  await until(() => Boolean(h.responseFor(newId)));
  const sessionId = h.responseFor(newId)!.result.sessionId as string;

  const promptId = await h.rpc('session/prompt', { sessionId, content: [{ type: 'text', text: 'list files' }] });
  // The editor receives a request_permission request; answer allow_once.
  await until(() => h.messages().some((m) => m.method === 'session/request_permission'));
  const req = h.messages().find((m) => m.method === 'session/request_permission')!;
  assert.equal(req.params.sessionId, sessionId);
  assert.equal(req.params.toolCall.title, 'run_shell');
  assert.equal(req.params.toolCall.kind, 'execute');
  assert.deepEqual(req.params.options.map((o: { optionId: string }) => o.optionId), [
    'reject_once',
    'allow_once',
    'allow_always',
  ]);
  h.send({ jsonrpc: '2.0', id: req.id, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } });

  await until(() => Boolean(h.responseFor(promptId)));
  assert.deepEqual(h.responseFor(promptId)!.result, { stopReason: 'end_turn' });
  assert.deepEqual(decisions, ['"approve"']);
  await h.close();
});

test('bus stop reasons map onto the pinned ACP stopReason set', () => {
  assert.equal(toAcpStopReason('end_turn'), 'end_turn');
  assert.equal(toAcpStopReason('interrupted'), 'cancelled');
  assert.equal(toAcpStopReason('max_tokens'), 'max_tokens');
  for (const r of ['tool_use', 'pause_turn', 'budget', 'max_iterations', 'fatal_tool_error', 'provider_error'] as const) {
    assert.equal(toAcpStopReason(r), 'end_turn', r);
  }
});
