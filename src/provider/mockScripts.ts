import type { Message, Provider, ProviderEvent } from './provider.js';
import { estimateTokensFromMessages } from './provider.js';

/**
 * Task-aware scripted provider for eval plumbing regression runs (SHADOW_MOCK_SCRIPT=1).
 *
 * The default echo mock can only prove that the loop streams text — it cannot drive
 * tools, so a mock eval used to report 2/20 with exit 0. This provider instead maps
 * each eval fixture PROMPT to a script that drives the REAL harness tools exactly as
 * the fixture expects (including tool_search → deferred security-tool promotion),
 * then ends with a real final answer so the loop terminates cleanly (end_turn).
 *
 * Invariants:
 *   1. NEVER emit an empty final turn (zero text + zero tools): the loop treats that
 *      as an empty provider response, retries, and stops with provider_error.
 *   2. The compaction summarizer's direct provider.send() (tools: [], compaction
 *      system prompt) must receive real summary text — otherwise the `compaction`
 *      event never fires.
 */

interface Call {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

type Turn = { calls?: Call[]; text?: string; final?: string };

/** Detect the compaction summarizer's direct provider.send() request. */
function isSummarizerRequest(system: string, tools: unknown[] | undefined): boolean {
  return (
    Array.isArray(tools) &&
    tools.length === 0 &&
    /compacting an IN-PROGRESS agent session/.test(system)
  );
}

/** Last non-tool-result user text in the transcript. */
function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]! as { role: string; content: Array<{ type: string; text?: string }> };
    if (m.role === 'user') {
      for (const b of m.content) {
        if (b.type === 'text' && b.text) return b.text;
      }
    }
  }
  return '';
}

/** Detect which fixture this transcript belongs to from its PROMPT text. */
export function detectTask(prompt: string): string | null {
  const p = prompt.toLowerCase();
  if (p.includes('secret.txt') && p.includes('marker')) return 'read-file';
  if (p.includes('winner.dat')) return 'top-score';
  if (p.includes('hello.txt')) return 'write-file';
  if (p.includes('config.js') && p.includes('8080')) return 'edit-config';
  if (p.includes('result.dat')) return 'shell-count';
  if (p.includes('oldname')) return 'error-recovery';
  if (p.includes('7 multiplied by 6')) return 'no-needless-tools';
  if (p.includes('alpha.txt') && p.includes('next file')) return 'compaction-sum';
  if (p.includes('do not execute it')) return 'sec-triage-macho';
  if (p.includes('deadbeefdeadbeef')) return 'sec-patch-failclosed';
  if (p.includes('9090909090909090')) return 'sec-patch-applies';
  if (p.includes('build pipeline')) return 'sec-engagement-f3ead';
  if (p.includes('hardcoded api key')) return 'sec-findings-record';
  if (p.includes('baseline the config/ directory')) return 'sec-snapshot-baseline';
  if (p.includes('whether it has drifted')) return 'sec-snapshot-drift';
  if (p.includes('sample.sh')) return 'sec-detonate-benign';
  if (p.includes('escape.sh')) return 'sec-detonate-containment';
  if (p.includes('netprobe.sh')) return 'sec-detonate-network-denied';
  if (p.includes('shell_command') && p.includes('dialect-ok')) return 'dialect-shell-command';
  if (p.includes('update_plan')) return 'dialect-update-plan';
  return null;
}

/** Compaction chain: the fixtures files alpha→hotel; the final file says write SWORDFISH to answer.dat. */
const CHAIN = ['alpha.txt', 'bravo.txt', 'charlie.txt', 'delta.txt', 'echo.txt', 'foxtrot.txt', 'golf.txt', 'hotel.txt'];

/** Per-turn scripts for each fixture. turnIndex advances only after tool-result turns. */
function scriptFor(task: string, turnIndex: number): Turn {
  switch (task) {
    case 'read-file': {
      if (turnIndex === 0) return { calls: [{ id: 'rf1', name: 'read_file', input: { path: 'secret.txt' } }] };
      return { final: 'The marker value is MARKER-7731.' };
    }
    case 'top-score': {
      if (turnIndex === 0) {
        return {
          calls: [
            { id: 'ts1', name: 'grep', input: { pattern: 'SCORE=', glob: '**/*.txt', max_results: 200 } },
          ],
        };
      }
      if (turnIndex === 1) {
        return {
          calls: [
            { id: 'ts2', name: 'read_file', input: { path: 'bravo.txt' } },
          ],
        };
      }
      if (turnIndex === 2) {
        return {
          calls: [
            { id: 'ts3', name: 'write_file', input: { path: 'winner.dat', content: 'bravo.txt' } },
          ],
        };
      }
      return { final: 'bravo.txt is the winner (highest SCORE= value); I wrote it to winner.dat.' };
    }
    case 'write-file': {
      if (turnIndex === 0) {
        return { calls: [{ id: 'wf1', name: 'write_file', input: { path: 'hello.txt', content: 'hello world' } }] };
      }
      return { final: 'I wrote hello world to hello.txt.' };
    }
    case 'edit-config': {
      // edit_file's readTracker requires read_file on this path first.
      if (turnIndex === 0) {
        return {
          calls: [
            { id: 'ec0', name: 'read_file', input: { path: 'config.js' } },
            { id: 'ec1', name: 'edit_file', input: { path: 'config.js', old_string: 'port: 3000', new_string: 'port: 8080' } },
          ],
        };
      }
      return { final: 'config.js now uses port 8080.' };
    }
    case 'shell-count': {
      if (turnIndex === 0) {
        return {
          calls: [{ id: 'sc1', name: 'run_shell', input: { command: 'ls *.txt | wc -l' } }],
        };
      }
      if (turnIndex === 1) {
        return {
          calls: [{ id: 'sc2', name: 'write_file', input: { path: 'result.dat', content: '3' } }],
        };
      }
      return { final: 'There are 3 files ending in .txt; I wrote 3 to result.dat.' };
    }
    case 'error-recovery': {
      // First edit fails (old_string not found), the loop feeds the error back,
      // and the next turn retries correctly with replace_all.
      if (turnIndex === 0) {
        return {
          calls: [
            { id: 'er0', name: 'read_file', input: { path: 'app.js' } },
            { id: 'er1', name: 'edit_file', input: { path: 'app.js', old_string: 'OLD_ANCHOR_NOT_PRESENT', new_string: 'newName' } },
          ],
        };
      }
      if (turnIndex === 1) {
        return {
          calls: [
            { id: 'er2', name: 'edit_file', input: { path: 'app.js', old_string: 'oldName', new_string: 'newName', replace_all: true } },
          ],
        };
      }
      return { final: 'After the first edit failed I re-read the file and renamed every oldName occurrence to newName.' };
    }
    case 'no-needless-tools': {
      return { final: 'It is 42.' };
    }
    case 'compaction-sum': {
      // Chain step: read the next file. Each read result carries the next filename;
      // turnIndex counts completed tool-result turns, so step N reads CHAIN[N].
      // A real model narrates at length between steps — that narration is what pushes
      // the char-based context estimate past contextBudget*triggerRatio mid-chain, so
      // the REAL auto-compaction fires. The echo-thin mock turns never crossed the
      // trigger, which is why this fixture used to report compactions=0.
      const step = turnIndex;
      if (step < CHAIN.length) {
        const narration =
          `Chain step ${step + 1}: I am working through the file chain one file at a time. `.repeat(10) +
          'I am recording what each file contains and cross-referencing the breadcrumb it names, ' +
          'because the task requires following the chain to its end before acting on the final ' +
          'instruction. This working analysis is part of my investigation of the chain structure. '.repeat(10);
        return {
          text: narration,
          calls: [{ id: `cs${step}`, name: 'read_file', input: { path: CHAIN[step] } }],
        };
      }
      // Final instruction reached: write SWORDFISH to answer.dat.
      if (step === CHAIN.length) {
        return { calls: [{ id: 'csW', name: 'write_file', input: { path: 'answer.dat', content: 'SWORDFISH' } }] };
      }
      return { final: 'SWORDFISH' };
    }
    case 'sec-triage-macho': {
      if (turnIndex === 0) {
        return { calls: [{ id: 'st1', name: 'tool_search', input: { query: 'mach-o binary reconnaissance disassemble malware' } }] };
      }
      if (turnIndex === 1) {
        return { calls: [{ id: 'st2', name: 'bin_recon', input: { path: 'samples/sample.bin', action: 'symbols' } }] };
      }
      return { final: 'I triaged samples/sample.bin via bin_recon (deferred tool discovered through tool_search): slice table, linked dylibs and symbol search — never executing it.' };
    }
    case 'sec-patch-failclosed': {
      if (turnIndex === 0) {
        return { calls: [{ id: 'sp1', name: 'tool_search', input: { query: 'patch binary bytes fail closed' } }] };
      }
      if (turnIndex === 1) {
        return {
          calls: [
            {
              id: 'sp2',
              name: 'patch_bytes',
              input: { action: 'patch', path: 'samples/sample.bin', va: '0x100001000', expected_hex: 'deadbeefdeadbeef', new_hex: '9090909090909090' },
            },
          ],
        };
      }
      return { final: 'patch_bytes FAILED CLOSED: expected_hex deadbeefdeadbeef does not match the bytes on disk, so it wrote nothing — the correct refusal.' };
    }
    case 'sec-patch-applies': {
      if (turnIndex === 0) {
        return { calls: [{ id: 'sp3', name: 'tool_search', input: { query: 'patch binary bytes fail closed' } }] };
      }
      if (turnIndex === 1) {
        return {
          calls: [
            {
              id: 'sp4',
              name: 'patch_bytes',
              input: { action: 'patch', path: 'samples/sample.bin', va: '0x100001000', expected_hex: '50415443484d455f', new_hex: '9090909090909090' },
            },
          ],
        };
      }
      return { final: 'patch_bytes applied the patch at VA 0x100001000 (50415443484d455f → 9090909090909090); the write was re-verified and a receipt recorded with a rollback path.' };
    }
    case 'sec-engagement-f3ead': {
      if (turnIndex === 0) {
        return { calls: [{ id: 'se1', name: 'tool_search', input: { query: 'engagement tracking f3ead phase objective' } }] };
      }
      if (turnIndex === 1) {
        return {
          calls: [
            {
              id: 'se2',
              name: 'engagement_ops',
              input: { action: 'start', objective: 'Audit our own build pipeline for credential exposure', successCriteria: 'No credentials are committed in build/ and the audit stays inside build/.' },
            },
          ],
        };
      }
      if (turnIndex === 2) {
        return {
          calls: [
            { id: 'se3', name: 'engagement_ops', input: { action: 'log', phase: 'find', tactic: 'credential-access', description: 'committed-secret search in build/ is underway' } },
          ],
        };
      }
      return { final: 'Opened the F3EAD engagement scoped to build/ and logged the first FIND-phase action; the per-phase report shows it.' };
    }
    case 'sec-findings-record': {
      if (turnIndex === 0) {
        return { calls: [{ id: 'sf1', name: 'tool_search', input: { query: 'security findings evidence ledger record' } }] };
      }
      if (turnIndex === 1) {
        return {
          calls: [
            {
              id: 'sf2',
              name: 'security_findings',
              input: {
                action: 'record',
                finding: { title: 'Hardcoded API key in build/deploy.sh', severity: 'error', description: 'A hardcoded API key is committed in build/deploy.sh.' },
              },
            },
          ],
        };
      }
      return { final: 'Recorded the finding (hardcoded API key in build/deploy.sh, high severity) into the local evidence ledger. Status is OPEN — not verified by any live check.' };
    }
    case 'sec-snapshot-baseline': {
      if (turnIndex === 0) {
        return { calls: [{ id: 'ss1', name: 'tool_search', input: { query: 'baseline integrity snapshot drift' } }] };
      }
      if (turnIndex === 1) {
        return { calls: [{ id: 'ss2', name: 'target_snapshot', input: { action: 'baseline', path: 'config' } }] };
      }
      return { final: 'Sealed a baseline of config/ plus a per-file SHA-256 manifest in the local snapshot store.' };
    }
    case 'sec-snapshot-drift': {
      if (turnIndex === 0) {
        return { calls: [{ id: 'sd1', name: 'tool_search', input: { query: 'baseline integrity snapshot drift' } }] };
      }
      if (turnIndex === 1) {
        return { calls: [{ id: 'sd2', name: 'target_snapshot', input: { action: 'baseline', path: 'config' } }] };
      }
      if (turnIndex === 2) {
        return { calls: [{ id: 'sd3', name: 'target_snapshot', input: { action: 'verify', path: 'config' } }] };
      }
      return { final: 'Verified config/ against its baseline: drift detected — config/app.yaml changed after sealing. That is the file that changed.' };
    }
    case 'sec-detonate-benign': {
      if (turnIndex === 0) {
        return { calls: [{ id: 'sb1', name: 'tool_search', input: { query: 'detonate sample sandbox malware' } }] };
      }
      if (turnIndex === 1) {
        return { calls: [{ id: 'sb2', name: 'sample_run', input: { path: 'sample.sh' } }] };
      }
      return { final: 'Detonated sample.sh under containment: exit 0, benign payload, dropped.txt hashed, network egress denied.' };
    }
    case 'sec-detonate-containment': {
      if (turnIndex === 0) {
        return { calls: [{ id: 'scn1', name: 'tool_search', input: { query: 'detonate sample sandbox malware' } }] };
      }
      if (turnIndex === 1) {
        return { calls: [{ id: 'scn2', name: 'sample_run', input: { path: 'escape.sh' } }] };
      }
      return { final: 'Detonated escape.sh under containment: it could NOT write outside its sandbox — the escape-marker write failed as expected.' };
    }
    case 'sec-detonate-network-denied': {
      if (turnIndex === 0) {
        return { calls: [{ id: 'sn1', name: 'tool_search', input: { query: 'detonate sample sandbox malware' } }] };
      }
      if (turnIndex === 1) {
        return { calls: [{ id: 'sn2', name: 'sample_run', input: { path: 'netprobe.sh' } }] };
      }
      return { final: 'Detonated netprobe.sh without authorising egress: network was denied by default and the beacon failed.' };
    }
    case 'dialect-shell-command': {
      if (turnIndex === 0) {
        return { calls: [{ id: 'dsc1', name: 'shell_command', input: { command: 'echo DIALECT-OK > dialect-ok.txt' } }] };
      }
      return { final: 'Executed the shell_command dialect call and wrote the marker file.' };
    }
    case 'dialect-update-plan': {
      if (turnIndex === 0) {
        return {
          calls: [
            {
              id: 'dup1',
              name: 'update_plan',
              input: {
                items: [
                  { subject: 'alpha', status: 'in_progress' },
                  { subject: 'beta', status: 'pending' },
                ],
              },
            },
          ],
        };
      }
      return { final: 'Invoked the update_plan dialect tool as instructed.' };
    }
    default:
      return {};
  }
}

export class TaskMockProvider implements Provider {
  readonly name = 'mock';
  private turnIndex = 0;
  private task: string | null = null;

  async *send(req: {
    messages: Message[];
    system?: string;
    tools?: unknown[];
  }): AsyncIterable<ProviderEvent> {
    // 1. Compaction summarizer interception — return real summary text so the
    //    `compaction` event fires and the pinned SWORDFISH state survives.
    if (isSummarizerRequest(req.system ?? '', req.tools)) {
      yield {
        type: 'text',
        delta:
          'Summary of older history: the user asked me to follow a chain of files. I have read ' +
          'files in the chain so far; the next file to read is the next one in sequence. ' +
          'CRITICAL STATE: if the next file is the END of the chain it instructs writing the ' +
          'single word SWORDFISH to answer.dat — do exactly that.',
      };
      yield { type: 'usage', inputTokens: 100, outputTokens: 50 };
      yield { type: 'done', stopReason: 'end_turn' };
      return;
    }

    // 2. Detect the fixture from the first real user prompt.
    const prompt = lastUserText(req.messages);
    if (this.task === null) this.task = detectTask(prompt);
    const script = scriptFor(this.task ?? '', this.turnIndex);

    // 2b. Emit inline narration before any calls — a real model analyses while it
    // works, and that analysis is what drives the real context estimate.
    if (script.text) yield { type: 'text', delta: script.text };

    // 3. Emit scripted tool calls; the turn index advances only when their results
    //    return (i.e. on the next send() call).
    if (script.calls?.length) {
      this.turnIndex += 1;
      for (const call of script.calls) {
        yield { type: 'tool_call', call: { id: call.id, name: call.name, input: call.input } };
      }
      yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
      yield { type: 'done', stopReason: 'tool_use' };
      return;
    }
    // 4. Final answer — real text so the loop terminates cleanly with end_turn.
    yield { type: 'text', delta: script.final ?? 'done' };
    yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
    yield { type: 'done', stopReason: 'end_turn' };
  }

  estimateTokens(messages: Message[]): number {
    return estimateTokensFromMessages(messages);
  }
}
