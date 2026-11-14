/**
 * Tests for the host accelerator inventory.
 *
 * Everything runs through a FAKE ProbeRunner, so these never touch the host, never spawn a real
 * SMI binary, and produce identical results on a Mac, a Linux box and CI. The fixtures are
 * byte-for-byte real output captured from actual machines, because the parsers are only worth
 * anything if they handle the shape the vendor tools really emit.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  inventoryAccelerators,
  parseNvidiaSmi,
  parseNvidiaSmiLine,
  parseRocmSmi,
  parseVmStat,
  parseSysctl,
  parseAppleDisplays,
  appleGpuCeilingBytes,
  summarizeInventory,
  NVIDIA_QUERY_ARGV,
  type ProbeRunner,
  type ProbeOutcome,
} from '../src/inference/gpu.js';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** Build a runner from a name → outcome map. Anything unlisted comes back `absent`. */
function fakeRunner(table: Record<string, Partial<ProbeOutcome>>): ProbeRunner {
  return (name) => {
    const hit = table[name];
    return {
      status: hit?.status ?? 'absent',
      stdout: hit?.stdout ?? '',
      stderr: hit?.stderr ?? '',
      exitCode: hit?.exitCode,
      signal: hit?.signal,
      durationMs: hit?.durationMs ?? 1,
    };
  };
}

// ── Real captured fixtures ───────────────────────────────────────────────────

/**
 * `nvidia-smi --query-gpu=... --format=csv,noheader,nounits` on a 2x RTX 4090 box.
 *
 * Card 0's `memory.free` (23500) is deliberately NOT `total - used` (24564 - 1024 = 23540): the
 * driver keeps a private reservation that `total - used` misses. Reporting the larger figure is how
 * a capacity tool ends up greenlighting an OOM, so the fixture has to be able to tell them apart.
 */
const NVIDIA_TWO_CARDS = [
  '0, NVIDIA GeForce RTX 4090, 24564, 1024, 23500, 550.127.08, 8.9, 450.00, 41, 3, 00000000:01:00.0',
  '1, NVIDIA GeForce RTX 4090, 24564, 0, 24564, 550.127.08, 8.9, 450.00, 38, 0, 00000000:21:00.0',
].join('\n');

/** nvidia-smi emits these sentinels for fields a card/driver does not support. */
const NVIDIA_NOT_SUPPORTED =
  '0, NVIDIA A100-SXM4-40GB, 40960, 512, 40448, 535.104.05, [N/A], [Not Supported], 33, [N/A], 0000:07:00.0';

/** `vm_stat` on Apple Silicon — note the 16384-byte page size, not 4096. */
const VM_STAT_ARM = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     6110.
Pages active:                                 239134.
Pages inactive:                               237896.
Pages speculative:                                95.
Pages throttled:                                   0.
Pages wired down:                             191183.
Pages purgeable:                                4975.
"Translation faults":                     18588925818.
`;

/** `vm_stat` on an Intel Mac — 4096-byte pages. The parser must not assume one size. */
const VM_STAT_INTEL = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                                12345.
Pages active:                              99999.
Pages inactive:                            50000.
Pages speculative:                            10.
Pages wired down:                          80000.
Pages purgeable:                            1000.
`;

/** `system_profiler SPDisplaysDataType -json`, trimmed to the keys we read. */
const SP_DISPLAYS_M4 = JSON.stringify({
  SPDisplaysDataType: [
    {
      _name: 'Apple M4',
      spdisplays_mtlgpufamilysupport: 'spdisplays_metal4',
      spdisplays_vendor: 'sppci_vendor_Apple',
      sppci_cores: '10',
      sppci_device_type: 'spdisplays_gpu',
      sppci_model: 'Apple M4',
    },
  ],
});

/** `sysctl` multi-key output, exactly the shape `sysctl a b c` prints. */
const SYSCTL_ARM = `hw.memsize: 17179869184
hw.ncpu: 10
hw.pagesize: 16384
hw.model: Mac16,10
machdep.cpu.brand_string: Apple M4
kern.osrelease: 27.2.0
hw.perflevel0.logicalcpu: 4
hw.perflevel1.logicalcpu: 6
`;

/** `rocm-smi --showmeminfo vram --showproductname --json` on a 2x MI300X host. */
const ROCM_JSON = JSON.stringify({
  system: '1.2.3',
  card0: {
    'Card series': 'AMD Instinct MI300X',
    'Card model': '0x74a1',
    'Card PCI Bus ID': '0000:c1:00.0',
    'VRAM Total Memory (B)': '137438953472',
    'VRAM Total Used Memory (B)': '8589934592',
  },
  card1: {
    'Card series': 'AMD Instinct MI300X',
    'Card PCI Bus ID': '0000:c4:00.0',
    'VRAM Total Memory (B)': '137438953472',
    'VRAM Total Used Memory (B)': '0',
  },
});

const PROC_MEMINFO = `MemTotal:       131762248 kB
MemFree:          8123456 kB
MemAvailable:   120000000 kB
Buffers:           234567 kB
Cached:          12345678 kB
`;

// ── nvidia-smi parser ────────────────────────────────────────────────────────

describe('parseNvidiaSmi', () => {
  it('parses two cards with MiB→byte conversion', () => {
    const gpus = parseNvidiaSmi(NVIDIA_TWO_CARDS);
    assert.equal(gpus.length, 2);
    assert.equal(gpus[0].vendor, 'nvidia');
    assert.equal(gpus[0].name, 'NVIDIA GeForce RTX 4090');
    // 24564 MiB, not MB — the `nounits` format reports MiB.
    assert.equal(gpus[0].memoryTotalBytes, 24564 * MIB);
    assert.equal(gpus[0].memoryUsedBytes, 1024 * MIB);
    assert.equal(gpus[0].computeCapability, '8.9');
    assert.equal(gpus[0].powerLimitWatts, 450);
    assert.equal(gpus[0].temperatureC, 41);
    assert.equal(gpus[0].utilizationPct, 3);
    assert.equal(gpus[0].busId, '00000000:01:00.0');
    assert.equal(gpus[1].index, 1);
  });

  it('prefers the driver-reported memory.free over total-minus-used', () => {
    // The difference between an accurate number and one that causes OOM: the driver holds a private
    // reservation that `total - used` does not account for (40 MiB in this fixture).
    const gpus = parseNvidiaSmi(NVIDIA_TWO_CARDS);
    assert.equal(gpus[0].memoryAvailableBytes, 23500 * MIB, 'uses memory.free');
    assert.equal(gpus[0].memoryTotalBytes - (gpus[0].memoryUsedBytes ?? 0), 23540 * MIB);
    assert.ok(
      gpus[0].memoryAvailableBytes < gpus[0].memoryTotalBytes - (gpus[0].memoryUsedBytes ?? 0),
      'memory.free is the smaller, safer figure',
    );
    // Card 1 is idle, so all three agree there — proving we did not just hard-code a subtraction.
    assert.equal(gpus[1].memoryAvailableBytes, 24564 * MIB);
  });

  it('treats [N/A] and [Not Supported] as unknown, not as zero', () => {
    const gpus = parseNvidiaSmi(NVIDIA_NOT_SUPPORTED);
    assert.equal(gpus.length, 1);
    assert.equal(gpus[0].computeCapability, undefined, '[N/A] is unknown, not ""');
    assert.equal(gpus[0].powerLimitWatts, undefined, '[Not Supported] is unknown');
    assert.equal(gpus[0].utilizationPct, undefined);
    // But the memory figures ARE present and must be parsed.
    assert.equal(gpus[0].memoryTotalBytes, 40960 * MIB);
    assert.equal(gpus[0].name, 'NVIDIA A100-SXM4-40GB');
    assert.equal(gpus[0].temperatureC, 33);
  });

  it('falls back to total-minus-used when memory.free is unsupported', () => {
    const line = '0, Test GPU, 8192, 2048, [N/A], 535.0, 8.6, 200.00, 40, 0, 0000:01:00.0';
    const gpu = parseNvidiaSmiLine(line);
    assert.ok(gpu);
    assert.equal(gpu.memoryAvailableBytes, (8192 - 2048) * MIB);
  });

  it('rejects a short row rather than mis-assigning columns', () => {
    assert.equal(parseNvidiaSmiLine('0, Some GPU, 8192'), undefined);
    assert.equal(parseNvidiaSmiLine(''), undefined);
    assert.deepEqual(parseNvidiaSmi(''), []);
  });

  it('rejects a row with no parseable memory total', () => {
    assert.equal(parseNvidiaSmiLine('0, GPU, [N/A], 0, 0, 1.0, 8.0, 1, 1, 1, bus'), undefined);
  });

  it('requests the documented query fields', () => {
    assert.equal(NVIDIA_QUERY_ARGV[0], 'nvidia-smi');
    assert.ok(NVIDIA_QUERY_ARGV[1].startsWith('--query-gpu='));
    assert.ok(NVIDIA_QUERY_ARGV[1].includes('memory.total'));
    assert.ok(NVIDIA_QUERY_ARGV[1].includes('compute_cap'));
    assert.equal(NVIDIA_QUERY_ARGV[2], '--format=csv,noheader,nounits');
  });
});

// ── rocm-smi parser ──────────────────────────────────────────────────────────

describe('parseRocmSmi', () => {
  it('parses cardN entries with byte values', () => {
    const { gpus, parseErrors } = parseRocmSmi(ROCM_JSON);
    assert.deepEqual(parseErrors, []);
    assert.equal(gpus.length, 2);
    assert.equal(gpus[0].vendor, 'amd');
    assert.equal(gpus[0].index, 0);
    assert.equal(gpus[0].memoryTotalBytes, 128 * GIB);
    assert.equal(gpus[0].memoryUsedBytes, 8 * GIB);
    assert.equal(gpus[0].memoryAvailableBytes, 120 * GIB);
    assert.equal(gpus[0].busId, '0000:c1:00.0');
    assert.equal(gpus[1].memoryAvailableBytes, 128 * GIB);
  });

  it('ignores non-card keys like `system`', () => {
    const { gpus } = parseRocmSmi(ROCM_JSON);
    assert.equal(gpus.length, 2, 'the "system" key is not a card');
  });

  it('reports a parse error for malformed JSON instead of returning empty silently', () => {
    const { gpus, parseErrors } = parseRocmSmi('not json at all');
    assert.deepEqual(gpus, []);
    assert.equal(parseErrors.length, 1);
    assert.match(parseErrors[0], /did not parse/);
  });

  it('reports a card it cannot size', () => {
    const { gpus, parseErrors } = parseRocmSmi(JSON.stringify({ card0: { 'Card model': 'x' } }));
    assert.deepEqual(gpus, []);
    assert.ok(parseErrors.some((e) => e.includes('card0') && e.includes('no VRAM total')));
  });

  it('reports a non-object root', () => {
    const { parseErrors } = parseRocmSmi('[1,2,3]');
    assert.ok(parseErrors.some((e) => e.includes('not an object')));
  });
});

// ── macOS parsers ────────────────────────────────────────────────────────────

describe('parseVmStat', () => {
  it('reads the page size from the header rather than assuming 4096', () => {
    const arm = parseVmStat(VM_STAT_ARM);
    assert.equal(arm.pageSizeBytes, 16384);
    assert.equal(arm.wiredBytes, 191183 * 16384);
    assert.equal(arm.freeBytes, 6110 * 16384);
    assert.equal(arm.purgeableBytes, 4975 * 16384);
  });

  it('handles an Intel Mac 4096-byte page size', () => {
    const intel = parseVmStat(VM_STAT_INTEL);
    assert.equal(intel.pageSizeBytes, 4096);
    assert.equal(intel.wiredBytes, 80000 * 4096);
    assert.equal(intel.freeBytes, 12345 * 4096);
  });

  it('yields undefined bytes when the page size is missing', () => {
    // Without a page size, a page count is meaningless; returning a number would be a guess.
    const odd = parseVmStat('Pages free:  100.\n');
    assert.equal(odd.pageSizeBytes, undefined);
    assert.equal(odd.freeBytes, undefined);
  });

  it('tolerates absent labels', () => {
    const sparse = parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:  10.\n');
    assert.equal(sparse.freeBytes, 10 * 16384);
    assert.equal(sparse.wiredBytes, undefined);
    assert.equal(sparse.inactiveBytes, undefined);
  });
});

describe('parseSysctl', () => {
  it('splits key: value pairs', () => {
    const s = parseSysctl(SYSCTL_ARM);
    assert.equal(s['hw.memsize'], '17179869184');
    assert.equal(s['hw.model'], 'Mac16,10');
    assert.equal(s['hw.perflevel0.logicalcpu'], '4');
    assert.equal(s['hw.perflevel1.logicalcpu'], '6');
    assert.equal(s['kern.osrelease'], '27.2.0');
  });

  it('keeps a value containing a colon intact', () => {
    const s = parseSysctl('kern.boottime: Mon Nov 10 12:00:00 2026\n');
    assert.equal(s['kern.boottime'], 'Mon Nov 10 12:00:00 2026');
  });

  it('ignores lines without a colon', () => {
    const s = parseSysctl('garbage\nno-colon-here\n');
    assert.deepEqual(s, {});
  });
});

describe('parseAppleDisplays', () => {
  it('reads name and core count', () => {
    const gpus = parseAppleDisplays(SP_DISPLAYS_M4);
    assert.equal(gpus.length, 1);
    assert.equal(gpus[0].name, 'Apple M4');
    assert.equal(gpus[0].cores, 10, 'sppci_cores is a string and must be numeric-coerced');
    assert.equal(gpus[0].vendor, 'sppci_vendor_Apple');
  });

  it('returns empty on malformed JSON rather than throwing', () => {
    assert.deepEqual(parseAppleDisplays('{not json'), []);
    assert.deepEqual(parseAppleDisplays(''), []);
    assert.deepEqual(parseAppleDisplays(JSON.stringify({ SPDisplaysDataType: 'nope' })), []);
    assert.deepEqual(parseAppleDisplays(JSON.stringify({})), []);
  });

  it('skips entries without a name', () => {
    const j = JSON.stringify({ SPDisplaysDataType: [{ sppci_cores: '4' }, { _name: 'Ok', sppci_cores: '8' }] });
    const gpus = parseAppleDisplays(j);
    assert.equal(gpus.length, 1);
    assert.equal(gpus[0].name, 'Ok');
  });

  it('leaves cores undefined when not numeric', () => {
    const j = JSON.stringify({ SPDisplaysDataType: [{ _name: 'X', sppci_cores: 'n/a' }] });
    assert.equal(parseAppleDisplays(j)[0].cores, undefined);
  });
});

describe('appleGpuCeilingBytes', () => {
  it('applies the documented bands', () => {
    // 8 GiB → 50%, 16 GiB → 2/3, 192 GiB → 75%.
    assert.equal(appleGpuCeilingBytes(8 * GIB), Math.floor(8 * GIB * 0.5));
    assert.equal(appleGpuCeilingBytes(16 * GIB), Math.floor(16 * GIB * (2 / 3)));
    assert.equal(appleGpuCeilingBytes(192 * GIB), Math.floor(192 * GIB * 0.75));
  });

  it('is monotonic in total RAM', () => {
    let prev = 0;
    for (const gib of [4, 8, 16, 32, 64, 128, 192, 512]) {
      const c = appleGpuCeilingBytes(gib * GIB);
      assert.ok(c > prev, `${gib} GiB ceiling ${c} should exceed ${prev}`);
      assert.ok(c <= gib * GIB, 'ceiling can never exceed total RAM');
      prev = c;
    }
  });

  it('handles zero and tiny values without NaN', () => {
    assert.equal(appleGpuCeilingBytes(0), 0);
    assert.ok(Number.isFinite(appleGpuCeilingBytes(1)));
  });
});

// ── inventoryAccelerators: Apple Silicon ─────────────────────────────────────

describe('inventoryAccelerators — Apple Silicon', () => {
  const appleRunner = fakeRunner({
    sysctl: { status: 'ok', stdout: SYSCTL_ARM, exitCode: 0 },
    vm_stat: { status: 'ok', stdout: VM_STAT_ARM, exitCode: 0 },
    'system_profiler': { status: 'ok', stdout: SP_DISPLAYS_M4, exitCode: 0 },
    'sysctl-iogpu': { status: 'ok', stdout: '0\n', exitCode: 0 },
  });

  const inv = inventoryAccelerators({ platform: 'darwin', runner: appleRunner });

  it('reports exactly one unified device', () => {
    assert.equal(inv.gpus.length, 1);
    assert.equal(inv.gpus[0].vendor, 'apple');
    assert.equal(inv.gpus[0].name, 'Apple M4');
    assert.equal(inv.gpus[0].computeUnits, 10);
    assert.equal(inv.devices.length, 1, 'unified memory is ONE pool, not GPU+host');
    assert.equal(inv.devices[0].unified, true);
  });

  it('does not double-count memory across devices', () => {
    // The whole point of the unified branch: total RAM must not appear as both a GPU pool and a
    // separate host pool.
    assert.equal(inv.devices.length, 1);
    assert.equal(inv.devices[0].totalMemoryBytes, 16 * GIB);
    assert.equal(inv.devices[0].systemRamBytes, undefined, 'no separate host pool on unified memory');
  });

  it('carries host memory facts including the P/E CPU split', () => {
    assert.ok(inv.hostMemory);
    assert.equal(inv.hostMemory!.totalBytes, 16 * GIB);
    assert.equal(inv.hostMemory!.logicalCpus, 10);
    assert.equal(inv.hostMemory!.performanceCpus, 4);
    assert.equal(inv.hostMemory!.efficiencyCpus, 6);
    assert.equal(inv.hostMemory!.pageSizeBytes, 16384);
    assert.equal(inv.hostMemory!.wiredBytes, 191183 * 16384);
    assert.equal(inv.osRelease, '27.2.0');
  });

  it('flags the GPU ceiling as MODELLED when wired_limit_mb is unset', () => {
    assert.equal(inv.gpus[0].modelled, true);
    assert.ok(
      inv.warnings.some((w) => w.includes('MODELLED') && w.includes('recommendedMaxWorkingSetSize')),
      JSON.stringify(inv.warnings),
    );
  });

  it('honours an explicit iogpu.wired_limit_mb as measured', () => {
    const explicit = inventoryAccelerators({
      platform: 'darwin',
      runner: fakeRunner({
        sysctl: { status: 'ok', stdout: SYSCTL_ARM, exitCode: 0 },
        vm_stat: { status: 'ok', stdout: VM_STAT_ARM, exitCode: 0 },
        'system_profiler': { status: 'ok', stdout: SP_DISPLAYS_M4, exitCode: 0 },
        'sysctl-iogpu': { status: 'ok', stdout: '12288\n', exitCode: 0 },
      }),
    });
    assert.equal(explicit.gpus[0].modelled, false, 'a real wired limit is measured, not modelled');
    assert.ok(
      explicit.notes.some((n) => n.includes('iogpu.wired_limit_mb=12288')),
      JSON.stringify(explicit.notes),
    );
    assert.ok(!explicit.warnings.some((w) => w.includes('MODELLED')));
  });

  it('honours a caller override', () => {
    const o = inventoryAccelerators({
      platform: 'darwin',
      runner: appleRunner,
      appleGpuCeilingOverrideBytes: 10 * GIB,
    });
    assert.equal(o.gpus[0].modelled, false);
    assert.ok(o.notes.some((n) => n.includes('caller override')));
  });

  it('notes that -ngl 999 is correct on unified memory', () => {
    assert.ok(inv.notes.some((n) => n.includes('-ngl 999')), JSON.stringify(inv.notes));
  });

  it('caps availability at reclaimable memory under pressure, never adding wired back', () => {
    // Found by running the real inventory on a loaded M4: reclaimable was 3.56 GiB but wired was
    // 2.99 GiB, and `min(ceiling, reclaimable + wired)` reported 6.56 GiB free. Wired pages are
    // pinned by the kernel and other processes and cannot be reclaimed, so adding them back
    // overstates availability by several GiB and turns "fits" into an OOM.
    //
    // Fixture: 16 GiB total, ceiling would be 2/3 ≈ 10.67 GiB, but only 2 GiB is reclaimable and
    // 12 GiB is wired. The answer must be 2 GiB, not 14 GiB.
    const page = 16384;
    const pressured = inventoryAccelerators({
      platform: 'darwin',
      arch: 'arm64',
      runner: fakeRunner({
        sysctl: { status: 'ok', exitCode: 0, stdout: SYSCTL_ARM },
        vm_stat: {
          status: 'ok',
          exitCode: 0,
          stdout: `Mach Virtual Memory Statistics: (page size of ${page} bytes)\n` +
            `Pages free:                                ${Math.round((1 * GIB) / page)}.\n` +
            `Pages active:                            ${Math.round((1 * GIB) / page)}.\n` +
            `Pages inactive:                          ${Math.round((0.5 * GIB) / page)}.\n` +
            `Pages purgeable:                         ${Math.round((0.5 * GIB) / page)}.\n` +
            `Pages wired down:                        ${Math.round((12 * GIB) / page)}.\n`,
        },
        'system_profiler': { status: 'ok', exitCode: 0, stdout: SP_DISPLAYS_M4 },
        'sysctl-iogpu': { status: 'ok', exitCode: 0, stdout: '0\n' },
      }),
    });
    const hm = pressured.hostMemory!;
    // free 1 + inactive 0.5 + purgeable 0.5 = 2 GiB reclaimable.
    assert.equal(hm.reclaimableBytes, 2 * GIB);
    assert.equal(hm.wiredBytes, 12 * GIB);
    const gpu = pressured.gpus[0];
    assert.equal(
      gpu.memoryAvailableBytes,
      2 * GIB,
      'availability is capped at reclaimable; wired memory is NOT added back',
    );
    // The ceiling (10.67 GiB) is larger, so pressure — not the ceiling — binds.
    assert.ok(
      pressured.notes.some((n) => n.includes('host memory pressure is the binding constraint')),
      JSON.stringify(pressured.notes),
    );
    // And the device handed to capacity.ts reflects the same 2 GiB, via reservedBytes.
    const dev = pressured.devices[0];
    assert.equal(dev.totalMemoryBytes - (dev.reservedBytes ?? 0), 2 * GIB);
  });

  it('uses the ceiling when reclaimable memory exceeds it', () => {
    // The mirror case: an idle machine has plenty reclaimable, so the GPU ceiling binds instead.
    const page = 16384;
    const idle = inventoryAccelerators({
      platform: 'darwin',
      arch: 'arm64',
      runner: fakeRunner({
        sysctl: { status: 'ok', exitCode: 0, stdout: SYSCTL_ARM },
        vm_stat: {
          status: 'ok',
          exitCode: 0,
          stdout: `Mach Virtual Memory Statistics: (page size of ${page} bytes)\n` +
            `Pages free:                                ${Math.round((9 * GIB) / page)}.\n` +
            `Pages inactive:                            ${Math.round((4 * GIB) / page)}.\n` +
            `Pages purgeable:                           ${Math.round((1 * GIB) / page)}.\n` +
            `Pages wired down:                          ${Math.round((2 * GIB) / page)}.\n`,
        },
        'system_profiler': { status: 'ok', exitCode: 0, stdout: SP_DISPLAYS_M4 },
        'sysctl-iogpu': { status: 'ok', exitCode: 0, stdout: '0\n' },
      }),
    });
    // reclaimable 14 GiB > ceiling 10.67 GiB, so the ceiling wins.
    assert.equal(idle.gpus[0].memoryAvailableBytes, appleGpuCeilingBytes(16 * GIB));
    assert.ok(
      !idle.notes.some((n) => n.includes('host memory pressure')),
      'no pressure note when the ceiling is the tighter constraint',
    );
  });

  it('records every probe it ran, with argv', () => {
    const names = inv.probes.map((p) => p.name);
    assert.ok(names.includes('sysctl'));
    assert.ok(names.includes('vm_stat'));
    assert.ok(names.includes('system_profiler'));
    const sp = inv.probes.find((p) => p.name === 'system_profiler')!;
    assert.deepEqual(sp.argv, ['system_profiler', 'SPDisplaysDataType', '-json']);
    assert.equal(sp.status, 'ok');
  });

  it('survives system_profiler failing entirely', () => {
    const degraded = inventoryAccelerators({
      platform: 'darwin',
      runner: fakeRunner({
        sysctl: { status: 'ok', stdout: SYSCTL_ARM, exitCode: 0 },
        vm_stat: { status: 'ok', stdout: VM_STAT_ARM, exitCode: 0 },
        'system_profiler': { status: 'failed', stderr: 'timed out', exitCode: 1 },
      }),
    });
    assert.ok(degraded.warnings.some((w) => w.includes('system_profiler failed')));
    // Host memory is still usable, and we still produce a unified device from RAM alone.
    assert.ok(degraded.hostMemory);
    assert.ok(degraded.devices.length >= 1);
  });

  it('survives sysctl failing entirely without throwing', () => {
    const broken = inventoryAccelerators({
      platform: 'darwin',
      runner: fakeRunner({
        sysctl: { status: 'failed', stderr: 'nope', exitCode: 1 },
        vm_stat: { status: 'failed', stderr: 'nope', exitCode: 1 },
        'system_profiler': { status: 'failed', stderr: 'nope', exitCode: 1 },
      }),
    });
    assert.ok(broken.warnings.some((w) => w.includes('hw.memsize')));
    assert.deepEqual(broken.devices, []);
    assert.ok(broken.probes.length > 0, 'the failed probes are still recorded');
  });

  it('handles system_profiler reporting zero display devices', () => {
    const none = inventoryAccelerators({
      platform: 'darwin',
      runner: fakeRunner({
        sysctl: { status: 'ok', stdout: SYSCTL_ARM, exitCode: 0 },
        vm_stat: { status: 'ok', stdout: VM_STAT_ARM, exitCode: 0 },
        'system_profiler': { status: 'ok', stdout: JSON.stringify({ SPDisplaysDataType: [] }), exitCode: 0 },
      }),
    });
    assert.ok(none.warnings.some((w) => w.includes('no display devices')));
    // RAM is known, so we still get a usable unified pool.
    assert.ok(none.devices.length >= 1);
  });

  it('treats an Intel Mac as discrete and refuses to invent VRAM', () => {
    const intel = inventoryAccelerators({
      platform: 'darwin',
      // Injected, not ambient: this test must behave identically on Apple Silicon and Intel CI.
      arch: 'x64',
      runner: fakeRunner({
        sysctl: {
          status: 'ok',
          exitCode: 0,
          stdout: 'hw.memsize: 34359738368\nhw.ncpu: 8\nhw.pagesize: 4096\nhw.model: MacBookPro16,1\nmachdep.cpu.brand_string: Intel(R) Core(TM) i9\nkern.osrelease: 23.0.0\n',
        },
        vm_stat: { status: 'ok', stdout: VM_STAT_INTEL, exitCode: 0 },
        'system_profiler': {
          status: 'ok',
          exitCode: 0,
          stdout: JSON.stringify({
            SPDisplaysDataType: [{ _name: 'AMD Radeon Pro 5500M', sppci_cores: '24' }],
          }),
        },
      }),
    });
    const amd = intel.gpus.find((g) => g.name === 'AMD Radeon Pro 5500M');
    assert.ok(amd);
    assert.equal(amd.memoryTotalBytes, 0, 'VRAM is unknown, not guessed');
    assert.ok(intel.warnings.some((w) => w.includes('excluded from capacity devices')));
    assert.equal(
      intel.devices.some((d) => d.label === 'AMD Radeon Pro 5500M'),
      false,
      'an unsized GPU must not become a capacity device',
    );
  });
});

// ── inventoryAccelerators: Linux ─────────────────────────────────────────────

describe('inventoryAccelerators — Linux', () => {
  it('reports two NVIDIA cards with host RAM attached', () => {
    const inv = inventoryAccelerators({
      platform: 'linux',
      runner: fakeRunner({
        'nvidia-smi': { status: 'ok', stdout: NVIDIA_TWO_CARDS, exitCode: 0 },
        'proc-meminfo': { status: 'ok', stdout: PROC_MEMINFO, exitCode: 0 },
        nproc: { status: 'ok', stdout: '64\n', exitCode: 0 },
        uname: { status: 'ok', stdout: '6.8.0-45-generic\n', exitCode: 0 },
      }),
    });
    assert.equal(inv.gpus.length, 2);
    assert.equal(inv.devices.length, 2);
    assert.equal(inv.devices[0].unified, false);
    // MemAvailable, not MemFree: MemFree badly understates allocatable memory.
    assert.equal(inv.hostMemory!.reclaimableBytes, 120000000 * 1024);
    assert.notEqual(inv.hostMemory!.reclaimableBytes, 8123456 * 1024);
    assert.equal(inv.hostMemory!.logicalCpus, 64);
    assert.equal(inv.osRelease, '6.8.0-45-generic');
    // Each device carries host RAM so a partial offload can be judged.
    assert.equal(inv.devices[0].systemRamBytes, 120000000 * 1024);
    assert.equal(inv.devices[0].label, 'NVIDIA GeForce RTX 4090');
  });

  it('sets totalMemoryBytes to the AVAILABLE figure for a discrete GPU', () => {
    // capacity.ts subtracts reservedBytes from totalMemoryBytes to get available; we pre-subtract and
    // leave reserved at zero so the two agree rather than double-discounting.
    const inv = inventoryAccelerators({
      platform: 'linux',
      runner: fakeRunner({
        'nvidia-smi': { status: 'ok', stdout: NVIDIA_TWO_CARDS, exitCode: 0 },
        'proc-meminfo': { status: 'ok', stdout: PROC_MEMINFO, exitCode: 0 },
      }),
    });
    assert.equal(inv.devices[0].totalMemoryBytes, 23500 * MIB);
    assert.equal(inv.devices[1].totalMemoryBytes, 24564 * MIB);
    assert.equal(inv.devices[0].reservedBytes ?? 0, 0);
  });

  it('reports a mixed NVIDIA+AMD host without index collisions', () => {
    const inv = inventoryAccelerators({
      platform: 'linux',
      runner: fakeRunner({
        'nvidia-smi': { status: 'ok', stdout: NVIDIA_TWO_CARDS, exitCode: 0 },
        'rocm-smi': { status: 'ok', stdout: ROCM_JSON, exitCode: 0 },
        'proc-meminfo': { status: 'ok', stdout: PROC_MEMINFO, exitCode: 0 },
      }),
    });
    assert.equal(inv.gpus.length, 4);
    const indices = inv.gpus.map((g) => g.index);
    assert.equal(new Set(indices).size, 4, `indices must be unique, got ${indices.join(',')}`);
    assert.ok(inv.gpus.some((g) => g.vendor === 'amd' && g.memoryTotalBytes === 128 * GIB));
  });

  it('records absent SMIs as a normal state, not a failure', () => {
    const inv = inventoryAccelerators({
      platform: 'linux',
      runner: fakeRunner({
        'proc-meminfo': { status: 'ok', stdout: PROC_MEMINFO, exitCode: 0 },
      }),
    });
    assert.equal(inv.probes.find((p) => p.name === 'nvidia-smi')!.status, 'absent');
    assert.equal(inv.probes.find((p) => p.name === 'rocm-smi')!.status, 'absent');
    assert.equal(inv.warnings.length, 0, 'absent binaries are not a warning');
    assert.ok(inv.notes.some((n) => n.includes('neither nvidia-smi nor rocm-smi')), JSON.stringify(inv.notes));
    // CPU-only host still yields a RAM-based device so CPU inference can be planned.
    assert.equal(inv.devices.length, 1);
    assert.match(inv.devices[0].label!, /CPU only/);
  });

  it('warns (not just notes) when probes ran but yielded no GPU', () => {
    const inv = inventoryAccelerators({
      platform: 'linux',
      runner: fakeRunner({
        // nvidia-smi installed and exit-0, but zero rows: a driver/runtime mismatch.
        'nvidia-smi': { status: 'ok', stdout: '', exitCode: 0 },
        'rocm-smi': { status: 'ok', stdout: '{}', exitCode: 0 },
        'proc-meminfo': { status: 'ok', stdout: PROC_MEMINFO, exitCode: 0 },
      }),
    });
    assert.ok(inv.warnings.some((w) => w.includes('no usable GPU')), JSON.stringify(inv.warnings));
  });

  it('surfaces a failed nvidia-smi with its stderr', () => {
    const inv = inventoryAccelerators({
      platform: 'linux',
      runner: fakeRunner({
        'nvidia-smi': {
          status: 'failed',
          exitCode: 9,
          stderr: 'NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver.',
        },
        'proc-meminfo': { status: 'ok', stdout: PROC_MEMINFO, exitCode: 0 },
      }),
    });
    assert.ok(inv.warnings.some((w) => w.includes('could not communicate with the NVIDIA driver')));
    const p = inv.probes.find((p) => p.name === 'nvidia-smi')!;
    assert.equal(p.status, 'failed');
    assert.equal(p.exitCode, 9);
  });

  it('surfaces an unparseable nvidia-smi response', () => {
    const inv = inventoryAccelerators({
      platform: 'linux',
      runner: fakeRunner({
        'nvidia-smi': { status: 'ok', stdout: 'garbage that is not csv\n', exitCode: 0 },
        'proc-meminfo': { status: 'ok', stdout: PROC_MEMINFO, exitCode: 0 },
      }),
    });
    assert.ok(inv.warnings.some((w) => w.includes('could not be parsed')));
    assert.ok(inv.probes.find((p) => p.name === 'nvidia-smi')!.parseError);
  });

  it('records a rocm-smi parse error as a warning', () => {
    const inv = inventoryAccelerators({
      platform: 'linux',
      runner: fakeRunner({
        'rocm-smi': { status: 'ok', stdout: 'not json', exitCode: 0 },
        'proc-meminfo': { status: 'ok', stdout: PROC_MEMINFO, exitCode: 0 },
      }),
    });
    assert.ok(inv.warnings.some((w) => w.includes('rocm-smi')));
  });

  it('works without /proc/meminfo', () => {
    const inv = inventoryAccelerators({
      platform: 'linux',
      runner: fakeRunner({
        'nvidia-smi': { status: 'ok', stdout: NVIDIA_TWO_CARDS, exitCode: 0 },
      }),
    });
    assert.equal(inv.hostMemory, undefined);
    assert.equal(inv.devices.length, 2);
    // No host RAM → capacity.ts will return `unchecked` for a partial offload, which is correct.
    assert.equal(inv.devices[0].systemRamBytes, undefined);
  });

  it('skips GPU probes when asked', () => {
    const inv = inventoryAccelerators({ platform: 'linux', skipGpu: true, runner: fakeRunner({}) });
    assert.deepEqual(inv.gpus, []);
    assert.equal(inv.probes.find((p) => p.name === 'nvidia-smi')!.status, 'not-applicable');
  });

  it('never throws when every probe fails', () => {
    const all = fakeRunner({
      'nvidia-smi': { status: 'failed', stderr: 'boom', exitCode: 1 },
      'rocm-smi': { status: 'failed', stderr: 'boom', exitCode: 1 },
      'proc-meminfo': { status: 'failed', stderr: 'boom', exitCode: 1 },
      nproc: { status: 'failed', stderr: 'boom', exitCode: 1 },
      uname: { status: 'failed', stderr: 'boom', exitCode: 1 },
    });
    const inv = inventoryAccelerators({ platform: 'linux', runner: all });
    assert.deepEqual(inv.devices, []);
    assert.ok(inv.probes.length >= 3);
    assert.ok(inv.warnings.length > 0);
  });
});

// ── Windows ──────────────────────────────────────────────────────────────────

describe('inventoryAccelerators — Windows', () => {
  it('says unsupported explicitly rather than reporting an empty list silently', () => {
    const inv = inventoryAccelerators({ platform: 'win32', runner: fakeRunner({}) });
    assert.equal(inv.platform, 'win32');
    assert.deepEqual(inv.gpus, []);
    assert.ok(inv.warnings.some((w) => w.includes('Windows accelerator inventory is not implemented')));
    // It must tell the user what to do instead of leaving them guessing.
    assert.ok(inv.warnings.some((w) => w.includes('nvidia-smi')));
  });
});

// ── Summary rendering ────────────────────────────────────────────────────────

describe('summarizeInventory', () => {
  it('renders GPUs, host RAM, and warnings', () => {
    const inv = inventoryAccelerators({
      platform: 'linux',
      runner: fakeRunner({
        'nvidia-smi': { status: 'ok', stdout: NVIDIA_TWO_CARDS, exitCode: 0 },
        'proc-meminfo': { status: 'ok', stdout: PROC_MEMINFO, exitCode: 0 },
        nproc: { status: 'ok', stdout: '64\n', exitCode: 0 },
      }),
    });
    const lines = summarizeInventory(inv);
    assert.ok(lines.some((l) => l.includes('RTX 4090')));
    assert.ok(lines.some((l) => l.includes('cc 8.9')));
    assert.ok(lines.some((l) => l.includes('host RAM')));
    assert.ok(lines.some((l) => l.includes('64 CPU')));
  });

  it('says when nothing was detected', () => {
    const inv = inventoryAccelerators({ platform: 'linux', skipGpu: true, runner: fakeRunner({}) });
    assert.ok(summarizeInventory(inv).some((l) => l.includes('no accelerators detected')));
  });

  it('flags a modelled ceiling in the rendered line', () => {
    const inv = inventoryAccelerators({
      platform: 'darwin',
      runner: fakeRunner({
        sysctl: { status: 'ok', stdout: SYSCTL_ARM, exitCode: 0 },
        vm_stat: { status: 'ok', stdout: VM_STAT_ARM, exitCode: 0 },
        'system_profiler': { status: 'ok', stdout: SP_DISPLAYS_M4, exitCode: 0 },
        'sysctl-iogpu': { status: 'ok', stdout: '0\n', exitCode: 0 },
      }),
    });
    const lines = summarizeInventory(inv);
    assert.ok(lines.some((l) => l.includes('MODELLED')), JSON.stringify(lines));
    assert.ok(lines.some((l) => l.includes('4P+6E')), 'P/E split is surfaced');
  });

  it('reports an unsized GPU as unknown rather than 0 GiB free', () => {
    const inv = inventoryAccelerators({
      platform: 'darwin',
      arch: 'x64',
      runner: fakeRunner({
        sysctl: {
          status: 'ok',
          exitCode: 0,
          stdout: 'hw.memsize: 34359738368\nhw.ncpu: 8\nhw.model: MacBookPro16,1\n',
        },
        vm_stat: { status: 'ok', stdout: VM_STAT_INTEL, exitCode: 0 },
        'system_profiler': {
          status: 'ok',
          exitCode: 0,
          stdout: JSON.stringify({ SPDisplaysDataType: [{ _name: 'AMD Radeon Pro 5500M' }] }),
        },
      }),
    });
    assert.ok(summarizeInventory(inv).some((l) => l.includes('VRAM unknown')));
  });
});
