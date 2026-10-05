/** One deadline covers the entire operation, including response bodies and retries. */
export async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let rejectAbort!: (error: unknown) => void;
  const cancelled = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const abort = () => {
    const reason = parent?.reason ?? new Error('Check cancelled');
    controller.abort(reason);
    rejectAbort(reason);
  };
  const timer = setTimeout(() => {
    const reason = new Error(
      `No response within ${timeoutMs / 1000}s. Check the endpoint or try again.`,
    );
    controller.abort(reason);
    rejectAbort(reason);
  }, timeoutMs);
  parent?.addEventListener('abort', abort, { once: true });
  try {
    if (parent?.aborted) abort();
    return await Promise.race([
      cancelled,
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return work(controller.signal);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
    controller.abort();
  }
}
