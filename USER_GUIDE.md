# Shadow — User Guide

A practical, task-oriented guide to running and tuning Shadow. For the feature overview, install
instructions, and security model, see the [README](README.md); this guide is the "how do I…" companion.

- [Install & update](#install--update)
- [Connect a model](#connect-a-model)
- [Output length (`maxOutputTokens`)](#output-length-maxoutputtokens)
- [Reasoning effort](#reasoning-effort)
- [Autonomy & safety](#autonomy--safety)
- [Everyday use](#everyday-use)
- [The config file](#the-config-file)
- [Troubleshooting](#troubleshooting)

---

## Install & update

```bash
# macOS / Linux
curl -fsSL https://shadow.redpillreader.com/install.sh | sh
# Windows (PowerShell)
irm https://shadow.redpillreader.com/install.ps1 | iex

shadow update        # pull the latest build in place
shadow --version
```

Shadow is a single self-contained binary — no Node or npm needed to run it. It reads your config from
`~/.shadow/config.json` and never phones home; the only outbound traffic is the model endpoint **you**
choose and the web tools the agent explicitly invokes.

---

## Connect a model

The fastest path is the onboarding wizard:

```bash
shadow onboard
```

It walks you through picking a provider (Anthropic, any OpenAI-compatible endpoint, Gemini, a local
llama.cpp/Ollama server, …), entering a base URL + key, and saves a model preset.

Once you have presets, switch between them live in the HUD with **`/model`** (↑/↓ to select, Enter to
switch). Each preset can carry its **own** base URL and key, so you can keep a local model and a cloud
model side by side and hop between them mid-session without losing context.

To add a preset without the wizard:

```
/model add "My Local 80B" openai my-local-model http://127.0.0.1:8807/v1
```

---

## Output length (`maxOutputTokens`)

`maxOutputTokens` is the per-call cap on how many tokens the model may generate in one turn. **The
shipping default is `65536` (64k).**

Why so high: reasoning models split that budget between *hidden thinking* and the *visible answer*. With a
small cap they burn it all thinking and hit the limit before answering — you'd see a stop reason of
`max_tokens` and an empty or truncated reply. A generous default keeps them answering. Local servers
(llama.cpp / Ollama) simply cap generation, so a high value costs nothing there; a cloud model with a
smaller hard limit returns a 400 that Shadow automatically catches and retries with a smaller cap.

> It's a **cap, not a target** — the model still stops at its natural end. Raising it does not, by itself,
> make responses longer or more expensive.

**Three ways to change it** (most specific wins):

| Scope | How | Example |
|---|---|---|
| One invocation | `--max-output-tokens <n>` flag | `shadow --max-output-tokens 32768` |
| This session, live | `/config set maxOutputTokens <n>` in the HUD | `/config set maxOutputTokens 32768` |
| Every session | edit `~/.shadow/config.json` | `"maxOutputTokens": 32768` |

When to **lower** it: a model with a small context window (some 4B/local reasoners run a 64k *total*
window, so a 64k output floor leaves no room for the prompt), or to bound latency/cost on a metered API.
Shadow's automatic shrink-and-retry handles the overflow case for you, but setting a fitting value avoids
the wasted first attempt.

Check the current value any time with **`/config get maxOutputTokens`**.

---

## Reasoning effort

`effort` controls how hard reasoning-capable models think: `low · medium · high · xhigh · max`.

```
/effort high          # this session
/config set effort high
```

Or `--effort high` at launch, or `"effort": "high"` in the config. Higher effort = better on hard tasks,
slower and more tokens. Default is `high`.

---

## Autonomy & safety

Shadow gates tool calls by autonomy level (cycle live with **Shift+Tab**):

| Level | Behavior |
|---|---|
| `manual` | confirm **every** tool call |
| `auto-read` | auto-approve read/search/glob; confirm write/exec/network |
| `auto-edit` *(default)* | auto-approve reads + writes **inside the workspace**; confirm exec/network |
| `full` | auto-approve everything **except** the catastrophic-command denylist |

A catastrophic shell command (`rm -rf /`, `mkfs`, `dd of=/dev/…`, fork bombs, …) always triggers a
confirmation — even at `full`. `--yolo` drops *all* checks including the denylist; use it only in a
sandbox you don't mind losing. Outside `--yolo`/`full`, file writes stay inside the workspace (the jail).

---

## Everyday use

- **`/help`** lists every slash command; **`/model`**, **`/effort`**, **`/theme`**, **`/context`**,
  **`/copy`**, **`/export`**, **`/resume`**, **`/mcp`** are the common ones.
- **Ctrl-O** expands a collapsed reasoning / tool-output block; **PageUp/PageDown** or the mouse wheel
  scroll the transcript.
- **Ctrl-C twice** quits; **Esc** interrupts the current turn.
- Pipe a one-shot task non-interactively: `shadow --task "summarize README.md"` (scriptable, plain output).

---

## The config file

`~/.shadow/config.json` is plain, readable JSON you own. Common top-level keys:

| Key | Meaning |
|---|---|
| `provider` / `model` | the active provider + model id |
| `models[]` | your `/model` picker presets (each may carry its own `baseUrl` / `apiKey`) |
| `maxOutputTokens` | per-call output cap (default `65536`) |
| `effort` | reasoning effort (default `high`) |
| `autonomy` | default autonomy level (default `auto-edit`) |
| `renderer` | `stock` (native scrollback, default) or `cell` (owned viewport) |
| `lastTheme` | color theme |
| `mcpServers` | MCP servers to auto-connect |

Base URLs are sanitized on load — a stray `[http://…]` or quotes get normalized to a valid URL — so a
copy-paste slip won't silently break every request.

> **Trust boundary:** your global `~/.shadow/config.json` is trusted. A project-local config inside a repo
> is **de-fanged** — it cannot set base URLs, keys, hooks, or MCP command servers — so cloning an untrusted
> repo can't redirect your key or run code.

---

## Troubleshooting

**Reply is empty or cut off, stop reason `max_tokens`.** The output cap was hit — raise it (see
[Output length](#output-length-maxoutputtokens)). Common on reasoning models with a low cap.

**"raise --max-output-tokens".** Same cause — a reasoning model ran out of output budget. The default is
now 64k; if you lowered it, raise it back or unset it.

**Model won't connect / `Unable to connect`.** The endpoint is unreachable — check the base URL and that
the server is up (`curl <baseUrl>/models`). For local models on another box, confirm you're on the same
network/VPN.

**`Failed to parse URL`.** A malformed base URL. Recent builds sanitize this automatically on load; if you
still see it, run `shadow update`, or check `~/.shadow/config.json` for a `baseUrl` with stray brackets or
quotes and fix or delete it.

**Web search / fetch fails.** Make sure you're not in `--offline` mode (which drops the web tools by
design), and that you're on a build ≥ `v1.0.0-rc.2`.

**Composer jumps / can't scroll with the mouse.** Set `"renderer": "stock"` in your config (native
scrollback). `cell` is the pinned alt-screen viewport (PageUp/PageDown only).

**Text looks too dim / low-contrast.** Update — recent builds use a WCAG-AA palette with white primary
text and a readable secondary gray.
