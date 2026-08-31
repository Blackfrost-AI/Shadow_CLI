// Plan 3.1 — LSP notes at the LOOP level: after a successful write_file, the note rides the
// tool result INTO the next provider round, result.ok stays true, and every gate holds.
// (diagnostics-loop.test.ts harness: hand-built LoopDeps, evented provider, ScriptedApprovalGate.)
//
// The fake LSP server here is warmed through the PRODUCTION module cache (getLspService keyed
// by workspace root) before the loop runs — that also proves the loop's fold-in resolves the
// same warmed service a real session would.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentLoop, type LoopDeps } from '../src/agent/loop.js';
import { EventBus } from '../src/agent/events.js';
import { Context } from '../src/agent/context.js';
import { Budget } from '../src/agent/budget.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ScriptedApprovalGate } from '../src/agent/approval.js';
import { writeFile } from '../src/tools/writeFile.js';
import { getLspService, stopLspServices } from '../src/agent/lsp/index.js';
import type { ProviderEvent } from '../src/provider/provider.js';

const FAKE_LSP = `let buf = '';
const send = (msg) => {
  const body = JSON.stringify(msg);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);
};
const diagsFor = (text) => text.includes('BOOM')
  ? [{ range: { start: { line: 0, character: 0 } }, severity: 1, message: 'loop fake: exploded', code: 4242, source: 'ts' }]
  : [];
const handle = (msg) => {
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } }); return; }
  if (msg.id !== undefined && msg.method) { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'textDocument/didOpen' || msg.method === 'textDocument/didChange') {
    const td = msg.params.textDocument;
    const text = (msg.params.contentChanges && msg.params.contentChanges[0] && msg.params.contentChanges[0].text) || td.text || '';
    setTimeout(() => send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: td.uri, version: td.version, diagnostics: diagsFor(text) } }), 10);
  }
};
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  for (;;) {
    const sep = buf.indexOf('\\r\\n\\r\\n');
    if (sep < 0) return;
    const m = /Content-Length:\\s*(\\d+)/i.exec(buf.slice(0, sep));
    if (!m) { buf = buf.slice(sep + 4); continue; }
    const len = Number(m[1]);
    if (buf.length < sep + 4 + len) return;
    const body = buf.slice(sep + 4, sep + 4 + len);
    buf = buf.slice(sep + 4 + len);
    let msg; try { msg = JSON.parse(body); } catch { continue; }
    handle(msg);
  }
});
setInterval(() => {}, 1 << 30);
`;

async function until(cond: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

interface LoopFx {
  root: string;
  lspCfg: { timeoutMs: number; servers: Record<string, { command: string; args: string[] }>; notes?: { maxSessionChars: number } };
  warm(): Promise<void>;
  cleanup(): void;
}

function makeFx(notes?: { maxSessionChars: number }): LoopFx {
  const root = mkdtempSync(join(tmpdir(), 'shadow-lsp-loop-'));
  const script = join(root, 'fake-lsp.mjs');
  writeFileSync(script, FAKE_LSP);
  const lspCfg = {
    timeoutMs: 1500,
    servers: { typescript: { command: process.execPath, args: [script] } },
    ...(notes ? { notes } : {}),
  };
  return {
    root,
    lspCfg,
    async warm() {
      writeFileSync(join(root, '__warmup.ts'), 'const warm = 1;');
      const svc = getLspService(root, lspCfg);
      await until(async () => {
        await svc.collect(join(root, '__warmup.ts'));
        return svc.snapshot().servers.some((s) => s.state === 'ready');
      }, 8000);
    },
    cleanup() {
      getLspService(root, lspCfg).stop();
      stopLspServices();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A provider that writes `writes` files across turns, then ends. Returns each round's messages. */
function scriptedProvider(writes: Array<{ path: string; content: string }>) {
  const rounds: string[] = [];
  const summaries: string[] = [];
  let turn = 0;
  const provider = {
    name: 'p',
    estimateTokens: () => 1,
    async *send(req: { messages: unknown[] }): AsyncGenerator<ProviderEvent> {
      turn++;
      if (turn <= writes.length) {
        const w = writes[turn - 1]!;
        yield { type: 'tool_call', call: { id: String(turn), name: 'write_file', input: { path: w.path, content: w.content } } };
        yield { type: 'done', stopReason: 'tool_use' };
      } else {
        rounds.push(JSON.stringify(req.messages));
        yield { type: 'text', delta: 'ok' };
        yield { type: 'done', stopReason: 'end_turn' };
      }
    },
  };
  return { provider, rounds, summaries };
}

async function runLoop(fx: LoopFx, writes: Array<{ path: string; content: string }>, extra: Partial<LoopDeps> = {}) {
  const registry = new ToolRegistry();
  registry.register(writeFile);
  // The bus the loop will actually emit on — a caller-provided bus must also be where our
  // `seen` capture listens, or the two buses split the events between them.
  const bus = extra.bus ?? new EventBus();
  const { ...rest } = extra;
  delete (rest as { bus?: EventBus }).bus;
  const seen: Array<{ summary: string; ok: boolean }> = [];
  bus.on((e) => {
    if (e.type === 'tool_end') seen.push({ summary: e.result.summary, ok: e.result.ok });
  });
  const { provider, rounds } = scriptedProvider(writes);
  const context = new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 });
  context.pinTask({ role: 'user', content: [{ type: 'text', text: 'go' }] });
  const deps = {
    provider: provider as LoopDeps['provider'],
    registry,
    gate: new ScriptedApprovalGate(['approve']),
    bus,
    budget: new Budget({ maxIterations: 8 }, 'mock', { mock: { input: 1, output: 1 } }, Date.now()),
    context,
    signal: new AbortController().signal,
    model: 'mock',
    system: 'test',
    maxOutputTokens: 1024,
    workspaceRoot: fx.root,
    dryRun: false,
    maxToolResultChars: 16_384,
    contextBudget: 1_000_000,
    lsp: fx.lspCfg,
    ...rest,
  } as LoopDeps;
  await new AgentLoop(deps, 'full').run();
  return { seen, rounds, bus };
}

test('loop: an LSP note rides the write result into the NEXT provider round — ok stays true', async () => {
  const fx = makeFx();
  try {
    await fx.warm();
    const { seen, rounds } = await runLoop(fx, [{ path: 'probe.ts', content: 'const x: number = 1; BOOM' }]);
    assert.equal(seen.length, 1);
    assert.match(seen[0]!.summary, /\[lsp: typescript\] 1 error, 0 warnings in probe\.ts/);
    assert.match(seen[0]!.summary, /loop fake: exploded \(error, 4242\)/);
    assert.equal(seen[0]!.ok, true, 'ADVISORY INVARIANT: diagnostics never fail the write');
    assert.ok(rounds[0]!.includes('[lsp: typescript]'), 'the next model round sees the note in the tool result');
  } finally {
    fx.cleanup();
  }
});

test('loop: identical rewrites dedupe — the second write carries no note, the turn is quiet', async () => {
  const fx = makeFx();
  try {
    await fx.warm();
    const { seen } = await runLoop(fx, [
      { path: 'a.ts', content: 'BOOM' },
      { path: 'a.ts', content: 'BOOM' },
    ]);
    assert.equal(seen.length, 2);
    assert.match(seen[0]!.summary, /\[lsp: typescript\]/);
    assert.ok(!seen[1]!.summary.includes('[lsp:'), 'identical diagnostics are suppressed');
    assert.equal(seen[1]!.ok, true);
  } finally {
    fx.cleanup();
  }
});

test('loop: a clean file and a non-source file produce no note at all', async () => {
  const fx = makeFx();
  try {
    await fx.warm();
    const { seen } = await runLoop(fx, [
      { path: 'clean.ts', content: 'const fine = 1;' },
      { path: 'notes.md', content: '# BOOM' },
    ]);
    assert.equal(seen.length, 2);
    assert.ok(!seen[0]!.summary.includes('[lsp:'), 'clean file → silence');
    assert.ok(!seen[1]!.summary.includes('[lsp:'), 'markdown → no server, no note');
  } finally {
    fx.cleanup();
  }
});

test('loop: SHADOW_NO_LSP=1 and enabled:false leave tool results untouched', async () => {
  const prev = process.env.SHADOW_NO_LSP;
  const fx = makeFx();
  try {
    await fx.warm();
    process.env.SHADOW_NO_LSP = '1';
    const killed = await runLoop(fx, [{ path: 'k.ts', content: 'BOOM' }]);
    assert.ok(!killed.seen[0]!.summary.includes('[lsp:'), 'kill switch: no note');
  } finally {
    if (prev === undefined) delete process.env.SHADOW_NO_LSP;
    else process.env.SHADOW_NO_LSP = prev;
    fx.cleanup();
  }
  const fx2 = makeFx();
  try {
    await fx2.warm();
    const off = await runLoop(fx2, [{ path: 'k.ts', content: 'BOOM' }], { lsp: { ...fx2.lspCfg, enabled: false } });
    assert.ok(!off.seen[0]!.summary.includes('[lsp:'), 'enabled:false: no note');
  } finally {
    fx2.cleanup();
  }
});

test('loop: session budget exhaustion suppresses notes and emits exactly one finding', async () => {
  const fx = makeFx({ maxSessionChars: 40 }); // a BOOM note is >40 chars
  try {
    await fx.warm();
    const findings: string[] = [];
    const bus = new EventBus();
    bus.on((e) => {
      if (e.type === 'finding') findings.push(e.title);
    });
    const { seen } = await runLoop(fx, [{ path: 'b.ts', content: 'BOOM' }], { bus });
    assert.equal(seen.length, 1);
    assert.ok(!seen[0]!.summary.includes('[lsp:'), 'blocked by the session cap');
    assert.equal(findings.length, 1, 'exactly one finding on first latch');
    assert.match(findings[0]!, /LSP diagnostics notes paused/);
  } finally {
    fx.cleanup();
  }
});
