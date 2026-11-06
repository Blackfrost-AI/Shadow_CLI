# m-14 security follow-ups (recorded, not yet fixed)

These are the WEAKNESSES from the three completed adversarial security reviews of
the integrated diff. They are defensible-but-suboptimal hardening gaps,
distinct from the 10 CONFIRMED vulnerabilities, which were all fixed (5 in
commit a25fbc4; 5 in the R2/R3 fix commit). Each is recorded so a future
session can pick them up without re-deriving the analysis.

## R1 weaknesses — DAP / browser relay / SSH remote

## DAP (`src/agent/dap/`)

1. **Unwired `session.request()` evaluate bypass** — `session.ts:737-739`:
   the public request() escape hatch bypasses GATE 2; `request('evaluate')`
   reaches the wire ungated while the gate lives only in `evaluate()`.
   Fix: reject `evaluate` in the non-privileged send path.
2. **Breakpoint paths escape containment and the launch digest** —
   `session.ts:677-686`: no `insideProject` on breakpoint paths, no line
   validation, no file-count cap; `initial.breakpoints` absent from the launch
   digest (`gating.ts:73-86`). Existence/line-structure oracle on arbitrary
   paths. Fix: apply rejectsInside + validation, fold into the digest.
3. **Stepping state machine never leaves `stopped`** — `inspection.ts:289-310`:
   step()/continue never flips state to running; DAP does not require a
   `continued` event; `STOPPED_ONLY` enforcement is inverted.
   `DAP_STEP_TIMEOUT_MS` is dead code. Fix: flip state on success.
4. **`exited` event does not tear down** — `session.ts:718-723`: only
   `terminated` closes; a non-compliant adapter sending `exited` alone leaves
   the child alive. Fix: treat `exited` as terminal.
5. **Unbounded adapter display strings** — `inspection.ts:130,152,192,222,258`:
   thread/frame/scope/breakpoint/variable strings type-checked but not
   length-bounded (only the 1 MiB wire cap). Fix: cap surfaced strings (e.g.
   4 KiB) with an explicit truncation marker.

## Browser relay (`src/web/browserRelay.ts`)

6. **Token not re-minted on re-attach** — `:582-587`: re-attach keeps the old
   token; a former token holder retains a valid bearer credential against the
   new target and can clear grants via `/disconnect` (grant-grinding DoS).
   Fix: mint a fresh token per successful attach.
7. **Audit loss if result redaction throws** — `:505-520`: a hostile result
   object with a throwing getter makes the `executed` audit entry never get
   written although the action ran. Fix: wrap post-dispatch redact/log in
   try/catch and persist a fallback `executed (detail redaction failed)` entry.

## SSH remote (`src/tools/sshRemote.ts`)

8. **Read cap enforced after full buffering** — `:1096-1140`: `spawnCollect`
   ignores `spec.maxBytes` while collecting; the cap is checked post-hoc.
   A hostile host can stream multi-GB and OOM the agent before truncation.
   Fix: kill the child when collected bytes exceed the cap for reads.
9. **Write-approval digest binds host key but not host identity** —
   `:303-316`: cloned images share host keys, so digests collide across hosts;
   approval UI reasoning on digests cannot distinguish targets. Fix: include
   alias, address, and port in the digest.
10. **Children inherit the full agent environment** — `:1107` and
    `:1096-1140`: ssh/ssh-keyscan spawn without `env`; SSH_AUTH_SOCK and every
    provider credential are exposed, against the safeEnv doctrine
    (`src/util/safeEnv.ts:1-5`). Fix: scrubbedEnv() + explicit SSH_AUTH_SOCK.
11. **Read landing is check-then-rename** — `:617-655`, `:458-481`: a file
    created inside the transfer window is silently overwritten by
    `renameSync(tmp, path)`; post-landing verify then matches and reports
    `landed`, contradicting "reads never overwrite". Fix: lstat the destination
    after rename and refuse if it is not the just-created file, or use a
    no-replace primitive.
12. **Unbounded keyscan fingerprinting** — `:1153-1163`: each block gets a
    fresh 20 s fingerprint timeout; a hostile server presenting ~100 blocks
    stalls connect for tens of minutes. Fix: bound block count and put the
    whole connect phase under one deadline.

## R2 weaknesses — ACP RPC / approval binding / mutation journal

13. **`session/load` suffix IDOR within the workspace** — `server.ts:210-213`:
    an attacker-chosen 1-char `sessionId` matches many stored sessions and
    selects the newest. Confined to the same allowlisted root, but the editor
    can be steered onto a transcript it did not name. Fix: exact-match only.
14. **Journal digest is self-referential, not a MAC** — `mutation.ts:182-216`:
    SHA-256 over the record's own content; a repo can plant structurally valid
    records. Mitigations hold today (apply requires the digest and re-validates
    before-bytes against disk), but the integrity check authenticates the record
    against itself. Fix: HMAC under a host-owned secret outside the repo.
15. **The journal write path is unwired** — the model-facing write tools
    (editFile/writeFile/applyPatch/multiEdit) bypass the journal entirely via
    `atomicWrite`; only tests import it. A security control no live path
    exercises protects nothing. Fix: wire the write tools through
    prepare/approve/apply or delete the surface.
16. **Lock reclaim non-atomic + raw error leaks** — `mutation.ts:274-283`:
    unlink-then-open is two steps; the losing reclaimer surfaces a raw ENOENT;
    the lock file is never lstat-checked so a symlinked lock chooses the parsed
    pid. Fix: atomic rename reclaim, wrap errors in MutationError, lstat first.
17. **Notifications bypass the pending bound** — `jsonrpc.ts:294-313`: no
    inflight accounting for notifications at all. Fix: count toward a separate
    small bound.
18. **`user_question` auto-answered with its first option** — `gate.ts:48-60`:
    a prompt-injected model can phrase a question whose first option is the
    harmful choice and receive it with no human review. Fix: hard-block like
    `acknowledgeOnly` until editors expose a question UI.

## R3 weaknesses — edits / advisors / commit proposals

19. **Advisor cost cap checked only after the full response is consumed** —
    `advisor.ts:197-200, 306-313`: pre-flight prices input tokens only; the
    model can emit the full output allowance before the first usage event, so
    realized cost can exceed maxCostUSD by the output/input price multiple.
    Fix: pre-flight must price the full worst case.
20. **Commit proposal self-issues its approval ledger entry** —
    `gitCommitProposal.ts:524`: `buildProposal` sets `issued` itself; wired
    naively the model could build then execute with its own digest. Fix:
    require an explicit ApprovalGate grant before the ledger flips to spent.
21. **Post-commit verification never checks the committed message** —
    `gitCommitProposal.ts:699-720`: a commit-msg hook can rewrite the message;
    the tree still matches so `ok:true` is returned. Fix: read
    `git log -1 --format=%B` post-commit and fail on drift.
22. **No parent check — concurrent commit silently reverted** — admitted at
    `gitCommitProposal.ts:55-58`; another process landing a commit in the race
    window gets its changes reverted by our tree while history looks linear.
    Fix: verify `newHead^ === state.headCommit` post-commit.
23. **LSP preview hard-truncated at 400 diff lines** — `editTool.ts:90`:
    apply-time binding re-renders the same truncated text, so changes in the
    invisible tail are applied under an approval that never displayed them.
    Fix: refuse to prepare when the plan exceeds the preview cap.
24. **astEdits `method` probe validates in a class context only** —
    `astEdits.ts:322-359`: object-literal methods match the selector too;
    shape validation runs against the wrong syntactic context. Fix: derive
    the probe wrapper from the matched node's actual parent kind.

## Notes from R2/R3 (positive findings worth preserving)

- Bounds are real and total (frame 1 MiB, pending 64, ledger FIFO-evicted at
  1024); no version downgrade exists; gate ordering is synchronous; dedup is
  sound against id-reuse races; cancellation fails closed on every ordering;
  overload is answerable not a wedge; canonicalJson collisions unreachable
  from the wire; ApprovalBinding core correct (burn-before-compare,
  constant-time, current-params re-derivation).
- Journal write-time hardening real (symlink lstat checks, journal-reserved
  paths unmutable, before-bytes bound from disk, per-file truth in reconcile,
  fsync with parent-dir fsync). Crash-recovery retry handles can never equal
  the old digest.
- astEdits single-match determinism real; no unicode-normalization surface;
  no UTF-16/UTF-8 offset confusion; no path escape; no hook bypass in commit
  proposals (`--no-verify` never passed); no egress before the enabled check
  in advisors; approval-to-bytes binding in the LSP apply path strong.
- **Wiring status (R3, verified by grep)**: none of astEdits,
  gitCommitProposal, AdvisorService, or editTool is imported anywhere in
  production — only by tests. All R3 findings are latent: they become
  reachable the moment these surfaces are wired to tools.


- DAP protocol core solid: strict framing, per-direction seq monotonicity, all
  reverse requests refused, pending promises settled on teardown.
- DAP gating well-constructed: launch digest covers adapter/mode/program/cwd/
  args/env-names/port; approvals single-use and kind-separated; env sourced
  only from the scrubbed environment; attach loopback-only.
- Relay transport strong: literal 127.0.0.1 bind, exact-string Origin/Host/
  Referer matching with Origin mandatory, timingSafeEqual token compare,
  token registered with registerSecret, pre-auth failures uniform.
- SSH host-key design sound: per-op pinned known_hosts, StrictHostKeyChecking,
  wx-exclusive pin creation, module-authoritative fingerprint comparison,
  live drift re-probe before transfer, timingSafeEqual on digests.
