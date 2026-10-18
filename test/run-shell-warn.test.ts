import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uninterruptibleReason, invokesPrivilegeEscalation, looksLikePowerShell } from '../src/tools/runShell.js';

test('looksLikePowerShell flags PowerShell on a POSIX host, not POSIX commands', () => {
  // flagged — IS pwsh or IS a cmdlet
  assert.equal(looksLikePowerShell("pwsh -Command 'ls /home'"), true);
  assert.equal(looksLikePowerShell('powershell -c "ls"'), true);
  assert.equal(looksLikePowerShell('Get-ChildItem /home/turd'), true);
  assert.equal(looksLikePowerShell('  Remove-Item foo.txt'), true);
  // NOT flagged — ordinary POSIX commands (incl. a Verb-Noun-looking arg)
  assert.equal(looksLikePowerShell('ls -la "/home/turd/Documents/Claude Projects"'), false);
  assert.equal(looksLikePowerShell('grep -r foo .'), false);
  assert.equal(looksLikePowerShell('git status'), false);
  assert.equal(looksLikePowerShell('find . -name Test-Foo'), false); // Verb-Noun as an arg, not the command
});

test('uninterruptibleReason flags commands that can survive ESC', () => {
  assert.match(uninterruptibleReason('sudo nmap -sV 10.0.0.1')!, /root/);
  assert.match(uninterruptibleReason('doas reboot')!, /root/);
  assert.match(uninterruptibleReason('echo hi && sudo rm x')!, /root/); // sudo after &&
  assert.match(uninterruptibleReason('setsid ./daemon.sh')!, /session/);
  assert.match(uninterruptibleReason('nohup python server.py')!, /nohup/);
  assert.match(uninterruptibleReason('./long-task.sh &')!, /background/);
});

test('uninterruptibleReason returns null for ordinary commands', () => {
  assert.equal(uninterruptibleReason('ls -la /tmp'), null);
  assert.equal(uninterruptibleReason('grep -r foo .'), null);
  assert.equal(uninterruptibleReason('echo sudoku'), null); // "sudo" not a standalone command
  assert.equal(uninterruptibleReason('git commit -m "x & y"'), null); // & inside a quoted arg, not trailing
});

// Regression: the old start-anchored regex matched the WORD sudo/doas/nohup anywhere it began a
// token — inside quoted arguments, grep patterns, file paths, heredoc bodies — so read-only
// commands that merely *mention* sudo were falsely reported as unkillable root processes.
test('uninterruptibleReason ignores sudo/nohup that are DATA, not commands', () => {
  const benign = [
    'git commit -m "sudo: fix the warning"',
    'git log --grep=sudo -n 5',
    "grep -rn 'sudo ' src/",
    'echo "run sudo make install"',
    'printf "nohup x\\n"',
    'rg "setsid" docs/',
    'cat src/docs/doas.md',
    'ls /usr/share/doc/sudo',
    './scripts/check-sudo.sh',
    'sed -n "/sudo/p" /etc/passwd',
    'python3 -c \'print("sudo")\'',
    'git commit -m @\' fix: sudo warning\n\nbody mentions doas and nohup\n\'@',
    'cat <<EOF > notes.md\nsudo make install\nnohup ./svc &\nEOF',
    'diff <(sed -n 1,20p a) <(sed -n 1,20p b)',
    'echo hi 2>&1 | tee log.txt',
    'FOO=sudo-bar ./x --flag "sudo"',
  ];
  for (const cmd of benign) {
    assert.equal(uninterruptibleReason(cmd), null, `false positive on: ${cmd}`);
    assert.equal(invokesPrivilegeEscalation(cmd), false, `invokesPrivilegeEscalation false positive on: ${cmd}`);
  }
});

test('uninterruptibleReason still catches sudo behind prefixes, pipelines and subshells', () => {
  assert.match(uninterruptibleReason('time sudo nmap -sV 10.0.0.1')!, /root/);
  assert.match(uninterruptibleReason('env FOO=1 sudo reboot')!, /root/);
  assert.match(uninterruptibleReason('nice -n 10 sudo -E x')!, /root/);
  assert.match(uninterruptibleReason('if sudo -n true; then echo ok; fi')!, /root/);
  assert.match(uninterruptibleReason('(cd / && sudo rm -rf build)')!, /root/);
  assert.match(uninterruptibleReason('find . -name "*.tmp" | xargs sudo rm -f')!, /root/);
  assert.match(uninterruptibleReason('echo password | sudo -S reboot')!, /root/);
  assert.match(uninterruptibleReason('sh -c "sudo reboot"')!, /root/);
  assert.match(uninterruptibleReason('echo "wrapped: $(sudo id -u)"')!, /root/); // inside double quotes
  assert.match(uninterruptibleReason('/usr/bin/sudo reboot')!, /root/);
  assert.match(uninterruptibleReason('pkexec reboot')!, /root/);
  assert.match(uninterruptibleReason('true && nohup ./svc &')!, /nohup|background/);
});

test('the root warning is suppressed when Shadow itself runs as root', () => {
  // Root Shadow can signal root children, so privilege escalation is not unkillable.
  assert.equal(uninterruptibleReason('sudo reboot', { shadowIsRoot: true }), null);
  // Detachment has nothing to do with uid and must still be reported.
  assert.match(uninterruptibleReason('nohup ./svc', { shadowIsRoot: true })!, /nohup/);
  assert.match(uninterruptibleReason('./svc &', { shadowIsRoot: true })!, /background/);
  // And non-root still warns.
  assert.match(uninterruptibleReason('sudo reboot', { shadowIsRoot: false })!, /root/);
});
