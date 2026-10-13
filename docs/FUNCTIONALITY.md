# Local workflows, sessions, review and evidence

These features use Shadow's existing provider, permission, budget and session controls. They add no telemetry, hosted coordination or automatic reporting. Inference still uses your selected endpoint. The interactive browsers below use Snowfall; the command matrix documents Ink support.

## Check and complete work

`/checks` opens reusable checks. Add a named command, inspect it, run it through the normal shell approval path, or require it for the current task. Saving a command does not execute it. Definitions are local data in `.shadow/checks.json`:

```json
{
  "version": 1,
  "profiles": [
    {"id": "types", "title": "Typecheck", "command": "npm run typecheck", "timeoutMs": 60000},
    {"id": "tests", "title": "Tests", "command": "npm test", "timeoutMs": 120000}
  ]
}
```

Use `/checks run types`, `/checks select types tests`, and `/checks history`. An empty `/checks select` clears requirements. Results record the actual command, exit status and bounded redacted output. A historical pass is timestamped evidence, not a guarantee about changed files. Check requirements are session-local; results remain local on disk.

Admitted writes and ordinary shell commands invalidate prior live results, including work by shared-workspace background agents. Read-only shell commands conservatively do so too. Isolated worktrees keep separate check state. External editor changes are not watched, and commands registered as checks may themselves have side effects; rerun relevant checks after those changes.

During a model run, Shadow can request at most two corrective turns when task/check state changed in that run and still shows unfinished work. It does not restart work merely because an old checklist exists. Cancellation, denied actions, errors and budget limits take precedence; intentional questions and detached jobs may end normally. The completion guard does not infer every unspoken deliverable and never guarantees model correctness.

## Inspect context

`/context` shows system instructions, tool definitions, conversation entries and managed sources. Estimates are labeled separately from the provider's last measured usage. After a request, the captured view describes that prepared request; before the first request, the view is a provisional draft. Adapter formatting and dynamic instructions may change the next request.

```text
/context pin src/example.ts
/context exclude src/example.ts
/context remove src/example.ts
```

Pins are file snapshots retained through compaction. Re-pin to refresh a changed file. Exclusion applies to managed attachments and `repository_context` retrieval of that exact file. It does not retroactively erase chat, summaries or information already sent, and it is not an access-control rule for other tools. Essential instructions and paired tool history are read-only in this inspector. Press `c` to inspect the compaction explanation without calling a model.

## Execute workflows

`/workflows` opens local procedures. Pick one, fill the inputs with the keyboard, review the preview, and select Run. Four built-in read-only procedures cover repository review, release readiness, configuration auditing and log triage. Previewing makes no model or tool calls.

Place versioned JSON files in `.shadow/workflows/`, an enabled plugin's `workflows/`, or `~/.shadow/workflows/`. Earlier workspace/plugin sources take precedence over later global and built-in names; conflicts are reported. Existing Markdown runbooks appear in the Reference runbooks menu for local inspection; they are not executable manifests.

```json
{
  "version": 1,
  "id": "fix-and-review",
  "title": "Fix and review",
  "description": "Implement a scoped change in a retained worktree and review it.",
  "parameters": {"task": {"description": "What should change?", "required": true}},
  "preset": "implement-review",
  "task": "Implement {{task}}. Keep unrelated files unchanged.",
  "checks": ["npm test"],
  "deadlineSeconds": 300,
  "maxTokens": 100000,
  "concurrency": 2
}
```

Parameters expand only in task text; commands and expected artifact paths stay static. This prevents a form value from becoming shell syntax. Optional profiles are names of existing user-configured profiles, never embedded credentials. Supported presets use the existing collaboration runner. Declared `checks` and `expectedArtifacts` require the `implement-review` preset, which runs those acceptance stages; a `pipeline` needs explicit, nonempty `steps`. Implement/review can make one bounded repair after failed checks; workflows never automatically replay after restart.

The source and prepared run are fingerprinted; editing the manifest after preview requires reopening it. Results, artifacts and checks appear in `/jobs`, `/room` and `/work`. The workflow provenance is recorded locally with redacted input values. To reuse a manifest, copy its JSON file into a supported directory; installation does not activate executable hooks or add MCP servers.

## Find sessions across selected projects

`/sessions` opens the local session library in Snowfall. Search recorded conversation text, pin frequently used sessions, and add tags from the session actions. Pins appear first. A result includes its project, a matching snippet when available, and any recorded parent from a fork or resume.

```text
/sessions search deployment failure
/sessions add /path/to/another/project
/sessions projects
/sessions pinned
/sessions remove /path/to/another/project
```

The current workspace is included by default. Other projects are included only when you add them; the library supports up to 32 selected roots and does not crawl the machine. Removing a project removes its library metadata, not its transcripts or files. Project roots, tags and pins live in `~/.shadow/session-library.sqlite`. Search reads existing logs on demand without making a second persistent copy of conversation text or sending it to a model.

Search covers recorded user messages, committed answers and reasoning, and tool results. It omits raw provider frames, unfinished streaming fragments, and duplicate context snapshots. Bounded head/tail reads can miss the middle of long logs; the UI reports incomplete coverage, malformed records and result limits. A search result is not proof that a session can be resumed: normal snapshot authentication still applies.

Sessions from the current project can resume in place. For another project, use the supplied command to launch Shadow in that project's working directory. Shadow does not silently change the workspace under a running session. A custom `SHADOW_SESSION_DIR` may not identify the original workspace; those entries remain inspectable without claiming a known project. `/work` opens native jobs and `/tmux` discovers external terminals; terminal screen text does not establish an external agent's structured task state.

## Review, fix and check changes

`/review working` opens the uncommitted change browser; `/diff` provides the same working-change view. `/review base <branch>` and `/review commit <sha>` inspect a comparison or historical commit. Select a file with the arrows and press Enter for its diff. In a working view, `s`, `u`, and `d` preview staging, unstaging, and restoring that file. Each action requires its own confirmation.

Inside a text diff, `n` and `p` move between hunks. Lowercase `s/u/d` target the selected hunk; uppercase `S/U/D` target the whole file. Historical comparisons remain read-only. Staging changes only the index; unstaging restores the selected index content to HEAD without changing the working file. Restore replaces an unstaged tracked file or hunk from its indexed version and saves a private backup under `.shadow/review-backups/` first. It never deletes an untracked file.

Every action checks the file, index and HEAD again before applying. Changes made since preview cause a conflict and require refreshing. Ordinary modified UTF-8 files support hunk actions; whole-file actions cover supported new/deleted/binary or mode-only changes. Renames, copies, conflicts, symlinks, submodules, and files over the scoped size limit require Git directly. Backups contain file contents and remain local; they are not automatically deleted.

Press `r` from the file list to choose a reviewer profile. The review is a model request through that configured profile. Open `/review findings` to inspect supported structured findings, request a scoped fix, and choose a project check to verify the result. A finding is a claim to assess; an empty report or a model's approval is not a passing test. Fix requests reuse the normal agent permissions and budgets. Inspect the resulting diff and actual check evidence before accepting the change.

## Understand model capability results

After a successful API/server connection is saved, onboarding offers an optional deeper capability check. **Finish setup** is selected by default. Choosing the check uses the selected endpoint for up to two minutes and seven model turns, requesting 1,024 output tokens per turn plus input tokens; provider reasoning budgets may be larger and provider charges may apply. Only disposable fixture files are edited. Skipping, cancelling or failing the check keeps the saved setup and chosen endpoint.

The check reports native tool calls, structured tool-call arguments, file edits, error recovery, and autonomous read-to-edit behavior. `Agentic`, `Limited`, and `Chat-only` describe this test's observations, not an endpoint allowlist. Streaming compatibility, cancellation reliability and final JSON-schema output remain explicitly **not assessed** by these five probes.

Use `/model test` for the active model or `/model test <preset>` for a selected preset, including configurations that were not tested during onboarding. `/model history` displays the active configuration's cached observation without making a provider request. A dated result is saved locally under `~/.shadow/capabilities/` and is associated with the effective provider, wire model, resolved endpoint, wire API, profile and declared model contract. Credentials are excluded. A different endpoint or model configuration does not inherit an unrelated pass. Stored results are historical observations, never automatic provider changes or authorization to run tools.

## Track security evidence

`/findings` opens a local workspace for scanner claims, observations, evidence and retests. It does not scan a remote target. Record the assessment scope, then import SARIF 2.1.0 or a JSON array:

```json
[
  {
    "title": "Example configuration issue",
    "description": "Explain the observation and its limits.",
    "source": "local-review",
    "rule": "CONFIG-1",
    "path": "config.json",
    "line": 12,
    "severity": "warning"
  }
]
```

```text
/findings scope Review the local application configuration
/findings import results.sarif
/findings export
```

Repeated findings retain notes/history; a finding observed again after verification reopens. Attach redacted text evidence from within the workspace. Mark disposition with a reason. Verified status requires selecting a current successful project check from this Shadow session, run after the latest finding update. Historical/imported result files, changed check profiles, and checks invalidated by later edits cannot establish verification. Users must choose a check relevant to the finding; a passing command is not proof of complete security coverage.

Findings use a local SQLite store at `.shadow/security/findings.sqlite`. Evidence copies and unique Markdown report files stay under `.shadow/security/`. Reports include evidence references and hashes rather than raw evidence bodies or transcripts. Export runs locally without inference. The deferred `security_findings` tool provides the same operations through normal tool permissions.

## Discover and review extensions

`/extensions` links the existing harness, skill, plugin, MCP, hook and network-receipt views. `/skills` provides keyboard access to installed skills, learned candidates, validation and reviewed activation. Activation retains the existing version checks and takes effect for new sessions. Rollback requires an explicit skill and archived generation; it does not change model weights.

For machine-readable execution, schema validation and ephemeral transcript mode, see [Automation](AUTOMATION.md). External CLI engines and user scripts retain their own network behavior; Shadow's local receipt is not a machine-wide traffic monitor.
