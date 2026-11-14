/**
 * Host accelerator and memory inventory — the "what hardware am I actually on" question.
 *
 * Why this module exists: `capacity.ts` can answer "does model X fit device Y", but nothing in
 * Shadow could tell you what Y is. `src/gguf.ts` spawns servers and parses their JSON; it never
 * looks at the GPU. So every offload decision was being made blind, and `-ngl` was a number the
 * user had to guess.
 *
 * Design rules, in the order they matter:
 *
 *  1. **Probe status is a first-class result.** "nvidia-smi not installed", "installed but
 *     errored", and "ran fine, no GPUs" are three different facts with three different meanings,
 *     and collapsing them is how a tool ends up telling an ML engineer they have no accelerator.
 *     Every probe records its command, exit code, truncated stderr, and duration.
 *  2. **Measured beats modelled, and modelled must say so.** VRAM total from `nvidia-smi` is
 *     measured. Apple's GPU working-set ceiling is NOT queryable from Node without native code, so
 *     it is modelled from a documented fraction — and that figure carries a warning naming the
 *     assumption, so the reader can override it rather than trust it.
 *  3. **No secrets, no surprises.** Every child process gets `scrubbedEnv()`, never
 *     `{...process.env}`: a vendor SMI binary has no business inheriting provider API keys.
 *  4. **The output feeds `capacity.ts` directly.** `devices` is a ready-made `CapacityDevice[]`,
 *     so the two modules cannot drift apart on what "available" means.
 *
 * Injectability: every external call goes through a `ProbeRunner`, defaulting to a real bounded
 * `spawnSync`. Tests pass a fake runner and never touch the host.
 */
import { spawnSync } from 'node:child_process';
import { scrubbedEnv } from '../util/safeEnv.js';
import type { CapacityDevice } from './capacity.js';

// ── Units ────────────────────────────────────────────────────────────────────

const KIB = 1024;
const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

/**
 * Hard bound on how long any single probe may run.
 *
 * Not generous on purpose. `nvidia-smi` normally answers in ~50 ms, but it can hang for the full
 * driver timeout when a GPU has fallen off the bus or an ECC error wedged it — which is exactly
 * the case where a user most wants an answer. Blocking the agent loop for 30 s to discover that is
 * worse than reporting the probe as timed out.
 */
const PROBE_TIMEOUT_MS = 8_000;

/** Cap on stderr/stdout we retain per probe. Enough to diagnose, small enough to stay in a receipt. */
const MAX_PROBE_OUTPUT = 8_000;

// ── Probe plumbing ───────────────────────────────────────────────────────────

export type ProbeStatus =
  /** Ran, exit 0, produced parseable output. */
  | 'ok'
  /** The binary is not installed. Distinct from failing — this is expected on most hosts. */
  | 'absent'
  /** Ran but errored, timed out, or returned output we could not parse. */
  | 'failed'
  /** This platform never has this accelerator; we did not even try. */
  | 'not-applicable';

export interface ProbeResult {
  /** Human label, e.g. `nvidia-smi`. */
  name: string;
  /** Exact argv, so a receipt shows what was actually executed. */
  argv: string[];
  status: ProbeStatus;
  exitCode?: number;
  signal?: string;
  /** Truncated stderr — the reason a probe failed, when it failed. */
  stderr?: string;
  durationMs: number;
  /** Set when output was present but unparseable; keeps the failure honest instead of silent. */
  parseError?: string;
}

/** What a probe returns. `stdout` is the raw text for the parser to interpret. */
export interface ProbeOutcome {
  status: Exclude<ProbeStatus, 'not-applicable'>;
  stdout: string;
  stderr: string;
  exitCode?: number;
  signal?: string;
  durationMs: number;
  parseError?: string;
}

/** Injectable seam. Tests supply a fake; production uses `realProbeRunner`. */
export type ProbeRunner = (name: string, argv: string[]) => ProbeOutcome;

/**
 * Default runner: bounded `spawnSync` with a scrubbed environment and no shell.
 *
 * `shell: false` plus an argv array means a hostile GPU *name* read back from SMI output can never
 * become a command — we never interpolate into a shell string. ENOENT (binary missing) is reported
 * as `absent`, which is a normal state, not an error.
 */
export const realProbeRunner: ProbeRunner = (name, argv) => {
  const started = Date.now();
  const [bin, ...args] = argv;
  let res;
  try {
    res = spawnSync(bin, args, {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      // No shell: argv is passed straight to execvp.
      shell: false,
      env: scrubbedEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * MIB,
    });
  } catch (err) {
    return {
      status: 'failed',
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
    };
  }
  const durationMs = Date.now() - started;
  const stderr = truncate(res.stderr ?? '', MAX_PROBE_OUTPUT);
  const stdout = truncate(res.stdout ?? '', MAX_PROBE_OUTPUT);

  // ENOENT is "not installed" — the overwhelmingly common case for rocm-smi/nvidia-smi, and it must
  // not be reported as a failure or the inventory looks broken on a healthy machine.
  const enoent = res.error && (res.error as NodeJS.ErrnoException).code === 'ENOENT';
  if (enoent) return { status: 'absent', stdout: '', stderr, durationMs };
  if (res.error) {
    // Timeout surfaces here as ETIMEDOUT with a SIGTERM/SIGKILL signal.
    return {
      status: 'failed',
      stdout,
      stderr: stderr || res.error.message,
      exitCode: res.status ?? undefined,
      signal: res.signal ?? undefined,
      durationMs,
    };
  }
  if (res.status !== 0) {
    return { status: 'failed', stdout, stderr, exitCode: res.status ?? undefined, durationMs };
  }
  return { status: 'ok', stdout, stderr, exitCode: 0, durationMs };
};

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…(truncated ${s.length - max} chars)`;
}

// ── Result types ─────────────────────────────────────────────────────────────

export type GpuVendor = 'nvidia' | 'amd' | 'apple' | 'intel' | 'unknown';

export interface GpuDevice {
  index: number;
  vendor: GpuVendor;
  /** Marketing name, when the probe reported one. */
  name?: string;
  /** Total framebuffer/unified bytes. Always present — a GPU we cannot size is not reported. */
  memoryTotalBytes: number;
  /** Bytes already consumed by other processes, when the probe reports it. */
  memoryUsedBytes?: number;
  /**
   * Bytes a NEW workload could take.
   *
   * Derived, not read: `total - used` where `used` is known, else `total`. On Apple Silicon this is
   * the modelled working-set ceiling minus current wired usage — see `appleGpuCeilingBytes`.
   */
  memoryAvailableBytes: number;
  /** Shader/CUDA cores or Apple GPU cores. Informational; it does not change the fit answer. */
  computeUnits?: number;
  driverVersion?: string;
  /** NVIDIA compute capability, e.g. `8.9`. Determines which quant kernels are available. */
  computeCapability?: string;
  powerLimitWatts?: number;
  temperatureC?: number;
  utilizationPct?: number;
  /** PCI bus id — the stable identifier across reboots, unlike the index. */
  busId?: string;
  /**
   * True when `memoryAvailableBytes` rests on a modelled ceiling rather than a measured one.
   * Carried per-device so a receipt can flag exactly which GPU is uncertain.
   */
  modelled?: boolean;
}

export interface HostMemory {
  totalBytes: number;
  /** Bytes wired down and not reclaimable. */
  wiredBytes?: number;
  /** Free + inactive + purgeable: memory the OS could hand to a new process. */
  reclaimableBytes?: number;
  pageSizeBytes?: number;
  /** Logical CPUs, and the P/E split on Apple Silicon where it is reported. */
  logicalCpus?: number;
  performanceCpus?: number;
  efficiencyCpus?: number;
  cpuModel?: string;
}

export interface AcceleratorInventory {
  platform: NodeJS.Platform;
  /** Raw OS release, for receipts. */
  osRelease?: string;
  gpus: GpuDevice[];
  hostMemory?: HostMemory;
  /**
   * Ready-to-use `CapacityDevice[]` for `estimateCapacity`.
   *
   * One entry per GPU on discrete hardware (host RAM attached to each, since any of them can be the
   * offload target), or a single unified entry on Apple Silicon.
   */
  devices: CapacityDevice[];
  probes: ProbeResult[];
  warnings: string[];
  notes: string[];
  /** Wall time for the whole inventory, so a slow host is visible. */
  durationMs: number;
}

// ── Apple Silicon ────────────────────────────────────────────────────────────

/**
 * Fraction of total RAM Apple's Metal layer will let one process wire, by total-RAM band.
 *
 * This is a MODELLED figure, not a measurement: `recommendedMaxWorkingSetSize` is only reachable
 * through Metal, and Shadow has no native module. The bands below track Apple's observed defaults
 * (roughly two-thirds on small machines, three-quarters on large ones). Every use carries a warning
 * naming this table so the reader knows to distrust it, and `iogpu.wired_limit_mb` overrides it
 * whenever the operator has actually set one.
 *
 * If Apple changes these defaults, this table is wrong — that is why it is isolated here with this
 * comment rather than sprinkled through the sizing math.
 */
const APPLE_WORKING_SET_BANDS: ReadonlyArray<{ upToBytes: number; fraction: number }> = [
  { upToBytes: 8 * GIB, fraction: 0.5 },
  { upToBytes: 36 * GIB, fraction: 2 / 3 },
  { upToBytes: Number.POSITIVE_INFINITY, fraction: 0.75 },
];

/** The modelled Metal working-set ceiling for a given total RAM. */
export function appleGpuCeilingBytes(totalRamBytes: number): number {
  const band =
    APPLE_WORKING_SET_BANDS.find((b) => totalRamBytes <= b.upToBytes) ??
    APPLE_WORKING_SET_BANDS[APPLE_WORKING_SET_BANDS.length - 1];
  return Math.floor(totalRamBytes * band.fraction);
}

/** Parse `sysctl -n hw.memsize` and friends. Tolerates missing keys. */
export function parseSysctl(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

/**
 * Parse `vm_stat` into byte counts.
 *
 * The page size is only in the header line ("(page size of 16384 bytes)"), and it is 4096 on Intel
 * Macs but 16384 on Apple Silicon — so reading it from the output rather than assuming is the whole
 * reason this is a function and not a constant.
 */
export function parseVmStat(stdout: string): {
  pageSizeBytes?: number;
  freeBytes?: number;
  inactiveBytes?: number;
  purgeableBytes?: number;
  wiredBytes?: number;
} {
  const pageSizeMatch = stdout.match(/page size of (\d+) bytes/i);
  const pageSizeBytes = pageSizeMatch ? Number(pageSizeMatch[1]) : undefined;
  const pages = (label: string): number | undefined => {
    const m = stdout.match(new RegExp(`^${label}:\\s+(\\d+)`, 'im'));
    return m ? Number(m[1]) : undefined;
  };
  const toBytes = (p: number | undefined): number | undefined =>
    p === undefined || pageSizeBytes === undefined ? undefined : p * pageSizeBytes;
  return {
    pageSizeBytes,
    freeBytes: toBytes(pages('Pages free')),
    inactiveBytes: toBytes(pages('Pages inactive')),
    purgeableBytes: toBytes(pages('Pages purgeable')),
    wiredBytes: toBytes(pages('Pages wired down')),
  };
}

/**
 * Parse `system_profiler SPDisplaysDataType -json`.
 *
 * Defensive on purpose: this output shape varies across macOS releases, and a missing key must
 * degrade to "unknown", never throw and take the whole inventory with it.
 */
export function parseAppleDisplays(json: string): Array<{ name: string; cores?: number; vendor?: string }> {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    return [];
  }
  const arr = (root as { SPDisplaysDataType?: unknown })?.SPDisplaysDataType;
  if (!Array.isArray(arr)) return [];
  const out: Array<{ name: string; cores?: number; vendor?: string }> = [];
  for (const entry of arr) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const name = typeof rec._name === 'string' ? rec._name : undefined;
    if (!name) continue;
    const coresRaw = rec.sppci_cores;
    const cores = typeof coresRaw === 'string' ? Number(coresRaw) : typeof coresRaw === 'number' ? coresRaw : undefined;
    // The vendor key is `spdisplays_vendor` on current macOS; older releases used `sppci_vendor`.
    // Accept both rather than silently dropping the field after an OS update.
    const vendor =
      typeof rec.spdisplays_vendor === 'string' ? rec.spdisplays_vendor
      : typeof rec.sppci_vendor === 'string' ? rec.sppci_vendor
      : undefined;
    out.push({
      name,
      cores: cores !== undefined && Number.isFinite(cores) ? cores : undefined,
      vendor,
    });
  }
  return out;
}

// ── NVIDIA ───────────────────────────────────────────────────────────────────

/**
 * Fields requested from `nvidia-smi`, in order.
 *
 * `memory.*` come back in MiB under `nounits`. `compute_cap` is absent on very old drivers, so it
 * is parsed as optional rather than assumed present.
 */
const NVIDIA_QUERY_FIELDS = [
  'index',
  'name',
  'memory.total',
  'memory.used',
  'memory.free',
  'driver_version',
  'compute_cap',
  'power.limit',
  'temperature.gpu',
  'utilization.gpu',
  'pci.bus_id',
] as const;

export const NVIDIA_QUERY_ARGV = [
  'nvidia-smi',
  `--query-gpu=${NVIDIA_QUERY_FIELDS.join(',')}`,
  '--format=csv,noheader,nounits',
];

/** Numeric or undefined — nvidia-smi emits `[N/A]` and `[Not Supported]` for unsupported fields. */
function optNum(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const t = s.trim();
  if (t === '' || t.startsWith('[')) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

function optStr(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  const t = s.trim();
  if (t === '' || t.startsWith('[')) return undefined;
  return t;
}

/**
 * Parse one `nvidia-smi --format=csv,noheader,nounits` line.
 *
 * Splitting on comma is safe for the fields we request: GPU names do contain spaces but not commas
 * in practice, and if one ever did, the row would fail the length check and be reported as a parse
 * error rather than silently mis-assigned.
 */
export function parseNvidiaSmiLine(line: string): GpuDevice | undefined {
  const parts = line.split(',');
  if (parts.length < NVIDIA_QUERY_FIELDS.length) return undefined;
  const [index, name, memTotal, memUsed, memFree, driver, cc, power, temp, util, busId] = parts;
  const totalMib = optNum(index === undefined ? undefined : memTotal);
  if (totalMib === undefined) return undefined;
  const idx = optNum(index) ?? 0;
  const memoryTotalBytes = totalMib * MIB;
  const usedMib = optNum(memUsed);
  const freeMib = optNum(memFree);
  // Prefer the driver's own `memory.free` over `total - used`: it accounts for the driver's private
  // reservation, which `total - used` does not, and reporting the larger figure causes OOM.
  const memoryAvailableBytes =
    freeMib !== undefined ? freeMib * MIB
    : usedMib !== undefined ? Math.max(0, memoryTotalBytes - usedMib * MIB)
    : memoryTotalBytes;
  return {
    index: idx,
    vendor: 'nvidia',
    name: optStr(name),
    memoryTotalBytes,
    memoryUsedBytes: usedMib !== undefined ? usedMib * MIB : undefined,
    memoryAvailableBytes,
    driverVersion: optStr(driver),
    computeCapability: optStr(cc),
    powerLimitWatts: optNum(power),
    temperatureC: optNum(temp),
    utilizationPct: optNum(util),
    busId: optStr(busId),
  };
}

export function parseNvidiaSmi(stdout: string): GpuDevice[] {
  const out: GpuDevice[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    const dev = parseNvidiaSmiLine(line);
    if (dev) out.push(dev);
  }
  return out;
}

// ── AMD ──────────────────────────────────────────────────────────────────────

/**
 * `rocm-smi` output shape has changed several times across ROCm releases and is not stable enough to
 * key on. We request JSON and accept whatever VRAM fields are present.
 */
export const ROCM_QUERY_ARGV = ['rocm-smi', '--showmeminfo', 'vram', '--showproductname', '--json'];

/**
 * Parse `rocm-smi --showmeminfo vram --json`.
 *
 * The JSON is keyed by `card0`, `card1`, … with nested `VRAM Total Memory (B)` /
 * `VRAM Total Used Memory (B)` string values, but the exact labels have varied. We therefore scan
 * each card object for any key matching /total/i and /used/i rather than hard-coding one spelling,
 * and report a parse error if we find a card we cannot size.
 */
export function parseRocmSmi(json: string): { gpus: GpuDevice[]; parseErrors: string[] } {
  const parseErrors: string[] = [];
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch (err) {
    return { gpus: [], parseErrors: [`rocm-smi JSON did not parse: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    return { gpus: [], parseErrors: ['rocm-smi JSON root was not an object'] };
  }
  const gpus: GpuDevice[] = [];
  const entries = Object.entries(root as Record<string, unknown>).filter(([k]) => /^card\d+$/i.test(k));
  entries.forEach(([cardKey, value], i) => {
    if (typeof value !== 'object' || value === null) {
      parseErrors.push(`${cardKey}: not an object`);
      return;
    }
    const rec = value as Record<string, unknown>;
    const findNum = (re: RegExp): number | undefined => {
      for (const [k, v] of Object.entries(rec)) {
        if (!re.test(k)) continue;
        const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d.-]/g, ''));
        if (Number.isFinite(n)) return n;
      }
      return undefined;
    };
    const total = findNum(/total.*mem|mem.*total/i);
    if (total === undefined || total <= 0) {
      parseErrors.push(`${cardKey}: no VRAM total found`);
      return;
    }
    // "Used" must not match the "Total Used" key twice; require /used/ and exclude /total/… but the
    // real label IS "VRAM Total Used Memory (B)", so match used explicitly and accept it.
    const used = findNum(/used/i);
    const name =
      typeof rec['SKU model'] === 'string' ? (rec['SKU model'] as string)
      : typeof rec['Card model'] === 'string' ? (rec['Card model'] as string)
      : typeof rec['Card series'] === 'string' ? (rec['Card series'] as string)
      : undefined;
    gpus.push({
      index: optNum(cardKey.replace(/\D/g, '')) ?? i,
      vendor: 'amd',
      name,
      memoryTotalBytes: total,
      memoryUsedBytes: used,
      memoryAvailableBytes: used !== undefined ? Math.max(0, total - used) : total,
      busId: typeof rec['Card PCI Bus ID'] === 'string' ? (rec['Card PCI Bus ID'] as string) : undefined,
    });
  });
  return { gpus, parseErrors };
}

// ── Top-level inventory ──────────────────────────────────────────────────────

export interface InventoryOptions {
  /** Defaults to `process.platform`. Injectable so the Apple path can be tested on Linux. */
  platform?: NodeJS.Platform;
  /**
   * Defaults to `process.arch`. Injectable for the same reason as `platform`.
   *
   * This must NOT be read from the ambient environment inside the function: doing so made the
   * `platform` injection untrustworthy, because running an Intel-Mac fixture on a real Apple
   * Silicon host would silently take the unified-memory branch. Every environment-derived input is
   * an option.
   */
  arch?: string;
  /** Defaults to `realProbeRunner`. */
  runner?: ProbeRunner;
  /**
   * Override Apple's modelled GPU ceiling, in bytes.
   *
   * Set this when you know the real `recommendedMaxWorkingSetSize` (or have configured
   * `iogpu.wired_limit_mb`) and do not want the modelled band table.
   */
  appleGpuCeilingOverrideBytes?: number;
  /** Skip accelerator probes entirely and report host memory only. */
  skipGpu?: boolean;
}

/**
 * Inventory the host's accelerators and memory.
 *
 * Never throws: a broken or missing probe degrades to a recorded `ProbeResult` and a warning. The
 * caller always gets an object it can put in a receipt.
 */
export function inventoryAccelerators(options: InventoryOptions = {}): AcceleratorInventory {
  const started = Date.now();
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const run = options.runner ?? realProbeRunner;
  const probes: ProbeResult[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  const gpus: GpuDevice[] = [];
  let hostMemory: HostMemory | undefined;
  let osRelease: string | undefined;

  /** Run a probe and record it, converting `not-applicable` into a skipped record. */
  const probe = (name: string, argv: string[], applicable: boolean): ProbeOutcome | undefined => {
    if (!applicable) {
      probes.push({ name, argv, status: 'not-applicable', durationMs: 0 });
      return undefined;
    }
    const outcome = run(name, argv);
    probes.push({
      name,
      argv,
      status: outcome.status,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stderr: outcome.stderr ? truncate(outcome.stderr, 2_000) : undefined,
      durationMs: outcome.durationMs,
      parseError: outcome.parseError,
    });
    return outcome;
  };

  if (platform === 'win32') {
    // No SMI path here yet: Windows users get an explicit "unsupported", not a silent empty list.
    warnings.push(
      'Windows accelerator inventory is not implemented; no GPUs were detected. ' +
        'Run `nvidia-smi` manually and pass VRAM figures explicitly.',
    );
  } else if (platform === 'darwin') {
    // ── macOS: unified memory on Apple Silicon, discrete GPU on Intel ──
    const sys = probe('sysctl', ['sysctl', 'hw.memsize', 'hw.ncpu', 'hw.pagesize', 'hw.model', 'machdep.cpu.brand_string', 'kern.osrelease', 'hw.perflevel0.logicalcpu', 'hw.perflevel1.logicalcpu'], true);
    const sysctl = sys && sys.status === 'ok' ? parseSysctl(sys.stdout) : {};

    const vm = probe('vm_stat', ['vm_stat'], true);
    const vmStat = vm && vm.status === 'ok' ? parseVmStat(vm.stdout) : {};

    const totalRam = Number(sysctl['hw.memsize']);
    if (!Number.isFinite(totalRam) || totalRam <= 0) {
      warnings.push('could not read hw.memsize; host memory is unknown');
    } else {
      const reclaimable =
        vmStat.freeBytes !== undefined || vmStat.inactiveBytes !== undefined || vmStat.purgeableBytes !== undefined
          ? (vmStat.freeBytes ?? 0) + (vmStat.inactiveBytes ?? 0) + (vmStat.purgeableBytes ?? 0)
          : undefined;
      hostMemory = {
        totalBytes: totalRam,
        wiredBytes: vmStat.wiredBytes,
        reclaimableBytes: reclaimable,
        pageSizeBytes: vmStat.pageSizeBytes ?? optNum(sysctl['hw.pagesize']),
        logicalCpus: optNum(sysctl['hw.ncpu']),
        performanceCpus: optNum(sysctl['hw.perflevel0.logicalcpu']),
        efficiencyCpus: optNum(sysctl['hw.perflevel1.logicalcpu']),
        cpuModel: sysctl['hw.model'] ?? sysctl['machdep.cpu.brand_string'],
      };
    }

    const displays = probe('system_profiler', ['system_profiler', 'SPDisplaysDataType', '-json'], !options.skipGpu);
    osRelease = sysctl['kern.osrelease'];
    const appleGpus = displays && displays.status === 'ok' ? parseAppleDisplays(displays.stdout) : [];
    if (displays && displays.status === 'failed') {
      warnings.push(`system_profiler failed; GPU model/core count unknown (${truncate(displays.stderr, 200)})`);
    }
    if (displays && displays.status === 'ok' && appleGpus.length === 0) {
      warnings.push('system_profiler reported no display devices; GPU inventory is empty');
    }

    // Is this Apple Silicon (unified) or Intel (discrete AMD/NVIDIA eGPU)?
    // `hw.model` (Mac16,10) is the most reliable signal; `arch` is injectable so tests are not at
    // the mercy of whatever machine they happen to run on.
    const isAppleSilicon =
      appleGpus.some((g) => /^Apple M\d/.test(g.name)) || /^arm64$/.test(arch) || /^Mac\d+,\d+$/.test(sysctl['hw.model'] ?? '');

    if (totalRam > 0) {
      // The operator-set wired limit is authoritative and measured; the band table is a guess.
      const wiredLimit = probe('sysctl-iogpu', ['sysctl', '-n', 'iogpu.wired_limit_mb'], isAppleSilicon);
      const wiredLimitMb = wiredLimit && wiredLimit.status === 'ok' ? Number(wiredLimit.stdout.trim()) : 0;
      const explicitCeiling = Number.isFinite(wiredLimitMb) && wiredLimitMb > 0 ? wiredLimitMb * MIB : undefined;

      const ceiling =
        options.appleGpuCeilingOverrideBytes ??
        explicitCeiling ??
        appleGpuCeilingBytes(totalRam);
      const ceilingSource =
        options.appleGpuCeilingOverrideBytes !== undefined ? 'caller override'
        : explicitCeiling !== undefined ? `iogpu.wired_limit_mb=${wiredLimitMb}`
        : 'modelled band table';

      if (explicitCeiling === undefined && options.appleGpuCeilingOverrideBytes === undefined) {
        warnings.push(
          `Apple GPU working-set ceiling is MODELLED (${ceilingSource}: ${(ceiling / GIB).toFixed(2)} GiB of ` +
            `${(totalRam / GIB).toFixed(2)} GiB total), not measured — Metal's recommendedMaxWorkingSetSize is ` +
            'not readable without native code. Set `iogpu.wired_limit_mb` or pass an override to make it exact.',
        );
      } else {
        notes.push(`Apple GPU ceiling from ${ceilingSource}: ${(ceiling / GIB).toFixed(2)} GiB`);
      }

      if (isAppleSilicon) {
        // Unified: the GPU ceiling and host RAM are ONE pool. Model it as a single unified device and
        // never also report a separate host pool, or the same bytes get counted twice.
        //
        // Two independent constraints apply, and the binding one is whichever is SMALLER:
        //   * `ceiling` — the most this process may wire (measured or modelled, see above).
        //   * `reclaimable` — free + inactive + purgeable: what the OS can actually hand out NOW.
        //
        // Wired pages are pinned by the kernel and other processes and CANNOT be reclaimed, so they
        // are deliberately NOT added back. Doing so overstates availability by several GiB on a busy
        // machine and turns "fits" into an OOM — the ceiling is a per-process limit, not free memory.
        const reclaimable = hostMemory?.reclaimableBytes;
        const usable = reclaimable !== undefined ? Math.min(ceiling, reclaimable) : ceiling;
        if (reclaimable !== undefined && reclaimable < ceiling) {
          notes.push(
            `host memory pressure is the binding constraint, not the GPU ceiling: ` +
              `${(reclaimable / GIB).toFixed(2)} GiB reclaimable vs ${(ceiling / GIB).toFixed(2)} GiB ceiling`,
          );
        }
        const first = appleGpus[0];
        if (appleGpus.length > 1) {
          notes.push(`system_profiler reported ${appleGpus.length} display devices; unified memory is modelled as one pool`);
        }
        gpus.push({
          index: 0,
          vendor: 'apple',
          name: first?.name,
          memoryTotalBytes: totalRam,
          memoryAvailableBytes: usable,
          computeUnits: first?.cores,
          modelled: explicitCeiling === undefined && options.appleGpuCeilingOverrideBytes === undefined,
        });
        notes.push(
          'Apple Silicon unified memory: CPU and GPU share one pool, so `-ngl 999` (full offload) is ' +
            'simply correct here rather than a tuning question.',
        );
      } else {
        // Intel Mac / eGPU: discrete. Report each display device, but we cannot size its VRAM from
        // system_profiler, so say so instead of inventing a number.
        for (const [i, g] of appleGpus.entries()) {
          warnings.push(
            `"${g.name}" is a discrete GPU but system_profiler does not report its VRAM; ` +
              'it is listed without a memory figure and excluded from capacity devices',
          );
          gpus.push({ index: i, vendor: 'apple', name: g.name, memoryTotalBytes: 0, memoryAvailableBytes: 0, computeUnits: g.cores });
        }
      }
    }
  } else {
    // ── Linux / *BSD: NVIDIA then AMD, plus /proc/meminfo for host RAM ──
    const nvidia = probe('nvidia-smi', NVIDIA_QUERY_ARGV, !options.skipGpu);
    if (nvidia && nvidia.status === 'ok') {
      const parsed = parseNvidiaSmi(nvidia.stdout);
      if (parsed.length === 0 && nvidia.stdout.trim() !== '') {
        nvidia.parseError = 'nvidia-smi produced output but no row parsed';
        const rec = probes.find((p) => p.name === 'nvidia-smi');
        if (rec) rec.parseError = nvidia.parseError;
        warnings.push('nvidia-smi output could not be parsed; check driver version');
      }
      gpus.push(...parsed);
    } else if (nvidia && nvidia.status === 'failed') {
      warnings.push(`nvidia-smi failed: ${truncate(nvidia.stderr, 200)}`);
    }

    const rocm = probe('rocm-smi', ROCM_QUERY_ARGV, !options.skipGpu);
    if (rocm && rocm.status === 'ok') {
      const { gpus: amdGpus, parseErrors } = parseRocmSmi(rocm.stdout);
      for (const e of parseErrors) warnings.push(`rocm-smi: ${e}`);
      // Offset AMD indices past NVIDIA's so a mixed host does not report two index-0 devices.
      const offset = gpus.length;
      gpus.push(...amdGpus.map((g, i) => ({ ...g, index: offset + i })));
    } else if (rocm && rocm.status === 'failed') {
      warnings.push(`rocm-smi failed: ${truncate(rocm.stderr, 200)}`);
    }

    const meminfo = probe('proc-meminfo', ['cat', '/proc/meminfo'], true);
    if (meminfo && meminfo.status === 'ok') {
      const kb = (label: string): number | undefined => {
        const m = meminfo.stdout.match(new RegExp(`^${label}:\\s+(\\d+)\\s*kB`, 'im'));
        return m ? Number(m[1]) * KIB : undefined;
      };
      const total = kb('MemTotal');
      const available = kb('MemAvailable');
      if (total !== undefined) {
        hostMemory = {
          totalBytes: total,
          // MemAvailable is the kernel's own estimate of allocatable memory; prefer it to
          // MemFree, which excludes reclaimable page cache and badly understates the truth.
          reclaimableBytes: available,
          logicalCpus: undefined,
        };
      }
    }
    const nproc = probe('nproc', ['nproc'], true);
    if (hostMemory && nproc && nproc.status === 'ok') {
      hostMemory.logicalCpus = Number(nproc.stdout.trim()) || undefined;
    }
    const uname = probe('uname', ['uname', '-r'], true);
    osRelease = uname && uname.status === 'ok' ? uname.stdout.trim() : undefined;

    if (gpus.length === 0 && !options.skipGpu) {
      const nvidiaAbsent = probes.find((p) => p.name === 'nvidia-smi')?.status === 'absent';
      const rocmAbsent = probes.find((p) => p.name === 'rocm-smi')?.status === 'absent';
      if (nvidiaAbsent && rocmAbsent) {
        notes.push(
          'neither nvidia-smi nor rocm-smi is installed — no discrete accelerator detected. ' +
            'This is normal for a CPU-only or integrated-GPU host.',
        );
      } else {
        warnings.push('accelerator probes ran but reported no usable GPU');
      }
    }
  }

  // ── Map GPUs → CapacityDevice ──
  const devices: CapacityDevice[] = [];
  const isUnified = gpus.some((g) => g.vendor === 'apple' && g.memoryTotalBytes > 0 && platform === 'darwin');

  for (const gpu of gpus) {
    if (gpu.memoryTotalBytes <= 0) continue; // unsized device: listed, but cannot be planned against
    if (isUnified) {
      devices.push({
        totalMemoryBytes: gpu.memoryTotalBytes,
        unified: true,
        // The ceiling is already subtracted in memoryAvailableBytes; express the remainder as the
        // reservation so capacity.ts's availableBytes() reproduces the same number.
        reservedBytes: Math.max(0, gpu.memoryTotalBytes - gpu.memoryAvailableBytes),
        label: gpu.name ?? 'Apple unified memory',
      });
      break; // one pool, one device
    }
    devices.push({
      totalMemoryBytes: gpu.memoryAvailableBytes,
      unified: false,
      // On a discrete GPU, host RAM is the pool a partial offload spills into. Without it the
      // capacity module returns `unchecked` — which is correct, and better than a false "fits".
      systemRamBytes: hostMemory?.reclaimableBytes ?? hostMemory?.totalBytes,
      label: gpu.name ?? `GPU ${gpu.index}`,
    });
  }

  if (devices.length === 0 && !isUnified) {
    // CPU-only host: still report host RAM so capacity.ts can answer "will this run on CPU at all".
    if (hostMemory && hostMemory.totalBytes > 0) {
      devices.push({
        totalMemoryBytes: hostMemory.reclaimableBytes ?? hostMemory.totalBytes,
        // ONE pool, so `unified: true` — and this is the whole fix for a real fail-closed bug.
        //
        // In capacity.ts, `unified` does not mean "Apple Silicon"; it means "CPU and GPU share one
        // ceiling, so there is no offload trade-off to tune". A CPU-only host has exactly that: one
        // pool, host RAM, and no VRAM to offload INTO.
        //
        // Flagging it `false` instead declares two physically separate pools, which makes capacity.ts
        // look for the second one in `systemRamBytes` — a field that means "host RAM *beside* the
        // VRAM" and is therefore meaningless here. With `-ngl 0` (the ONLY correct setting for CPU
        // inference) every weight lands in the CPU pool, so the verdict came back `unchecked` with
        // "host RAM was not reported" even though MemAvailable had just been measured. That inverts
        // the intended failure mode: it blocks the one configuration that works and reads as
        // "unknown hardware" rather than "you asked for the wrong placement".
        unified: true,
        label: 'CPU only (no accelerator detected)',
      });
      notes.push(
        'no accelerator detected; capacity is reported against host RAM for CPU inference ' +
          '(one pool — there is no GPU to offload layers to, so -ngl 0 is the only meaningful setting)',
      );
    }
  }

  return {
    platform,
    osRelease,
    gpus,
    hostMemory,
    devices,
    probes,
    warnings,
    notes,
    durationMs: Date.now() - started,
  };
}

// ── Reporting ────────────────────────────────────────────────────────────────

function gib(bytes: number, digits = 2): string {
  return `${(bytes / GIB).toFixed(digits)} GiB`;
}

/** One-line-per-GPU summary for CLI output and receipts. */
export function summarizeInventory(inv: AcceleratorInventory): string[] {
  const lines: string[] = [];
  if (inv.gpus.length === 0) {
    lines.push('no accelerators detected');
  }
  for (const g of inv.gpus) {
    const bits = [`${g.vendor}${g.index > 0 ? `#${g.index}` : ''}`];
    if (g.name) bits.push(g.name);
    if (g.memoryTotalBytes > 0) {
      bits.push(`${gib(g.memoryAvailableBytes)}/${gib(g.memoryTotalBytes)} free`);
      if (g.modelled) bits.push('(ceiling MODELLED)');
    } else {
      bits.push('VRAM unknown');
    }
    if (g.computeUnits !== undefined) bits.push(`${g.computeUnits} cores`);
    if (g.computeCapability) bits.push(`cc ${g.computeCapability}`);
    if (g.temperatureC !== undefined) bits.push(`${g.temperatureC}C`);
    if (g.utilizationPct !== undefined) bits.push(`${g.utilizationPct}% util`);
    lines.push(bits.join(' · '));
  }
  if (inv.hostMemory) {
    const hm = inv.hostMemory;
    const bits = [`host RAM ${gib(hm.reclaimableBytes ?? hm.totalBytes)}/${gib(hm.totalBytes)} available`];
    if (hm.logicalCpus !== undefined) {
      bits.push(
        hm.performanceCpus !== undefined && hm.efficiencyCpus !== undefined
          ? `${hm.logicalCpus} CPU (${hm.performanceCpus}P+${hm.efficiencyCpus}E)`
          : `${hm.logicalCpus} CPU`,
      );
    }
    lines.push(bits.join(' · '));
  }
  for (const w of inv.warnings) lines.push(`WARN: ${w}`);
  return lines;
}
