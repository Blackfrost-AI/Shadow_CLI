# Shadow — User Guide

A practical, task-oriented guide to running and tuning Shadow. For the feature overview, install
instructions, and security model, see the [README](README.md); this guide is the "how do I…" companion.

- [Install & update](#install--update)
- [Connect a model](#connect-a-model)
- [Qwen 3.8: hosted or self-hosted](#qwen-38-hosted-or-self-hosted)
- [Output length (`maxOutputTokens`)](#output-length-maxoutputtokens)
- [Self-hosted model temperature](#self-hosted-model-temperature)
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

**Local models (no key, no cloud):** `shadow local add <path-to.gguf>` on any platform, or on Apple
Silicon an MLX folder / `mlx-community/<model>` repo id (one-time HuggingFace download, then fully
local). Then `shadow local test <name>` and `shadow local use <name>` — Shadow launches and manages
the server itself.

---

## Qwen 3.8: hosted or self-hosted

For hosted Qwen, run `shadow onboard`, choose **Cloud**, then **Alibaba Qwen (DashScope)**. The
wizard starts with `qwen3.8-max` and the official OpenAI-compatible endpoint; you can edit the model
ID before the connection test.

For the forthcoming open-weight release, use the exact served model ID published with the weights —
Shadow does not maintain an allowlist or rewrite it:

```text
/model add "Qwen 3.8 local" openai <official-served-model-id> http://127.0.0.1:8000/v1 --self-hosted
/model test "Qwen 3.8 local"
/config set temperature 0.7
```

Replace the URL with your llama.cpp, vLLM, SGLang, Ollama, or other OpenAI-compatible server. A
loopback/LAN URL is recognized as self-hosted automatically; retain `--self-hosted` for clarity, and
use it whenever your own server has a public hostname. The global `temperature` setting defaults to
`1.0` and is sent only to endpoints Shadow has proved or you have marked as self-hosted.

Qwen model IDs pass through unchanged rather than being allowlisted. Shadow parses both
`reasoning_content` and newer `reasoning` streams and handles native as well as Qwen/Hermes XML
tool calls. On a verified DashScope endpoint, Qwen 3.8 Max additionally uses the documented
`max_completion_tokens`, adaptive reasoning-effort, and preserved-thinking contract; its historical
reasoning stays separate from visible content and is sent back on later turns. That preserved
reasoning counts toward input tokens and billing. Unknown open-weight variants remain
capability-neutral until their server documents its actual wire behavior.

---

## Secure your keys (encrypted vault)

By default a key you enter in `shadow onboard` is saved to `~/.shadow/credentials.json` (`chmod 600`,
plain JSON). If you'd rather your keys were **encrypted at rest**, use the secure setup instead:

```bash
shadow onboard --web
```

This opens a small form in your browser served **only** on `127.0.0.1` (a one-time token guards it and a
strict CSP blocks every outbound request — a key typed there physically cannot leave your machine). You
pick a provider, paste your key, and set a **master password**. Shadow seals the key into
`~/.shadow/vault.enc` — **scrypt → AES-256-GCM** (authenticated: a wrong password or a tampered file
simply won't open). No plaintext key file is written.

**Unlocking on later runs**, in order:

1. **OS keychain** (macOS Keychain / Linux libsecret / Windows DPAPI) — Shadow caches the derived *key*
   (never the password) so on a machine with a keychain you type the password **once** and future launches
   unlock silently.
2. **`SHADOW_VAULT_PASSWORD`** environment variable — for headless / CI boxes with no keychain.
3. **Interactive prompt** — masked, three tries, if neither of the above applies.

**Adding more providers.** Re-run `shadow onboard --web` any time to add another key — it **merges** into
your existing vault (unlocking silently via the keychain, or asking for your master password), so you can
hold an Anthropic key and a Z.ai/GLM key in the same vault without one clobbering the other.

If you already have a plaintext `credentials.json`, the first interactive run **offers to encrypt it into
the vault and then shreds the plaintext** (overwrite-then-remove). Environment variables
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) still override everything, so key-in-env and CI workflows are
unchanged whether or not you use the vault.

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

## Self-hosted model temperature

Set the sampling temperature for locally hosted OpenAI-compatible models in
`~/.shadow/config.json`:

```json
{
  "temperature": 0.7
}
```

The default is `1.0`; valid values are `0` through `2`. Lower values make output more
deterministic, while higher values increase variation.

Shadow sends this setting only when the resolved model endpoint is self-hosted on loopback,
`.local`, or a private/LAN IP (including Shadow-managed GGUF, MLX, and vLLM servers). It is omitted
from Anthropic, OpenAI, and other public cloud requests, including after a model switch or fallback.
OpenAI GPT-5/o-series reasoning requests omit it as well because that request family rejects
`temperature`.

If your self-hosted server has a public hostname or IP, Shadow cannot safely distinguish it from a
hosted API by URL alone. Mark that trusted endpoint explicitly alongside its `baseUrl`:

```json
{
  "provider": "openai",
  "model": "my-model",
  "baseUrl": "https://models.example.net/v1",
  "selfHosted": true,
  "temperature": 0.7
}
```

The same optional `"selfHosted": true` marker can be placed on an entry in `models`. Never set it
on a public cloud preset; local/LAN endpoints are detected automatically and do not need it. The
equivalent TUI command is `/model add <label> openai <model> <baseUrl> --self-hosted`; the web model
form exposes the same choice as **Remote self-host**.

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
confirmation — even at `full`. Launching with `--autonomy full` drops the filesystem jail and OS
sandbox but keeps that denylist; switching to `full` mid-session changes approvals without widening
the launch sandbox. `--yolo` drops *all* checks including the denylist; use it only in a sandbox you
don't mind losing.

---

## Everyday use

- **`/help`** lists every slash command; **`/model`**, **`/effort`**, **`/theme`**, **`/context`**,
  **`/copy`**, **`/export`**, **`/resume`**, **`/mcp`** are the common ones.
- **Ctrl-O** expands a collapsed reasoning / tool-output block; **PageUp/PageDown** scroll the
  transcript. Mouse input is opt-in with `"mouse": true` or `SHADOW_MOUSE=1`.
- **Copy & paste**: paste multi-line text straight into the composer (it inserts atomically — newlines
  never fire a send); **Ctrl-V** pastes from the system clipboard explicitly; **Alt-C** (or `/copy`)
  copies the last answer, **`/copy code`** just its last fenced code block. Huge pastes condense to a
  `[Pasted text #N]` chip and expand again on send.
- **Accessibility**: `/theme colorblind` switches to an Okabe–Ito palette (safe under deuteranopia,
  protanopia, and tritanopia); `/theme high-contrast` is a WCAG-AAA loud mode. Your turns carry a `▌`
  bar on every line and failed tools a `✗` — state never rides on color alone.
- **Tables & charts**: GFM tables render as rounded grids with numeric columns right-aligned; a fenced
  ` ```chart ` block (`label: value` lines, `type: bar|line|spark`) renders as a real unicode chart.
- **Ctrl-C twice** quits; **Esc** interrupts the current turn.
- Pipe a one-shot task non-interactively: `shadow --task "summarize README.md"` (scriptable, plain output).

---

## The config file

`~/.shadow/config.json` is plain, readable JSON you own. Common top-level keys:

| Key | Meaning |
|---|---|
| `provider` / `model` | the active provider + model id |
| `models[]` | your `/model` picker presets (each may carry `baseUrl`, `apiKey`, and remote `selfHosted`) |
| `maxOutputTokens` | per-call output cap (default `65536`) |
| `temperature` | self-hosted model sampling temperature, `0`–`2` (default `1.0`; omitted from unmarked cloud APIs) |
| `effort` | reasoning effort (default `high`) |
| `autonomy` | default autonomy level (default `auto-edit`) |
| `lastTheme` | color theme |
| `mcpServers` | MCP servers to auto-connect |
| `updateCheck` | opt-in update notice (default `false`) — see below |

Secrets live **outside** this file: either `credentials.json` (`chmod 600`) or, if you ran
`shadow onboard --web`, the encrypted `vault.enc` (see [Secure your keys](#secure-your-keys-encrypted-vault)).

Base URLs are sanitized on load — a stray `[http://…]` or quotes get normalized to a valid URL — so a
copy-paste slip won't silently break every request.

**Verify your privacy posture.** Run `shadow doctor --privacy` to see exactly what the active config can
send — every egress path (model provider, web tools, MCP servers, the opt-in update check) marked live or
inactive, where your keys live (encrypted vault vs plaintext), and whether offline mode is usable. It makes
**no network calls**. Add `--offline` to preview the offline posture.

> **Update check (opt-in, off by default).** Set `"updateCheck": true` and Shadow will, at most **once a
> day**, do a single payload-free `GET` of the public `package.json` version and print a one-line notice if
> a newer release exists. It sends **no** identifiers, usage data, or key material, and never downloads
> anything on its own. Left at the default it makes **zero** network calls — this is the only outbound
> traffic Shadow can ever originate beyond your chosen model endpoint and the explicit web tools.

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
design), and update to the current build before troubleshooting an older installation.

**Can't scroll with the mouse.** Mouse tracking is off by default so Shadow does not take over normal
terminal selection. Use PageUp/PageDown, or opt in with `"mouse": true` in config (or
`SHADOW_MOUSE=1` for one run).

**Text looks too dim / low-contrast.** Update — recent builds use a WCAG-AA palette with white primary
text and a readable secondary gray.

**Vault won't unlock / keeps asking for the master password.** The OS-keychain cache may be missing (a
headless box, or a machine with no keychain). Either type the password each session, or set
`SHADOW_VAULT_PASSWORD` in your environment for unattended runs. If you've genuinely forgotten the master
password there's no recovery by design — delete `~/.shadow/vault.enc` and re-run `shadow onboard --web`
(or `shadow onboard` to go back to a plaintext key). An `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in the
environment bypasses the vault entirely.
