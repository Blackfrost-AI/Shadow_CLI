# m-7 + m-8: versioned persistent stdio RPC + crash restore — RESULTS

Worktree `m7-m8-rpc-recovery` @ base `7677ac4`. This slice was completed and
verified in-session; committed after lead-agent verification.

## m-7 — RPC hardening (src/acp/jsonrpc.ts, src/acp/policy.ts, src/acp/approvalBinding.ts, src/acp/cli.ts)

Every bound below is default-on in the peer itself (the 2-arg constructor keeps
working for existing tests only because the policy gates handshake/dedup
enforcement).

| Gate | Behavior |
|---|---|
| Frame bound | >1 MiB frame → typed error + connection close; a frame that grows past the bound across chunks dies the moment it crosses it |
| Inflight bound + backpressure | ≥8 concurrent inbound ops → completed frames queue (cap 64); queue full → transport paused via injected hooks; overload answered with a typed error, never dropped; FIFO drain + resume on drain |
| Versioned handshake | initialize must be FIRST; unsupported protocolVersion → specific typed error + close; capability vocabulary pinned; un-negotiated methods refused |
| Dedup ledger | Same id+method+params → the ORIGINAL outcome (attaches to in-flight promise, side effect runs exactly once); same id different content → typed refusal (spoofing) |
| Approval binding | Every outbound permission ask sealed `_meta.approvalDigest = sha256(redacted params)`; response MUST echo; mismatch → slot rejected, gate fail-closes to deny; non-echoing editors fail closed (documented compat limit) |
| Cancellation | Per-op AbortController; session/cancel aborts matching prompt ops and still reaches registry.interrupt; handler promise stays the sole response source (exactly-once) |
| Disconnect | `peer.end(reason)` aborts all inflight, drops backlog, clears the ledger, poisons the stream; cli.ts shutdown calls it before server.close() |

## m-8 — crash restore (src/tools/crashRecovery.ts)

Listing = journal reconcile() truth + applied-but-unconfirmed records +
interrupted jobs. NO automatic resolution. Operator-only actions with explicit
confirmations:

- `rollback`: journal `rollBack(id, recordedDigest)` — restores exact before-bytes;
  succeeds only for `applied` records; a digest minted for a different operation is refused.
- `keep`: durable flag recorded; state untouched; entry leaves the listing.
- `retry`: NEW prepare→approve→apply with a fresh approval; old approval replay
  refused by the journal state machine; old record superseded.
- `reconnectReport`: initialize response carries `incompleteOperations`
  (opt-in via `AcpServerDeps.crashReport`) — lists without replaying.
- A corrupted journal record surfaces as a visible problem, never hidden.
- Original session/job data is never modified by recovery actions.

## Verification

- `npm run typecheck` — **PASS**
- New: `acp-rpc.test.ts` **11/11 PASS**, `crash-recovery.test.ts` **8/8 PASS**
- Existing regression (all green, exact wire shapes preserved):
  `acp-jsonrpc` 16/16, `acp-protocol` + `acp-events` + `acp-gate` 32/32,
  `acp-cli` 13/13, `acp-rpc` + `crash-recovery` 19/19, `acp-server` +
  `agent-loop` + `mutation` + `approval` 27/27 — **86/86 total**

## Honest limits

- Editors that do not echo `_meta.approvalDigest` fail closed — approval
  routing to such editors is unavailable (documented compatibility limitation).
- Backpressure pause/resume hooks are exercised through injected fakes; the
  real stdin pause path is integration-scope (m14/m15).
