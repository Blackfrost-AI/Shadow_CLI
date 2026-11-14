import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Cross-repo end-to-end proof of the Shadow ecosystem: the REAL Shadow Desktop companion client
// (Desktop/src/main/shadowHost.ts) drives the REAL `shadow web` host with the deterministic mock
// provider — no network, no keys. Opt-in like the live-server tests: set SHADOW_E2E_DESKTOP_DIR to
// the Desktop checkout to run it; otherwise this file only registers a skip, so CI stays hermetic.
const desktopDir = process.env.SHADOW_E2E_DESKTOP_DIR;

if (!desktopDir) {
  test(
    'desktop companion end-to-end (skipped: set SHADOW_E2E_DESKTOP_DIR to the Desktop checkout)',
    { skip: true },
    () => {},
  );
} else {
  // Isolate ~/.shadow FIRST: startWebServer and the project allowlist read the global store.
  const { isolateHome, assertStoreIsolated } = await import('./helpers/isolateHome.js');
  const { home: HOME } = isolateHome('hoste2e');
  const store = await import('../src/state/globalStore.js');
  assertStoreIsolated(store.GLOBAL_DIR, HOME);
  const projects = await import('../src/web/projects.js');
  const serverMod = await import('../src/web/server.js');
  const { EventBus } = await import('../src/agent/events.js');
  const { ShadowHostClient } = await import(
    pathToFileURL(join(desktopDir, 'src/main/shadowHost.ts')).href
  );

  (store as unknown as { saveGlobalConfig: (c: unknown) => void }).saveGlobalConfig({
    provider: 'mock',
    model: 'mock',
    projects: [],
  });

  function project(): string {
    return realpathSync(mkdtempSync(join(HOME, 'e2e-project-')));
  }

  test('the real desktop client handshakes, opens, drives and reads back a CLI session', async () => {
    const proj = project();
    const server = await serverMod.startWebServer({
      bus: new EventBus(),
      workspaceRoot: proj,
    });
    const client = new ShadowHostClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      token: server.token,
    });
    let watchPromise: Promise<void> | undefined;
    const controller = new AbortController();
    try {
      // The OpenAPI-shaped contract the desktop relies on.
      const handshake = await client.handshake();
      assert.equal(handshake.name, 'shadow');
      assert.equal(handshake.protocol, 1);
      assert.ok(handshake.capabilities.includes('chat'));

      projects.addProject(proj);
      const listed = await client.projects();
      assert.ok(
        (listed as Array<{ path: string }>).some((entry: { path: string }) => entry.path === proj),
        'the allowlisted project is listed for the companion',
      );

      const { id } = await client.create({ projectRoot: proj });
      assert.ok(id, 'a session id comes back');

      // Attach the live stream BEFORE submitting; the SSE replay ring guarantees no dropped frame
      // even if the turn starts before the reader is connected.
      const reply = await new Promise<{ text: unknown }>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('timed out waiting for the mock reply')),
          20_000,
        );
        watchPromise = client
          .watch(
            id,
            undefined,
            (_eventId: unknown, event: { type?: string } & Record<string, unknown>) => {
              if (event.type === 'assistant_done') {
                clearTimeout(timer);
                resolve(event as { text: unknown });
              }
            },
            controller.signal,
          )
          .catch((error: unknown) => {
            if (!controller.signal.aborted) {
              clearTimeout(timer);
              reject(error);
            }
          });
        // Submit only after the reader is wired.
        queueMicrotask(() => {
          void client
            .submit(id, 'hello from Shadow Desktop')
            .catch((error: unknown) => {
              clearTimeout(timer);
              reject(error);
            });
        });
      });

      // demoMock streams a deterministic acknowledgement of the exact prompt.
      assert.match(String(reply.text), /Shadow \(mock\)/);
      assert.match(String(reply.text), /hello from Shadow Desktop/);

      // The same turn is readable back through the transcript the desktop hydrates from.
      const transcript = await client.transcript(id);
      const types = (transcript.events as Array<{ event: { type: string } }>).map(
        (entry: { event: { type: string } }) => entry.event.type,
      );
      assert.ok(types.includes('user'), 'the user turn is recorded');
      assert.ok(types.includes('assistant_done'), 'the assistant turn is recorded');

      // Interrupt is revocation-style: always safe, reports whether a turn was live.
      assert.equal(typeof (await client.interrupt(id)), 'boolean');

      const sessions = await client.sessions();
      const row = (sessions as Array<{ id?: string; canPrompt?: boolean }>).find(
        (session: { id?: string }) => session.id === id,
      );
      assert.ok(row, 'the driven session is listed');
      assert.equal(row.canPrompt, true, 'the companion-opened session is drivable');
    } finally {
      controller.abort();
      await watchPromise?.catch(() => {});
      await server.close();
      rmSync(proj, { recursive: true, force: true });
    }
  });
}