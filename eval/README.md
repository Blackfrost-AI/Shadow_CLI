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
2. **Telemetry** from the run's session log — tool calls executed, **`bad_tool_json`
   count** (the #1 local-model failure signal), iterations, stop reason, tokens.

## The suite (8 tasks)

| id | capability | what it proves |
|---|---|---|
| `read-file` | tool-call | calls a tool and uses the result |
| `count-todos` | multi-step | search → compute → write |
| `write-file` | write | produces a file with exact content |
| `edit-config` | edit | exact-string edit (read-before-edit + uniqueness) |
| `shell-count` | shell | drives a shell command to an outcome |
| `error-recovery` | error-recovery | a non-unique edit fails first → adapts |
| `no-needless-tools` | completion | answers directly, no tools, clean `end_turn` |
| `compaction-sum` | compaction | finishes a multi-read task while context is being summarized (tiny `--context-budget`) — also exercises the orphan-`tool_result` guard |

## Run it

```bash
# Self-test the harness with no model (the mock can't call tools, so tool tasks
# are EXPECTED to fail — this just proves the runner + scoring work):
npm run eval -- --mock

# Against your models (copy the template first, edit it, then point at it):
cp eval/models.example.json eval/models.json   # edit to your pulled models
npm run eval -- --config eval/models.json

# A subset, keeping the workspaces for inspection:
npm run eval -- --config eval/models.json --only edit-config,compaction-sum --keep
```

Scorecards print to stdout and are written to `eval/results/<timestamp>.md`.

## Reading a scorecard

- **passed X/8** — headline drivability.
- **tool-call JSON validity %** — of all tool calls attempted, how many were valid
  JSON. A low number means the model emits malformed tool calls and needs the
  harness's repair ladder + constrained decoding (tracked in the roadmap).
- **bad-JSON N** — raw count of unparseable tool calls. Today a single one can end
  a run (no repair/retry yet) — so this is the most important number to drive to 0,
  by model *and* by harness improvement.

## Notes

- Ollama is OpenAI-compatible: `provider: "openai"`, `baseUrl: ".../v1"`. The
  `apiKey` is ignored by Ollama but must be present so shadow doesn't treat the
  provider as unconfigured.
- Runs are sequential (one model at a time) to avoid overloading a single box.
- `--yolo` is used so the agent runs unattended; every task runs in an isolated
  temp dir that is deleted afterward (use `--keep` to inspect).
