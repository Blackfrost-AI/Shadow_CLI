// DEC synchronized-output (private mode 2026) wrapper for the Ink render stream.
//
// Ink repaints the live region by writing a full frame to stdout on each render. On a terminal that
// paints incrementally (notably tmux 3.4+), a viewer can catch a half-drawn frame — the flicker /
// "glitch" you see during redraws and resizes. Bracketing each frame in BSU (`ESC [ ? 2026 h`) …
// ESU (`ESC [ ? 2026 l`) tells the terminal to buffer the changes and flip them ATOMICALLY, so a
// frame is never shown half-drawn. Claude Code enabled exactly this to fix tmux flicker (CHANGELOG
// 2.1.200). Terminals without 2026 support silently ignore the private-mode escapes, so it is a
// no-op there — and `SHADOW_NO_SYNC_OUTPUT=1` disables it entirely as a safety hatch.

const BSU = '\x1b[?2026h';
const ESU = '\x1b[?2026l';

/**
 * Return a stdout proxy that wraps every string `write()` in synchronized-output brackets. All other
 * properties/methods (columns, rows, `on('resize')`, isTTY, …) delegate straight to the real stream,
 * so Ink is unaffected apart from atomic frames. When `SHADOW_NO_SYNC_OUTPUT` is set, the real stream
 * is returned unchanged.
 */
export function withSynchronizedOutput(out: NodeJS.WriteStream): NodeJS.WriteStream {
  if (process.env.SHADOW_NO_SYNC_OUTPUT) return out;
  return new Proxy(out, {
    get(target, prop) {
      if (prop === 'write') {
        return (chunk: unknown, ...rest: unknown[]) =>
          typeof chunk === 'string' && chunk.length > 0
            ? (target.write as (...a: unknown[]) => boolean)(BSU + chunk + ESU, ...rest)
            : (target.write as (...a: unknown[]) => boolean)(chunk, ...rest);
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
