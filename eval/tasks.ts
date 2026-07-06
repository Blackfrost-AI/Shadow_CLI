import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalTask, CheckResult } from './types.js';

// ── helpers ───────────────────────────────────────────────────────────────────
const write = (ws: string, rel: string, content: string): void =>
  writeFileSync(join(ws, rel), content, 'utf8');
const readMaybe = (ws: string, rel: string): string | null => {
  const p = join(ws, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
};
const norm = (s: string | null): string => (s ?? '').replace(/\s+/g, ' ').trim();
const pass = (detail: string): CheckResult => ({ pass: true, detail });
const fail = (detail: string): CheckResult => ({ pass: false, detail });
const usedTool = (run: { toolCalls: { name: string }[] }, ...names: string[]): boolean =>
  run.toolCalls.some((t) => names.includes(t.name));

/**
 * The standard suite — increasing difficulty across the core harness capabilities.
 * Each task is self-contained: it seeds its own workspace and scores by the
 * observable end-state, so it works identically against any model.
 */
export const TASKS: EvalTask[] = [
  // 1. Can it call a tool at all and use the result?
  {
    id: 'read-file',
    title: 'Read a file and report a value from it',
    capability: 'tool-call',
    prompt: 'Read the file secret.txt in this directory and tell me the marker value it contains.',
    setup: (ws) => write(ws, 'secret.txt', 'The marker value is MARKER-7731. Keep it safe.\n'),
    check: (ws, run) => {
      const sawMarker = /MARKER-7731/.test(run.stdout);
      const calledRead = usedTool(run, 'read_file');
      if (sawMarker && calledRead) return pass('read_file used; marker surfaced');
      return fail(`marker in output=${sawMarker}, read_file called=${calledRead}`);
    },
  },

  // 2. Multi-step: search, then act on the result.
  {
    id: 'top-score',
    title: 'Search across files, report the winner',
    capability: 'multi-step',
    // Replaces the old count-todos task: "count TODO lines across all files" proved a poor
    // discriminator — models built fragile find/extension-whitelists (miss .md/.txt) or grepped
    // recursively into the harness's own session log, so the graded number was noise, not skill.
    // This task searches + COMPARES to a single unambiguous winner: deterministic and robust.
    prompt:
      'Each .txt file in this directory has a line of the form "score=<number>". Find the file with the ' +
      'highest score and write just that file\'s name (for example: b.txt) to winner.dat.',
    setup: (ws) => {
      write(ws, 'alpha.txt', 'name: alpha\nscore=42\n');
      write(ws, 'bravo.txt', 'name: bravo\nscore=97\n'); // highest
      write(ws, 'charlie.txt', 'name: charlie\nscore=15\n');
      write(ws, 'delta.txt', 'name: delta\nscore=88\n');
    },
    check: (ws, run) => {
      const got = norm(readMaybe(ws, 'winner.dat'));
      if (got === 'bravo.txt' || got === 'bravo') return pass(`winner.dat == ${got} (bravo, score 97)`);
      const searched = usedTool(run, 'grep', 'run_shell', 'glob', 'read_file');
      return fail(`winner.dat="${got}" (expected bravo.txt); used a search tool=${searched}`);
    },
  },

  // 3. Write a file with exact content.
  {
    id: 'write-file',
    title: 'Create a file with exact content',
    capability: 'write',
    prompt: 'Create a file named hello.txt whose entire contents are exactly: hello world',
    setup: () => {},
    check: (ws) => {
      const got = norm(readMaybe(ws, 'hello.txt'));
      return got === 'hello world' ? pass('hello.txt == "hello world"') : fail(`hello.txt="${got}"`);
    },
  },

  // 4. Exact-string edit (read-before-edit + uniqueness).
  {
    id: 'edit-config',
    title: 'Edit one value in a file',
    capability: 'edit',
    prompt: 'In config.js, change the port from 3000 to 8080. Leave everything else unchanged.',
    setup: (ws) =>
      write(ws, 'config.js', 'export const config = {\n  host: "localhost",\n  port: 3000,\n};\n'),
    check: (ws, run) => {
      const txt = readMaybe(ws, 'config.js') ?? '';
      const ok = /\bport:\s*8080\b/.test(txt) && !/3000/.test(txt);
      const edited = usedTool(run, 'edit_file', 'write_file');
      return ok ? pass('port is 8080, 3000 gone') : fail(`edited=${edited}; file now: ${norm(txt).slice(0, 80)}`);
    },
  },

  // 5. Shell to produce an outcome.
  {
    id: 'shell-count',
    title: 'Use the shell to compute, write the result',
    capability: 'shell',
    prompt:
      'Count how many files in this directory have a .txt extension, and write just that number to result.dat.',
    setup: (ws) => {
      write(ws, 'one.txt', '1');
      write(ws, 'two.txt', '2');
      write(ws, 'three.txt', '3');
      write(ws, 'readme.md', 'not a txt'); // 3 .txt files; result.dat is not .txt
    },
    check: (ws, run) => {
      const got = norm(readMaybe(ws, 'result.dat'));
      if (got === '3') return pass('result.dat == 3');
      return fail(`result.dat="${got}" (expected 3); ran_shell=${usedTool(run, 'run_shell')}`);
    },
  },

  // 6. Error recovery: the obvious edit fails (non-unique), model must adapt.
  {
    id: 'error-recovery',
    title: 'Recover from a failed edit (non-unique match)',
    capability: 'error-recovery',
    prompt: 'In app.js, rename every occurrence of the identifier oldName to newName.',
    setup: (ws) =>
      write(
        ws,
        'app.js',
        'function oldName() { return 1; }\nconst y = oldName();\nexport { oldName };\n', // 3 occurrences
      ),
    check: (ws, run) => {
      const txt = readMaybe(ws, 'app.js') ?? '';
      const renamed = !/oldName/.test(txt) && (txt.match(/newName/g) ?? []).length >= 3;
      const hadError = run.errors > 0 || run.toolCalls.some((t) => !t.ok);
      if (renamed)
        return pass(`all renamed${hadError ? ' (recovered from a failed attempt)' : ''}`);
      return fail(`oldName still present or <3 newName; file: ${norm(txt).slice(0, 80)}`);
    },
  },

  // 7. Completion discipline: answer directly, no needless tools, clean stop.
  {
    id: 'no-needless-tools',
    title: 'Answer a trivial question without tools and stop',
    capability: 'completion',
    prompt: 'What is 7 multiplied by 6? Answer in one short sentence. Do not use any tools.',
    setup: () => {},
    check: (_ws, run) => {
      const answered = /\b42\b/.test(run.stdout);
      const noTools = run.toolCalls.length === 0;
      const cleanStop = run.stopReason === 'end_turn';
      if (answered && noTools && cleanStop) return pass('answered 42, no tools, end_turn');
      return fail(`answered42=${answered}, tools=${run.toolCalls.length}, stop=${run.stopReason}`);
    },
  },

  // 8. Compaction: prove the model keeps driving the loop DESPITE auto-summarization firing.
  //    Compaction engages only when BOTH hold: the transcript exceeds contextBudget*triggerRatio
  //    AND there are more than keepLastTurns (6) turns to collapse. A flat "read 5 files" task
  //    fails the second — models batch the reads into 2-3 turns, so nothing is ever old enough to
  //    summarize (that's why compaction NEVER fired here before — a false green for years). A
  //    breadcrumb CHAIN fixes both: each file names the next, so reads CAN'T be batched (you don't
  //    know the next filename until you read the current one) → one turn per step → many turns;
  //    padded bodies push tokens over budget. The chain is SELF-CORRECTING (the current file always
  //    says what's next), so it isolates the thing we mean to test — does the model stay on task
  //    after its history is summarized — instead of also leaning on flaky mental arithmetic (an
  //    earlier "sum the numbers" version failed every model by double-counting re-read files). The
  //    check verifies compaction ACTUALLY fired (the loop's `compaction` bus event), not just the
  //    answer.
  {
    id: 'compaction-sum',
    title: 'Stay on task across a compaction boundary',
    capability: 'compaction',
    prompt:
      'Start by reading alpha.txt. Each file names the next file to read. Keep following the chain, ' +
      'reading one file after another, until you reach a file that has no next file — it contains a ' +
      'final instruction. Do exactly what that final file tells you to do.',
    // ~350 tok/turn against a 3.5k budget → the transcript crosses budget*0.75 in the back half of
    // the 8-step chain and keeps re-summarizing, so the model must keep following across summaries.
    contextBudget: 3500,
    maxIterations: 30,
    setup: (ws) => {
      // Digit-free padding (~350 tokens/turn); the 8-step chain guarantees enough turns to cross
      // keepLastTurns so summarization actually engages.
      const pad = 'This paragraph is padding whose only purpose is to grow the running transcript so that automatic context compaction is exercised partway through this chain rather than never. '.repeat(4);
      const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
      names.forEach((name, idx) => {
        const body =
          idx + 1 < names.length
            ? `The next file to read is ${names[idx + 1]}.txt.`
            : 'This is the end of the chain. Write the single word SWORDFISH (nothing else) to a file named answer.dat.';
        write(ws, `${name}.txt`, `${pad}\n${body}\n${pad}\n`);
      });
    },
    check: (ws, run) => {
      const got = norm(readMaybe(ws, 'answer.dat'));
      if (got.toUpperCase() !== 'SWORDFISH')
        return fail(`answer.dat="${got}" (expected SWORDFISH); iterations=${run.iterations}, stop=${run.stopReason}, compactions=${run.compactions}`);
      // The right answer is necessary but NOT sufficient: this task exists to prove the model
      // finishes DESPITE compaction. If compaction never fired, the run didn't exercise it —
      // surface that instead of a false green. (Requires the loop's `compaction` bus event.)
      if (run.compactions < 1)
        return fail(`answer.dat correct but compaction never fired (compactions=0) — chain too short/small to exercise it`);
      return pass(`followed the chain to SWORDFISH across ${run.compactions} compaction(s)`);
    },
  },
];

/** Codex/Grok-shaped dialect checks — foreign tool names normalized by the harness. */
export const DIALECT_TASKS: EvalTask[] = [
  {
    id: 'dialect-shell-command',
    title: 'Accept shell_command + working_directory alias',
    capability: 'dialect',
    prompt: 'Use shell_command with working_directory set to this directory and command "echo DIALECT-OK > dialect-ok.txt".',
    setup: () => {},
    check: (ws, run) => {
      const got = norm(readMaybe(ws, 'dialect-ok.txt'));
      const usedShell = run.toolCalls.some((t) => t.name === 'run_shell' || t.name === 'shell_command');
      if (got.includes('DIALECT-OK') && usedShell) return pass('shell_command dialect ok');
      return fail(`file="${got}" shell=${usedShell}`);
    },
  },
  {
    id: 'dialect-update-plan',
    title: 'Accept update_plan alias mapping to todo_write',
    capability: 'dialect',
    prompt: 'Call update_plan with two items: "alpha" in_progress and "beta" pending.',
    setup: () => {},
    check: (_ws, run) => {
      const used = run.toolCalls.some((t) => t.name === 'todo_write' || t.name === 'update_plan');
      return used ? pass('update_plan dialect invoked') : fail('no update_plan/todo_write call');
    },
  },
];
