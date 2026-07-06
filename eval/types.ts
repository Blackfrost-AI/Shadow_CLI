/**
 * Shared types for the harness-capability eval. The eval answers ONE question:
 * "can this model jump into the Shadow harness and take control?" — i.e. drive
 * the tool-calling loop to a correct, observable outcome. Scoring is by workspace
 * END-STATE (deterministic, model-agnostic) plus harness telemetry, never by
 * parsing the model's prose.
 */

export interface RunResult {
  exitCode: number;
  timedOut: boolean;
  wallMs: number;
  stdout: string;
  stderr: string;
  /** Tool calls the loop actually executed (from the session log). */
  toolCalls: { name: string; ok: boolean }[];
  /** Count of `bad_tool_json` errors — the #1 local-model failure signal. */
  badJson: number;
  /** Total error events surfaced during the run. */
  errors: number;
  /** Assistant turns (model round-trips). */
  iterations: number;
  /** Final stop reason: end_turn | max_iterations | budget | interrupted | … */
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
  /** Auto-compaction events fired during the run — proves the compaction task actually
   *  summarized context, not merely produced the right number. */
  compactions: number;
}

export interface CheckResult {
  pass: boolean;
  detail: string;
}

export interface EvalTask {
  id: string;
  title: string;
  /** Which harness capability this probes. */
  capability:
    | 'tool-call'
    | 'multi-step'
    | 'write'
    | 'edit'
    | 'shell'
    | 'error-recovery'
    | 'completion'
    | 'compaction'
    | 'dialect';
  /** The instruction handed to the model (passed as --task). */
  prompt: string;
  /** Seed the fresh workspace before the run. */
  setup: (ws: string) => void;
  /** Score the run by the workspace end-state + telemetry. */
  check: (ws: string, run: RunResult) => CheckResult;
  /** Per-task loop cap (default 15). */
  maxIterations?: number;
  /** Per-task context budget — set small to FORCE compaction. */
  contextBudget?: number;
  /** Per-task wall-clock cap in seconds (default from runner). */
  maxWallSec?: number;
}

export interface ModelCfg {
  label: string;
  provider?: 'openai' | 'anthropic' | 'mock';
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  mock?: boolean;
}
