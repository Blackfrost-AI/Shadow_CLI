// DEC synchronized-output (private mode 2026) wrapper for the Ink render stream.
//
// Ink repaints the live region by writing a full frame to stdout on each render. On a terminal that
// paints incrementally (notably tmux 3.4+), a viewer can catch a half-drawn frame — the flicker /
// "glitch" you see during redraws and resizes. Bracketing a frame in BSU (`ESC [ ? 2026 h`) …
// ESU (`ESC [ ? 2026 l`) tells the terminal to buffer the changes and flip them ATOMICALLY, so a
// frame is never shown half-drawn. the reference client enabled exactly this to fix tmux flicker (CHANGELOG
// 2.1.200). Terminals without 2026 support silently ignore the private-mode escapes, so it is a
// no-op there — and `SHADOW_NO_SYNC_OUTPUT=1` disables it entirely as a safety hatch.
//
// COALESCING: an Ink frame is not one write — the renderer issues several (clear-lines, the frame,
// cursor moves) back-to-back in the same tick. Bracketing EACH write opened and closed the
// synchronized section 3× per frame, so the terminal flipped 3 half-frames anyway and the wrapper
// bought nothing but escape overhead. The section now opens on the first write of a tick and
// closes on the next event-loop iteration (setImmediate), so every synchronous batch of writes —
// one Ink frame, a frame plus its cursor bookkeeping — lands inside ONE atomic flip. Content is
// never buffered or delayed: only the ESU is deferred (~0ms, next loop iteration), which is the
// usage the DEC spec itself describes (begin … many outputs … end).

import { writeSync } from 'node:fs';

const BSU = '\x1b[?2026h';
const ESU = '\x1b[?2026l';

// The process-wide open section (one in practice: the app wraps a single stdout). Tracked at module
// level so the exit guard — installed once — can close whichever section is open, and so a second
// proxy (only possible in tests) politely closes the first before opening its own: a terminal can
// be in only one synchronized section at a time.
interface OpenSection {
  close: () => void;
}
let openSection: OpenSection | null = null;
let exitGuardInstalled = false;

/** Close any open section at process exit — leaving the terminal inside an unclosed BSU would
 *  freeze its output for every program that runs after us. writeSync because 'exit' handlers run
 *  after the event loop is torn down (stream writes may never flush). */
function installExitGuard(): void {
  if (exitGuardInstalled) return;
  exitGuardInstalled = true;
  process.once('exit', () => {
    if (openSection) {
      try {
        writeSync(1, ESU);
      } catch {
        // stdout already gone — nothing left to unfreeze.
      }
    }
  });
}

/**
 * Return a stdout proxy that wraps writes in synchronized-output brackets, one bracket per event-loop
 * tick of writes (see COALESCING above). All other properties/methods (columns, rows, `on('resize')`,
 * isTTY, …) delegate straight to the real stream, so Ink is unaffected apart from atomic frames.
 * When `SHADOW_NO_SYNC_OUTPUT` is set, the real stream is returned unchanged.
 */
export function withSynchronizedOutput(out: NodeJS.WriteStream): NodeJS.WriteStream {
  if (process.env.SHADOW_NO_SYNC_OUTPUT) return out;
  let mine = false; // this proxy's section is the one currently open
  let closer: NodeJS.Immediate | null = null;
  const close = (): void => {
    if (closer) {
      clearImmediate(closer);
      closer = null;
    }
    if (mine) {
      mine = false;
      if (openSection && openSection.close === close) openSection = null;
      (out.write as (...a: unknown[]) => boolean)(ESU);
    }
  };
  return new Proxy(out, {
    get(target, prop) {
      if (prop === 'write') {
        return (chunk: unknown, ...rest: unknown[]) => {
          if (typeof chunk !== 'string' || chunk.length === 0) {
            return (target.write as (...a: unknown[]) => boolean)(chunk, ...rest);
          }
          if (!mine) {
            if (openSection) openSection.close(); // never two sections at once
            installExitGuard();
            mine = true;
            openSection = { close };
            if (!closer) closer = setImmediate(close);
            return (target.write as (...a: unknown[]) => boolean)(BSU + chunk, ...rest);
          }
          if (!closer) closer = setImmediate(close);
          return (target.write as (...a: unknown[]) => boolean)(chunk, ...rest);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
