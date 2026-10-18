/**
 * Waterfall chains — in-process middleware with short-circuit, wrap, and rewrite.
 *
 * Adapted from DeepSeek Harness (`deepseek-ai/deepseek-harness`), MIT License, which models hook
 * listeners as a continuation chain rather than a flat list of side effects. Copyright (c) DeepSeek.
 * See THIRD_PARTY_NOTICES.md.
 *
 * WHY NOT THE FLAT RUNNER
 * -----------------------
 * `hooks/runner.ts` is right for what it does: run external scripts, collect verdicts, block or
 * contribute context. It is the wrong shape for anything that has to *transform* a value on its way
 * through, because a flat loop can only append — it cannot express "rewrite this tool result",
 * "skip the remaining steps", or "do work on both sides of the inner call".
 *
 * A waterfall composes listeners around a value with an explicit `next()`:
 *
 *   short-circuit   return without calling next() → the inner steps never run
 *   wrap            `await next()` then post-process → work on both sides (timing, redaction)
 *   rewrite         `next(transformed)` → the rest of the chain sees a different value
 *
 * That is exactly what a security harness needs: a redaction pass that rewrites a tool result
 * before the model sees it, an audit step that wraps every call with a receipt, or a policy step
 * that refuses to continue. None of those are expressible as "append some context".
 *
 * INVARIANTS
 * ----------
 * - A listener that never calls `next()` terminates the chain. That is the short-circuit, and it
 *   is deliberate: forgetting `next()` must fail toward *less* execution, never toward silently
 *   running the rest of the pipeline unguarded.
 * - Calling `next()` twice is idempotent — the downstream chain runs once and both calls observe
 *   the same result. Middleware that forgets a `return` is common; letting it double-apply a
 *   side effect (two writes, two audit records) is the kind of bug that only shows up in production.
 * - A throwing listener propagates, annotated with its position, so a broken step is identifiable
 *   rather than looking like a failure of the whole chain.
 */

/** The continuation handed to every listener: run the rest of the chain. */
export type WaterfallNext<T> = (value?: T) => Promise<T>;

/** One chain step. Receives the current value, context, and the continuation. */
export type WaterfallListener<T, C = unknown> = (
  value: T,
  ctx: C,
  next: WaterfallNext<T>,
) => Promise<T> | T;

interface Entry<T, C> {
  name: string;
  listener: WaterfallListener<T, C>;
}

/**
 * An ordered chain of transform listeners.
 *
 * Instances are cheap and meant to be long-lived: register once at startup, `run()` per value.
 */
export class WaterfallChain<T, C = unknown> {
  private readonly entries: Entry<T, C>[] = [];

  /**
   * Append a listener. Returns an unsubscribe function so a caller (or a test) can remove exactly
   * the step it added without rebuilding the chain.
   */
  use(name: string, listener: WaterfallListener<T, C>): () => void {
    const entry: Entry<T, C> = { name, listener };
    this.entries.push(entry);
    return () => {
      const i = this.entries.indexOf(entry);
      if (i >= 0) this.entries.splice(i, 1);
    };
  }

  /** Number of registered listeners (for diagnostics). */
  get size(): number {
    return this.entries.length;
  }

  /** Listener names in execution order — a readable trace for a doctor/status surface. */
  names(): string[] {
    return this.entries.map((e) => e.name);
  }

  /**
   * Run `value` through the chain.
   *
   * With no listeners this is the identity function, which keeps every call site free of a
   * "is anything registered?" branch.
   */
  async run(value: T, ctx: C): Promise<T> {
    const entries = this.entries.slice();
    if (!entries.length) return value;

    // Memoized downstream result: a listener that calls next() twice must not run the rest of the
    // chain twice. `started` distinguishes "not yet" from "resolved to undefined".
    const dispatch = async (index: number, current: T): Promise<T> => {
      if (index >= entries.length) return current;
      const entry = entries[index]!;
      let started = false;
      let pending: Promise<T> | undefined;
      const next: WaterfallNext<T> = (override?: T) => {
        // `override === undefined` means "continue with the current value" — that is the common
        // `await next()` case, so it must not be read as "replace with undefined".
        const downstream = override === undefined ? current : override;
        if (!started) {
          started = true;
          pending = dispatch(index + 1, downstream);
        }
        return pending!;
      };
      try {
        return await entry.listener(current, ctx, next);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`waterfall step "${entry.name}" (${index + 1}/${entries.length}) failed: ${detail}`, {
          cause: err,
        });
      }
    };

    return dispatch(0, value);
  }
}

/** Convenience constructor — `waterfall<Result>()` reads better at a declaration site than `new`. */
export function waterfall<T, C = unknown>(): WaterfallChain<T, C> {
  return new WaterfallChain<T, C>();
}