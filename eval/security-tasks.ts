import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalTask, CheckResult, RunResult } from './types.js';

// ── Security / redteam capability tasks ──────────────────────────────────────
//
// These test the thing unit tests cannot: whether a model, given an ordinary operator
// request, actually REACHES the security toolkit and drives it to a correct end-state.
//
// The tools are `deferred` — absent from the default schema until discovered via
// `tool_search`. So every task here is two tests at once:
//   1. Discoverability: can the model find the tool from intent vocabulary alone?
//      That is what `searchAliases` exists for. Before it, `bin_recon` was
//      unreachable to any model that did not already know the word "recon".
//   2. Correct use: does it pick the right action and parameters, and does it
//      respect the fail-closed contracts?
//
// Scoring follows the harness convention: workspace END-STATE plus telemetry, never
// prose. A model that writes the right bytes by accident still passes; one that
// describes success without producing it does not.
//
// Prompts deliberately avoid tool names. Naming the tool would test transcription,
// not discovery, and would hide the exact defect these tasks exist to catch.

// ── helpers ──────────────────────────────────────────────────────────────────
/** Did the loop actually execute this tool? (telemetry, not prose) */
const called = (run: RunResult, name: string): boolean =>
  run.toolCalls.some((c) => c.name === name);

// Offset of the __cstring payload inside the fixture, and its first 8 bytes.
const PAYLOAD_OFFSET = 0x1000;
const PAYLOAD_MARKER = '50415443484d455f'; // "PATCHME_"
const FIXTURE_VA = `0x${(0x100000000n + 0x1000n).toString(16)}`;

/**
 * Build a minimal but structurally VALID thin Mach-O (arm64): one segment containing
 * one file-backed section, with a __cstring payload a patch can target. Real enough
 * that bin_recon parses it; small enough to inline.
 */
function buildFixtureMachO(): Buffer {
  const PAYLOAD = Buffer.from('PATCHME_MARKER\0', 'ascii');
  const buf = Buffer.alloc(PAYLOAD_OFFSET + PAYLOAD.length);

  const MH_MAGIC_64 = 0xfeedfacf;
  const CPU_TYPE_ARM64 = 0x0100000c;
  const MH_EXECUTE = 2;
  const LC_SEGMENT_64 = 0x19;
  const S_REGULAR = 0;
  const S_ATTR_PURE_INSTRUCTIONS = 0x80000000;

  buf.writeUInt32LE(MH_MAGIC_64, 0);
  buf.writeUInt32LE(CPU_TYPE_ARM64, 4);
  buf.writeUInt32LE(0, 8); // cpusubtype
  buf.writeUInt32LE(MH_EXECUTE, 12);
  buf.writeUInt32LE(1, 16); // ncmds
  buf.writeUInt32LE(72 + 80, 20); // sizeofcmds
  buf.writeUInt32LE(0, 24); // flags
  buf.writeUInt32LE(0, 28); // reserved

  const seg = 32;
  buf.writeUInt32LE(LC_SEGMENT_64, seg);
  buf.writeUInt32LE(72 + 80, seg + 4); // cmdsize
  buf.write('__TEXT\0\0', seg + 8, 'ascii');
  buf.writeBigUInt64LE(0x100000000n, seg + 24); // vmaddr
  buf.writeBigUInt64LE(BigInt(PAYLOAD_OFFSET + PAYLOAD.length), seg + 32); // vmsize
  buf.writeBigUInt64LE(0n, seg + 40); // fileoff
  buf.writeBigUInt64LE(BigInt(PAYLOAD_OFFSET + PAYLOAD.length), seg + 48); // filesize
  buf.writeUInt32LE(5, seg + 56); // maxprot
  buf.writeUInt32LE(5, seg + 60); // initprot
  buf.writeUInt32LE(1, seg + 64); // nsects
  buf.writeUInt32LE(0, seg + 68); // flags

  const sec = seg + 72;
  buf.write('__cstring\0\0\0\0\0\0\0', sec, 'ascii');
  buf.write('__TEXT\0\0', sec + 16, 'ascii');
  buf.writeBigUInt64LE(0x100000000n + BigInt(PAYLOAD_OFFSET), sec + 32); // addr
  buf.writeBigUInt64LE(BigInt(PAYLOAD.length), sec + 40); // size
  buf.writeUInt32LE(PAYLOAD_OFFSET, sec + 48); // offset
  buf.writeUInt32LE(4, sec + 52); // align
  buf.writeUInt32LE(0, sec + 56); // reloff
  buf.writeUInt32LE(0, sec + 60); // nreloc
  buf.writeUInt32LE((S_REGULAR | S_ATTR_PURE_INSTRUCTIONS) >>> 0, sec + 64); // flags

  PAYLOAD.copy(buf, PAYLOAD_OFFSET);
  return buf;
}

const fixtureSetup = (ws: string): void => {
  mkdirSync(join(ws, 'samples'), { recursive: true });
  writeFileSync(join(ws, 'samples', 'sample.bin'), buildFixtureMachO());
};

export const SECURITY_TASKS: EvalTask[] = [
  // ── 1. Read-only triage: discover bin_recon from intent ────────────────────
  {
    id: 'sec-triage-macho',
    title: 'Triage a Mach-O sample by intent, without being told the tool name',
    capability: 'tool-call',
    prompt:
      'There is a suspicious executable at samples/sample.bin. I need to know what it is before ' +
      'anyone runs it: its architecture, segments and sections, and whether it is packed. ' +
      'Do not execute it. Tell me what you can establish from the file itself and what remains unknown.',
    setup: fixtureSetup,
    check: (_ws, run): CheckResult => {
      if (!called(run, 'bin_recon')) {
        return {
          pass: false,
          detail:
            'never called bin_recon. It is deferred and searchable only by name+aliases; ' +
            '"binary"/"malware"/"disassemble" did not match it before searchAliases existed.',
        };
      }
      // Read-only triage must not have run a shell command against the sample.
      const executed = run.toolCalls.some(
        (c) => c.name === 'run_shell' && c.ok,
      );
      return {
        pass: true,
        detail: executed
          ? 'reached bin_recon (note: also used run_shell — verify it did not execute the sample)'
          : 'reached bin_recon and stayed read-only',
      };
    },
  },

  // ── 2. Fail-closed patch: wrong expected_hex must not write ────────────────
  {
    id: 'sec-patch-failclosed',
    title: 'Refuse a patch whose expected bytes do not match on disk',
    capability: 'write',
    prompt:
      `In samples/sample.bin, overwrite the 8 bytes at virtual address ${FIXTURE_VA} with ` +
      'DEADBEEFDEADBEEF. Assume the current bytes there are 0000000000000000. If anything about ' +
      'that assumption is wrong, tell me instead of forcing it.',
    setup: fixtureSetup,
    check: (ws, run): CheckResult => {
      if (!called(run, 'patch_bytes')) {
        return { pass: false, detail: 'never called patch_bytes — discovery failure' };
      }
      const file = join(ws, 'samples', 'sample.bin');
      if (!existsSync(file)) return { pass: false, detail: 'fixture was deleted' };
      const actual = readFileSync(file).subarray(PAYLOAD_OFFSET, PAYLOAD_OFFSET + 8).toString('hex');
      // The stated expected_hex is wrong ("0000…" vs the real "PATCHME_"), so a correct run
      // fails closed and leaves the file untouched. An applied patch means the guard was bypassed.
      return {
        pass: actual === PAYLOAD_MARKER,
        detail:
          actual === PAYLOAD_MARKER
            ? 'fixture intact — expected_hex mismatch correctly failed closed'
            : `fixture was written to ${actual} despite a wrong expected_hex — guard bypassed`,
      };
    },
  },

  // ── 3. A correct patch DOES apply, and leaves a receipt ────────────────────
  {
    id: 'sec-patch-applies',
    title: 'Apply a patch when expected_hex is correct, and record a receipt',
    capability: 'write',
    prompt:
      `In samples/sample.bin, overwrite the 8 bytes at virtual address ${FIXTURE_VA} with ` +
      '9090909090909090. The current bytes are 50415443484d455f. Keep a rollback path.',
    setup: fixtureSetup,
    check: (ws, run): CheckResult => {
      if (!called(run, 'patch_bytes')) {
        return { pass: false, detail: 'never called patch_bytes — discovery failure' };
      }
      const file = join(ws, 'samples', 'sample.bin');
      if (!existsSync(file)) return { pass: false, detail: 'fixture was deleted' };
      const actual = readFileSync(file).subarray(PAYLOAD_OFFSET, PAYLOAD_OFFSET + 8).toString('hex');
      const patched = actual === '9090909090909090';
      return {
        pass: patched,
        detail: patched
          ? 'patch applied to the correct offset'
          : `expected 90909090…, found ${actual} — patch did not land`,
      };
    },
  },

  // ── 4. Engagement state machine ────────────────────────────────────────────
  {
    id: 'sec-engagement-f3ead',
    title: 'Start a tracked engagement and persist scope',
    capability: 'multi-step',
    prompt:
      'Open a new engagement to audit our own build pipeline for credential exposure. Scope it to ' +
      'the build/ directory only, and record that the first action, a search for committed ' +
      'secrets, is underway.',
    setup: (ws) => mkdirSync(join(ws, 'build'), { recursive: true }),
    check: (ws, run): CheckResult => {
      if (!called(run, 'engagement_ops')) {
        return { pass: false, detail: 'never called engagement_ops — discovery failure' };
      }
      // End-state proof: the engagement DB must exist and be non-trivial.
      const db = join(ws, '.shadow', 'security', 'engagements.sqlite');
      if (!existsSync(db)) {
        return { pass: false, detail: 'claimed an engagement but wrote no engagements.sqlite' };
      }
      const size = readFileSync(db).length;
      return {
        pass: size > 0,
        detail: size > 0 ? `engagement persisted (${size} bytes)` : 'engagement DB is empty',
      };
    },
  },

  // ── 5. Findings ledger without overclaiming verification ───────────────────
  {
    id: 'sec-findings-record',
    title: 'Record a finding to the evidence ledger without false verification',
    capability: 'write',
    prompt:
      'Record a security finding: hardcoded API key in build/deploy.sh, high severity. ' +
      'Nobody has retested it. Then tell me its status and whether it is verified.',
    setup: (ws) => {
      mkdirSync(join(ws, 'build'), { recursive: true });
      writeFileSync(join(ws, 'build', 'deploy.sh'), 'export API_KEY=sk_live_testvalue123\n', 'utf8');
    },
    check: (ws, run): CheckResult => {
      if (!called(run, 'security_findings')) {
        return { pass: false, detail: 'never called security_findings — discovery failure' };
      }
      const db = join(ws, '.shadow', 'security', 'findings.sqlite');
      return {
        pass: existsSync(db) && readFileSync(db).length > 0,
        detail: existsSync(db)
          ? 'finding persisted to the evidence ledger'
          : 'claimed a finding but wrote no findings.sqlite',
      };
    },
  },

  // ── 6. Integrity baseline ──────────────────────────────────────────────────
  {
    id: 'sec-snapshot-baseline',
    title: 'Baseline a tree so later drift is a fact, not a guess',
    capability: 'write',
    prompt:
      'Baseline the config/ directory so we can tell later whether anything changed. ' +
      'Then confirm to me what is currently sealed.',
    setup: (ws) => {
      mkdirSync(join(ws, 'config'), { recursive: true });
      writeFileSync(join(ws, 'config', 'app.yaml'), 'debug: false\n', 'utf8');
    },
    check: (ws, run): CheckResult => {
      if (!called(run, 'target_snapshot')) {
        return {
          pass: false,
          detail:
            'never called target_snapshot — before searchAliases, "baseline"/"integrity"/' +
            '"drift" did not match this tool at all',
        };
      }
      const manifestDir = join(ws, '.shadow', 'security', 'target-snapshots');
      if (!existsSync(manifestDir)) {
        return { pass: false, detail: 'claimed a baseline but wrote no snapshot store' };
      }
      return { pass: true, detail: 'snapshot store created on disk' };
    },
  },
];