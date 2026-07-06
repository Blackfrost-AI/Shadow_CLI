# Testing Shadow — RC 0.9.0-dev.1

Thanks for kicking the tires. Shadow is an agentic CLI: it lets a tool-calling LLM drive
your local workspace — read/edit files, run shell, search, plan, spawn sub-agents, use MCP.

## Install (current RC)

Requires **Node ≥ 20**. `dist/` is prebuilt, so no compile step:

```sh
npm install --omit=dev        # runtime deps only (~50 pkgs, a few seconds)
node dist/index.js --help     # or: npm link   →   then just `shadow`
```

> A one-line `curl … | sh` installer (single self-contained binary, no Node required) is
> planned — for this round, use the npm path above.

## First run

```sh
shadow onboard                # pick a provider, paste a key, choose a model — it tests + saves
shadow                        # interactive TUI
shadow --task "…"             # one-shot, headless (exits non-zero on failure)
```

Use **agentic (tool-calling) models** only — a chat-only model will reply but won't call
tools. Models perform best on the wire format they were trained for (Anthropic vs OpenAI vs
Responses). Cloud frontier models and local Ollama endpoints both work.

## Safety posture — please read

- **Guardrails are ON by default**: a filesystem **jail** (file tools confined to the
  workspace) and an **OS sandbox** (bubblewrap on Linux / seatbelt on macOS) around `run_shell`.
- **Two ways to turn them off:**
  - `--yolo` (aliases `--nuke`, `--dangerously-skip-permissions`): drops jail + sandbox **+**
    the catastrophic-command denylist **+** all approval prompts.
  - **Full autonomy** (`--autonomy full`): drops jail + sandbox, but **keeps** the denylist.
- This is decided **at launch**. Switching to full mid-session (Shift+Tab) does **not**
  retroactively drop the sandbox.
- `--add-dir <path>` widens the jail to one extra directory without going fully unrestricted.

## What to exercise

- A real multi-step task in a scratch repo: read → edit → run tests → report.
- File tools: `read_file`, `edit_file`/`multi_edit`, `write_file`, `apply_patch` (codex patch
  format), `grep`, `glob`.
- `run_shell`: confirm the sandbox engages; try writing **outside** the workspace and confirm
  the jail blocks it (it should, unless `--yolo`/full-auto).
- Plan mode (`--plan-mode`), the todo list, sub-agents (`agent` tool), `web_search`/`web_fetch`.
- TUI slash commands: `/help`, `/model`, `/diff`, `/status`, `/theme`, `/vim`, `/image`, …
- Multimodal: `/image <path>` to attach an image; or ask the model to call `view_image <path>`
  to load one itself (vision-capable models only).

## Experimental / new this build

- **`view_image`** tool (model-loaded images) — new; unit-tested, only lightly live-tested.
- **Full-auto dropping the sandbox** — new behavior (see Safety).
- **`apply_patch`** (OpenAI/Grok codex patch grammar) + foreign tool-name aliases
  (`shell`/`Bash`/`Read`/… → Shadow's tools).

## Known issues / caveats

- `view_image` isn't broadly live-validated across vision models yet.
- The "full autonomy disabled the sandbox" startup notice may not print under some forced
  dev configs (cosmetic only — the jail/sandbox are still correctly dropped).
- Reasoning models: if a turn comes back empty, raise `--max-output-tokens` (the model may have
  spent the whole budget on hidden reasoning).

## Reporting a bug

Include: `shadow --version`, the provider + model, the exact command/prompt, expected vs actual,
and the session log at `<workspace>/.shadow/sessions/<timestamp>.jsonl` (already secret-redacted).
