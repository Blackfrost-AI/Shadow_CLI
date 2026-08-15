import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { AgentLoop, type LoopDeps } from '../src/agent/loop.js';
import { EventBus } from '../src/agent/events.js';
import { Context } from '../src/agent/context.js';
import { Budget } from '../src/agent/budget.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { makeRunShell } from '../src/tools/runShell.js';
import type { ApprovalGate, ApprovalRequest, ApprovalDecision } from '../src/agent/approval.js';
import type { ProviderEvent } from '../src/provider/provider.js';
import {
  sandboxConfinement,
  sandboxToolAvailable,
  unconfinedBanner,
  SECRET_READ_DENY,
  wrapCommand,
} from '../src/safety/sandbox.js';

/**
 * P2-12 + P3-04 — the confinement-aware approval escalation.
 *
 * When the OS sandbox was REQUESTED but this host has no tool to enforce it, an unconfined
 * run_shell is a bigger decision than a confined one. The failure policy decides:
 *   warn        → no gate (pre-P2-12 behavior; warning folds into the tool result)
 *   auto        → gate, suppressible like the autonomy floor (session approvals stick)
 *   fail-closed → gate, NEVER suppressible — like the catastrophic denylist
 * These tests run at autonomy 'full' so the NORMAL gate never fires — every observed gate call
 * is the escalation itself.
 */

class RecordingGate implements ApprovalGate {
  requests: ApprovalRequest[] = [];
  private i = 0;
  constructor(
    private readonly decisions: ApprovalDecision[] = [],
    private readonly fallback: ApprovalDecision = 'approve',
  ) {}
  request(req: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(req);
    const d = this.i < this.decisions.length ? this.decisions[this.i++]! : this.fallback;
    return Promise.resolve(d);
  }
}

/**
 * Records the PEAK number of approval dialogs open at once. Two concurrent dialogs can never be
 * shown (the TUI queues them), so `mayNeedPermissionPrompt` must serialize any turn whose calls
 * may gate. If the parallel-guard regresses, two unconfined fail-closed calls fire together and
 * peak climbs to 2 — that is exactly the wedge P2-12's fix removed.
 */
class PeakConcurrencyGate extends RecordingGate {
  inFlight = 0;
  peak = 0;
  override async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    this.inFlight++;
    this.peak = Math.max(this.peak, this.inFlight);
    await new Promise((r) => setTimeout(r, 15)); // hold the "dialog" open briefly
    this.inFlight--;
    return super.request(req);
  }
}

async function runShells(opts: {
  shellConfined: boolean | undefined;
  policy: 'auto' | 'fail-closed' | 'warn';
  decisions: ApprovalDecision[];
  calls: number;
  gate?: RecordingGate;
  permissionRules?: Array<{ tool: string; pattern?: string; action: 'allow' | 'ask' | 'deny' }>;
}): Promise<RecordingGate> {
  const root = mkdtempSync(join(tmpdir(), 'p212-'));
  try {
    const registry = new ToolRegistry();
    registry.register(makeRunShell());
    const gate = opts.gate ?? new RecordingGate(opts.decisions);
    let turn = 0;
    const provider = {
      name: 'p',
      estimateTokens: () => 1,
      async *send(): AsyncGenerator<ProviderEvent> {
        turn++;
        if (turn === 1) {
          for (let i = 0; i < opts.calls; i++) {
            // A WRITE command on purpose: read-only commands ride the bash-read-only fast path,
            // which legitimately suppresses the 'auto' escalation — testing that here would
            // conflate two features.
            yield { type: 'tool_call', call: { id: `c${i}`, name: 'run_shell', input: { command: `touch probe-${i}.txt` } } };
          }
          yield { type: 'done', stopReason: 'tool_use' };
        } else {
          yield { type: 'text', delta: 'ok' };
          yield { type: 'done', stopReason: 'end_turn' };
        }
      },
    };
    const context = new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 });
    context.pinTask({ role: 'user', content: [{ type: 'text', text: 'go' }] });
    const deps = {
      provider: provider as LoopDeps['provider'],
      registry,
      gate,
      bus: new EventBus(),
      budget: new Budget({ maxIterations: 8 }, 'mock', { mock: { input: 1, output: 1 } }, Date.now()),
      context,
      signal: new AbortController().signal,
      model: 'mock',
      system: 'test',
      maxOutputTokens: 1024,
      workspaceRoot: root,
      dryRun: false,
      maxToolResultChars: 16_384,
      contextBudget: 1_000_000,
      shellConfined: opts.shellConfined,
      sandboxFailurePolicy: opts.policy,
      permissionRules: opts.permissionRules,
    } as LoopDeps;
    await new AgentLoop(deps, 'full').run();
    return gate;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("policy warn: unconfined run_shell is NOT gated (pre-P2-12 behavior)", async () => {
  const gate = await runShells({ shellConfined: false, policy: 'warn', decisions: [], calls: 2 });
  assert.equal(gate.requests.length, 0, 'warn keeps the old behavior — no approval gate');
});

test('policy auto: every unconfined run_shell gates, with a loud UNCONFINED reason', async () => {
  const gate = await runShells({ shellConfined: false, policy: 'auto', decisions: ['approve', 'approve'], calls: 2 });
  assert.equal(gate.requests.length, 2, 'both unconfined calls stop at the gate');
  for (const req of gate.requests) {
    assert.match(req.reason, /UNCONFINED/, 'the reason must say the command runs unconfined');
    assert.match(req.reason, /policy: auto/);
  }
});

test('policy auto: a session approval suppresses later unconfined calls (the floor is suppressible)', async () => {
  const gate = await runShells({
    shellConfined: false,
    policy: 'auto',
    decisions: [{ approveForSession: true }],
    calls: 3,
  });
  assert.equal(gate.requests.length, 1, 'approve-for-session silences the rest of the session');
});

test('policy fail-closed: the gate NEVER bends — no session approval can suppress it', async () => {
  const gate = await runShells({
    shellConfined: false,
    policy: 'fail-closed',
    decisions: [{ approveForSession: true }, 'approve', 'approve'],
    calls: 3,
  });
  assert.equal(gate.requests.length, 3, 'every unconfined call asks, every time');
  assert.match(gate.requests[0]!.reason, /fail-closed — this gate never bends/);
});

test('policy fail-closed: a PREFIX approval cannot suppress the gate either', async () => {
  const gate = await runShells({
    shellConfined: false,
    policy: 'fail-closed',
    // The matching prefix WOULD suppress the call under a plain autonomy floor (isSessionApproved
    // honors it for run_shell) — fail-closed must gate anyway, every time.
    decisions: [{ approveForPrefix: 'touch' }, 'approve', 'approve'],
    calls: 3,
  });
  assert.equal(gate.requests.length, 3, 'prefix approval bends the floor, never fail-closed');
});

test('policy auto: a PREFIX approval suppresses later unconfined calls', async () => {
  const gate = await runShells({
    shellConfined: false,
    policy: 'auto',
    decisions: [{ approveForPrefix: 'touch' }],
    calls: 3,
  });
  assert.equal(gate.requests.length, 1, 'auto rides the floor — a prefix grant silences the rest');
});

test('policy fail-closed: parallel unconfined calls serialize at the gate (no dialog race)', async () => {
  const gate = new PeakConcurrencyGate([], 'approve');
  await runShells({ shellConfined: false, policy: 'fail-closed', decisions: [], calls: 3, gate });
  assert.equal(gate.requests.length, 3, 'every parallel call still gates');
  assert.equal(gate.peak, 1, 'calls serialize — a second dialog never opens while the first is pending');
});

test("policy auto: a permission-rule allow suppresses the gate (the rule is operator-typed, global-only)", async () => {
  const gate = await runShells({
    shellConfined: false,
    policy: 'auto',
    decisions: [],
    calls: 2,
    permissionRules: [{ tool: 'run_shell', pattern: 'touch probe-.*', action: 'allow' }],
  });
  assert.equal(gate.requests.length, 0, 'an allow rule suppresses the auto escalation like the floor');
});

test('policy fail-closed: a permission-rule allow does NOT suppress the gate', async () => {
  const gate = await runShells({
    shellConfined: false,
    policy: 'fail-closed',
    decisions: ['approve', 'approve'],
    calls: 2,
    permissionRules: [{ tool: 'run_shell', pattern: 'touch probe-.*', action: 'allow' }],
  });
  assert.equal(gate.requests.length, 2, 'fail-closed gates even through a rule allow');
});

test('confined host: the escalation never fires, even under fail-closed', async () => {
  const gate = await runShells({ shellConfined: true, policy: 'fail-closed', decisions: [], calls: 2 });
  assert.equal(gate.requests.length, 0, 'a confined shell is an ordinary call');
});

test('sandbox explicitly off (undefined confined): no escalation — the waiver is explicit', async () => {
  const gate = await runShells({ shellConfined: undefined, policy: 'fail-closed', decisions: [], calls: 2 });
  assert.equal(gate.requests.length, 0, '--no-sandbox/--yolo/full-autonomy waivers do not escalate');
});

// --- the state helpers ---

test('sandboxConfinement maps the three states and agrees with the tool probe', () => {
  assert.equal(sandboxConfinement('off'), 'off');
  assert.equal(
    sandboxConfinement('auto'),
    sandboxToolAvailable() ? 'confined' : 'unconfined',
    'auto resolves through the same probe wrapCommand uses',
  );
  assert.equal(unconfinedBanner('off', 'auto'), '', 'an explicit waiver never warns');
  if (sandboxToolAvailable()) {
    assert.equal(unconfinedBanner('auto', 'fail-closed'), '', 'a host with the tool never warns');
  }
});

test('SECRET_READ_DENY covers the widened credential set (F07-06 structural half)', () => {
  const home = homedir();
  for (const rel of ['.ssh', '.aws', '.gnupg', '.npmrc', '.pypirc', '.git-credentials', '.config/gcloud', '.azure', '.config/huggingface', '.m2/settings.xml']) {
    assert.ok(SECRET_READ_DENY.includes(join(home, rel)), `${rel} must be deny-listed`);
  }
});

test('on macOS the seatbelt profile denies the widened credential set', { skip: process.platform !== 'darwin' && 'seatbelt is macOS-only' }, () => {
  const r = wrapCommand({ command: 'true', workspaceRoot: tmpdir(), allowNetwork: true, enabled: true });
  assert.equal(r.sandboxed, true);
  const profile = r.argv.join(' ');
  assert.ok(profile.includes('.npmrc'), 'registry auth tokens are denied to the sandboxed shell');
  assert.ok(profile.includes('.git-credentials'), 'plaintext git passwords are denied');
});

// --- source pins ---

test('source pins: the policy is wired through config, loop, deps, doctor, startup, /status', () => {
  const config = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
  assert.match(config, /sandboxFailurePolicy: z\.enum\(\['auto', 'fail-closed', 'warn'\]\)\.default\('auto'\)/);
  assert.ok(
    config.match(/PROJECT_UNTRUSTED_KEYS[^;]*'sandboxFailurePolicy'/s),
    'a project file must never set the failure policy',
  );
  const loop = readFileSync(new URL('../src/agent/loop.ts', import.meta.url), 'utf8');
  assert.match(loop, /unconfinedNoBend/, 'fail-closed joins the never-bend tier');
  assert.match(loop, /UNCONFINED/, 'the approval reason names the unconfined state');
  assert.match(loop, /unconfinedEscalation/, 'the parallel-execution guard knows about the escalation');
  const deps = readFileSync(new URL('../src/agent/loopDeps.ts', import.meta.url), 'utf8');
  assert.match(deps, /shellConfined: cfg\.sandbox === 'off' \? undefined : sandboxToolAvailable\(\)/);
  const doctor = readFileSync(new URL('../src/doctor.ts', import.meta.url), 'utf8');
  assert.match(doctor, /sandbox-policy/, 'doctor reports the persistent confinement state');
  const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(index, /unconfinedBanner\(/, 'startup prints the loud banner');
  const tui = readFileSync(new URL('../src/tui.tsx', import.meta.url), 'utf8');
  assert.match(tui, /sandboxConfinement\(opts\.cfg\.sandbox\)/, '/status shows the confinement state');
});
