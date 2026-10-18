// sample_run — contained dynamic detonation of an untrusted sample.
//
// The static tools (bin_recon, patch_bytes, target_snapshot) never load or execute their target,
// so triage could only ever describe a sample's bytes. sample_run closes that loop: it copies the
// sample into a private scratch directory, executes it under an OS sandbox whose ONLY writable
// path is that scratch directory, and reports what actually happened — exit status, timing,
// files dropped (hashed), and whether egress was even possible.
//
// Containment is a HARD precondition, not a best effort. `wrapCommand` degrades to
// `sandboxed: false` when no sandbox tool is present; for run_shell that is a warning, but for
// detonation it would mean running unknown code unconfined. So this tool REFUSES instead, and
// says why. The same reasoning puts Windows out of scope for v1: there is no jail, so there is no
// detonation — the tool fails closed rather than pretending.
//
// Network is DENIED by default (inverted from run_shell, where agent tasks need installs). A
// sample that tries to beacon should fail cleanly and be reported as such.

import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import { resolveWithin } from '../safety/workspaceJail.js';
import { wrapCommand } from '../safety/sandbox.js';
import { EvidenceStore } from '../security/evidence.js';
import { fail, ok, type Tool, type ToolResult } from './types.js';

/** Samples are binaries; refuse anything that is obviously not one, and anything huge. */
const MAX_SAMPLE_BYTES = 256 * 1024 * 1024;
/** Captured stdout/stderr per stream. The rest is still counted, just not returned. */
const MAX_STREAM_BYTES = 64 * 1024;
/** Files enumerated from the scratch tree after the run. */
const MAX_ARTIFACTS = 500;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60_000;

const schema = z
  .object({
    /** Path to the sample, relative to the workspace (or absolute inside it). */
    path: z.string().min(1).max(2000),
    /** Arguments passed to the sample. */
    args: z.array(z.string().max(4000)).max(64).optional(),
    /** Wall-clock cap. Defaults to 30s; hard-capped at 5min. */
    timeout_ms: z.number().int().min(1).max(MAX_TIMEOUT_MS).optional(),
    /**
     * Allow egress. Default false: a sample is assumed hostile, and an unexpected beacon is a
     * finding rather than a convenience. Set true only when the engagement needs C2 behaviour
     * observed.
     */
    allow_network: z.boolean().optional(),
    /** Keep the scratch tree after the run (default: kept — artifacts are evidence). */
    cleanup: z.boolean().optional(),
  })
  .strict();

type Input = z.infer<typeof schema>;

interface Artifact {
  /** Path relative to the scratch root. */
  path: string;
  bytes: number;
  sha256: string;
  kind: 'file' | 'dir' | 'symlink';
}

interface Capture {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  wallMs: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  /** True when the sandbox actually confined the child. */
  sandboxed: boolean;
  sandboxNote?: string;
  /** Files present in the scratch tree that were NOT there before the run. */
  artifacts: Artifact[];
  artifactTruncated: boolean;
  sampleSha256: string;
  sampleBytes: number;
  scratchDir: string;
}

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/** Walk a tree, hashing every regular file. Bounded so a fork bomb can't hang the tool. */
function enumerate(root: string): { artifacts: Artifact[]; truncated: boolean } {
  const artifacts: Artifact[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (artifacts.length >= MAX_ARTIFACTS) return;
      const abs = join(dir, name);
      const rel = relative(root, abs).split(sep).join('/');
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        artifacts.push({ path: rel, bytes: 0, sha256: '', kind: 'symlink' });
      } else if (st.isDirectory()) {
        artifacts.push({ path: rel, bytes: 0, sha256: '', kind: 'dir' });
        walk(abs);
      } else if (st.isFile()) {
        // Hash small files; a huge dropped file still gets reported, just unhashed.
        let digest = '';
        if (st.size <= MAX_SAMPLE_BYTES) {
          try {
            digest = sha256(readFileSync(abs));
          } catch {
            digest = '';
          }
        }
        artifacts.push({ path: rel, bytes: st.size, sha256: digest, kind: 'file' });
      }
    }
  };
  walk(root);
  return { artifacts, truncated: artifacts.length >= MAX_ARTIFACTS };
}

/** Execute the sample under the detonation jail and capture everything we can observe. */
async function detonate(opts: {
  sampleAbs: string;
  scratchDir: string;
  workspaceRoot: string;
  args: string[];
  timeoutMs: number;
  allowNetwork: boolean;
  signal: AbortSignal;
}): Promise<Omit<Capture, 'artifacts' | 'artifactTruncated' | 'sampleSha256' | 'sampleBytes' | 'scratchDir'>> {
  const started = Date.now();
  const sandbox = wrapCommand({
    command: '',
    workspaceRoot: opts.workspaceRoot,
    allowNetwork: opts.allowNetwork,
    enabled: true,
    exclusiveWriteRoot: opts.scratchDir,
    // The sample IS the process — never an argument to a shell. Compiling the argv here (rather
    // than slicing a `shell -c` tail) is what lets a real Mach-O/ELF run at all, and it removes
    // the shell from the path of a hostile filename.
    execArgv: [opts.sampleAbs, ...opts.args],
  });

  const argv = sandbox.argv;

  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;

    const finish = (exitCode: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      resolve({
        exitCode,
        signal,
        timedOut,
        wallMs: Date.now() - started,
        stdout,
        stderr,
        stdoutBytes,
        stderrBytes,
        sandboxed: sandbox.sandboxed,
        sandboxNote: sandbox.note,
      });
    };

    let child;
    try {
      child = spawn(argv[0]!, argv.slice(1), {
        cwd: opts.scratchDir,
        // A fresh env: the sample inherits nothing useful from the agent. HOME/TMPDIR point into
        // the scratch tree so runtimes that need temp space still work under the exclusive jail.
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: opts.scratchDir,
          TMPDIR: opts.scratchDir,
          LANG: process.env.LANG ?? 'C',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        // Detached so the child is a process-GROUP leader: the timeout path then kills -pid and
        // reaches the sample behind sandbox-exec/bwrap, which do not forward signals reliably.
        // No stdio inheritance means this does not detach the terminal.
        detached: true,
      });
    } catch (error) {
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        wallMs: Date.now() - started,
        stdout: '',
        stderr: `spawn failed: ${(error as Error).message}`,
        stdoutBytes: 0,
        stderrBytes: 0,
        sandboxed: sandbox.sandboxed,
        sandboxNote: sandbox.note,
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the whole process GROUP, not just the direct child. The direct child is
      // `sandbox-exec` (or bwrap), which does not reliably forward signals to the sample it
      // wrapped — a sample that ignores or outlives the forward would run to completion and
      // defeat the timeout. `detached: true` above makes the child a group leader so -pid
      // reaches every descendant. Fall back to a plain kill if the group is already gone.
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, opts.timeoutMs);

    const onAbort = (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdout.length < MAX_STREAM_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderr.length < MAX_STREAM_BYTES) stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      finish(null, `spawn error: ${error.message}`);
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      finish(code, sig);
    });
  });
}

export const sampleRun: Tool<Input, Capture> = {
  name: 'sample_run',
  description:
    'Detonate an untrusted sample in a contained scratch jail and report what it actually did: ' +
    'exit status, timing, dropped files (each hashed) and whether network egress was permitted. ' +
    'The sample runs with the workspace READ-ONLY and a private tmp, so it cannot modify the tree ' +
    'it came from. Network is DENIED by default. Refuses outright when no OS sandbox is available ' +
    'rather than running unknown code unconfined, and is unsupported on Windows. Use after ' +
    'bin_recon triage to turn static observations into dynamic facts.',
  risk: 'exec',
  deferred: true,
  searchAliases: [
    'detonate',
    'sandbox',
    'execute',
    'malware',
    'ransomware',
    'sample',
    'dynamic',
    'behaviour',
    'behavior',
    'run',
    'emulate',
  ],
  inputSchema: schema,
  async run(input: Input, ctx): Promise<ToolResult<Capture>> {
    const started = Date.now();

    // ── Preconditions ───────────────────────────────────────────────────────────
    // No jail, no detonation. This is the whole safety argument, so it fails closed.
    if (process.platform === 'win32') {
      return fail(
        'sample_run',
        'exec',
        Date.now() - started,
        'unsupported_platform',
        'sample_run has no OS sandbox on Windows and will not run untrusted code unconfined. ' +
          'Use bin_recon for static triage, or run the detonation on macOS or Linux.',
      );
    }

    let sampleAbs: string;
    try {
      sampleAbs = resolveWithin(ctx.workspaceRoot, input.path);
    } catch (error) {
      return fail('sample_run', 'exec', Date.now() - started, 'bad_path', (error as Error).message);
    }
    if (!existsSync(sampleAbs)) {
      return fail('sample_run', 'exec', Date.now() - started, 'not_found', `No such sample: ${input.path}`);
    }
    const st = statSync(sampleAbs);
    if (!st.isFile()) {
      return fail('sample_run', 'exec', Date.now() - started, 'not_a_file', `Not a regular file: ${input.path}`);
    }
    if (st.size === 0) {
      return fail('sample_run', 'exec', Date.now() - started, 'empty_sample', `Sample is empty: ${input.path}`);
    }
    if (st.size > MAX_SAMPLE_BYTES) {
      return fail(
        'sample_run',
        'exec',
        Date.now() - started,
        'sample_too_large',
        `Sample is ${st.size} bytes; the cap is ${MAX_SAMPLE_BYTES}.`,
      );
    }

    const sampleBytes = readFileSync(sampleAbs);
    const sampleSha = sha256(sampleBytes);

    if (ctx.dryRun) {
      return ok('sample_run', 'exec', Date.now() - started, `[dry-run] would detonate ${input.path} (sha256 ${sampleSha.slice(0, 16)}…)`, {
        exitCode: null,
        signal: null,
        timedOut: false,
        wallMs: 0,
        stdout: '',
        stderr: '',
        stdoutBytes: 0,
        stderrBytes: 0,
        sandboxed: true,
        artifacts: [],
        artifactTruncated: false,
        sampleSha256: sampleSha,
        sampleBytes: sampleBytes.length,
        scratchDir: '(dry-run)',
      } as Capture);
    }

    // ── Scratch tree ───────────────────────────────────────────────────────────
    // Lives under the workspace so it is covered by the same jail/cleanup story, but it is the
    // ONLY writable path passed to the sandbox.
    const scratchRoot = resolveWithin(ctx.workspaceRoot, '.shadow/security/detonation');
    const runId = `${Date.now()}-${sampleSha.slice(0, 12)}`;
    const scratchDir = join(scratchRoot, runId);
    try {
      mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      return fail(
        'sample_run',
        'exec',
        Date.now() - started,
        'scratch_failed',
        `Could not create scratch dir: ${(error as Error).message}`,
      );
    }

    const sampleName = `sample${sep}${input.path.split(/[\\/]/).pop() ?? 'sample'}`;
    const staged = join(scratchDir, sampleName);
    try {
      mkdirSync(join(scratchDir, 'sample'), { recursive: true, mode: 0o700 });
      writeFileSync(staged, sampleBytes, { mode: 0o700 });
      chmodSync(staged, 0o700);
    } catch (error) {
      return fail(
        'sample_run',
        'exec',
        Date.now() - started,
        'stage_failed',
        `Could not stage the sample: ${(error as Error).message}`,
      );
    }

    // ── Detonate ──────────────────────────────────────────────────────────────
    // Containment is a PRECONDITION, checked before the sample is ever spawned. Testing
    // `capture.sandboxed` after the fact is too late: `wrapCommand` degrades to an unconfined
    // passthrough when no OS sandbox is present, so the sample would already have run loose and
    // the tool would merely have described the escape afterwards. Preflight the same argv and
    // refuse up front if it is not confined.
    const probe = wrapCommand({
      command: '',
      workspaceRoot: ctx.workspaceRoot,
      allowNetwork: input.allow_network ?? false,
      enabled: true,
      exclusiveWriteRoot: scratchDir,
      execArgv: [staged, ...(input.args ?? [])],
    });
    if (!probe.sandboxed) {
      return fail(
        'sample_run',
        'exec',
        Date.now() - started,
        'containment_unavailable',
        `No OS sandbox is available (${probe.note ?? 'unknown reason'}), so the sample would run ` +
          'UNCONFINED. Refusing to detonate. Install bubblewrap (Linux) or run on macOS.',
      );
    }

    const timeoutMs = Math.min(input.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const capture = await detonate({
      sampleAbs: staged,
      scratchDir,
      workspaceRoot: ctx.workspaceRoot,
      args: input.args ?? [],
      timeoutMs,
      allowNetwork: input.allow_network ?? false,
      signal: ctx.signal,
    });

    // Post-condition. The preflight above should make this unreachable; if it ever fires, the
    // sandbox degraded mid-run and we must not report a clean detonation.
    if (!capture.sandboxed) {
      return fail(
        'sample_run',
        'exec',
        Date.now() - started,
        'containment_unavailable',
        `No OS sandbox was available (${capture.sandboxNote ?? 'unknown reason'}), so the sample ` +
          'would have run UNCONFINED. Refusing to report this as a detonation. Install ' +
          'bubblewrap (Linux) and re-run, or detonate on macOS.',
      );
    }

    // ── Post-run evidence ────────────────────────────────────────────────────
    // A sandbox that failed to LAUNCH is not a sample that exited non-zero. bwrap/sandbox-exec
    // report setup errors on stderr and exit 1, which would otherwise be indistinguishable from
    // the sample's own exit code — the operator would read "exit 1" and conclude the malware
    // returned 1. Detect the launcher's signature and fail loudly instead.
    const launcherError = /^(bwrap|sandbox-exec):/m.test(capture.stderr);
    if (launcherError) {
      return fail(
        'sample_run',
        'exec',
        Date.now() - started,
        'sandbox_launch_failed',
        `The sandbox failed to start, so the sample never ran:\n${capture.stderr.trim().slice(0, 2000)}`,
      );
    }

    const { artifacts, truncated } = enumerate(scratchDir);
    // The staged sample itself is not an artifact of the run.
    const dropped = artifacts.filter((a) => a.path !== sampleName);

    const result: Capture = {
      ...capture,
      artifacts: dropped,
      artifactTruncated: truncated,
      sampleSha256: sampleSha,
      sampleBytes: sampleBytes.length,
      scratchDir: relative(ctx.workspaceRoot, scratchDir).split(sep).join('/'),
    };

    // ── Receipt ──────────────────────────────────────────────────────────────
    // Bind the detonation to the sample hash in the findings ledger, so "we ran this" is a
    // recorded fact rather than a claim in chat.
    try {
      const store = new EvidenceStore(ctx.workspaceRoot);
      try {
        store.importFindings([
          {
            title: `Detonated ${input.path} (sha256 ${sampleSha.slice(0, 16)}…)`,
            description:
              `exit=${capture.exitCode ?? 'null'} signal=${capture.signal ?? 'none'} ` +
              `timedOut=${capture.timedOut} wallMs=${capture.wallMs} ` +
              `network=${input.allow_network ? 'allowed' : 'denied'} ` +
              `dropped=${dropped.length}`,
            rule: 'sample_run',
            source: 'sample_run',
            path: input.path,
            severity: capture.timedOut ? 'warning' : 'note',
          },
        ]);
      } finally {
        store.close();
      }
    } catch (error) {
      ctx.log(`sample_run: receipt not recorded: ${(error as Error).message}`);
    }

    if (input.cleanup) {
      try {
        rmSync(scratchDir, { recursive: true, force: true });
      } catch {
        /* artifacts already captured above */
      }
    }

    const verdict = capture.timedOut
      ? `timed out after ${timeoutMs}ms`
      : `exit ${capture.exitCode ?? capture.signal ?? 'unknown'}`;
    const net = input.allow_network ? 'egress ALLOWED' : 'egress denied';
    return ok(
      'sample_run',
      'exec',
      Date.now() - started,
      `Detonated ${input.path} (${verdict}, ${capture.wallMs}ms, ${net}); ` +
        `${dropped.length} artifact(s) in ${result.scratchDir}`,
      result,
    );
  },
};