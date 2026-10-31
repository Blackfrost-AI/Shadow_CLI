import { randomUUID } from 'node:crypto';
import { readFileSync, statSync, writeSync } from 'node:fs';
import Ajv, { type ValidateFunction } from 'ajv';
import type { EventBus, LoopEvent, StopReasonExt } from '../agent/events.js';
import { VALUE_TAKING_FLAGS } from './flags.js';
import { redact, redactString } from '../util/redact.js';

export const AUTOMATION_VERSION = 1;
export const AUTOMATION_EXIT = { success: 0, runtime: 1, usage: 2, incomplete: 3, schema: 4, interrupted: 130, terminated: 143 } as const;
export type MachineFormat = 'json' | 'jsonl';

/** Inspect only flags before --. Invalid machine flags still get a JSON startup error. */
export function requestedMachineFormat(argv: string[]): MachineFormat | undefined {
  let format: string | undefined;
  let schema = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') break;
    if (arg === '--json') format = 'jsonl';
    else if (arg === '--output-schema') {
      schema = true;
      i++;
    } else if (arg.startsWith('--output-schema=')) schema = true;
    else if (arg === '--output-format') format = argv[++i] ?? 'json';
    else if (arg.startsWith('--output-format=')) format = arg.slice('--output-format='.length);
    // Do not mistake the contents of another option's value for an output flag.
    else if (VALUE_TAKING_FLAGS.has(arg)) i++;
  }
  if (format === 'text') return undefined;
  return format === 'jsonl' ? 'jsonl' : format !== undefined || schema ? 'json' : undefined;
}

export function exitCodeForStop(reason: StopReasonExt): number {
  if (reason === 'end_turn') return AUTOMATION_EXIT.success;
  if (reason === 'interrupted') return AUTOMATION_EXIT.interrupted;
  if (reason === 'provider_error' || reason === 'fatal_tool_error') return AUTOMATION_EXIT.runtime;
  return AUTOMATION_EXIT.incomplete;
}

export interface OutputSchema {
  schema: unknown;
  validate: ValidateFunction;
}

/** Local schemas only. Ajv never downloads remote refs; compilation precedes provider startup. */
export function loadOutputSchema(path: string): OutputSchema {
  if (statSync(path).size > 1024 * 1024) throw new Error('output schema exceeds the 1 MiB limit');
  const schema: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof schema !== 'boolean' && (!schema || typeof schema !== 'object' || Array.isArray(schema))) {
    throw new Error('output schema must be a JSON Schema object or boolean');
  }
  const ajv = new Ajv({ strict: false, strictSchema: true, allErrors: true, validateFormats: false, ownProperties: true, logger: false });
  return { schema, validate: ajv.compile(schema as object) };
}

export function schemaTask(task: string, schema?: OutputSchema): string {
  if (!schema) return task;
  return `${task}\n\nOutput contract: Return the final answer as one JSON value matching the following JSON Schema. Do not wrap the final JSON in Markdown or explanatory text. Use tools normally if the task requires them.\n${JSON.stringify(schema.schema)}`;
}

interface CheckEvidence { tool_call_id: string; job_id?: string; check_id?: string; status: 'passed' | 'failed' | 'unverified'; evidence: unknown }

/** Explicit, versioned envelopes. No telemetry, persistence, retries, or model calls. */
export class AutomationOutput {
  readonly runId = randomUUID();
  private sequence = 0;
  private started = false;
  private finished = false;
  private stopReason?: StopReasonExt;
  private finalAnswer = '';
  private usage: Record<string, unknown> | null = null;
  private checks: CheckEvidence[] = [];
  private errors: Array<{ code: string; message: string }> = [];
  private forcedExit?: number;
  private sessionId?: string;
  private ephemeral = false;
  private schema?: OutputSchema;
  private completionUnverified = false;

  constructor(readonly format: MachineFormat, private readonly write: (text: string) => void) {}
  get active(): boolean { return this.started; }

  configure(options: { schema?: OutputSchema; ephemeral?: boolean; sessionId?: string }): void {
    this.schema = options.schema;
    this.ephemeral = options.ephemeral ?? false;
    this.sessionId = options.sessionId;
  }

  information(text: string): void {
    this.started = true;
    this.stopReason = 'end_turn';
    this.finalAnswer = text;
  }

  private envelope(type: string, data: Record<string, unknown>): Record<string, unknown> {
    return { version: AUTOMATION_VERSION, type, run_id: this.runId, sequence: ++this.sequence,
      ...(this.sessionId ? { session_id: this.sessionId } : {}), ...data };
  }

  private emit(type: string, data: Record<string, unknown>): void {
    if (this.format === 'jsonl') this.write(JSON.stringify(this.envelope(type, redact(data) as Record<string, unknown>)) + '\n');
  }

  attach(bus: EventBus): () => void {
    this.started = true;
    this.emit('run_started', { ephemeral: this.ephemeral, output_schema: !!this.schema });
    return bus.on((event) => this.onEvent(event));
  }

  private onEvent(event: LoopEvent): void {
    if (this.finished) return;
    if (event.type === 'stop') {
      this.stopReason = event.reason;
      this.finalAnswer = event.finalAnswer;
    } else if (event.type === 'usage') {
      const { type: _type, ...usage } = event;
      this.usage = usage;
    } else if (event.type === 'error') {
      if (this.errors.length < 32) this.errors.push({ code: 'runtime_error', message: redactString(event.message) });
    } else if (event.type === 'tool_end' && event.call.name === 'acceptance_check') {
      const input = event.call.input as { jobId?: string } | undefined;
      const data = event.result.data as { status?: string } | undefined;
      const status = data?.status;
      this.checks.push({ tool_call_id: event.call.id, job_id: input?.jobId,
        status: status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : 'unverified', evidence: event.result.data ?? null });
    } else if (event.type === 'tool_end' && event.call.name === 'project_checks') {
      const data = event.result.data as { check?: { id?: string; status?: string } } | undefined;
      if (data?.check) this.checks.push({ tool_call_id: event.call.id, check_id: data.check.id,
        status: data.check.status === 'passed' ? 'passed' : data.check.status === 'failed' ? 'failed' : 'unverified', evidence: data.check });
    } else if (event.type === 'finding' && ['Completion remains unverified', 'Completion unverified', 'Completion hook failed'].includes(event.title)) {
      this.completionUnverified = true;
    }
    const identities: Record<string, unknown> = {};
    if ('call' in event) identities.tool_call_id = event.call.id;
    if ('callId' in event) identities.tool_call_id = event.callId;
    if ('taskId' in event) identities.task_id = event.taskId;
    if ('subagent' in event && event.subagent) identities.task_id = event.subagent;
    if ('jobId' in event && event.jobId) identities.job_id = event.jobId;
    if ('requestId' in event) identities.request_id = event.requestId;
    // Reasoning, tool signatures and full provider payloads are intentionally absent. Committed
    // assistant text and tool/job lifecycle events are sufficient for automation consumers.
    if (event.type === 'thinking' || event.type === 'reasoning_done') return;
    const safeEvent: Record<string, unknown> = { ...event };
    if ('call' in event) safeEvent.call = { id: event.call.id, name: event.call.name, input: event.call.input };
    this.emit(event.type, { ...identities, data: safeEvent });
  }

  fail(error: unknown, exitCode = this.started ? AUTOMATION_EXIT.runtime : AUTOMATION_EXIT.usage): void {
    this.forcedExit = exitCode;
    this.errors.push({ code: this.started ? 'runtime_error' : 'startup_error', message: redactString(error instanceof Error ? error.message : String(error)) });
  }

  cancel(signal: 'SIGINT' | 'SIGTERM'): void {
    this.forcedExit = signal === 'SIGTERM' ? AUTOMATION_EXIT.terminated : AUTOMATION_EXIT.interrupted;
    this.stopReason = 'interrupted';
  }

  /** A single final result; validating it never replays the task or any completed tool. */
  finish(fallbackExit = 0, write = this.write): number {
    if (this.finished) return this.forcedExit ?? (this.stopReason ? exitCodeForStop(this.stopReason) : fallbackExit);
    let exitCode = this.forcedExit ?? (this.stopReason ? exitCodeForStop(this.stopReason)
      : this.started ? AUTOMATION_EXIT.incomplete : AUTOMATION_EXIT.usage);
    if (!this.started && !this.errors.length && exitCode !== 130 && exitCode !== 143) this.errors.push({ code: 'startup_error', message: 'Run did not start; see stderr diagnostics.' });
    if (fallbackExit !== 0 && exitCode === 0) exitCode = AUTOMATION_EXIT.runtime;
    if (this.completionUnverified && exitCode === 0) exitCode = AUTOMATION_EXIT.incomplete;
    let structured: unknown;
    const text = redactString(this.finalAnswer);
    if (this.schema && exitCode === 0) {
      try {
        structured = JSON.parse(text);
        if (!this.schema.validate(structured)) {
          throw new Error(`Final answer does not match the output schema: ${JSON.stringify(this.schema.validate.errors?.slice(0, 20))}`);
        }
      } catch (error) {
        exitCode = AUTOMATION_EXIT.schema;
        structured = undefined;
        this.errors.push({ code: 'output_schema', message: redactString(error instanceof Error ? error.message : String(error)) });
      }
    }
    this.forcedExit = exitCode;
    this.finished = true;
    const result = this.envelope('result', {
      status: exitCode === 0 ? 'completed' : exitCode === 130 || exitCode === 143 ? 'cancelled' : exitCode === 3 ? 'incomplete' : 'failed',
      stop_reason: this.stopReason ?? (this.started ? 'no_stop' : 'startup_error'), exit_code: exitCode,
      ephemeral: this.ephemeral, result: { text, ...(structured !== undefined ? { structured } : {}) },
      usage: this.usage, checks: redact(this.checks), completion_verified: this.completionUnverified ? false : null, errors: this.errors,
    });
    write(JSON.stringify(result) + '\n');
    return exitCode;
  }
}

/** Reserve stdout before startup. Human diagnostics are redirected, including older plugins.
 * The exit fallback covers legacy process.exit startup paths without losing the result frame. */
export function installAutomationOutput(argv: string[]): AutomationOutput | undefined {
  const format = requestedMachineFormat(argv);
  if (!format) return undefined;
  const rawWrite = process.stdout.write.bind(process.stdout);
  const output = new AutomationOutput(format, (text) => { rawWrite(text); });
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (output.active) return; // the headless runtime owns graceful tool cancellation
      output.cancel(signal);
      process.exit(signal === 'SIGTERM' ? AUTOMATION_EXIT.terminated : AUTOMATION_EXIT.interrupted);
    });
  }
  process.once('exit', (code) => {
    const finalCode = output.finish(code, (text) => {
      try {
        const buffer = Buffer.from(text);
        for (let offset = 0; offset < buffer.length;) offset += writeSync(1, buffer, offset, buffer.length - offset);
      } catch { /* a closed consumer pipe cannot receive a final result */ }
    });
    process.exitCode = finalCode;
  });
  return output;
}

/** Async input keeps signal handlers responsive while a producer holds its pipe open. */
export async function readTaskInput(input: NodeJS.ReadableStream, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const clean = (): void => {
      input.removeListener('data', data); input.removeListener('end', end); input.removeListener('error', error);
      signal.removeEventListener('abort', abort);
    };
    const error = (err: unknown): void => { clean(); input.pause(); reject(err); };
    const abort = (): void => error(signal.reason ?? new Error('interrupted'));
    const end = (): void => { clean(); resolve(Buffer.concat(chunks).toString('utf8')); };
    const data = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 8 * 1024 * 1024) return error(new Error('piped task exceeds the 8 MiB limit'));
      chunks.push(bytes);
    };
    input.on('data', data); input.once('end', end); input.once('error', error);
    signal.addEventListener('abort', abort, { once: true });
  });
}
