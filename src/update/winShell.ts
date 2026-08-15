import { execFileSync } from 'node:child_process';

/**
 * Resolve which PowerShell to spawn for the Windows binary self-update.
 * Prefer `pwsh` (PowerShell 7+) whenever it's on PATH — it verifies via ImportFromPem.
 * The built-in `powershell` (5.1) fallback is also fully supported: install.ps1 verifies
 * the same ECDSA-P256 signature on 5.1 via .NET Framework 4.7+'s native ECDSA (since
 * v6.14.0; before that, 5.1 aborted and pwsh was the only working runtime).
 */
export function windowsPowerShell(
  probe: (cmd: string, args: string[]) => unknown = (cmd, args) =>
    execFileSync(cmd, args, { stdio: 'ignore' }),
): string {
  try {
    probe('where.exe', ['pwsh']);
    return 'pwsh';
  } catch {
    return 'powershell';
  }
}
