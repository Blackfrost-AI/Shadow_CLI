import { execFile } from 'node:child_process';

/** Best-effort browser launch. The URL is always printed too, so failure is not fatal. */
export function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], () => {});
    else if (process.platform === 'darwin') execFile('open', [url], () => {});
    else execFile('xdg-open', [url], () => {});
  } catch {
    /* the URL is printed too — the user can paste it */
  }
}
