// m-4: the Ink-side shell-escape hook, extracted under src/tui/ per the structural line
// budget (plan 2.4). The composer routes only a typed /! prefix here; the shared core
// rejects empty/paste/multiline payloads and busy state before any lock is taken, then
// dispatches through the full execution-policy pipeline via opts.runNativeTool. One
// dispatch, no retries; ESC aborts through controllerRef like any running turn.

import { useCallback, useEffect, useRef } from 'react';
import { runShellEscape } from './shellEscape.js';
import { C } from './theme.js';
import { runLock, CLI_HOLDER } from '../web/runLock.js';
import type { ToolResult } from '../tools/types.js';

interface Ref<T> { current: T }

export interface UseShellEscapeArgs {
  opts: {
    runNativeTool?: (name: string, input: unknown, signal: AbortSignal, parentBudget: never) => Promise<ToolResult<unknown>>;
  };
  pushLine: (line: { text: string; kind?: 'error' | 'system'; color?: string; dimColor?: boolean }) => void;
  setRunning: (v: boolean) => void;
  setLine: (s: string) => void;
  runningRef: Ref<boolean>;
  compactingRef: Ref<boolean>;
  modelSwitchingRef: Ref<boolean>;
  asyncCommandRef: Ref<boolean>;
  inputRef: Ref<string>;
  runStartRef: Ref<number>;
  interruptionReportedRef: Ref<boolean>;
  controllerRef: Ref<AbortController | null>;
  flushQueueRef: Ref<(() => void) | null>;
  makeBudget: () => unknown;
}

export function useShellEscape(args: UseShellEscapeArgs): (raw: string) => void {
  const { opts, pushLine, setRunning, setLine, makeBudget } = args;
  const shellEscapeRef = useRef<((raw: string) => void) | null>(null);
  const shellEscape = useCallback(async (raw: string): Promise<void> => {
    if (!opts.runNativeTool) {
      pushLine({ text: '  Shell escape is unavailable in this session.', dimColor: true });
      return;
    }
    try {
      await runShellEscape({
        busy: () => args.runningRef.current || args.compactingRef.current || args.modelSwitchingRef.current || args.asyncCommandRef.current,
        errorLine: (text) => pushLine({ text: `  ${text}`, color: C.yellow }),
        outcomeLine: (text, ok) => pushLine({ kind: 'system', text: `  ${text}`, color: ok ? C.green : C.yellow }),
        clearComposer: () => { if (args.inputRef.current.trim()) setLine(''); },
        armAbort: (controller) => {
          // Live-turn state goes live before the lock, mirroring runOne's acquisition seam:
          // the abort path can then unwind as a clean early return outside the try below.
          args.runStartRef.current = Date.now();
          args.interruptionReportedRef.current = false;
          args.runningRef.current = true;
          setRunning(true);
          args.controllerRef.current = controller;
        },
        acquireLock: (signal) => runLock.acquire(CLI_HOLDER, { priority: true, signal }),
        runNativeTool: async (name, input, signal, budget) => {
          if (!opts.runNativeTool) throw new Error('Shell escape is unavailable in this session.');
          return opts.runNativeTool(name, input, signal, budget as never);
        },
        newBudget: () => makeBudget(),
      }, raw);
    } catch (error) {
      pushLine({ kind: 'error', text: `  ! ${(error as Error).message}`, color: C.red });
    } finally {
      // Mirror runOne's lock-rejection unwind: controller out, state down, queue drained.
      args.controllerRef.current = null;
      args.runningRef.current = false;
      setRunning(false);
      args.flushQueueRef.current?.();
    }
  }, [opts, pushLine, setRunning, setLine, makeBudget]);
  // Late-bound dispatch seam: the SlashCtx object is assembled during render before this hook
  // exists; it dereferences the ref at dispatch time (mirrors startTurnRef).
  useEffect(() => { shellEscapeRef.current = (raw) => { void shellEscape(raw); }; });
  return (raw: string) => { shellEscapeRef.current?.(raw); };
}
