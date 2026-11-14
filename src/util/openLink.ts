/**
 * Open a clicked hyperlink in the operator's default browser.
 *
 * The vendored pi-tui engine hit-tests OSC 8 hyperlinks on mouse release and calls the
 * host-supplied `openUrl` callback (tui-alt-screen `openUrl` option). Shadow wires that
 * callback here. This is a USER-initiated action on a link the operator clicked — not
 * telemetry and not an agent-driven fetch — so it bypasses the egress broker by design,
 * exactly like the image viewer's `saveAndOpen` (termImage.ts) opens Preview.app.
 *
 * Safety: only http/https URLs are opened. The URL is passed as a single argv element to
 * `open` (macOS) / `xdg-open` (Linux) with no shell, so there is no command-injection
 * surface even for a hostile OSC 8 target. Anything else (file://, javascript:, custom
 * schemes, malformed) is refused.
 */
import { spawn } from 'node:child_process';

/** True only for well-formed http/https URLs. */
export function isOpenableUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Open `url` in the default browser. Returns true when a launcher was spawned, false when
 * the URL was refused or the platform is unsupported. Fire-and-forget: the child is
 * detached and unref'd so it never keeps the TUI process alive, and spawn errors are
 * swallowed (a missing xdg-open must not crash the renderer).
 */
export function openExternalUrl(url: string): boolean {
  if (!isOpenableUrl(url)) return false;
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null;
  if (!cmd) return false;
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}