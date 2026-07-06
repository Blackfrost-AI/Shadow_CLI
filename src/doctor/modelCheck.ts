// Model capability triage — drive the active (or a named) model through a few real
// agentic probes and return a verdict: Agentic / Limited / Chat-only. This is the
// FAST self-test (a handful of model round-trips), distinct from the full external
// benchmark. Especially useful for local .gguf models: after `shadow local add`, run
// this to learn whether the model is actually worth using as an agent.
//
// The core takes a ready-made Provider so it stays surface-agnostic and unit-testable
// with the mock provider — the CLI (`shadow doctor model`) and TUI (`/model test`)
// both resolve their own provider, then call runModelCheck(). No duplication.
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Provider,
  CompletionRequest,
  Message,
  ToolCall,
  ToolSchema,
  StopReason,
} from '../provider/provider.js';
import { ToolRegistry } from '../tools/registry.js';
import { readFile } from '../tools/readFile.js';
import { writeFile } from '../tools/writeFile.js';
import { editFile } from '../tools/editFile.js';
import type { Tool, ToolContext } from '../tools/types.js';

export type ProbeStatus = 'pass' | 'fail';
export type ModelVerdict = 'agentic' | 'limited' | 'chat-only';

export interface ProbeResult {
  id: 'tool_call' | 'format' | 'file_edit' | 'error_recovery' | 'autonomous';
  label: string;
  status: ProbeStatus;
  detail: string; // one-line observation
}

export interface ModelCheckResult {
  model: string;
  providerName: string;
  isLocal: boolean;
  probes: ProbeResult[];
  verdict: ModelVerdict;
  recommendation: string;
  elapsedMs: number;
}

export interface ModelCheckOptions {
  model: string;
  providerName?: string; // for display only
  isLocal?: boolean; // local .gguf endpoint (adds ctx/gpu-layers hints to the recommendation)
  perTurnTimeoutMs?: number; // hard cap per model turn (default 45s — local models are slow)
  maxOutputTokens?: number; // per-turn output cap (default 2048 — room for "thinking" models)
  maxAutonomousTurns?: number; // iteration cap for the read→edit probe (default 4)
  log?: (msg: string) => void;
}

const DEFAULT_PER_TURN_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
const DEFAULT_MAX_AUTONOMOUS_TURNS = 4;

const SYSTEM =
  'You are a coding agent under a quick capability test. When a task needs a tool, ' +
  'call it via the provided tools — do not describe the call in prose. Keep replies short.';

// Synthetic, zero-side-effect tool for probe 1 (no execution — we only check emission).
const PING_TOOL: ToolSchema = {
  name: 'ping',
  description: 'Connectivity check. Call this with a short message to confirm tool calling works.',
  parameters: {
    type: 'object',
    properties: { message: { type: 'string', description: 'Any short string to echo back.' } },
    required: ['message'],
    additionalProperties: false,
  },
};

interface TurnOutcome {
  text: string;
  toolCalls: ToolCall[];
  stopReason?: StopReason;
  error?: { code: string; message: string };
  timedOut: boolean;
}

/** A structurally valid native tool call: a name plus a parseable object of args. */
function isValidCall(c: ToolCall): boolean {
  return (
    typeof c.name === 'string' &&
    c.name.length > 0 &&
    typeof c.input === 'object' &&
    c.input !== null &&
    !Array.isArray(c.input)
  );
}

/** Heuristic: did the model paste a tool call into prose instead of using the wire format? */
function looksLikeProseToolCall(text: string): boolean {
  return (
    /\*\*\*\s*Begin Patch/i.test(text) ||
    /<tool_call/i.test(text) ||
    /"tool_calls?"\s*:/i.test(text) ||
    /\bfunctions?\.[a-z_]+\s*\(/i.test(text) ||
    /"name"\s*:\s*"[a-z_]+"[\s\S]*"(arguments|parameters|input)"\s*:/i.test(text)
  );
}

/** Consume one model turn with a hard timeout so a hung/looping model can't stall the test. */
async function collectTurn(
  provider: Provider,
  req: Omit<CompletionRequest, 'signal'>,
  timeoutMs: number,
): Promise<TurnOutcome> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const out: TurnOutcome = { text: '', toolCalls: [], timedOut: false };
  try {
    for await (const ev of provider.send({ ...req, signal: ac.signal })) {
      if (ev.type === 'text') out.text += ev.delta;
      else if (ev.type === 'tool_call') out.toolCalls.push(ev.call);
      else if (ev.type === 'error') {
        out.error = { code: ev.code, message: ev.message };
        if (!ev.recoverable) break;
      } else if (ev.type === 'done') {
        out.stopReason = ev.stopReason;
      }
    }
  } catch (e) {
    if (ac.signal.aborted) out.timedOut = true;
    else out.error = { code: 'turn_failed', message: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
  return out;
}

function probeWorkspaceTools(): { registry: ToolRegistry; schemas: ToolSchema[] } {
  const registry = new ToolRegistry();
  registry.register(readFile as Tool);
  registry.register(writeFile as Tool);
  registry.register(editFile as Tool);
  return { registry, schemas: registry.toSchemas() };
}

function schemaFor(all: ToolSchema[], name: string): ToolSchema {
  const s = all.find((t) => t.name === name);
  if (!s) throw new Error(`probe wiring error: missing schema for ${name}`);
  return s;
}

function ctxFor(root: string): ToolContext {
  return {
    workspaceRoot: root,
    signal: new AbortController().signal,
    log: () => {},
    dryRun: false,
  };
}

/** Validate args against the tool schema, then run it. Returns a model-facing summary. */
async function runCall(
  registry: ToolRegistry,
  call: ToolCall,
  root: string,
): Promise<{ ok: boolean; summary: string }> {
  const tool = registry.get(call.name);
  if (!tool) return { ok: false, summary: `unknown tool "${call.name}"` };
  const parsed = tool.inputSchema.safeParse(call.input);
  if (!parsed.success) {
    return { ok: false, summary: `invalid arguments for ${call.name}: ${parsed.error.issues.map((i) => i.message).join('; ')}` };
  }
  const res = await tool.run(parsed.data, ctxFor(root));
  return { ok: res.ok, summary: res.summary };
}

function assistantToolTurn(call: ToolCall): Message {
  return { role: 'assistant', content: [{ type: 'tool_use', id: call.id, name: call.name, input: call.input }] };
}

function toolResultTurn(call: ToolCall, ok: boolean, content: string): Message {
  return { role: 'user', content: [{ type: 'tool_result', toolCallId: call.id, ok, content }] };
}

/**
 * Run the capability probes against `provider` and return per-probe results + a verdict.
 *
 * Verdict thresholds (documented; not configurable):
 *   • Chat-only — NO probe produced a structurally valid native tool call. The model
 *     replies in prose; it cannot drive Shadow's agentic loop.
 *   • Agentic   — tool-call emission PASS AND file-edit PASS AND error-recovery PASS
 *     AND autonomous read→edit PASS. The full core loop works.
 *   • Limited   — emits at least one valid tool call, but is not Agentic (fails the
 *     edit, the recovery, or the autonomous chain). Usable for simple, supervised tasks.
 */
export async function runModelCheck(
  provider: Provider,
  opts: ModelCheckOptions,
): Promise<ModelCheckResult> {
  const t0 = Date.now();
  const timeout = opts.perTurnTimeoutMs ?? DEFAULT_PER_TURN_TIMEOUT_MS;
  const maxTokens = opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const maxAuto = opts.maxAutonomousTurns ?? DEFAULT_MAX_AUTONOMOUS_TURNS;
  const log = opts.log ?? (() => {});
  const isLocal = opts.isLocal ?? false;

  const probes: ProbeResult[] = [];
  let emittedAnyValidCall = false;

  const { registry, schemas } = probeWorkspaceTools();
  const tmp = mkdtempSync(join(tmpdir(), 'shadow-modelcheck-'));

  try {
    // ── Probe 1 + 2: tool-call emission + structured wire format ──────────────
    log('probe 1/5: tool-call emission…');
    const t1 = await collectTurn(
      provider,
      {
        model: opts.model,
        system: SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Call the `ping` tool with the message "hello". Use the tool — do not answer in prose.' }] }],
        tools: [PING_TOOL],
        maxOutputTokens: maxTokens,
      },
      timeout,
    );
    const pingCall = t1.toolCalls.find((c) => c.name === 'ping' && isValidCall(c));
    const anyValid1 = t1.toolCalls.some(isValidCall);
    if (anyValid1) emittedAnyValidCall = true;

    if (t1.timedOut) {
      probes.push({ id: 'tool_call', label: 'Tool-call emission', status: 'fail', detail: `timed out after ${Math.round(timeout / 1000)}s` });
    } else if (t1.error && t1.toolCalls.length === 0 && !t1.text) {
      // Hard provider/connection error with nothing back — the model is unreachable;
      // the remaining probes would all fail the same way, so short-circuit.
      const msg = `${t1.error.code}: ${t1.error.message}`;
      probes.push({ id: 'tool_call', label: 'Tool-call emission', status: 'fail', detail: msg });
      probes.push({ id: 'format', label: 'Structured tool format', status: 'fail', detail: 'skipped (provider error)' });
      probes.push({ id: 'file_edit', label: 'File edit', status: 'fail', detail: 'skipped (provider error)' });
      probes.push({ id: 'error_recovery', label: 'Error recovery', status: 'fail', detail: 'skipped (provider error)' });
      probes.push({ id: 'autonomous', label: 'Autonomous read→edit', status: 'fail', detail: 'skipped (provider error)' });
      return finalize(probes, false, opts, isLocal, t0, msg);
    } else if (pingCall) {
      probes.push({ id: 'tool_call', label: 'Tool-call emission', status: 'pass', detail: 'emitted a valid `ping` tool call' });
    } else if (anyValid1) {
      probes.push({ id: 'tool_call', label: 'Tool-call emission', status: 'pass', detail: `emitted a valid tool call (\`${t1.toolCalls[0]!.name}\`)` });
    } else {
      probes.push({ id: 'tool_call', label: 'Tool-call emission', status: 'fail', detail: 'replied in prose — no structurally valid tool call' });
    }

    // Probe 2 (format) — overlaps probe 1; reports the wire-format observation.
    if (anyValid1) {
      probes.push({ id: 'format', label: 'Structured tool format', status: 'pass', detail: 'native tool_use channel (parseable JSON args)' });
    } else if (looksLikeProseToolCall(t1.text)) {
      probes.push({ id: 'format', label: 'Structured tool format', status: 'fail', detail: 'pasted a tool call into prose (e.g. *** Begin Patch / fake JSON), not the wire format' });
    } else {
      probes.push({ id: 'format', label: 'Structured tool format', status: 'fail', detail: 'no tool call in the wire format' });
    }

    // ── Probe 3: file edit (create a file with required content) ───────────────
    log('probe 3/5: file edit…');
    const editTools = [schemaFor(schemas, 'write_file')];
    const t3 = await collectTurn(
      provider,
      {
        model: opts.model,
        system: SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Create a file named hello.txt containing exactly the text SHADOW_OK (and nothing else). Use the write_file tool.' }] }],
        tools: editTools,
        maxOutputTokens: maxTokens,
      },
      timeout,
    );
    const writeCall = t3.toolCalls.find((c) => c.name === 'write_file' && isValidCall(c));
    if (t3.toolCalls.some(isValidCall)) emittedAnyValidCall = true;
    if (writeCall) {
      await runCall(registry, writeCall, tmp);
      const target = join(tmp, 'hello.txt');
      const okFile = existsSync(target) && readFileSync(target, 'utf8').includes('SHADOW_OK');
      probes.push({
        id: 'file_edit',
        label: 'File edit',
        status: okFile ? 'pass' : 'fail',
        detail: okFile ? 'wrote hello.txt with the expected content' : 'tool ran but the file content was wrong',
      });
    } else {
      probes.push({ id: 'file_edit', label: 'File edit', status: 'fail', detail: t3.timedOut ? `timed out after ${Math.round(timeout / 1000)}s` : 'did not emit a valid write_file call' });
    }

    // ── Probe 4: error recovery (adapt after a file-not-found tool error) ──────
    log('probe 4/5: error recovery…');
    const readSchema = schemaFor(schemas, 'read_file');
    const r1prompt = 'Read the file notes.txt and report its first line. Use the read_file tool.';
    const t4a = await collectTurn(
      provider,
      {
        model: opts.model,
        system: SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: r1prompt }] }],
        tools: [readSchema],
        maxOutputTokens: maxTokens,
      },
      timeout,
    );
    const readCall = t4a.toolCalls.find((c) => c.name === 'read_file' && isValidCall(c));
    if (t4a.toolCalls.some(isValidCall)) emittedAnyValidCall = true;
    if (!readCall) {
      probes.push({ id: 'error_recovery', label: 'Error recovery', status: 'fail', detail: t4a.timedOut ? `timed out after ${Math.round(timeout / 1000)}s` : 'no initial read_file call to recover from' });
    } else {
      // Execute the (failing) read against an empty workspace → error result, then hand it back.
      const failed = await runCall(registry, readCall, tmp);
      const failedPath = (readCall.input as { path?: unknown }).path;
      const t4b = await collectTurn(
        provider,
        {
          model: opts.model,
          system: SYSTEM,
          messages: [
            { role: 'user', content: [{ type: 'text', text: r1prompt }] },
            assistantToolTurn(readCall),
            toolResultTurn(readCall, false, failed.summary),
            { role: 'user', content: [{ type: 'text', text: 'That failed. Adapt and try a sane alternative (e.g. a different path or list the directory).' }] },
          ],
          tools: [readSchema, schemaFor(schemas, 'write_file')],
          maxOutputTokens: maxTokens,
        },
        timeout,
      );
      if (t4b.toolCalls.some(isValidCall)) emittedAnyValidCall = true;
      const nextCall = t4b.toolCalls.find(isValidCall);
      const samePath = nextCall && nextCall.name === readCall.name && (nextCall.input as { path?: unknown }).path === failedPath;
      if (nextCall && !samePath) {
        probes.push({ id: 'error_recovery', label: 'Error recovery', status: 'pass', detail: `adapted: tried \`${nextCall.name}\` with a different input` });
      } else if (samePath) {
        probes.push({ id: 'error_recovery', label: 'Error recovery', status: 'fail', detail: 'repeated the identical failing call' });
      } else {
        probes.push({ id: 'error_recovery', label: 'Error recovery', status: 'fail', detail: t4b.timedOut ? `timed out after ${Math.round(timeout / 1000)}s` : 'gave up — no corrective action' });
      }
    }

    // ── Probe 5: autonomous read→edit (tiny end-to-end) ───────────────────────
    log('probe 5/5: autonomous read→edit…');
    const greeting = join(tmp, 'greeting.txt');
    writeFileSync(greeting, 'hello world\n', 'utf8');
    const autoTools = [readSchema, schemaFor(schemas, 'edit_file'), schemaFor(schemas, 'write_file')];
    const convo: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'In greeting.txt, change the word "world" to "shadow". Read the file first, then make the edit.' }] },
    ];
    let autoTimedOut = false;
    for (let turn = 0; turn < maxAuto; turn++) {
      const t = await collectTurn(
        provider,
        { model: opts.model, system: SYSTEM, messages: convo, tools: autoTools, maxOutputTokens: maxTokens },
        timeout,
      );
      if (t.timedOut) {
        autoTimedOut = true;
        break;
      }
      const calls = t.toolCalls.filter(isValidCall);
      if (calls.length > 0) emittedAnyValidCall = true;
      if (calls.length === 0) break; // model stopped acting (answered or gave up)
      // Commit the assistant tool turn, execute every call, hand back the results.
      convo.push({ role: 'assistant', content: calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })) });
      const resultBlocks = [];
      for (const c of calls) {
        const r = await runCall(registry, c, tmp);
        resultBlocks.push({ type: 'tool_result' as const, toolCallId: c.id, ok: r.ok, content: r.summary });
      }
      convo.push({ role: 'user', content: resultBlocks });
      if (existsSync(greeting) && readFileSync(greeting, 'utf8').includes('hello shadow')) break;
    }
    const autoOk = existsSync(greeting) && readFileSync(greeting, 'utf8').includes('hello shadow');
    probes.push({
      id: 'autonomous',
      label: 'Autonomous read→edit',
      status: autoOk ? 'pass' : 'fail',
      detail: autoOk ? 'updated greeting.txt to "hello shadow"' : autoTimedOut ? `timed out after ${Math.round(timeout / 1000)}s` : 'did not complete the read→edit without hand-holding',
    });

    return finalize(probes, emittedAnyValidCall, opts, isLocal, t0);
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

function statusOf(probes: ProbeResult[], id: ProbeResult['id']): boolean {
  return probes.find((p) => p.id === id)?.status === 'pass';
}

function finalize(
  probes: ProbeResult[],
  emittedAnyValidCall: boolean,
  opts: ModelCheckOptions,
  isLocal: boolean,
  t0: number,
  connectionError?: string,
): ModelCheckResult {
  const toolOk = statusOf(probes, 'tool_call');
  const editOk = statusOf(probes, 'file_edit');
  const recoveryOk = statusOf(probes, 'error_recovery');
  const autoOk = statusOf(probes, 'autonomous');

  let verdict: ModelVerdict;
  if (!emittedAnyValidCall) verdict = 'chat-only';
  else if (toolOk && editOk && recoveryOk && autoOk) verdict = 'agentic';
  else verdict = 'limited';

  const localHint = isLocal
    ? ' For a local gguf, raise --ctx (more room for the agent loop) and/or --gpu-layers, then re-test.'
    : '';
  let recommendation: string;
  if (connectionError) {
    recommendation = `Could not reach the model (${connectionError}). Check credentials / that the local server is up, then retry.`;
  } else if (verdict === 'agentic') {
    recommendation = 'Ready for autonomous coding in Shadow.';
  } else if (verdict === 'limited') {
    recommendation = 'Usable for simple, supervised edits — expect to babysit multi-step work. Use a stronger model for unattended runs.' + localHint;
  } else {
    recommendation = 'Replies in prose, not tool calls — not usable as an agent in Shadow. Pick a stronger model.' + localHint;
  }

  return {
    model: opts.model,
    providerName: opts.providerName ?? 'unknown',
    isLocal,
    probes,
    verdict,
    recommendation,
    elapsedMs: Date.now() - t0,
  };
}

export interface ReportColors {
  pass?: (s: string) => string;
  fail?: (s: string) => string;
  head?: (s: string) => string;
  dim?: (s: string) => string;
}

const VERDICT_LABEL: Record<ModelVerdict, string> = {
  agentic: 'AGENTIC',
  limited: 'LIMITED',
  'chat-only': 'CHAT-ONLY',
};

/** Render the result as a plain (optionally colored) report — mirrors formatDoctorReport. */
export function formatModelCheckReport(result: ModelCheckResult, colors: ReportColors = {}): string {
  const id = (s: string) => s;
  const pass = colors.pass ?? id;
  const fail = colors.fail ?? id;
  const head = colors.head ?? id;
  const dim = colors.dim ?? id;

  const local = result.isLocal ? ' (local gguf)' : '';
  const lines = [head(`shadow model check — ${result.providerName}/${result.model}${local}`), ''];
  for (const p of result.probes) {
    const mark = p.status === 'pass' ? pass('✓') : fail('✗');
    const tag = p.status === 'pass' ? pass('[pass]') : fail('[fail]');
    lines.push(`  ${mark} ${tag} ${p.label}: ${p.detail}`);
  }
  lines.push('');
  const verdictText = `Verdict: ${VERDICT_LABEL[result.verdict]}`;
  lines.push(result.verdict === 'agentic' ? pass(verdictText) : result.verdict === 'limited' ? head(verdictText) : fail(verdictText));
  lines.push('  ' + result.recommendation);
  lines.push(dim(`  (${(result.elapsedMs / 1000).toFixed(1)}s)`));
  return lines.join('\n');
}
