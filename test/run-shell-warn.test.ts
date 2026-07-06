import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uninterruptibleReason, looksLikePowerShell } from '../src/tools/runShell.js';

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
