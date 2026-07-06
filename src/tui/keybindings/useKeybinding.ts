/**
 * React layer for the keybinding engine. `useKeybindings()` is called once by the
 * root screen; it loads the merged defaults+user config, hot-reloads on file
 * change, holds the handler registry + pending chord, and exposes a `consume()`
 * that the existing `useInput` handler calls FIRST.
 *
 * Resolution + dispatch model:
 *  - `match` with a registered handler → run it, return true (key consumed).
 *  - `match` with NO handler → return false so the legacy inline handler keeps
 *    working (this is what lets us migrate handlers incrementally without risk).
 *  - `chord_started` → swallow the key (don't type it), return true.
 *  - `chord_cancelled` / `none` → clear pending, return false (fall through).
 *
 * No React context/provider is required for the MVP: the root screen owns the one
 * engine instance and registers handlers via effects. A `useKeybinding(action, fn)`
 * per-component hook is the documented extension point once screens are split out.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fromInkKey, type InkKeyLike } from './match.js';
import { resolveAction } from './resolver.js';
import { initKeybindingsWatcher, loadKeybindingsSync } from './loader.js';
import type { Chord, ContextName, LoadedBindings } from './types.js';

export interface KeybindingApi {
  loaded: LoadedBindings;
  pending: React.RefObject<Chord>;
  handlers: React.RefObject<Map<string, () => void>>;
  /** Register a handler for an action id; returns a cleanup that unregisters it. */
  register: (action: string, handler: () => void) => () => void;
  /**
   * Resolve one keypress against the active contexts. Runs the matched handler if
   * one is registered. Returns true if the key was consumed (caller must not also
   * handle it); false to let the legacy path run.
   */
  consume: (input: string, key: InkKeyLike, contexts: readonly ContextName[]) => boolean;
}

export function useKeybindings(): KeybindingApi {
  const [loaded, setLoaded] = useState<LoadedBindings>(() => loadKeybindingsSync());
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;

  const handlers = useRef<Map<string, () => void>>(new Map());
  const pending = useRef<Chord>([]);

  useEffect(() => initKeybindingsWatcher((next) => {
    pending.current = [];
    setLoaded(next);
  }), []);

  const register = useCallback((action: string, handler: () => void) => {
    handlers.current.set(action, handler);
    return () => {
      // Only delete if still ours (a re-register replaced it).
      if (handlers.current.get(action) === handler) handlers.current.delete(action);
    };
  }, []);

  const consume = useCallback((input: string, key: InkKeyLike, contexts: readonly ContextName[]) => {
    const result = resolveAction(fromInkKey(input, key), contexts, loadedRef.current.bindings, pending.current);
    if (result.type === 'match') {
      pending.current = [];
      const h = handlers.current.get(result.action);
      if (h) {
        h();
        return true;
      }
      return false; // matched a binding but no handler migrated yet → fall through
    }
    if (result.type === 'chord_started') {
      pending.current = result.pending;
      return true; // swallow the prefix key so it isn't typed into the composer
    }
    if (result.type === 'chord_cancelled') {
      pending.current = [];
      return false; // let the cancelling char fall through
    }
    return false;
  }, []);

  return { loaded, pending, handlers, register, consume };
}
