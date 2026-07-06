import type { z } from 'zod';
import type { ReadTracker } from './readTracker.js';
import type { DiffLine } from '../util/diff.js';
import type { ImageBlock } from '../provider/provider.js';

export type ToolRisk = 'read' | 'write' | 'exec' | 'network';

export interface ToolResult<T = unknown> {
  ok: boolean;
  summary: string; // concise, model-facing description of the outcome
  data?: T; // structured payload (tool-specific)
  // Images to inject into the model's context this turn (e.g. view_image). The loop
  // appends these as ImageBlocks in the tool-result user turn — NOT serialized into the
  // text content (so the base64 never bloats `summary`/`data`). Provider adapters render
  // them per backend (Anthropic image block / OpenAI-Gemini image_url data-URI).
  images?: ImageBlock[];
  error?: { code: string; message: string; recoverable: boolean };
  // `meta` is UI/runtime metadata only — NOT serialized back to the model (so a `diff` here
  // renders in the canvas without bloating the model's context).
  meta: {
    tool: string;
    durationMs: number;
    risk: ToolRisk;
    diff?: DiffLine[];
    findings?: { title: string; body: string; severity?: 'info' | 'warn' | 'error' }[];
  };
}

export type ShellOutputHandler = (chunk: string, stream: 'stdout' | 'stderr') => void;

export interface ToolContext {
  workspaceRoot: string; // absolute; relative paths resolve under this
  /** Extra absolute roots (from additionalDirectories / --add-dir) file tools + the sandbox may read/write. */
  additionalRoots?: string[];
  signal: AbortSignal; // for timeouts / Ctrl-C
  log: (msg: string) => void;
  dryRun: boolean; // when true, write/exec tools no-op and report what they WOULD do
  readTracker?: ReadTracker; // read-before-edit guard (present in the real loop, optional in tests)
  /** When true, run_shell emits live stdout/stderr chunks via onShellOutput. */
  streamShell?: boolean;
  onShellOutput?: ShellOutputHandler;
  /** Called when run_shell spawns its child: the PID, and a warning if the command may detach/
   *  escalate (sudo/setsid/nohup/&) and survive an ESC interrupt — so the user can kill it manually. */
  onShellStart?: (info: { pid: number; warn: string | null }) => void;
  toolCallId?: string;
  /** When set, write tools save a pre-mutation checkpoint for `/rewind`. */
  checkpoint?: { sessionId: string; turn: number };
}

export interface Tool<I = unknown, O = unknown> {
  name: string;
  description: string; // shown to the model
  risk: ToolRisk;
  // Output type is `I`; input is widened to `unknown` so a schema may `z.preprocess`/`z.coerce`
  // a weak model's stringified arg (JSON-string array, numeric string) before validating. A plain
  // `z.object<I>` (input = output) still satisfies this.
  inputSchema: z.ZodType<I, z.ZodTypeDef, unknown>;
  /** When true, omitted from the default tool schema until discovered via `tool_search`. */
  deferred?: boolean;
  run(input: I, ctx: ToolContext): Promise<ToolResult<O>>;
}

/** Convenience builder for a successful result. */
export function ok<T>(
  tool: string,
  risk: ToolRisk,
  durationMs: number,
  summary: string,
  data?: T,
): ToolResult<T> {
  return { ok: true, summary, data, meta: { tool, durationMs, risk } };
}

/** Convenience builder for a failed result. */
export function fail(
  tool: string,
  risk: ToolRisk,
  durationMs: number,
  code: string,
  message: string,
  recoverable = true,
): ToolResult<never> {
  return {
    ok: false,
    summary: message,
    error: { code, message, recoverable },
    meta: { tool, durationMs, risk },
  };
}
