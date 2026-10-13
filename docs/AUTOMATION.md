# Scripting Shadow

Shadow's normal text output remains the default. Machine output is opt-in and requires a one-shot task or piped input. It uses the same model, tools, permissions, and local configuration as an ordinary run. It adds no telemetry or service dependency.

```sh
shadow --task 'Summarize the changes' --output-format json > result.json
shadow --task 'Review this repository' --json > events.jsonl
cat task.txt | shadow --output-format json --ephemeral > result.json
```

`--output-format json` writes one final result object. `--output-format jsonl` (also `--json`) writes events as they arrive followed by one final result. In machine mode, the entire pipe is one multiline task. Existing text-mode pipes retain their line-per-task behavior. Empty machine input is an error. Piped input is limited to 8 MiB and remains interruptible while waiting for EOF.

Stdout contains only JSON data, including startup errors. Human startup messages, warnings, and diagnostics go to stderr. `--help` and `--version` can also return their text in a result envelope. Administrative subcommands do not support these flags. `resume --session <id> --task 'Continue with the remaining checks' --json` is supported; resuming loads state but never automatically replays completed actions. `--repl`, `--web`, and `--screen-reader` are incompatible with machine output.

## Result and event contract

Every frame has `version: 1`, a `type`, a process-local UUID `run_id`, and a monotonically increasing `sequence`. Persisted sessions also have `session_id`. Additive fields and new event types may appear; consumers should ignore fields or events they do not use.

```json
{"version":1,"type":"result","run_id":"example","sequence":8,"status":"completed","stop_reason":"end_turn","exit_code":0,"ephemeral":true,"result":{"text":"Done"},"usage":{"inputTokens":100,"outputTokens":20,"costUSD":0,"contextPct":1},"checks":[],"completion_verified":null,"errors":[]}
```

JSONL starts with `run_started`. Runtime event types include `user`, `text`, `assistant_done`, `tool_start`, `tool_end`, `tool_denied`, `subagent_start`, `subagent_end`, `usage`, `finding`, `retry`, and `stop`. The runtime event is nested under `data`. Tool events carry a top-level `tool_call_id`; worker and persistent job events carry `task_id` and `job_id` when available. These IDs correlate existing actions; reading an event never runs it.

The final `result` frame is authoritative for the overall exit code. A `stop` event reflects the loop's stop; schema validation or incomplete completion checks can still make the final result fail. `status` is `completed`, `failed`, `incomplete`, or `cancelled`. `result.text` is the final assistant answer, not intermediate commentary. `usage` contains the latest cumulative turn usage or `null` when no provider usage is available.

`checks` includes observed `acceptance_check` and `project_checks` execution evidence, with `passed`, `failed`, or `unverified` status and tool/check/job IDs where available. Empty checks means no observed checks, not that verification passed. `completion_verified` is `false` when the completion guard reports unresolved work, and otherwise `null`: a model ending its turn alone is not independent verification.

Reasoning streams and tool-call signatures are omitted. The existing best-effort secret redactor is applied to output data. As with any command's output, callers decide whether and where to save their result/events; Shadow does not upload them.

## Validate a final JSON answer

Write a local JSON Schema, for example `result.schema.json`:

```json
{"type":"object","required":["summary"],"properties":{"summary":{"type":"string"}},"additionalProperties":false}
```

```sh
shadow --task 'Summarize this repository' --output-schema result.schema.json > result.json
```

`--output-schema` defaults the output format to `json`; it can also accompany `jsonl`. Shadow tells the model to return one JSON value and validates the final, redacted answer with Ajv. On success, the envelope includes the parsed value in `result.structured`. The final answer must be JSON without Markdown fences. Invalid JSON or a schema mismatch exits with code 4 and includes an `output_schema` error. Validation never reruns a task or repeats tools to repair an answer.

Schemas are local, limited to 1 MiB, and compiled before provider startup. Draft-07 schemas and local references are supported; external references are not downloaded. Unsupported schema keywords or drafts fail startup. `format` is treated as an annotation, not a validator (use structural constraints or patterns where appropriate). Data is never coerced, defaulted, or stripped to manufacture a pass.

## Exit codes

| Code | Meaning in machine mode |
| --- | --- |
| 0 | Loop completed and any requested output schema passed |
| 1 | Runtime/provider/tool fatal failure |
| 2 | Invalid arguments, schema, configuration, or startup failure |
| 3 | Incomplete: iteration/token/budget limit, paused/no stop, or unresolved completion checks |
| 4 | Final answer is invalid JSON or does not satisfy its output schema |
| 130 | Interrupted with SIGINT/Ctrl-C |
| 143 | Terminated with SIGTERM |

Cancellation never starts a replacement attempt. The existing runtime aborts active work and reports the final interruption. A killed process (`SIGKILL`), broken output pipe, or machine crash cannot guarantee a final frame. Human text output retains its existing error conventions.

## Ephemeral conversation boundary

`--ephemeral` supports one-shot tasks and pipes in either text or machine mode. It creates no conversation JSONL, resumable context snapshots, Work Center sidecar, or new session harness binding. It also skips the automatic session-retention sweep. There is no transcript to resume afterward.

This is a conversation-persistence option, not an incognito operating system. Normal tool effects remain: files the task writes, file checkpoint/review backups, retained worktree artifacts, job/check records, explicit memory/skill changes, local security/egress receipts, configured hook output, and provider-side retention are outside this boundary. Redirected stdout/stderr are also controlled by the caller. Ephemeral runs preserve normal permission checks and the user-selected endpoint.
