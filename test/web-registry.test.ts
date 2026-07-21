import test from 'node:test';
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { EventBus } from '../src/agent/events.js';
import type { AgentSession } from '../src/agent/bootstrap.js';
import {
  createSessionRegistry,
  CLI_SESSION_ID,
  type AgentBuilder,
  type TurnRunner,
  type WebSession,
  type McpHandle,
  type JailCapability,
} from '../src/web/registry.js';

/**
 * The registry with an INJECTED mock builder — no credentials, no MCP, no model server. Pins the
 * load-bearing constraint: nothing builds an agent except submit(); GET /api/sessions, SSE attach
 * and /api/transcript never do. A build failure is contained to its own session with a guaranteed
 * terminal frame, and every other session keeps serving.
 */

function fakeRes(): ServerResponse & { text(): string } {
  const frames: string[] = [];
  const res = {
    write(s: string, cb?: () => void): boolean {
      frames.push(s);
      cb?.();
      return true;
    },
    end(): void {},
    text(): string {
      return frames.join('');
    },
  };
  return res as unknown as ServerResponse & { text(): string };
}

const JAIL: JailCapability = { workspaceRoot: '/tmp/ws', additionalRoots: [] };

function makeAgent() {
  const counts = { bgKill: 0, wakeupClear: 0 };
  const agent = {
    bg: { killAll: () => counts.bgKill++ },
    wakeup: { clear: () => counts.wakeupClear++ },
  } as unknown as AgentSession;
  return { agent, counts };
}

function makeMcp(): { handle: McpHandle; stopped: () => number } {
  let n = 0;
  return { handle: { stop: () => n++ }, stopped: () => n };
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error('condition never became true');
}

/** Build a registry whose builder/runTurn are spies. Overrides supply the behavior; the wrappers
 *  always count the call first. */
function makeRegistry(overrides?: { builder?: AgentBuilder; runTurn?: TurnRunner }) {
  const calls = { builder: 0, runTurn: 0 };
  const defaultBuilder: AgentBuilder = async () => ({ agent: makeAgent().agent, mcp: [], jail: JAIL });
  const builder: AgentBuilder = async (s) => {
    calls.builder++;
    return (overrides?.builder ?? defaultBuilder)(s);
  };
  const runTurn: TurnRunner = async (s, p) => {
    calls.runTurn++;
    if (overrides?.runTurn) await overrides.runTurn(s, p);
  };
  const registry = createSessionRegistry({ builder, runTurn });
  return { registry, calls };
}

test('create() and the read path never build an agent', async () => {
  const { registry, calls } = makeRegistry();
  registry.attachReserved({ bus: new EventBus(), displayPath: '/tmp/ws', origin: 'local' });
  const s = registry.create({ projectRoot: '/tmp/ws' });

  registry.list(); // GET /api/sessions
  s.stream.attach(fakeRes()); // SSE attach
  s.stream.transcript(); // /api/transcript

  assert.equal(calls.builder, 0, 'nothing above builds an agent');
  assert.equal(s.agent, null);
});

test('first submit builds exactly once; a second submit while a turn is in flight is 409 busy', async () => {
  let releaseBuild!: () => void;
  const gate = new Promise<void>((r) => (releaseBuild = r));
  const { registry, calls } = makeRegistry({
    builder: async () => {
      await gate; // hold the build open so status stays 'initializing'
      return { agent: makeAgent().agent, mcp: [], jail: JAIL };
    },
  });
  const s = registry.create({ projectRoot: '/tmp/ws' });

  const first = await registry.submit(s.id, 'hi');
  assert.deepEqual(first, { ok: true });
  await until(() => registry.get(s.id)!.status === 'initializing');

  const second = await registry.submit(s.id, 'again');
  assert.deepEqual(second, { ok: false, code: 409, reason: 'busy' });

  releaseBuild();
  await until(() => registry.get(s.id)!.status === 'idle');
  assert.equal(calls.builder, 1, 'the build ran once despite two submits');
  assert.equal(calls.runTurn, 1, 'exactly one turn ran');
});

test('a build failure is contained: status error, a terminal frame, secret scrubbed, others alive', async () => {
  const { registry } = makeRegistry({
    builder: async () => {
      throw new Error('provider handshake failed: key sk-abcdef0123456789abcdef leaked');
    },
  });
  const a = registry.create({ projectRoot: '/tmp/a' });
  const b = registry.create({ projectRoot: '/tmp/b' });
  const resA = fakeRes();
  const resB = fakeRes();
  a.stream.attach(resA);
  b.stream.attach(resB);

  await registry.submit(a.id, 'go');
  await until(() => registry.get(a.id)!.status === 'error');

  assert.equal(a.lastError !== null && a.lastError.includes('sk-abcdef0123456789abcdef'), false, 'key scrubbed from lastError');
  // Terminal frame so the browser spinner stops: an error, then a stop.
  assert.ok(resA.text().includes('"type":"error"'), 'error frame reached A');
  assert.ok(resA.text().includes('"type":"stop"'), 'terminal stop frame reached A');
  assert.ok(!resA.text().includes('sk-abcdef0123456789abcdef'), 'key scrubbed from the wire');

  // B is untouched: only the SSE preamble, no event frames, still idle, live client.
  assert.ok(!resB.text().includes('"type":'), 'no event frames crossed into B');
  assert.equal(registry.get(b.id)!.status, 'idle');
  assert.equal(b.stream.clientCount(), 1);
});

test('retry after a failed build re-invokes the builder', async () => {
  let attempt = 0;
  const { registry, calls } = makeRegistry({
    builder: async () => {
      attempt++;
      if (attempt === 1) throw new Error('first build fails');
      return { agent: makeAgent().agent, mcp: [], jail: JAIL };
    },
  });
  const s = registry.create({ projectRoot: '/tmp/ws' });

  await registry.submit(s.id, 'go');
  await until(() => registry.get(s.id)!.status === 'error');
  await registry.submit(s.id, 'go again');
  await until(() => registry.get(s.id)!.status === 'idle');

  assert.equal(calls.builder, 2, 'the builder ran again after the failure');
});

test('close() stops mcp children, kills bg shells and clears wakeups exactly once', async () => {
  const { agent, counts } = makeAgent();
  const mcp = makeMcp();
  const { registry } = makeRegistry({
    builder: async () => ({ agent, mcp: [mcp.handle], jail: JAIL }),
  });
  const s = registry.create({ projectRoot: '/tmp/ws' });
  await registry.submit(s.id, 'go');
  await until(() => registry.get(s.id)!.status === 'idle');

  const removed = await registry.remove(s.id);
  assert.equal(removed, true);
  assert.equal(mcp.stopped(), 1, 'mcp.stop() once');
  assert.equal(counts.bgKill, 1, 'bg.killAll() once');
  assert.equal(counts.wakeupClear, 1, 'wakeup.clear() once');
  assert.equal(registry.get(s.id), undefined, 'removed from the map');
});

test('the reserved mirror cannot be prompted, and the reserved id is not client-claimable', async () => {
  const { registry } = makeRegistry();
  registry.attachReserved({ bus: new EventBus(), displayPath: '/tmp/ws', origin: 'mirror' });

  const r = await registry.submit(CLI_SESSION_ID, 'drive the terminal');
  assert.deepEqual(r, { ok: false, code: 409, reason: 'session_is_mirror' });

  // A browser session gets a random 16-hex id, never the reserved literal.
  const s = registry.create({ projectRoot: '/tmp/ws' });
  assert.notEqual(s.id, CLI_SESSION_ID);
  assert.match(s.id, /^[0-9a-f]{16}$/);

  // A second reserved attach is refused (there is exactly one).
  assert.throws(() => registry.attachReserved({ bus: new EventBus(), displayPath: '/x', origin: 'mirror' }));

  // remove() never deletes the reserved session.
  assert.equal(await registry.remove(CLI_SESSION_ID), false);
});

test('submit on an unknown id is 404', async () => {
  const { registry } = makeRegistry();
  const r = await registry.submit('deadbeefdeadbeef', 'hi');
  assert.deepEqual(r, { ok: false, code: 404, reason: 'unknown session' });
});

test('interrupt aborts a web session in flight and returns false for one that is idle', async () => {
  let seen: AbortSignal | null = null;
  const { registry } = makeRegistry({
    runTurn: (s: WebSession) =>
      new Promise<void>((resolve) => {
        seen = s.abort!.signal;
        s.abort!.signal.addEventListener('abort', () => resolve());
      }),
  });
  const s = registry.create({ projectRoot: '/tmp/ws' });

  assert.equal(registry.interrupt(s.id), false, 'nothing to interrupt while idle');
  await registry.submit(s.id, 'go');
  await until(() => registry.get(s.id)!.status === 'running');
  assert.equal(registry.interrupt(s.id), true, 'a running turn is interruptible');
  await until(() => registry.get(s.id)!.status === 'idle');
  assert.ok(seen, 'runTurn saw the abort signal');
});
