import { execFile } from 'node:child_process';

/**
 * Best-effort browser launch. The URL is always printed too, so failure is not fatal.
 *
 * NOTE on the token: the launch URL carries the session token in its fragment, and passing it
 * here puts it in this child process's ARGV — visible to any other local user via `ps`. That is
 * accepted rather than fixed: on a single-user machine it is not a boundary, the token is
 * short-lived and loopback-only, and the alternatives (a temp-file handoff, a clipboard hop) are
 * each worse in their own way. `shadow web --no-open` skips the launch entirely and just prints
 * the URL, which is the escape hatch for a shared box.
 */
export function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], () => {});
    else if (process.platform === 'darwin') execFile('open', [url], () => {});
    else execFile('xdg-open', [url], () => {});
  } catch {
    /* the URL is printed too — the user can paste it */
  }
}
