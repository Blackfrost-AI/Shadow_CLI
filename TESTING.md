# Testing Shadow

Thanks for kicking the tires. Shadow is an agentic CLI: it lets a tool-calling LLM drive
your local workspace — read/edit files, run shell, search, plan, spawn sub-agents, use MCP.

## Install the current build

The normal install is the signed, self-contained binary (no Node runtime required):

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Blackfrost-AI/Shadow_CLI/main/install.sh | sh
```

For source testing, use **Node ≥ 20** and build the checkout so `dist/` matches the source under test:

```sh
npm install
npm run build
npm link                      # then run: shadow --help
```

Windows testers can use the signed PowerShell installer documented in `README.md`.

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

## Suggested focus areas

- **`view_image`** across different vision-capable providers and image formats.
- **Full-auto dropping the sandbox** (see Safety), especially on macOS and Linux.
- **`apply_patch`** (OpenAI/Grok codex patch grammar) + foreign tool-name aliases
  (`shell`/`Bash`/`Read`/… → Shadow's tools).

## Known issues / caveats

- `view_image` behavior varies with the selected model's actual vision support.
- Reasoning models: if a turn comes back empty, raise `--max-output-tokens` (the model may have
  spent the whole budget on hidden reasoning).

## Reporting a bug

Include: `shadow --version`, the provider + model, the exact command/prompt, expected vs actual,
and the session log at `<workspace>/.shadow/sessions/<timestamp>.jsonl` (already secret-redacted).
