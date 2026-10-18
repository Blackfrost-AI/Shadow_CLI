import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

/**
 * Tab activity indicator, verified against a REAL terminal.
 *
 * The unit tests in session-names.test.ts prove the frame math. This one proves the escape
 * actually reaches the terminal, that it animates while a turn is in flight, and — the property
 * most likely to regress — that it goes completely still when the session is idle. A spinner that
 * cannot stop is worse than no spinner: it reports work that is not happening.
 *
 * Runs the real CLI under a pty against a mock OpenAI-compatible provider, so nothing here is a
 * simulation of the write path. Skipped on Windows, which has no pty in Node core.
 */

const CLI = resolve('src/index.ts');

/**
 * Skip reason, or false to run. Windows has no `pty` in the stdlib; a host without `python3`
 * cannot allocate the pty either. Both skip cleanly rather than failing with a confusing
 * "captured 0 bytes" on a machine that simply lacks the tool.
 */
function skipReason(): string | false {
  if (process.platform === 'win32') return 'no pty on Windows';
  const probe = spawnSync('python3', ['-c', 'import pty, select; print("ok")'], { encoding: 'utf8' });
  if (probe.status !== 0) return 'python3 with pty module not available';
  return false;
}
const SKIP = skipReason();

/** A provider that streams a reply slowly enough for several ticks to land mid-turn. */
async function slowProvider(): Promise<{ baseUrl: string; close: () => void }> {
  const server = createServer((req, res) => {
    if (!req.url?.includes('/chat/completions')) {
      res.writeHead(404).end('{}');
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const chunk = (delta: object) =>
        `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta }] })}\n\n`;
      res.write(chunk({ role: 'assistant', content: '' }));
      // Hold the turn open ~700ms so the 120ms ticker produces several distinct frames.
      let n = 0;
      const timer = setInterval(() => {
        n++;
        if (n > 5) {
          clearInterval(timer);
          res.write(chunk({ content: ' done' }));
          res.write(`data: ${JSON.stringify({ id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.write(chunk({ content: ' .' }));
      }, 120);
      void body;
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, close: () => server.close() };
}

interface PtyResult {
  titles: string[];
  raw: string;
}

/**
 * Run the interactive TUI under a real pty, type one prompt, and collect every OSC-2 title escape.
 *
 * `--task` is deliberately headless, so the TUI never starts and never writes a title; proving the
 * indicator works means driving the real interactive path. Node core has no pty, and `script(1)`
 * refuses a piped stdin, so `test/fixtures/pty-run.py` allocates one with `pty.fork()`. That is
 * what makes `stdout.isTTY` true and the title path run at all.
 */
async function runInteractivePty(
  args: string[],
  env: NodeJS.ProcessEnv,
  prompt: string,
  timeoutSec = 30,
): Promise<PtyResult> {
  const out = join(mkdtempSync(join(tmpdir(), 'shadow-pty-out-')), 'raw.bin');
  const runner = resolve('test/fixtures/pty-run.py');
  const child = spawn(
    'python3',
    [runner, out, '2.0', String(timeoutSec), prompt, '--', process.execPath, '--import', 'tsx/esm', CLI, ...args],
    { env, stdio: 'ignore' },
  );
  const code = await new Promise<number | null>((r) => child.once('close', r));
  let raw = '';
  try {
    raw = readFileSync(out, 'utf8');
  } catch {
    raw = '';
  }
  rmSync(dirname(out), { recursive: true, force: true });
  // OSC 0 is what pi-tui's setTitle writes ("\x1b]0;title\x07"); OSC 2 is the equivalent
  // form used elsewhere. Accept both so the test tracks the terminal, not one library.
  const titles = [...raw.matchAll(/\x1b\][02];([^\x07]*)\x07/g)].map((m) => m[1]!);
  if (code !== 0 && titles.length === 0) {
    throw new Error(`pty runner exited ${code}; captured ${raw.length} bytes`);
  }
  return { titles, raw };
}

function fixture(): { home: string; workspace: string; env: (over: NodeJS.ProcessEnv) => NodeJS.ProcessEnv } {
  const home = mkdtempSync(join(tmpdir(), 'shadow-title-e2e-'));
  const workspace = join(home, 'ws');
  mkdirSync(workspace, { recursive: true });
  // Provider config goes on disk rather than through flags: the CLI's `--provider/--model` pair
  // resolves against a configured catalog, so a bare `--model mock` is not enough to boot.
  const configDir = join(home, '.shadow');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({
      provider: 'openai',
      model: 'mock',
      maxIterations: 2,
      models: [{ label: 'Mock', provider: 'openai', model: 'mock', apiKey: 'sk-test' }],
    }),
  );
  return {
    home,
    workspace,
    env: (over) => {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, TERM: 'xterm-256color' };
      for (const k of [
        'SHADOW_PROFILE',
        'SHADOW_HARNESSES',
        'SHADOW_VAULT_PASSWORD',
        'SHADOW_ALLOW_IMPORT',
        'OPENAI_BASE_URL',
        'ANTHROPIC_BASE_URL',
      ]) {
        delete env[k];
      }
      return { ...env, ...over };
    },
  };
}

test('the tab title animates during a turn and freezes when idle', { skip: SKIP }, async () => {
  const prov = await slowProvider();
  const f = fixture();
  try {
    const { titles, raw } = await runInteractivePty(
      ['--workspace', f.workspace],
      f.env({ SHADOW_BASE_URL: prov.baseUrl, OPENAI_API_KEY: 'sk-test' }),
      'say hi',
    );

    assert.ok(
      titles.length > 0,
      `no title escapes were written. First 2000 bytes of terminal output:\n${raw.slice(0, 2000)}`,
    );

    const busy = titles.filter((t) => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●] /.test(t));
    assert.ok(busy.length > 0, `expected at least one working frame, saw: ${JSON.stringify(titles)}`);

    // Animation means the frame CHANGED at least once while working.
    const distinct = new Set(busy.map((t) => t[0]));
    assert.ok(distinct.size > 1, `expected several frames, saw only ${JSON.stringify([...distinct])}`);

    // The last title written must be idle — no trailing spinner left frozen in the tab.
    const last = titles[titles.length - 1]!;
    assert.ok(
      !/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●] /.test(last),
      `the session ended busy: last title was ${JSON.stringify(last)} — an idle tab must not move`,
    );
    assert.match(last, / — Shadow$/, 'the session name must survive the activity prefix');
  } finally {
    prov.close();
    rmSync(f.home, { recursive: true, force: true });
  }
});

test('--reduced-motion shows a static busy marker, never an animation', { skip: SKIP }, async () => {
  const prov = await slowProvider();
  const f = fixture();
  try {
    const { titles } = await runInteractivePty(
      ['--workspace', f.workspace, '--reduced-motion'],
      f.env({ SHADOW_BASE_URL: prov.baseUrl, OPENAI_API_KEY: 'sk-test' }),
      'say hi',
    );
    const busy = titles.filter((t) => t.startsWith('● '));
    assert.ok(busy.length > 0, `expected the static busy marker, saw: ${JSON.stringify(titles)}`);
    // No braille frames at all under reduced motion.
    assert.equal(
      titles.filter((t) => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(t)).length,
      0,
      'reduced motion must not animate',
    );
  } finally {
    prov.close();
    rmSync(f.home, { recursive: true, force: true });
  }
});