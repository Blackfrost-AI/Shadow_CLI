# DAP debugging (m10) — gated launch, inspection redaction, adapter protocol

Status: **module + tests complete (worktree-local)**. No registry wiring yet —
integration into the live CLI is a main-checkout decision (m14/m15).

## Components

- `src/agent/dap/protocol.ts` — DAP wire framing: UTF-8 byte-counted encoder;
  buffered decoder (`MAX_MESSAGE_BYTES` per message, `MAX_BUFFERED_BYTES` stream
  cap, no resync after malformed input); `DapPeer` request/event lifecycle with
  per-message sequence enforcement, single-use request ids, abort → `cancel`
  (requestId, never seq), teardown rejecting all in-flight requests, and a
  hard refusal to serve adapter reverse-requests.
- `src/agent/dap/gating.ts` — single-use, digest-bound approvals. Launch digest
  covers the exact validated argv; evaluate digest covers (expression, frame).
  Consumptions are one-shot; no digest funds a second use or a different kind.
- `src/agent/dap/session.ts` — `DapSession`: untrusted launch validation (argv
  arrays only, no shell metacharacters, NUL rejection, argv count/length caps,
  real workspace jail via realpath, loopback-only attach, env NAMES only),
  spec-ordered handshake (initialize → launch → configurationDone → running),
  STOPPED_ONLY gating for inspection commands, handshake timeout, and
  fail-closed close that rejects every pending request.
- `src/agent/dap/inspection.ts` — secret-shape and secret-name redaction
  (`[REDACTED: …]`), stack frames reduced to basename + line/column, and
  bounded step timeouts.

## Defects found and fixed during test-driven verification

1. **Debuggee env spread (real)**: `debuggeeEnv` did `{...base}` then copied
   approved names — the whole scrubbed base flowed to the debuggee regardless
   of approval, making the envKeys approval a no-op. Now the debuggee env is
   PATH + approved names ONLY; zero approvals ⇒ zero secrets.
2. **Approval burn (real)**: `evaluate()` consumed the single-use approval
   before the wire-state check — a running debuggee burned the operator's
   approval and prompted for commands that could never run. Now the state
   check precedes gate consumption.
3. **Session wedge (real)**: an adapter that refused (or dropped) `initialize`
   or `launch` left the session wedged in `created`/`launching` with a live
   transport. Now every handshake failure closes first, then surfaces the
   honest refusal; state ends `closed`.
4. **Unhandled rejection window (real)**: the launch request's rejection could
   fire while unawaited (during configurationDone) and surface as an unhandled
   rejection. Now suppressed until awaited after cleanup.

## Verification

- `node --import tsx/esm --test test/dap-gating.test.ts test/dap-protocol.test.ts test/dap-inspection.test.ts`
  — **44/44 PASS** (22 session/gating, 15 protocol, 7 inspection) using the
  fake in-memory adapter from `test/fixtures/dap.ts` (real DAP framing, no
  process spawn) and REAL temp workspace roots (the jail check realpaths).
- `npm run typecheck` — **PASS**.

## Honest limits

- The fake adapter never spawns a real debugger process: real js-debug/pydebugpy
  behavior, install verification, and process reaping on the host remain
  untested here (they are integration-scope, deliberately out of this slice).
- No registry wiring: nothing in the live CLI invokes DapSession yet.
- Adapter availability/install checks (`installRequirement`) are not exercised.
