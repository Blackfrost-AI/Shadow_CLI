# m-7 + m-8: versioned persistent stdio RPC + crash restore

Worktree: /Users/craigmac/.shadow/worktrees/m7-m8-rpc-recovery @ 7677ac4. No commits.

## Facts established by study

- `src/acp/jsonrpc.ts` `RpcPeer` = NDJSON transport seam: `feed()` splits lines with NO size
  bound, dispatches requests concurrently with NO inflight bound, no dedup, no cancellation of
  inbound ops, no disconnect handling. Outbound requests already track a pending map with
  abort; `cancelPending()` drains it. Malformed lines already answer -32700 without dying.
- `src/acp/server.ts` `createAcpServer` = method router. `initialize` answers the pinned v1
  capability object REGARDLESS of the requested protocolVersion (silent degradation). No
  handshake-first enforcement (existing tests call session/* without initialize).
- `src/acp/gate.ts` = approval bridge; asks ride `session/request_permission` OUTBOUND and the
  editor's response is matched by the outbound request id only — the decision is not bound to
  the ask's content.
- `src/tools/mutation.ts` (FROZEN semantics): journal states prepared/approved/aplying…;
  `reconcile()` lists ONLY applying/rolling-back/unknown with per-file truth; `rollBack()`
  works ONLY from state `applied`; `apply()` only from `approved`; `prepare()` re-derives
  `approvalDigest = sha256(files)`; locks are pid-keyed advisory.
- `src/state/jobStore.ts`: `recoverOrphansIfPresent()` marks dead-owner running jobs
  `interrupted` (never auto-restarts); `.shadow/jobs.sqlite`.
- Existing acp tests: acp-jsonrpc / acp-server / acp-gate / acp-events / acp-cli — several pin
  exact wire shapes (initialize response deep-equal; cli.ts shutdown structure). They must
  stay 100% green.

## Design decisions

1. **All m-7 enforcement lives in the peer + an injectable ACP policy** (`src/acp/policy.ts`),
   wired by `src/acp/cli.ts`. The 2-arg `RpcPeer` constructor keeps working (bounds are
   default-on; handshake/capability/dedup gates activate only when a policy is supplied), so
   existing tests are untouched. Bounds are NOT optional: frame cap 1 MiB (matches the journal's
   own MAX_BYTES), inflight cap 8, backlog cap 64, operations-map cap 1024.
2. **Handshake**: policy pins supported versions [ACP_PROTOCOL_VERSION] and the capability
   vocabulary {approvals, events, session, prompt, work}. initialize-first is enforced in
   policy mode; wrong/missing version → specific typed error; negotiated set is pinned and
   un-negotiated methods are refused with a specific error. Server-side initialize ALSO
   validates the version (defense in depth) — no existing test sends a bad version.
3. **Backpressure**: when inflight hits 8, completed frames queue (bounded 64); when the queue
   is full the transport is paused via injected pause/resume hooks (cli.ts: stdin.pause()).
   Frames arriving past the bound are answered with a typed overload error (never silently
   dropped — every request gets exactly one response).
4. **Dedup**: per-connection operation map keyed by request id. Same id+method+params → the
   original outcome (duplicates attach to the in-flight promise); same id, different
   method/params → typed refusal (id reuse is spoofing).
5. **Serialized session mutations**: session/new, session/set_mode, session/set_model,
   session/set_config_option, session/close run through ONE serial queue inside the peer
   (policy-classified); everything else keeps bounded concurrency. This preserves the existing
   busy/run-lock semantics pinned by acp-server tests.
6. **Approval binding**: in policy mode every outbound `session/request_permission` ask is
   sealed with `_meta.approvalDigest = sha256(redacted params)`; the response MUST echo it;
   a mismatched echo rejects the slot (gate fail-closes to deny). Editor-compat limitation:
   editors that do not echo fail closed — documented.
7. **Cancellation**: each inbound op gets an AbortController; handlers receive it via an
   extended ctx param `(method, params, ctx)` — existing 2-param handlers remain assignable.
   The policy maps session/cancel{sessionId} to abort-matching prompt ops AND still reaches
   registry.interrupt. The handler's promise stays the sole response source (exactly-once).
8. **Disconnect**: `peer.end(reason)` aborts every inflight op, drops backlog, clears the
   operation map, poisons the stream. cli.ts shutdown calls it before server.close().
9. **Reconnect report**: server `AcpServerDeps` gains an OPTIONAL `crashReport?: () => unknown`;
   when present the initialize response carries `incompleteOperations` (per-operation truth
   from crashRecovery). Absent (tests) → response byte-identical to today.
10. **m-8 `src/tools/crashRecovery.ts`**: listing = journal reconcile() results PLUS journal
    records in state `applied` that carry no resolution flag (real effects on disk, unconfirmed
    at boot) PLUS interrupted jobs. No automatic resolution. Resolution actions:
    - `rollback`: `journal.rollBack(id, recordedDigest)` — succeeds only for applied entries
      (restores exact bytes); for interrupted states the journal's own refusal is surfaced
      verbatim (no byte surgery outside the journal).
    - `keep`: state untouched; a durable resolution flag is recorded (that IS the flag) and the
      entry leaves the unresolved listing.
    - `retry`: a NEW prepare→approve→apply of the same content (new record, new explicit
      approval); the old record is marked superseded. Replay of the OLD approval is refused by
      the journal state machine (pinned by test).
    Original session/job data is never modified by recovery actions (pinned by test).
11. **CLI surface**: `/crash-restore` follows the exact `/checks` pattern —
    `commandCatalog.ts` piOnly entry + `doCrashRestore` in app.ts. Listing is read-only (no
    approval); each resolution opens an explicit operator confirmation picker (ChoicePicker)
    before any journal call.

## Test matrix

- `test/acp-rpc.test.ts`: oversized frame (error+close), backpressure (pause + typed overload +
  FIFO drain + resume), wrong version (specific code+message), un-negotiated capability
  refused, dedup (original outcome, side effect once, cross-content id reuse refused),
  malformed line survives, cancellation aborts in-flight, approval spoofing (A's echo cannot
  approve B; B's ask with A's echo fails closed), disconnect (abort + clean state + poisoned),
  ACP/JSONL compatibility (one JSON object per line, CRLF, split frames).
- `test/crash-recovery.test.ts`: per-op listing with per-file truth, rollback restores exact
  bytes, keep flagged+untouched, retry-new-approval ok + old replay refused, session
  preserved.
- Existing suites re-run: acp-jsonrpc, acp-server, acp-gate, acp-events, acp-cli, mutation.

## Verification gates

npm run typecheck green; every new test green; every existing acp + mutation test green.
