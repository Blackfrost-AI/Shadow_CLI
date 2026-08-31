import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

// Redirect ~/.shadow to a throwaway HOME BEFORE importing anything that loads config:
// globalStore derives GLOBAL_DIR from homedir() at module load, and these tests WRITE web.token
// into the global config.json — a runner ignoring process.env.HOME would rewrite the user's
// real ~/.shadow. `npm test`, never `bun test`.
const { home: HOME } = isolateHome('web-stable-token');

const store = await import('../src/state/globalStore.js');
assertStoreIsolated(store.GLOBAL_DIR, HOME);
const { EventBus } = await import('../src/agent/events.js');
const { startWebServer, resolveWebToken, WEB_TOKEN_MIN_LENGTH } = await import('../src/web/server.js');
const { runWeb, formatWebBoot } = await import('../src/web/cli.js');
const { openCommand } = await import('../src/web/browser.js');
const { loadConfig } = await import('../src/config.js');

/** 33 chars, base64url-shaped, no whitespace/control chars — a valid stable token. */
const STABLE_TOKEN = 'stable-web-token-0123456789abcdef';

const CONFIG_PATH = join(HOME, '.shadow', 'config.json');

/** Write (or, with null, remove) the GLOBAL config these tests read through loadConfig. */
function setGlobalConfig(cfg: Record<string, unknown> | null): void {
  if (cfg === null) rmSync(CONFIG_PATH, { force: true });
  else writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

function freshWorkspace(label: string): string {
  return mkdtempSync(join(tmpdir(), `webtok-${label}-`));
}

/** Read SSE frames until one containing `marker` arrives; return that data line. */
async function frameContaining(res: Response, marker: string, timeoutMs = 3000): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const m = buf.indexOf(marker);
      if (m !== -1) {
        // Walk back to the `data: ` prefix of the frame the marker landed in, forward to its EOL.
        const start = buf.lastIndexOf('data: ', m);
        let end = buf.indexOf('\n', m);
        if (end === -1) end = buf.length;
        return buf.slice(start === -1 ? 0 : start + 'data: '.length, end);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  throw new Error(`no SSE frame containing ${JSON.stringify(marker)} within ${timeoutMs}ms`);
}

test('a configured web.token wins over the per-boot random token', async () => {
  setGlobalConfig({ web: { token: STABLE_TOKEN } });
  const ws = freshWorkspace('wins');
  try {
    const h = await startWebServer({ bus: new EventBus(), workspaceRoot: ws });
    try {
      assert.equal(h.token, STABLE_TOKEN, 'the server authenticates with the configured token');
      assert.ok(h.url.endsWith(`#t=${STABLE_TOKEN}`), 'the join URL carries it in the fragment');

      // The configured token is what the auth gate actually checks…
      const ok = await fetch(`http://127.0.0.1:${h.port}/health?t=${encodeURIComponent(STABLE_TOKEN)}`);
      assert.equal(ok.status, 200, 'configured token accepted');
      const bad = await fetch(`http://127.0.0.1:${h.port}/health?t=${encodeURIComponent('not-the-token-0123456789')}`);
      assert.equal(bad.status, 401, 'any other token still refused');
    } finally {
      await h.close();
    }

    // …and stability is the point: a second boot (a restart) mints nothing new.
    const h2 = await startWebServer({ bus: new EventBus(), workspaceRoot: ws });
    try {
      assert.equal(h2.token, STABLE_TOKEN, 'a restart reuses the same token — no rotation dance');
    } finally {
      await h2.close();
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a too-short web.token rejects the boot with an actionable error', async () => {
  assert.equal(WEB_TOKEN_MIN_LENGTH, 16, 'the documented floor');
  setGlobalConfig({ web: { token: 'tooshort' } });
  const ws = freshWorkspace('short');
  try {
    await assert.rejects(
      startWebServer({ bus: new EventBus(), workspaceRoot: ws }),
      (e: Error) =>
        e.message.includes('at least 16 characters') &&
        e.message.includes('(got 8)') &&
        e.message.includes('~/.shadow/config.json'),
      'the error names the limit, the actual length, and the file to fix',
    );
    // The pure resolver rejects identically (startWebServer is the integration path).
    assert.throws(() => resolveWebToken({ web: { token: 'x'.repeat(15) } }), /at least 16 characters/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a web.token with whitespace or control characters is rejected', async () => {
  const ws = freshWorkspace('badchars');
  try {
    for (const bad of [
      'abcdefghijklmnopqrst uvwxyz', // interior space (29 chars — long enough, still refused)
      'abcdefghijklmnop\tuvwxyz0123', // tab
      'abcdefghijklmnop\nuvwxyz0123', // newline
      'abcdefg\u0007hijklmnopqrstuvwxyz', // C0 control char (BEL)
    ]) {
      setGlobalConfig({ web: { token: bad } });
      await assert.rejects(
        startWebServer({ bus: new EventBus(), workspaceRoot: ws }),
        /whitespace or control characters/,
        `refused: ${JSON.stringify(bad)}`,
      );
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('no configured token → the random fallback still mints a fresh token per boot', async () => {
  setGlobalConfig(null);
  const ws = freshWorkspace('random');
  try {
    const a = await startWebServer({ bus: new EventBus(), workspaceRoot: ws });
    const b = await startWebServer({ bus: new EventBus(), workspaceRoot: ws });
    try {
      assert.match(a.token, /^[A-Za-z0-9_-]{32}$/, '24 random bytes → 32 base64url chars');
      assert.match(b.token, /^[A-Za-z0-9_-]{32}$/);
      assert.notEqual(a.token, b.token, 'each boot mints its own token, as before');
      assert.ok(a.url.includes('#t='), 'fragment handoff preserved');
    } finally {
      await a.close();
      await b.close();
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('the config token is registered for redaction exactly like a random one', async () => {
  setGlobalConfig({ web: { token: STABLE_TOKEN } });
  const ws = freshWorkspace('redact');
  try {
    const bus = new EventBus();
    const h = await startWebServer({ bus, workspaceRoot: ws });
    try {
      const res = await fetch(`http://127.0.0.1:${h.port}/events?t=${encodeURIComponent(STABLE_TOKEN)}`);
      assert.equal(res.status, 200);
      const deadline = Date.now() + 2000;
      while (h.clients() === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      assert.equal(h.clients(), 1, 'client registered');

      bus.emit({ type: 'error', message: `leaked the console token: ${STABLE_TOKEN}` });
      // The marker survives redaction (only the token value is scrubbed), so this finds the frame.
      const frame = await frameContaining(res, 'leaked the console token');
      assert.ok(!frame.includes(STABLE_TOKEN), 'the stable token must be scrubbed from the wire');
    } finally {
      await h.close();
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a project shadow.config.json cannot pin the web token (global-only key)', () => {
  setGlobalConfig(null); // no global token in play — only the project file could supply one
  const ws = freshWorkspace('untrusted');
  try {
    writeFileSync(
      join(ws, 'shadow.config.json'),
      JSON.stringify({ web: { token: 'repo-pinned-token-0123456789' } }),
    );
    const cfg = loadConfig(ws);
    assert.equal(cfg.web.token, undefined, 'a cloned repo cannot choose the console credential');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('the boot block prints a one-line copy-paste join command with the fragment token', async () => {
  setGlobalConfig({ web: { token: STABLE_TOKEN } });
  const ws = freshWorkspace('bootline');
  try {
    const h = await startWebServer({ bus: new EventBus(), workspaceRoot: ws });
    try {
      const block = formatWebBoot(h);
      const joinLine = `${openCommand()} "${h.url}"`;
      assert.ok(block.split('\n').includes(`  ${joinLine}`), `join line present:\n${block}`);
      assert.ok(joinLine.includes('#t='), 'the token is handed over as a URL fragment');
      assert.ok(!joinLine.includes('?t='), 'never as a query string');
      assert.ok(joinLine.startsWith(`${openCommand()} "http://127.0.0.1:${h.port}/#t=`), joinLine);
    } finally {
      await h.close();
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('runWeb prints the join line end to end', async () => {
  setGlobalConfig({ web: { token: STABLE_TOKEN } });
  let output = '';
  let interrupted = false; // latch: stop() writes again, and `output` keeps the marker — fire once
  await runWeb({
    write: (s) => {
      output += s;
      // Boot block is out and runWeb is about to register its signal handlers; interrupt it so
      // the call returns. setImmediate fires after the handler registration (same tick, next
      // queue phase), and runWeb's once('SIGINT') is the only handler, so nothing else reacts.
      if (!interrupted && output.includes('Ctrl-C to stop')) {
        interrupted = true;
        setImmediate(() => process.kill(process.pid, 'SIGINT'));
      }
    },
    open: false,
  });
  assert.match(
    output,
    new RegExp(`${openCommand().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} "http://127\\.0\\.0\\.1:\\d+/#t=${STABLE_TOKEN}"`),
    `printed boot output:\n${output}`,
  );
});
