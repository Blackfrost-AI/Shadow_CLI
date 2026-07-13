import { execFileSync } from 'node:child_process';

/**
 * Resolve which PowerShell to spawn for the Windows binary self-update.
 * install.ps1 verifies the release signature with .NET 5+ ECDSA APIs (ImportFromPem +
 * DSASignatureFormat) and FAILS CLOSED below PowerShell 7.1 — but the built-in `powershell`
 * is 5.1, so a hardcoded spawn broke every Windows self-update even with PS7 installed.
 * Prefer `pwsh` whenever it's on PATH; the 5.1 fallback still reaches install.ps1's own
 * actionable "requires PowerShell 7.1+" abort rather than failing silently.
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
