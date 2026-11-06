# SSH remote paths

Scoped remote file access over SSH, with a pinned host identity, bounded remote paths, and explicit remote-write approval. This module exists because pulling a file from a server — or pushing one — is a side-effecting network operation with an identity question attached: *which host am I actually talking to?* Shadow answers that question the same way it answers local edits: by binding the action to exact, operator-pinned identity up front, refusing everything else, and recording what actually happened.

Scope: this module implements the access machinery. Wiring it into the live tool registry and the user configuration loader is a later integration step and is intentionally out of scope here; see "Integration status".

## Configuration model

Hosts are **configured, never ad-hoc**. The registry is supplied at construction, validated, frozen, and immutable for the factory's lifetime:

```ts
createSshRemote(workspaceRoot, [
  {
    alias: 'lab',                  // registry key: [A-Za-z0-9._-]+
    address: 'lab.invalid',        // hostname or IPv4 literal — no user@ prefix, no port suffix
    port: 22,                      // optional, default 22, 1..65535
    user: 'operator',              // [A-Za-z0-9._-]+
    hostKeyFingerprint: 'SHA256:…',  // pinned host identity, canonical OpenSSH form
    allowedPrefix: '/srv/data',    // absolute POSIX path; '/' is refused
    allowAgentForwarding: false,   // explicit opt-in; off by default
    maxReadBytes: 1048576,         // per-file read cap (default 1 MiB, hard max 64 MiB)
  },
], { runner });
```

Validation happens at construction, before any connection can be attempted:

- `hostKeyFingerprint` must be canonical OpenSSH form (`SHA256:` + 43 base64 chars + `=`). An MD5 or hex fingerprint is rejected.
- `allowedPrefix` must be an absolute POSIX path, and **`/` is refused** — an "everything under root" prefix makes the bound meaningless, so it is not representable.
- `address` is a hostname or IPv4 literal only. No `user@`, no port, no IPv6 in this version.
- The validated host object is frozen (`Object.freeze`); nothing downstream can mutate it per call.

A request naming any alias not in the registry is refused outright with zero runner calls. There is no code path anywhere in this module that accepts a raw host string from the model.

## Verification guarantees

**Host-key pinning, verified before anything else.** Every operation — read, write-prepare, write-apply, reconciliation — begins with a `connect` step that obtains the fingerprint of the host key the server actually presented. That fingerprint is compared against the pinned fingerprint **in this module**, not delegated to the runner or to OpenSSH's trust store:

```
Host key mismatch for host lab:
pinned SHA256:AAAA…= but the server presented SHA256:BBBB…=
Aborting before any command or transfer; the pinned fingerprint must be
re-verified out of band before this host is used again.
```

No probe, read, or transfer is issued until the pin matches. If the server presents no key at all, the operation aborts the same way. A matching fingerprint is only then materialized into a per-operation `known_hosts` pin file, and every subsequent `ssh` call runs with `StrictHostKeyChecking=yes` against that file — so both the module's own comparison and OpenSSH's must agree.

**No agent forwarding by default.** Every built `ssh` command line carries an explicit `ForwardAgent=no` **and** `ClearAllForwardings=yes`; the `-A` shorthand is never emitted. Forwarding is enabled only when the host configuration explicitly opts in (`allowAgentForwarding: true`, which changes the argv to `ForwardAgent=yes`), and a call-time request for forwarding on a host that does not opt in is refused **before any connection**. Forwarding cannot be turned on per call.

**Bounded remote paths.** Every remote path is POSIX-normalized (`..` segments resolved away, whitespace/backslash/NUL rejected) and must be exactly the configured prefix or strictly below it (`prefix + '/'`). Sibling lookalikes fail: `/srv/data2/f` is not under `/srv/data`, and `/srv/data/../escape` normalizes outside. Out-of-prefix paths are refused before any connection is made. Lexical honesty: a symlink on the remote host *inside* the prefix can still point elsewhere on that host — the prefix bounds where the operator directs transfers, it is not a remote filesystem semantics guarantee.

**Bounded reads.** Each host has a per-file read cap (default 1 MiB, hard max 64 MiB) enforced at two independent layers: the probe must report a size within the cap before a transfer is attempted, and the received byte count is checked again against the cap after transfer. Reads land in the workspace only through a fresh-file target (see below), with a per-file SHA-256 checksum recorded in the outcome and re-verified byte-for-byte after landing.

## Write approval binding

A remote write approval binds **four** dimensions, mirroring `src/tools/mutation.ts`'s approval-digest binding:

```ts
approvalDigest = SHA256(JSON.stringify({
  binding: 'ssh-remote-write-v1',
  hostFingerprint,                  // the pinned host identity
  items: [{ remotePath, contentDigest, preconditionDigest }],
}))
```

- `hostFingerprint` — the host identity the approval was issued against.
- `remotePath` — the exact remote path.
- `contentDigest` — SHA-256 of the exact bytes to be written.
- `preconditionDigest` — SHA-256 of what the path holds *right now*, or `null` when it is absent. Captured at prepare time by live probe.

The digest is compared with `timingSafeEqual` at **both** approve and apply time. Consequently:

- An approval for content A cannot authorize content B at the same path.
- An approval for one path cannot authorize another path with identical content.
- An approval for one host cannot authorize the same path/content on another host (different pinned fingerprint → different digest).
- Any change to the remote precondition after approval invalidates apply — but more strictly, apply **re-probes every precondition live** before the first transfer and aborts on drift.

State machine: `prepared → approved → applying → applied | partial | unknown`. `applyWrite` re-verifies the host key, re-probes every precondition, durably persists the `applying` marker **before** the first transfer, and then classifies the true remote state by live re-probe. There is **no replay**: only an `approved` record can be applied; an interrupted operation is surfaced for inspection, never automatically retried.

## Outcome recording

Remote outcomes are classified by live probe, never inferred from exit codes:

| Write state | Meaning |
|---|---|
| `applied` | Every item's live remote digest matches its approved content. |
| `partial` | Some items verified applied, and every remaining item is provably still at its precondition. |
| `unknown` | Any item cannot be classified (probe failure), or matches neither precondition nor approved content. |

Per-item truth is always recorded: `matches-after`, `matches-before`, `drifted`, `unverifiable`. The journal lives at `<workspace>/.shadow/ssh-remote/` (0700 directories, atomic+fsync writes), and `reconcile()` re-probes every `applying`/`partial`/`unknown` record live, reporting per-item truth without replaying anything.

Reads resolve to `complete | partial | refused | unknown` with per-item status (`landed`, `refused-oversize`, `refused-missing`, `refused-non-regular`, `probe-failed`, `transfer-failed`, `truncated`, `landing-failed`, `landing-mismatch`). Undetermined effects are never reported as a refusal: a failed probe or transfer makes the outcome `unknown`, because "we declined" and "we could not determine" are different facts.

**Local checkpoints do not restore remote state.** There is no remote rollback function, and `localRestore()` always throws with that statement; `localRestoreStatus()` always reports `available: false` alongside the durable remote state. Any repair must be a new, separately approved remote write. A local rollback of a remote write is never claimed.

## Local landing rules

A read's local target must be workspace-relative, must not already exist (reads never overwrite), must not contain a symlink anywhere on its path, must have an existing parent directory, and must not be inside the SSH journal. Every landed file is re-read and compared byte-for-byte against what was received before it is reported as `landed`; a mismatch removes our own bad landing and reports `landing-mismatch`.

## Testing and network policy

Unit tests run against an injected fake runner that simulates a remote filesystem in a local map. **No real network is touched by any test.** The real network runner is an explicit opt-in (`options.realRunner`) and is not exercised by the unit tests — this repository has no live authorized target in CI, so the real runner is **UNVERIFIED** until run against an explicitly configured, operator-authorized host. Live access always requires an explicitly configured authorized target.

## Integration status and honest limitations

- **Unverified real runner.** The `realRunner` implementation (ssh-keyscan pre-flight → ssh-keygen fingerprint extraction → per-operation known_hosts pin → BatchMode ssh) follows the documented strategy but has never run against a real host in this repository. It is exported for explicit opt-in use only.
- **No cross-process locking.** Two processes applying the same approved write concurrently are guarded by the live precondition re-probe (the second sees drift and aborts), but a small race window remains. The in-flight guard is per-process only.
- **Remote path checks are lexical.** Remote symlinks inside the allowed prefix can redirect a write within the remote host. The prefix bounds operator intent, not remote filesystem semantics.
- **Remote writes are not atomic.** An interrupted multi-item write can leave part of the batch applied; the journal makes that state visible and classified, not impossible.
- **IPv6 targets are unsupported in this version** (no bracket notation in the address validator).
- **Not wired into the live tool registry.** `registerBuiltinTools` does not register an SSH tool in this change; the module is exported for the integration step where the registry, the config loader, and the approval UI are reconciled together.
