# Collaboration and recoverable work

Shadow 10.0.3 connects planning, delegated work, code review and session recovery. These interactive
workflows use Snowfall, the default terminal, with its thick banner, full-width conversation,
separate thinking blocks and pinned composer. See the [user guide](../USER_GUIDE.md) for setup.

Jobs, rooms, usage observations and progress records are stored locally. Shadow adds no analytics,
crash uploads, install identifiers or hosted coordination service. Prompts and selected context
go to your configured provider; enabled MCP connections and invoked tools have their own network
behavior. Update discovery is off by default and project files cannot enable it. External programs
you configure have their own network behavior.

## Start with a small workflow

1. Open `/work`. Use arrows and Enter to inspect a worker, command or plan item. A opens its
   available actions. `/tasks` filters the plan; `/jobs` shows persisted project jobs.
2. Open `/consult`, select a model profile and enter a question. This uses a separate read-only
   context. `/consult list` shows its ID; `/consult follow <id> <question>` continues it, including
   after a session resume. `/consult cancel <id>` requests cancellation.
3. Open `/review`, choose working changes, a branch comparison or a commit, then inspect files.
   Enter opens a diff; N/P jumps between hunks; Escape returns. R selects a reviewer profile.
   `/review findings` opens structured findings and their source location when the model returns
   the requested format. Findings are opinions, not proof that checks passed.
4. Open `/team` and choose a preset. The selection fills the composer; add the task and submit.
   A second opinion is read-only. Implement-and-review creates a retained Git worktree and an
   independent review. Parallel team defaults to two read-only perspectives and synthesis.
5. Inspect `/jobs`, `/room` and `/work artifacts`. Apply, keep or discard output deliberately.
   Nothing is automatically merged into your main checkout.

Pickers accept arrows, a number followed by Enter, or `/` to filter. Escape clears a search,
then closes the picker. Once overlays are closed, Escape interrupts the active operation.
Cancellation propagates to native child workers. A stopped model response and a verified
result are separate states.

## Profiles and bounded presets

Configure profiles through the existing onboarding/model controls. A profile label resolves
provider, endpoint, credential reference, model, capabilities, effort and context/output limits
together. Choosing another profile does not switch the lead session's model. Secrets are not
written into job configuration records.

Simple examples:

```text
/consult "Local reviewer" Check the error handling in src/config.ts
/team second-opinion Review the cancellation behavior in this workspace
/team implement-review Fix the documented formatting bug and preserve existing behavior
/team parallel-team Inspect startup reliability from two independent perspectives
```

Advanced options are explicit JSON, or the same `collaborate` tool discovered with `tool_search`:

```text
/team --json {"preset":"implement-review","prompt":"Fix the fixture bug","profiles":["Local implementer","Remote reviewer"],"expectedArtifacts":["src/parser.ts"],"checks":["npm test"],"deadlineSeconds":300,"maxTokens":40000,"maxCostUSD":2}
```

The profiles array follows stage order. Pipeline accepts one to four explicit `steps`, each with
`task`, optional `role` and optional `profile`. A role defaults to a read-only reviewer; an
implementation role requires the usual write/exec permissions. Debate requires a structured
verdict citing the contributing jobs. Plan/solve requires a bounded structured plan. Invalid
planner/judge output stops the workflow instead of becoming a success.

Every preset is capped at eight stages, at most three concurrent workers, and a configurable
deadline and token/spend ceilings. Defaults are 300 seconds, 100,000 tokens and concurrency two.
The dollar ceiling is optional; parent ceilings still apply. A dollar-limited run refuses an
unpriced profile. Unknown provider usage remains **unknown**; provider-reported usage is needed
for accurate token/cost metering, and estimates are not billed spend. Stage and time ceilings
remain active. Budget exhaustion does not purchase a hidden synthesis call.

## Jobs, evidence and recovery

Jobs live in the workspace's `.shadow/jobs.sqlite`. SQLite transactions coordinate local
processes; attempt ownership and heartbeats prevent two processes from claiming the same pending
job. Startup marks dead owners interrupted. It does not replay a write or command.

`/jobs` shows attempts, blockers and acceptance. Preparing a retry and starting it are explicit
actions. Attempt history and artifact references remain available. Cross-process cancellation
is cooperative and polled; a live process is never stolen merely because its heartbeat is old.
If an interrupted job produced a worktree, inspect and recover its artifact before deciding
whether to retry. Workers do not continue running across application exit.

`/room` is a local project conversation. Messages support recipients, replies and unread cursors.
Workers read bounded directed messages at safe model boundaries. A message does not grant
permission or automatically start another worker. Use a consultation follow-up or an explicitly
prepared attempt when new execution is needed.

Execution can be completed, partial, failed, cancelled or interrupted. Acceptance is separately
passed, failed or unverified. It can require expected files, declared check commands and a
supported JSON result schema. Missing, interrupted, timed-out or malformed evidence cannot pass.
Checks execute through the normal shell permission path **in the retained worker checkout**.
Check commands, exits and logs are retained with the job. A model saying “tests passed” is not
recorded check evidence.

`/work artifacts` shows retained checkouts and patches, including committed, staged, unstaged
and untracked output. Apply checks for conflicting main-workspace edits. Keep preserves the
checkout. Discard archives the patch before deleting the checkout; ignored outputs that could
be lost prevent cleanup. An active artifact needs explicit recovery after its owner has stopped.

## Extensions and repository context

`/mcp` opens connector choices. The direct commands include:

```text
/mcp add docs https://example.test/mcp
/mcp add local --command executable argument
/mcp test local
/mcp reconnect local
/mcp timeout local 90
/mcp tools local lookup,read
/mcp disable local
```

Connector calls have bounded deadlines and show progress when the server reports it. Disable
unregisters owned tools immediately. Deferred schemas are discovered through `tool_search`;
oversized results expose an `mcp_artifact` handle for bounded retrieval. Remote cancellation is a protocol request,
not a guarantee that the server terminated its worker. No external multi-CLI bridge is required
for native consultation.

The live connector management commands above are Snowfall controls. Ink's legacy MCP menu
saves configuration for restart; it does not yet expose the live reconnect/disable manager.

`repository_context` provides maps, ranked excerpts with selection reasons, ranges, instruction
sources, symbols, definitions and references. Supported language servers provide semantic
results; otherwise the response identifies lexical fallback. Ignored/generated files and paths
outside the workspace are excluded. `/skills` shows global, plugin and workspace sources and
conflicts. Scoped project instructions accompany normal file reads. `/memory` supports show,
set and delete with user/generated/legacy provenance; unknown legacy timestamps stay unknown.

## Runtime limits

These tools coordinate one user's local workspace. Workers stop when Shadow exits; reopening
a session restores records without replaying work. Provider tool-calling and usage capabilities
vary, and a model's conclusion is separate from recorded check evidence. The interactive controls
in this guide are Snowfall features; Ink retains its compatibility controls. Consult the
[terminal contract](TERMINAL_RENDERERS.md) for renderer support.
