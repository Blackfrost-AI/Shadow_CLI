# Harness-capability eval

A standard, model-agnostic test that answers one question: **can this model jump
into the Shadow harness and take control?** — i.e. drive the tool-calling loop to
a correct, observable outcome.

It is the measuring stick for the local-model thesis: a great harness should let a
modest local model (Qwen / Gemma / GLM via Ollama) actually *do work*. Run it
against any model and compare scorecards.

## How it scores

Every task runs the **real `shadow` binary** non-interactively (`--task --yolo`)
in a fresh throwaway workspace, then is graded by:

1. **Workspace end-state** — deterministic, model-agnostic. "Did `hello.txt`
   contain exactly `hello world`?", "Is `config.js`'s port now `8080`?". Never by
   parsing the model's prose.
2. **Telemetry** from the run's session log — tool calls executed, **`bad_tool_json`**
   count (the #1 local-model failure signal), iterations, stop reason, tokens.
3. **Stop health** — a task passes ONLY if the fixture end-state is correct AND the
   loop reached a legitimate terminal state (`end_turn` / `refusal` / `pause_turn`).
   A correct artifact produced under `provider_error`, `max_iterations`, `budget`,
   `interrupted`, `fatal_tool_error`, `spawn_error`, `max_tokens`, or a wall-clock
   kill is reported as `⚠️` (fixture ok, stop abnormal) and **fails the run** — it
   proved the plumbing, not the product. The eval exits nonzero whenever any task
   does not pass cleanly.

## The suite (20 tasks)

| id | capability | what it proves |
|---|---|---|
| `read-file` | tool-call | calls a tool and uses the result |
| `top-score` | multi-step | search → read → compute → write |
| `write-file` | write | produces a file with exact content |
| `edit-config` | edit | exact-string edit (read-before-edit + uniqueness) |
| `shell-count` | shell | drives a shell command to an outcome |
| `error-recovery` | error-recovery | a failing edit first → adapts and retries |
| `no-needless-tools` | completion | answers directly, no tools, clean `end_turn` |
| `compaction-sum` | compaction | finishes a multi-read task while context is being summarized (tiny `--context-budget`) — also exercises the orphan-`tool_result` guard |
| `dialect-shell-command` | dialect | harness remaps foreign tool names (`shell_command` → `run_shell`) |
| `dialect-update-plan` | dialect | harness remaps foreign plan schemas (`update_plan` → `todo_write`) |
| `sec-triage-macho` | tool-call | discovers deferred `bin_recon` via `tool_search` and triages a Mach-O sample without executing it |
| `sec-patch-failclosed` | write | `patch_bytes` refuses a stale-byte patch (expected_hex mismatch) |
| `sec-patch-applies` | write | `patch_bytes` applies a verified same-size byte patch and records a receipt |
| `sec-engagement-f3ead` | multi-step | `engagement_ops` start + log actions with phase/tactic tags |
| `sec-findings-record` | write | `security_findings` records a finding into the local evidence ledger |
| `sec-snapshot-baseline` | write | `target_snapshot` seals a baseline + per-file SHA-256 manifest |
| `sec-snapshot-drift` | multi-step | `target_snapshot` baseline → modify → verify reports drift |
| `sec-detonate-benign` | exec | `sample_run` detonates a benign sample under sandbox containment |
| `sec-detonate-containment` | exec | detonated sample cannot escape its scratch dir (escape-marker write fails) |
| `sec-detonate-network-denied` | exec | detonation denies network egress by default |

## Run it

```bash
# Self-test the harness with no model. The task-aware scripted mock drives the
# REAL tools for every fixture (including tool_search → deferred security tools),
# so a mock run is a valid plumbing regression signal: every task must pass AND
# stop cleanly, and the command must exit nonzero on any failure.
npm run eval -- --mock

# Against your models (copy the template first, edit it, then point at it):
cp eval/models.example.json eval/models.json   # edit to your pulled models
npm run eval -- --config eval/models.json

# A subset, keeping the workspaces for inspection:
npm run eval -- --config eval/models.json --only edit-config,compaction-sum --keep
```

Scorecards print to stdout and are written to `eval/results/<timestamp>.md`.
**Exit code is nonzero whenever any task fails or stops abnormally** — CI-safe.

## Reading a scorecard

- **passed X/20 · abnormal stops N** — headline drivability. `abnormal stops` counts
  every task whose loop did not reach a legitimate terminal state; it must be 0.
- **stopOK column** — per-task stop health: `✅` legitimate terminal state, `⚠️`
  fixture passed but the loop stopped abnormally (counts as a failure).
- **tool-call JSON validity %** — of all tool calls attempted, how many were valid
  JSON. A low number means the model emits malformed tool calls and needs the
  harness's repair ladder + constrained decoding (tracked in the roadmap).
- **bad-JSON N** — raw count of unparseable tool calls. Today a single one can end
  a run (no repair/retry yet) — so this is the most important number to drive to 0,
  by model *and* by harness improvement.
- **tok (lead-loop)** — the cumulative input+output snapshot the loop's budget
  reported for the whole run (latest cumulative value; never summed across turns).
- **tok (per-request incl. cache)** — the sum of every provider round-trip's raw
  input/output tokens plus cache reads/writes. This is the real cost signal: it
  counts each request exactly once and exposes how much of the prompt was cached.
- **subagents in/out/$** — rolled-up spend of every finished sub-agent across the
  run, counted exactly once per sub-agent from `subagent_usage` events.

## Notes

- Ollama is OpenAI-compatible: `provider: "openai"`, `baseUrl: ".../v1"`. The
  `apiKey` is ignored by Ollama but must be present so shadow doesn't treat the
  provider as unconfigured.
- Runs are sequential (one model at a time) to avoid overloading a single box.
- `--yolo` is used so the agent runs unattended; every task runs in an isolated
  temp dir that is deleted afterward (use `--keep` to inspect). This makes the eval
  a test of unattended task completion, **not** of sandbox/approval enforcement —
  security modes need their own adversarial suite under ordinary permissions.
