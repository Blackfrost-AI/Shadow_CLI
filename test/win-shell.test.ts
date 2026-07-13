import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsPowerShell } from '../src/update/winShell.js';

// install.ps1 fails closed below PowerShell 7.1 (ECDSA verification needs .NET 5+), so the
// Windows self-update must spawn pwsh when it exists instead of the built-in 5.1 powershell.

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
