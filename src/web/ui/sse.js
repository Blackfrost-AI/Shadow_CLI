import { token } from './api.js';

/**
 * An SSE subscriber. Wraps EventSource with:
 *  - the session token on the URL (EventSource cannot set Authorization headers),
 *  - automatic reconnect via Last-Event-ID (EventSource does this natively, but only if the
 *    server's `id:` lines are present — Shadow's replay buffer at server.ts emits them),
 *  - batched dispatch so a flood of `text` deltas or `shell_output` frames doesn't starve
 *    the UI thread on long turns,
 *  - an explicit connection state, because a silent dead stream is the worst failure mode
 *    here: the page looks alive and simply stops updating.
 *
 * Why a timer and not requestAnimationFrame: rAF is throttled to ~0Hz in a background tab.
 * A user who switches away mid-build comes back to a frozen console and then a flood. The
 * timer keeps draining while hidden; `visibilitychange` forces an immediate catch-up flush.
 */

const FLUSH_MS = 60;

/** Connection lifecycle, surfaced so the UI can say which one is true. */
export const ConnState = {
  CONNECTING: 'connecting',
  OPEN: 'open',
  RECONNECTING: 'reconnecting',
  DEAD: 'dead',
};

/**
 * @param path   stream path, e.g. '/events'
 * @param handler called with each parsed event
 * @param onState optional (state, detail) callback for connection transitions
 */
export function subscribe(path, handler, onState) {
  const url = `${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(token())}`;

  let pending = [];
  let timer = null;
  let es = null;
  let closed = false;
  let everOpened = false;
  let state = null;

  const setState = (next, detail) => {
    if (state === next) return;
    state = next;
    if (onState) {
      try {
        onState(next, detail);
      } catch {
        /* a status callback must never break the stream */
      }
    }
  };

  const flush = () => {
    timer = null;
    if (pending.length === 0) return;
    const batch = pending;
    // NOTE: never drop `pending` without dispatching. The browser's Last-Event-ID has already
    // advanced past these events, so anything discarded here is an unrecoverable gap that a
    // reconnect will not refill.
    pending = [];
    for (const e of batch) {
      try {
        handler(e);
      } catch {
        // A handler error must not kill the stream — matches the bus's own swallow rule.
      }
    }
  };

  const schedule = () => {
    if (timer !== null || closed) return;
    timer = setTimeout(flush, FLUSH_MS);
  };

  const onVisibility = () => {
    if (!document.hidden) flush();
  };

  const connect = () => {
    setState(everOpened ? ConnState.RECONNECTING : ConnState.CONNECTING);
    es = new EventSource(url);

    es.onopen = () => {
      everOpened = true;
      setState(ConnState.OPEN);
    };

    es.onmessage = (m) => {
      try {
        pending.push(JSON.parse(m.data));
        schedule();
      } catch {
        // Non-JSON keepalive frame; ignore.
      }
    };

    es.onerror = () => {
      if (closed) return;
      // EventSource retries on its own EXCEPT when the response was fatal (a 401 closes it
      // permanently). readyState tells the two apart: CLOSED means it has given up, and the
      // page must say so rather than looking connected forever.
      if (es && es.readyState === EventSource.CLOSED) {
        setState(ConnState.DEAD, everOpened ? 'stream closed by server' : 'could not authenticate');
      } else {
        setState(ConnState.RECONNECTING);
      }
    };
  };

  document.addEventListener('visibilitychange', onVisibility);
  connect();

  return {
    state: () => state,
    close() {
      closed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      if (timer !== null) clearTimeout(timer);
      timer = null;
      // Drain what we already took off the wire before tearing down — see the note in flush().
      flush();
      if (es) es.close();
      es = null;
    },
  };
}
