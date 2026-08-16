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
- Live steering: start a deliberately long answer, type a correction, and press Enter. Model
  streaming should stop promptly, any visible partial answer should remain marked interrupted,
  and the correction should become the next turn. If a tool is already running, that call must
  settle before the correction starts; calls that have not started must be skipped safely.
- Browser control: run `shadow mcp enable browser`, restart Shadow, and ask it to navigate a local
  test page with the registered `mcp_playwright_*` tools. This launches an isolated Chrome profile;
  it does not attach to your everyday signed-in browser. Disable it with
  `shadow mcp disable playwright` and restart.

## Maintained functionality matrix

Point-in-time model reviews are evidence, not the release gate. Every release assessment must cover
all three axes below and record any unsupported surface explicitly.

| Capability | Model/protocol | Runtime integration | Interactive UX / release check |
|---|---|---|---|
| Agent loop | Native + textual tool calls; strict tool-use/result pairing, including ordered parallel results for Qwen/Hermes templates | read/edit/shell and approval boundaries | multi-step scratch-repo task reaches a verified result |
| Live steering | partial assistant history is text-only and `interrupted`; no incomplete reasoning/tool intent is replayed | model stream/compaction cancels promptly; active tool settles; later calls are paired as skipped | TUI Enter steers before natural completion; Esc preserves pending input; Ctrl-C drops it |
| Browser control | MCP tool schemas remain provider-neutral | `enable browser` persists the pinned Playwright preset without replacing other MCP entries; tools register as `mcp_playwright_*` after restart; risk remains `exec` | isolated visible Chrome navigates/clicks/reads a deterministic local page; disable key is `playwright`; missing Chrome/npx fails actionably |
| Self-hosted generation | OpenAI-compatible request shape and tool parsing | local/LAN endpoint, context budget, temperature, cancellation | configured temperature applies only to self-hosted models and is visible in `/config get temperature` |
| Qwen open weights | native, Hermes/XML, JSON, and DeepSeek-style textual calls; self-hosted Qwen 3.5/3.8 `reasoning_content` survives multi-step tool turns | exact model id, local sampling, context-window clamp, abort-safe fallback | streamed tool scaffolding never appears in scrollback; capability probe completes against the target endpoint |
| Surface parity | same history and safety invariants in each supported surface | TUI, headless/REPL, web session, editor (ACP) | divergences are named, never implied: live steering is currently TUI-only; web and ACP sessions reject a second prompt while busy; round-table mode asks the user to wait or interrupt; ACP v0 is text-only with no session restore |
| Editor integration (ACP) | JSON-RPC 2.0 / ACP v1 over stdio; `agent_message_chunk` / `tool_call` / `plan` updates; text-only prompts in v0 | `session/new` only inside allowlisted project dirs (jail re-resolved every turn); tool approval bridged to the editor's `session/request_permission`, fail-closed on any ambiguity; no new egress | `shadow acp --add-project` is repeatable/idempotent; a full prompt round-trip streams chunks + tool updates over a real wire; cancel → `cancelled`; a busy second prompt is rejected; a refusal names the remediation |
| Egress / network posture | every outbound request flows the broker (`shadowFetch`): offline wall → SSRF tier → DNS pin-set → receipt | `--offline` denies below the broker — process-wide undici dispatcher on Node, `globalThis.fetch` wall in the Bun binary; local serves still pass; MCP HTTP honors deadline + caller abort | `shadow egress` prints the disk receipt from a fresh process; `/connections` shows the session aggregate; new hardcoded hosts fail the snapshot guard |

Deterministic coverage belongs in the default suite:

- `test/tui-integration.test.ts` — live steering and deferred slash-command behavior.
- `test/loop.test.ts` / `test/context.test.ts` — interrupted-history, tool-boundary, and
  compaction-cancellation invariants.
- `test/mcp-manage.test.ts` / `test/mcp-browser-contract.test.ts` — exact browser preset,
  real CLI persistence/disable, MCP registration/invocation, preservation, and `exec` risk.
- `test/qwen38-compat.test.ts` / `test/text-tool-calls.test.ts` — hosted and self-hosted
  reasoning replay plus every supported textual tool-call dialect.
- `test/egress-broker.test.ts` — offline wall (broker + dispatcher/fetch-wall layer, incl.
  hostname-resolution verification and every cloud-metadata spelling), SSRF tiers, fail-closed
  resolution, DNS pin-set failover + cross-host redirect fallback, receipt
  format/rotation/fresh-process read + writer bounds, LRU agent cache, MCP HTTP deadline + abort,
  ESLint guard self-test (incl. alias/bracket/dynamic-import bypass shapes).
- `test/acp-jsonrpc.test.ts` / `test/acp-events.test.ts` / `test/acp-gate.test.ts` /
  `test/acp-server.test.ts` / `test/acp-cli.test.ts` — the ACP bridge: transport framing (split
  frames, CRLF, malformed JSON survives the stream, outbound ids, abort semantics), the full event
  map (every mapped + deliberately-unmapped bus shape), every permission-gate decision + the editor
  params shape, a full server round-trip over a real RPC wire (streaming, run-lock queueing across
  sessions, cancel, busy-second-prompt, project-allowlist refusal), the spec `prompt` field (and
  its legacy alias), secret scrubbing at the bus→wire and permission seams, the session-scoped
  approval-grant wiring (TUI parity), and the CLI arg surface + shutdown/stdout-purity structure.
- `test/no-telemetry.test.ts` — install-identifier absence, pinned remote-host snapshot, raw-fetch
  call-site cap.
- `test/snapshot-delta.test.ts` / `test/session-retention.test.ts` — the session-log phase-2
  contracts: chained delta snapshots (shape/chaining, byte-identical reconstruction, the ≤3×
  ratio + length-linearity acceptance, resume/rewind/picker parity, torn-delta fallback,
  periodic checkpoints, legacy full-only + fork-adoption compat, hostile baseOffset/messageCount
  and interleaved-lineage pins) and opt-in retention (off-by-default, age/keep rules, newest-M
  protection, live-fresh + resume-target guards, archive-over-delete moves with the paired
  checkpoint tree, `.archive` symlink refusal, session-id traversal guard, 0700/0600 checkpoint
  permissions, `/doctor` dry-run, global-only config strip).

A real-Chrome smoke test is environment-dependent and should run in an isolated home/profile as a
release or nightly check, with prerequisite skips reported separately from failures. It must use a
local page so browser correctness is not confused with internet availability.

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
