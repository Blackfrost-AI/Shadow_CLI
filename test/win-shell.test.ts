import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsPowerShell } from '../src/update/winShell.js';

// Legacy shell selection prefers pwsh when present. The installer also supports stock
// PowerShell 5.1, and current standalone self-update does not spawn either shell.

test('prefers pwsh when the PATH probe finds it', () => {
  const probed: string[][] = [];
  const sh = windowsPowerShell((cmd, args) => {
    probed.push([cmd, ...args]);
    return '';
  });
  assert.equal(sh, 'pwsh');
  assert.deepEqual(probed, [['where.exe', 'pwsh']]);
});

test('falls back to powershell when pwsh is not on PATH', () => {
  const sh = windowsPowerShell(() => {
    throw new Error('not found');
  });
  assert.equal(sh, 'powershell');
});

test('default probe never throws on a machine without where.exe', () => {
  // On macOS/Linux where.exe does not exist — the helper must swallow that and fall back.
  assert.ok(['pwsh', 'powershell'].includes(windowsPowerShell()));
});
