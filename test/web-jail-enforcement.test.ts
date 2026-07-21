import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

// Isolate ~/.shadow before importing anything that pulls in globalStore (GLOBAL_DIR is derived at
// module load). resolveJail + loadConfig read the global config. `npm test`, never `bun test`.
const { home: HOME } = isolateHome('jail');

const { buildTurnDeps } = await import('../src/web/runTurn.js');
const { makeAgentBuilder } = await import('../src/web/sessionAgent.js');
const { loadConfig } = await import('../src/config.js');
const store = await import('../src/state/globalStore.js');
const { ToolRegistry } = await import('../src/tools/registry.js');
const { Context } = await import('../src/agent/context.js');
const { TodoList } = await import('../src/agent/todo.js');
const { PlanModeState } = await import('../src/agent/planMode.js');
const { EventBus } = await import('../src/agent/events.js');
const { INSTALL_DIR } = await import('../src/installDir.js');
import type { AgentSession } from '../src/agent/bootstrap.js';
import type { WebSession, JailCapability } from '../src/web/registry.js';
import type { AutonomyLevel } from '../src/safety/permissions.js';

assertStoreIsolated(store.GLOBAL_DIR, HOME);

/** A minimal built session whose jail root DELIBERATELY differs from its display path, so a test
 *  can prove which one reaches buildLoopDeps. cfg comes from real defaults; the other agent fields
 *  are only passed through by buildTurnDeps. */
function fakeBuiltSession(opts: {
  jail: JailCapability;
  displayPath: string;
  autonomy?: AutonomyLevel;
  additionalDirectories?: string[];
}): WebSession {
  const cfg = { ...loadConfig(HOME), additionalDirectories: opts.additionalDirectories ?? [] };
  const agent = {
    cfg,
    provider: {} as never,
    registry: new ToolRegistry(),
    context: new Context({ contextBudget: cfg.contextBudget, triggerRatio: cfg.summarizeTriggerRatio, keepLastTurns: cfg.keepLastTurns }),
    system: 'system',
    todoList: new TodoList(),
    planMode: new PlanModeState(false),
    sessionLog: undefined,
  } as unknown as AgentSession;

  return {
    id: 'websess',
    displayPath: opts.displayPath,
    bus: new EventBus(),
    abort: new AbortController(),
    agent,
    jail: opts.jail,
    model: () => 'mock',
    autonomy: () => opts.autonomy ?? 'auto-edit',
  } as unknown as WebSession;
}

test('the jail reaching buildLoopDeps is the JailCapability root, never the display path', () => {
  const jail: JailCapability = Object.freeze({ workspaceRoot: '/private/tmp/pinned-jail', additionalRoots: [] });
  const deps = buildTurnDeps(fakeBuiltSession({ jail, displayPath: '/some/other/DISPLAY/path' }));

  assert.equal(deps.workspaceRoot, '/private/tmp/pinned-jail', 'the pinned jail root reaches buildLoopDeps');
  assert.notEqual(deps.workspaceRoot, '/some/other/DISPLAY/path', 'NOT the display path (trap #5)');
});

test('additionalRoots is the jail\'s [], never cfg.additionalDirectories', () => {
  const jail: JailCapability = Object.freeze({ workspaceRoot: '/private/tmp/j', additionalRoots: [] });
  const deps = buildTurnDeps(
    fakeBuiltSession({ jail, displayPath: '/x', additionalDirectories: ['/etc', '/'] }),
  );
  // deepEqual to [] proves the jail was not widened — cfg.additionalDirectories (/etc, /) never reaches it.
  assert.deepEqual(deps.additionalRoots, [], 'cfg.additionalDirectories never widens the web jail');
});

test('/ never appears in additionalRoots even at autonomy full with SHADOW_DEV_UNRESTRICTED=1', () => {
  const prev = process.env.SHADOW_DEV_UNRESTRICTED;
  process.env.SHADOW_DEV_UNRESTRICTED = '1';
  try {
    const jail: JailCapability = Object.freeze({ workspaceRoot: '/private/tmp/j', additionalRoots: [] });
    const deps = buildTurnDeps(fakeBuiltSession({ jail, displayPath: '/x', autonomy: 'full' }));
    // The web path never calls resolveUnrestricted and never pushes a filesystem root (trap #6).
    assert.deepEqual(deps.additionalRoots, [], 'full autonomy does not grant / on the web path');
    assert.equal(deps.workspaceRoot, '/private/tmp/j');
  } finally {
    if (prev === undefined) delete process.env.SHADOW_DEV_UNRESTRICTED;
    else process.env.SHADOW_DEV_UNRESTRICTED = prev;
  }
});

test('the REAL builder re-reads the allowlist FRESH and refuses a non-allowlisted project', async () => {
  // resolveJail runs at build time (not create), so a project that is not currently allowlisted —
  // whether never added or removed since — fails the build. No vault or provider needed: it throws
  // at resolveJail, before createAgentSession.
  store.saveGlobalConfig({ projects: [] });
  const builder = makeAgentBuilder({ bootConfig: loadConfig(HOME), installDir: INSTALL_DIR });
  const session = {
    id: 'web1',
    displayPath: '/definitely/not/allowlisted',
    bus: new EventBus(),
    model: () => '',
  } as unknown as WebSession;

  await assert.rejects(builder(session), /not an allowlisted project/);
});

test('the real builder builds end-to-end for an allowlisted project and connectMcp yields no clients', async () => {
  // Exercises connectMcp — dead code until this work item (trap #14) — as the sessionAgent path's
  // first production caller. Mock provider needs no credential; empty mcpServers → [].
  const projects = await import('../src/web/projects.js');
  store.saveGlobalConfig({ projects: [] });
  const proj = mkdtempSync(join(HOME, 'proj-'));
  try {
    projects.addProject(proj);
    const bootConfig = { ...loadConfig(HOME), provider: 'mock' as const, model: 'mock', mcpServers: {} };
    const builder = makeAgentBuilder({ bootConfig, installDir: INSTALL_DIR });
    const session = { id: 'web2', displayPath: proj, bus: new EventBus(), model: () => '' } as unknown as WebSession;

    const built = await builder(session);
    assert.deepEqual(built.mcp, [], 'connectMcp returned [] for empty mcpServers');
    assert.equal(built.jail.workspaceRoot, realpathSync(proj), 'jail pinned to the realpath root');
    assert.ok(built.agent, 'a real AgentSession was built');
    // The AgentSession now carries the jail on it (bootstrap addition), one source of truth.
    assert.equal(built.agent.workspaceRoot, realpathSync(proj));
    assert.deepEqual(built.agent.additionalRoots, []);
    built.agent.bg.killAll();
    built.agent.wakeup.clear();
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test('submit with the REAL builder to a revoked project ends in status error (containment), not a crash', async () => {
  const { createSessionRegistry } = await import('../src/web/registry.js');
  const { makeTurnRunner } = await import('../src/web/runTurn.js');
  store.saveGlobalConfig({ projects: [] });
  const registry = createSessionRegistry({
    builder: makeAgentBuilder({ bootConfig: loadConfig(HOME), installDir: INSTALL_DIR }),
    runTurn: makeTurnRunner(),
  });
  const s = registry.create({ projectRoot: '/not/allowlisted/x' });
  const r = await registry.submit(s.id, 'go');
  assert.deepEqual(r, { ok: true }, 'submit returns 202 immediately; the failure is async');

  const deadline = Date.now() + 3000;
  while (registry.get(s.id)!.status !== 'error' && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 5));
  }
  assert.equal(registry.get(s.id)!.status, 'error', 'the real build failure is contained, not thrown out');
  assert.match(registry.get(s.id)!.lastError ?? '', /not an allowlisted/);
});
