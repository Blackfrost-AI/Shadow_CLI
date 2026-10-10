# Shadow — User Guide

A practical, task-oriented guide to running and tuning Shadow. For the feature overview, install
instructions, and security model, see the [README](README.md); this guide is the "how do I…" companion.

- [Install & update](#install--update)
- [Connect a model](#connect-a-model)
- [Qwen 3.8: hosted or self-hosted](#qwen-38-hosted-or-self-hosted)
- [Output length (`maxOutputTokens`)](#output-length-maxoutputtokens)
- [Self-hosted Qwen chat-template thinking](#self-hosted-qwen-chat-template-thinking)
- [Self-hosted model temperature](#self-hosted-model-temperature)
- [Reasoning effort](#reasoning-effort)
- [Autonomy & safety](#autonomy--safety)
- [Security foundation & harness add-ons](#security-foundation--harness-add-ons)
- [Learn reusable skills](#learn-reusable-skills)
- [Everyday use](#everyday-use)
- [The config file](#the-config-file)
- [Mission mode (`/goal`)](#mission-mode-goal)
- [Code intelligence (LSP + diagnostics)](#code-intelligence-lsp--diagnostics)
- [Troubleshooting](#troubleshooting)

---

## Install & update

The signed 8.7.1 transition release uses Blackfrost hosting. Existing standalone users can run
`shadow update` once through the legacy host; subsequent updates use Blackfrost. Windows installs
support built-in PowerShell 5.1, with no PowerShell 7 requirement.

```bash
# macOS / Linux
curl -fsSL https://blackfrostai.com/shadow/install.sh | sh
# Windows (PowerShell)
irm https://blackfrostai.com/shadow/install.ps1 | iex

shadow update        # pull the latest build in place
shadow --version
```

Shadow is a single self-contained binary — no Node or npm needed to run it. It reads your config from
`~/.shadow/config.json`. It sends no analytics or crash reports. Model providers, web tools,
configured MCP servers, plugin operations, and explicit updates can make network requests;
`shadow doctor --privacy` shows those paths. Published binaries built before the hosting move
need a bridge update or a reinstall before the legacy download host is retired.

---

## Connect a model

The fastest path is the onboarding wizard:

```bash
shadow onboard
```

It walks you through picking a provider (Anthropic, any OpenAI-compatible endpoint, Gemini, a local
llama.cpp/Ollama server, …) and entering a base URL + key. Shadow then probes the endpoint's model
catalog, detects local/self-hosted endpoints where it can do so honestly, and shows the model IDs the
key can access. Select one or several; only those become presets in `/model`, and you choose which is
the default. If discovery is unsupported, Shadow shows current agentic recommendations and keeps an
exact-ID escape hatch.

The terminal wizard uses the same retro banner and theme as your session. Start with **Local file**,
**Model server**, **Cloud provider**, or **Subscription account**. Each API provider menu shows five shortcuts, **Browse all providers**,
and **Custom endpoint**. The full list scrolls and supports search; no provider is hidden permanently.

- **↑/↓**, then **Enter**: choose an item. A typed number also requires Enter.
- **/**: search the provider or model list, including items outside the visible page.
- **Space**: select several models; Enter continues to the default-model choice.
- **Esc**: clear search first, then go back. During a check, cancel the check and return to setup.
- **Ctrl+C**: quit. Configuration changes happen only at **Save and finish**.

Keys remain masked when pasted or edited. Endpoint discovery has one six-second deadline, and the
connection check has a thirty-second deadline (sixty seconds for subscriptions). Verification waits
for a completed, valid tool response; a text fragment or usage count alone does not pass. Failed checks keep your entries and offer retry,
endpoint/key editing, another model, or an explicitly unverified save. The review screen shows the
endpoint, default model, model count, and connection status. It never displays your key.

Each endpoint gets its own credential reference, so adding another provider preserves previous
provider keys. If you already use an encrypted vault, setup unlocks it before saving into it.
Keyless servers explicitly use no authentication instead of inheriting a cloud key. Local files are
registered on confirmation and start on first use; run `shadow local test <name>` to test one.
Optional MCP extensions can be configured after connecting a model through `/mcp`.

The expanded catalog includes [Cerebras](https://inference-docs.cerebras.ai/resources/openai),
[Fireworks](https://docs.fireworks.ai/tools-sdks/openai-compatibility),
[DeepInfra](https://docs.deepinfra.com/chat/overview),
[Hugging Face](https://huggingface.co/docs/inference-providers/en/index), and
[NVIDIA NIM](https://docs.api.nvidia.com/nim/reference/llm-apis). These presets use their documented
compatible endpoints and discover model IDs from the account instead of pinning a model that may
be retired. Server choices also include [vLLM](https://docs.vllm.ai/en/stable/serving/openai_compatible_server.html),
[SGLang](https://github.com/sgl-project/sglang/blob/main/docs/docs/get-started/quickstart.mdx), and
[llama.cpp](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).

For Z.ai's Coding Plan, the curated fallback is `glm-5.3` plus `glm-5.3-flash`; legacy `glm-4.6` is
not selected unless the live API lists it and you explicitly choose it.

Once you have presets, switch between them live in the HUD with **`/model`** (↑/↓ to select, Enter to
switch). Each preset can carry its **own** base URL and key, so you can keep a local model and a cloud
model side by side and hop between them mid-session without losing context.

### Subscription accounts

Run `shadow onboard` → **Subscription account**, then choose:

- **Continue with ChatGPT**: browser sign-in using OpenAI’s native
  [Sign in with ChatGPT for open-source apps](https://developers.openai.com/siwc/token-sharing-open-source).
  Allow plan usage, choose an account/workspace and a model from that account’s live catalog, then
  verify and save. Your plan’s eligibility and usage limits apply; manage connections in
  [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage).
- **Claude Code subscription**: install the official [Claude Code CLI](https://code.claude.com/docs/en/setup).
  Shadow checks your existing sign-in or hands the terminal to Claude’s official login. Choose
  Sonnet, Opus or Haiku, then verify availability on your plan. The unmodified official engine
  returns validated proposals; Shadow continues to own its tools, approvals and session history.
  This follows the [current Claude subscription integration path](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

The verification consumes a small amount of plan allowance. Failed or cancelled verification keeps
your active model unchanged. API keys in the environment cannot override a subscription selection;
quota/authentication errors do not automatically switch to paid API billing. Explicitly choosing an
API preset with `/model` does switch billing paths.
Subscription tokens still count toward Shadow’s token/time limits, but Shadow does not price them
using API rates. Its dollar counter does not measure provider-side plan or extra-usage charges.

```sh
shadow login status
shadow login chatgpt                 # authenticate; then onboard to select/verify a model
shadow login chatgpt <profile-id>     # reconnect a saved account
shadow login chatgpt --no-open       # print the browser link for manual opening
shadow login claude                  # official Claude Code sign-in
shadow login logout <profile-id>     # ChatGPT: revoke and clear local credentials
```

`shadow login codex` is an alias for native ChatGPT sign-in. Claude sign-out remains
`claude auth logout`. Browser setup (`shadow onboard --web`) supports API keys/endpoints and links
back to terminal setup for subscriptions. A browser sign-in link returns to Shadow on the same
machine; a remote terminal requires forwarding its printed loopback port.

Shadow stores native ChatGPT tokens under `~/.shadow/chatgpt-auth` in owner-only files (0600,
directory 0700); they are **not encrypted by the API-key vault**. Account registrations remain after
logout for reconnection. Logout reports if server revocation could not be confirmed. Login links omit
retained identity-token hints, so reconnecting may ask you to choose the account again. Shadow never
reads or copies Claude Code’s login tokens.

Claude connection limits: final answer text appears after structured validation;
text and tool calls are supported, while images and custom stop sequences are rejected explicitly.
Ordinary engine tools, MCP, plugins and hooks are disabled; managed administrator hooks can still
apply. Shadow requests that the official engine disable nonessential traffic. Its sockets remain
outside Shadow’s fetch receipt, and the engine’s own account/privacy policies apply. Both account
connections are blocked in offline mode.

### Manual API presets

To add a preset without the wizard:

```
/model add "My Local 80B" openai my-local-80b http://10.0.0.5:8807/v1
```

**Local models (no key, no cloud):** `shadow local add <path-to.gguf>` on any platform, or on Apple
Silicon an MLX folder / `mlx-community/<model>` repo id (one-time HuggingFace download, then fully
local). Then `shadow local test <name>` and `shadow local use <name>` — Shadow launches and manages
the server itself.

## Qwen 3.8: hosted or self-hosted

For hosted Qwen, run `shadow onboard`, choose **Cloud**, then **Alibaba Qwen (DashScope)**. The
wizard starts with `qwen3.8-max` and the official OpenAI-compatible endpoint; live discovery is used
when DashScope exposes it, with exact model entry available before the connection test.

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

A separate `reasoning_content` or `reasoning` field makes the answer's `content` literal text,
including when the reasoning field is empty or null. Known inline-reasoning models instead split
only a leading `<think>…</think>` block; tags later in an answer or code example remain intact.
A model capability of `reasoning: "hidden"` disables tag guessing entirely, while an explicit
`"interleaved"` declaration allows both reasoning channels. If a server introduces its structured
field only after sending a leading tag, declare `"hidden"` to avoid that initial ambiguity.

Valid native tool calls are processed even when the response ends with `finish_reason: "length"`;
malformed arguments use the existing correction flow. Completed main-session Chat Completions
streams also save an `openai_stream_summary` debug record in the session log: frame and fragment
counts, bounded call indexes, argument lengths, parsed-call outcomes, finish reason, and requested
token limit. This diagnostic contains no raw prompts, reasoning, call names/IDs, or arguments.
Interrupted streams and subagent requests do not guarantee this summary.

---

## Secure your keys (encrypted vault)

By default a key you enter in `shadow onboard` is saved to `~/.shadow/credentials.json` (`chmod 600`,
plain JSON). If you'd rather your keys were **encrypted at rest**, use the secure setup instead:

```bash
shadow onboard --web
```

This opens a small form in your browser served **only** on `127.0.0.1` (a one-time token guards it and a
strict CSP prevents the page from contacting anything except that loopback server). You pick a
provider, paste your key, optionally click **Discover models** (Shadow then sends the key only to the
endpoint you selected), choose the model allowlist, and set a **master password**. Shadow seals the key into
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

## Self-hosted Qwen chat-template thinking

Some SGLang/Qwen servers accept a request-local chat-template switch. Configure it on the exact
model preset in `~/.shadow/config.json`; for example, to disable template-generated thinking for
an agent-tuned model:

```json
{
  "models": [
    {
      "label": "Local Security 9B",
      "provider": "openai",
      "model": "local-security-9b",
      "baseUrl": "http://192.0.2.10:8908/v1",
      "selfHosted": true,
      "capabilities": {
        "chatTemplateEnableThinking": false
      }
    }
  ]
}
```

On the OpenAI Chat Completions wire this adds
`"chat_template_kwargs": { "enable_thinking": false }`. Shadow does not infer the option from a
Qwen-like model name. It is omitted when the capability is unset and from cloud, Anthropic, and
OpenAI Responses requests.

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
`temperature`. And if a server on the OpenAI-compatible wire (including the opt-in Responses
wire) rejects it with a 400, Shadow's recovery ladder strips `temperature` from that request,
retries, and remembers the rejection for the rest of the session on that wire — you never pay
the same 400 twice (full ladder in [COMPAT_MATRIX.md](COMPAT_MATRIX.md)).

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

## Named profiles

A **profile** bundles a model with the settings that go with it, so switching workloads is one flag
instead of five edits. Define profiles in your global `~/.shadow/config.json` under `profiles`:

```json
{
  "models": [
    {
      "label": "Local Security 9B",
      "provider": "openai",
      "model": "local-security-9b",
      "baseUrl": "http://192.0.2.10:8908/v1",
      "selfHosted": true,
      "capabilities": { "chatTemplateEnableThinking": false }
    }
  ],
  "profiles": {
    "deep":  { "model": "gpt-5",             "effort": "max",  "autonomy": "auto-edit", "contextBudget": 200000 },
    "quick": { "model": "claude-haiku-4-5",  "effort": "low",  "autonomy": "manual" },
    "local": { "model": "qwen3-8b-local",    "sandbox": "off", "summarizeTriggerRatio": 0.8 },
    "local-security-9b": {
      "model": "Local Security 9B",
      "harnesses": ["incident-response"],
      "autonomy": "auto-read",
      "contextBudget": 220000,
      "maxIterations": 12,
      "maxToolResultChars": 32768,
      "maxOutputTokens": 32768,
      "parallelTools": false
    }
  }
}
```

Every field is optional — a profile can be just a `model`, or the full bundle. Fields a profile omits
fall through to your normal config. A profile may set: `model`, `effort`, `autonomy`, `sandbox`,
`contextBudget`, `summarizeTriggerRatio`, `harnesses`, `parallelTools`, `maxIterations`,
`maxToolResultChars`, and `maxOutputTokens`. `model` may be a model-preset label, as in
`Local Security 9B`; the preset owns its provider, endpoint, credentials, and endpoint capabilities. A
profile deliberately **cannot** carry a `provider`, `baseUrl`, credentials, keys, hooks, or anything
else that runs code or redirects a credential.

`harnesses` binds trusted add-ons when a new session starts. An empty array explicitly clears a
global harness selection for that profile, while an explicit `--harness` replaces the profile list
for that invocation. A resumed session keeps the harness receipt it started with.

Activate a profile at launch:

```
shadow --profile deep
SHADOW_PROFILE=deep shadow          # same thing via env
```

The switch is **atomic**: the profile's model + effort + autonomy + context all take effect together for
that run. Precedence is `CLI flag > env > profile > project config > global config > defaults`, so a
single `--effort` or `SHADOW_MODEL` still wins back one key while the profile sets the rest. An unknown
`--profile` name fails loudly at startup and lists the profiles you actually have; a malformed entry
reports the offending field. Profiles are **global-only** — a project-local `shadow.config.json` cannot
plant one. `/status` shows the active profile and exactly which keys it contributed.

---

## Autonomy & safety

Shadow gates tool calls by autonomy level. `/autonomy` works in both renderers; Ink also cycles the
levels with **Tab** when completion does not own the key. **Shift+Tab** toggles plan mode directly in
both renderers.

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

### The sandbox, and what happens when it can't run

Confinement and approval are **two separate axes**:

- **Capability** — `sandbox` (`"auto"` default / `"off"`) × what the host actually has
  (`sandbox-exec` on macOS, `bwrap` on Linux; nothing on Windows). `shadow doctor` reports the
  resulting state; `/status` shows it live.
- **Approval** — the autonomy level above, plus `sandboxFailurePolicy`: what happens when the
  sandbox was *requested* but this host can't enforce it. Shadow never silently fakes confinement —
  it prints a banner at startup and gates according to the policy:

| `sandboxFailurePolicy` | Unconfined `run_shell` behavior |
|---|---|
| `auto` *(default)* | stops at the approval gate; session approvals / allow-rules may suppress later prompts |
| `fail-closed` | the gate **never bends** — every unconfined call asks, every time |
| `warn` | no gate; a warning is folded into the tool result (pre-P2-12 behavior) |

The policy is a **global-only** setting (`~/.shadow/config.json`) — a project's
`shadow.config.json` cannot lower it. An explicit waiver (`sandbox: "off"`, `--no-sandbox`,
`--yolo`, `--autonomy full` at launch) never escalates: you already chose unconfinement.

### Untrusted content arrives in envelopes

Web pages (`web_fetch`), search snippets (`web_search`), and MCP server replies are bytes Shadow
does not own — any of them could carry instructions aimed at the model ("ignore previous
instructions and…"). Shadow wraps each one in a containment envelope: a provenance header naming
the tool and source, then the payload between `<<<UNTRUSTED_CONTENT_BEGIN>>>` /
`<<<UNTRUSTED_CONTENT_END>>>` markers — quoted, never rewritten (for `web_fetch` the payload is
the page's HTML→text reduction; everything from that point on is untouched). The system prompt
teaches the model to read anything inside the markers as data, never as instructions, and to tell
you when enveloped content tried to give it orders. Oversized payloads are clamped *before* the
envelope closes around them, so an envelope in the context is always closed — a truncated result
loses tail content, never its containment.

The envelope is containment, not prevention (THREAT_MODEL §4.2): it makes injections harder to
fall for, and the approval gate is still what stops one from *doing* anything. `full` autonomy +
web tools + a sensitive workspace remains a risk combination you are choosing.

---

## Terminal renderer support

Snowfall is the v10 development candidate's default terminal. Run `shadow`, or `npm start`
from a built source checkout. It owns a full-width conversation with a persistent composer
and a compact footer for task, agent, context and cost totals. Use `/tasks`, `/agents`,
`/context` and `/cost` for details. Saved themes still apply; use
`/theme snowfall` for the new ice palette.

```sh
SHADOW_TUI=ink shadow
```

This fallback retains Vim editing, experimental round-table `/table`, custom shell status lines,
and `~/.shadow/keybindings.json` mappings for the v10 cycle. Custom slash commands work in both
renderers. See the generated [command and key matrix](TERMINAL_RENDERERS.md) and the
[candidate verification record](docs/V10_VERIFICATION.md).

## Security foundation & harness add-ons

Every Shadow session starts with the built-in **Shadow Security** foundation. It gives the agent an
evidence-first security engineering baseline: keep scope and authority explicit, preserve material
evidence, separate observations from conclusions, prefer reversible actions, and prove the result
before calling work complete. Coding and systems work remain available when the task needs them.

The foundation is provider-neutral. It never selects or restricts a model, provider, endpoint,
credential, or deployment environment. Your onboarding choice, `/model` selection, or CLI override
still determines where inference runs. A harness also cannot widen autonomy, permissions, or the
sandbox.

Trusted local add-ons live directly under `~/.shadow/harnesses/<id>/`. They can add ordered
instructions and skills, require existing Shadow tools, or hide tools from the effective session.
The strict manifest rejects provider settings, credentials, hooks, MCP servers, script or executable
entry points, and other runtime-control fields. The package loader rejects symlinks, path escapes,
special files, and content over its size/count limits. Every accepted regular file contributes to the
package digest, but only declared Markdown instructions and recognized `skills/` entries are exposed
to the session. Files under `references/` and other extra regular files are inert: Shadow does not
inject, execute, or expose them as tools. If an add-on needs a native capability, its manifest may
require an adapter compiled into the installed Shadow binary.

A minimal package looks like this:

```text
~/.shadow/harnesses/example-sec/
├── harness.json
├── instructions/root.md
└── skills/example-workflow/SKILL.md
```

```json
{
  "schemaVersion": 1,
  "id": "example-sec",
  "version": "1.0.0",
  "title": "Example Security Workflow",
  "description": "An internal evidence and review workflow.",
  "instructions": ["instructions/root.md"],
  "requiredAdapters": [],
  "tools": {
    "add": ["read_file", "grep", "run_shell"],
    "remove": []
  }
}
```

Manage installed add-ons from the shell:

```bash
shadow harness list
shadow harness show example-sec
shadow harness validate example-sec
shadow harness enable example-sec       # add it to the configured stack
shadow harness disable example-sec
shadow harness use example-sec          # replace the configured stack with this add-on
shadow harness use security             # built-in foundation only
shadow --harness example-sec            # select it for this new session only
```

Inside Shadow, `/harness` and `/harness list` show the foundation, installed packages, the current
stack, and the next-session selection. `/harness show <id>`, `enable <id>`, `disable <id>`,
`use <id>`, and `use security` mirror the local management commands.

The stack resolves once when a new session starts. Changing the selection does not alter the
current session. Each session records the exact add-on IDs, versions, and content digests; resuming
fails closed if one of those packages was changed or removed instead of silently running a
different harness. An invalid package, missing required tool, conflicting tool policy, or missing
compiled adapter also stops startup with a concrete error.

Harness discovery, validation, and selection are local operations. They add no analytics,
telemetry, callback service, or remote catalog lookup. When a session uses an add-on, its selected
instructions and skill metadata become part of the normal model request and therefore go to the
provider or endpoint you configured.

`shadow harness validate` checks the package manifest, paths, files, and computed digest. Tool
readiness is host-specific, so a new session checks it against the tools that host actually exposes.
Unknown or unavailable requirements fail before startup hooks or provider work; terminal-only
orchestration requirements are rejected by web sessions instead of being advertised and then dropped.

## Learn reusable skills

`/learn [focus]` asks the active model to inspect a workflow and prepare a reusable skill with
references to available local session, artifact, test, or review evidence. This is a normal model
turn, so it uses the endpoint you already selected. The resulting draft stays local under
`~/.shadow/skills/.candidates/`; it does not enter the active skill catalog automatically.

Review and control the lifecycle explicitly:

```text
/skills pending
/skills show <name>
/skills validate <name>
/skills activate <name>
/skills reject <name> <reason>
/skills rollback <name> <generation>
```

Activation requires a structurally valid `SKILL.md`, at least one reusable claim tied to evidence,
and a recorded passing validation or replay receipt linked to evidence for every claim. Shadow checks
the receipt shape, identifiers, references, and digests; it does not rerun the named validation or
replay or authenticate the underlying evidence. Explicit local operator activation is the trust
gate. The model-facing `skill_manage` tool can draft, update, inspect, and validate candidates, but
it cannot activate, reject, or roll back one. Those decisions require the local operator commands
above. Activation writes the skill under `~/.shadow/skills/<name>/`; prior active generations remain
under `~/.shadow/skills/.revisions/`, and a new session loads the updated skill catalog.

The candidate store, evidence references, and decision receipts are local files. This lifecycle adds
no telemetry or callback upload for that store. `/learn` is a normal model turn, and `skill_manage`
inputs and results become model-visible conversation data, so that material is sent to the provider
or endpoint you selected just like other prompts and tool results.

## Everyday use

- **`/help`** describes the active renderer; **`/model`**, **`/effort`**, **`/theme`**, **`/context`**,
  **`/copy`**, **`/export`**, **`/resume`**, **`/fork`**, **`/compact`**, **`/harness`**, and **`/mcp`**
  are common. Use **`/learn`** and **`/skills`** to prepare and review evidence-backed local skills.
- **Branch a session with `/fork`**: copies the transcript so far into a new session id and switches
  to it, leaving the original untouched — try a risky refactor on the fork, keep exploring on the
  original. New turns and `/rewind` live in the fork, and pre-fork file checkpoints come with it.
- **Run a mission with `/goal <text>`**: starts a plan-gated orchestrator session — see
  [Mission mode](#mission-mode-goal). `/goal` alone prints status; `/goal clear` ends it.
- **Inspect execution with `/work`**: lists subagents, background shells, and planning items in
  one ownership-aware view in both Ink and pi. Use `/work show <id>` for timestamps, ownership,
  token/tool counts, safe file/tool facets, final output, and bounded recent activity; filter with
  `--type`, `--status`, `--tool`, or `--file`. Completed history is durable. Use
  `/work --all-sessions` or `/work --session <id>` for read-only cross-session queries, and
  `show <session-suffix>::<work-id>` to inspect a historical row.
  `/work cancel <id>` safely cancels a live background subagent through the existing agent
  cancellation path, and `/work kill <id>` terminates a live background shell. Background
  subagents can pause cooperatively at the next safe model/tool boundary with `/work pause <id>`
  and continue with `/work resume <id>`. Change a queued agent with
  `/work priority <id> low|normal|high`; running work with no activity for five minutes is marked
  stalled. `/work retry <id> --confirm` starts a linked new background run after exponential
  backoff; it never replays in place, is limited to three attempts, and requires the explicit flag
  because external effects may repeat. Foreground agents and historical rows are inspect-only.
  `/tasks` remains the model's planning checklist and does not mean executable background work.
  Activity history is capped at 100 records per item by default; set
  `SHADOW_WORK_TRANSCRIPT_LIMIT` to a positive value (capped at 10,000) when a different bound is
  required.
- **Use Work Center from the web console or ACP**: the authenticated loopback console Inspector
  lists live work, opens bounded detail, and exposes only valid per-item controls. ACP v1 now
  advertises and implements session loading and permission modes, exposes model selection through
  `session/set_config_option`, and keeps the older `session/set_model` compatibility method.
  Editors can discover Work Center support through `agentCapabilities._meta.shadowWorkExtension`
  and use the versioned `_shadow/work/list` and `_shadow/work/control` extension methods. Loaded
  history and cross-session Work Center data remain read-only; client-supplied MCP launch commands
  are refused during load.
- **Rewind with `/rewind`**: bare `/rewind` opens a picker that lists every rewindable turn with the
  prompt you sent; `/rewind <n>` jumps straight to turn `n`. By default a rewind restores BOTH the
  conversation and that turn's file checkpoints — **`--chat-only`** rewinds only the conversation
  (files untouched), **`--code-only`** restores only the files (conversation untouched). After a
  rewind the composer is prefilled with the first undone prompt, so you can rephrase and resubmit.
  `/resume` loads a prior session from its last snapshot.
- **Keep track of named sessions**: the opening prompt becomes a short session name, generated
  locally without another model request. It appears in the terminal title (`Website launch — Shadow`),
  `/session`, `/sessions`, and `/resume`. Type `/resume ` followed by part of a name to filter the
  choices; selecting a row uses its stable session ID. Use `/rename Website launch` to choose a
  name yourself. Names survive restarts, resumes and forks. `/new` (or `/clear`) starts a separate
  conversation so the previous named session stays available. Older logs get a name from their
  first readable prompt when available. Closing Shadow restores the terminal's previous title.
  Sessions created before harness-bound snapshots require a one-time explicit migration because an
  absent receipt cannot distinguish an old log from a copied or downgraded current log. Inspect the
  exact file, then run `shadow resume <id-or-path> --trust-legacy`. Shadow requires an explicit
  target and writes an owner-only receipt bound to that absolute path and the complete file digest;
  moving, copying, or changing the log invalidates it. The flag refuses current-format v2 sessions.
  This detects workspace-only replacement; it is not a cryptographic defense against another local
  process running as you that can rewrite both the session and its receipt under `~/.shadow/`.
- **Export the current transcript with `/export [path]`** for Markdown or `/export html [path]` for
  standalone HTML. A missing path creates a timestamped file under `exports/`; supplied paths stay
  confined to the workspace. Resumed history is read from the latest durable context snapshot.
- **Vim editing in Ink (`/vim`)**: the composer gets a vim NORMAL/INSERT model — **Esc** enters NORMAL;
  `i` `a` `I` `A` (and `o`/`O`, which open a new line) enter INSERT. Motions: `h l 0 $ w b e j k`
  plus in-line finds `f`/`F`/`t`/`T` — repeat the last find with `;`, reverse it with `,`. Edits:
  `x s d c y D C` with the usual operator+motion combos (`dw`, `c$`, `yy`, `d2w`, `2dd`…), paste
  with `p`/`P` (deletes and yanks share one unnamed register), `r` replace a char, `J` join lines.
  Numeric counts work everywhere (`3w`, `d2w`, `2fl` finds the second `l`). Every key stays inside
  the caret's hard line — `0`/`$`/`dd` never cross a newline — and every vim edit goes through the
  normal undo stack (**Ctrl-Z**). `/vim off` returns to the usual emacs-style editing. Pi's editor
  uses fixed editing keys in v10; start `SHADOW_TUI=ink shadow` when Vim mode is required.
- **Workspace memory**: the agent can save durable facts about your project (the build command,
  conventions, where key modules live) with its `memory` tool instead of re-discovering them each
  session. Only a one-line **index** of stored facts rides in the system prompt; the agent recalls
  a key's full value on demand. The store lives at `.shadow/memory.json` — inspect or hand-edit it
  there, and never put secrets in it.
- **Transcript navigation**: **Ctrl-O** opens or toggles activity detail in both terminals. In Ink,
  **PageUp/PageDown** navigate the transcript and optional mouse handling is enabled with
  `"mouse": true` or `SHADOW_MOUSE=1`. In Snowfall, PageUp/PageDown and the wheel scroll the transcript. Home/End jump
  to its start/latest output; Ctrl+Up/Down jump between prompts; Ctrl+Shift+F searches.
  On exit the complete conversation is printed into native terminal scrollback.
- **Copy & paste**: paste multi-line text straight into either composer (it inserts atomically —
  newlines never fire a send). Ink also provides **Ctrl-V** for the system clipboard and **Alt-C**
  for the last answer. `/copy` works in both terminals, and **`/copy code`** copies only the last
  fenced code block. Huge pastes condense to a `[Pasted text #N]` chip and expand again on send.
- **Accessibility**: `/theme colorblind` switches to an Okabe–Ito palette (safe under deuteranopia,
  protanopia, and tritanopia); `/theme high-contrast` is a WCAG-AAA loud mode. Your turns start with `◇`,
  assistant turns with `✻`, and failed tools with `✗ FAILED`; state never rides on color alone.
- **Tables & charts**: GFM tables render as rounded grids with numeric columns right-aligned; a fenced
  ` ```chart ` block (`label: value` lines, `type: bar|line|spark`) renders as a real unicode chart.
- **Ctrl-C twice** quits; **Esc** interrupts the current turn.
- Pipe a one-shot task non-interactively: `shadow --task "summarize README.md"` (scriptable, plain output).

---

## The web console (`shadow web`)

`shadow web` starts a local server and prints a launch URL — open it in a browser. The token in
the URL fragment is the credential: it is never transmitted to the server (the shell document is
served without auth precisely because it never sees the token), it lives in `sessionStorage`
(scoped to the port, so other local services cannot read it), and the address bar is scrubbed
after load. Refreshing keeps you signed in; copying the link to another browser on the same
machine works; the token stops working when the server exits.

The layout is three panes:

- **Sessions** (left) — one row per web session with a live status dot and relative time.
  `✎ New session` starts one in the project of your choice; `⚙` opens Settings. Under
  `shadow --web` the terminal's own session appears as a read-only mirror (composer disabled,
  live transcript streaming in).
- **Chat** (center) — the transcript streams live: markdown answers, thinking rows, tool cards
  that expand to full output and diffs. When a tool needs approval a dock slides in with
  **Allow once / Allow for session / Reject**; `ask_user_question` prompts render as answerable
  forms. Typing mid-turn queues the message — queued prompts drain one per completed turn, in
  order. The autonomy pill (bottom-left of the composer) sets the session's approval level and
  persists server-side. The **Trajectory** tab swaps the transcript for a timestamped timeline of
  everything that happened — same data, different lens.
- **Inspector** (right, `▤` to toggle) — session facts, usage accounting (turns, tokens, cache
  hit, cost), the last 12 requests with latency/TTFT, sub-agents, pending asks, and the raw last
  turn as a collapsible JSON tree.

**Settings** (`⚙`, either pane) is one sheet with five panes: **General** (light/dark/auto
theme), **Models** (add a preset, set default, enable/disable, delete — the vault-locked case
explains itself), **Agents** (built-ins are read-only; create your own), **MCP** (add/remove
servers; spawns happen at boot, so a new one applies on the next `shadow web` start), and
**Projects** — the allowlist itself. Removing a project closes its open web sessions; files on
disk are never touched.

Everything the console does goes through the same gated `/api` routes with the same project
allowlist jail as terminal sessions — it is a second face on the same agent, not a second agent.

---

## Optional browser automation (Playwright MCP)

Browser control is **off by default**. To opt in, install Node.js 18+ with `npx`, then run either:

```bash
shadow mcp enable browser       # from your shell
/mcp enable browser             # inside Shadow
```

Shadow pins the official `@playwright/mcp@0.0.79` server and launches a visible Chrome window with
an isolated profile, separate from your everyday Chrome cookies and logins. Restart Shadow after
enabling it; MCP servers connect when a session starts. Every browser tool is treated as executable:
at the default `auto-edit` level Shadow asks before it runs, unless you approve that tool for the
session or choose `full` autonomy.

Profile isolation prevents browser state from carrying between sessions; it is **not a security
boundary**. The MCP server and Chrome still run as your OS user and retain network access, so treat
visited pages as untrusted and do not use this profile for sensitive accounts. Disable the opt-in with
`shadow mcp disable playwright` (or `/mcp disable playwright`) and restart again.

---

## Plugins (data-only, local-first)

A plugin is a folder of markdown that adds **custom slash commands, output styles, skills,
sub-agent definitions, or workflows** — the five surfaces Shadow already reads from your workspace
and `~/.shadow`. There is no plugin runtime and no plugin code: a manifest that declares executable
surfaces (`hooks`, `mcpServers`, `scripts`, …) is refused at install, and only `.md` files ever
cross the install boundary.

```bash
shadow plugin add <git-url>      # or: shadow plugin add ./path/to/folder
shadow plugin list               # status, provenance (source + commit), what it contributes
shadow plugin enable my-pack     # /plugins enable my-pack works inside a session too
shadow plugin remove my-pack     # archives under ~/.shadow/plugins/.removed/ — never deletes
```

Key behaviors worth knowing:

- **Install ≠ activate.** Everything installs DISABLED so you can read the files first; a repo that
  bundles `.shadow/plugins/` can only OFFER a plugin — nothing is auto-loaded.
- **Precedence — per surface, and it is not uniform.** Slash commands and output styles:
  `workspace` < enabled plugins < your own `~/.shadow` files — your files win a name collision.
  **Sub-agent definitions are inverted:** `~/.shadow/agents` < plugins `<workspace>/.shadow/agents`
  — later wins, so a cloned repo's same-named definition overrides yours (read `.shadow/` before
  working in an unfamiliar clone; THREAT_MODEL §4.14). **Skills** scan workspace roots first,
  first-name-wins — the repo outranks plugins (there is no user-global skills dir). A disabled
  plugin contributes nothing.
- **Git installs are hardened:** scheme allowlist only (`https://`, `ssh://`, `file://`,
  `git@host:path`), scrubbed environment, shallow clone into a private temp dir, and the exact
  commit is recorded. Private repos that need an ssh-agent: clone it yourself and
  `shadow plugin add <path>`.
- **Offline mode** refuses remote clones (local `file://` sources still work).

Shadow ships with **no central plugin catalog.** If you want a searchable index, point the
`pluginIndexUrl` key at one (and `pluginIndexKey` at its ECDSA P-256 public key to require a valid
detached signature — unsigned/tampered indexes are refused outright). Then
`shadow plugin search [query]` lists entries and `shadow plugin add <name>` installs by name. The
index is display-only untrusted data; the URL it resolves still passes the same git allowlist.
`shadow doctor --privacy` reports whether the index path is active and whether it is
signature-verified. See [THREAT_MODEL.md](THREAT_MODEL.md) for the full trust model.

---

## The config file

`~/.shadow/config.json` is plain, readable JSON you own. Common top-level keys:

| Key | Meaning |
|---|---|
| `provider` / `model` | the active provider + model id |
| `models[]` | your `/model` picker presets (each may carry `baseUrl`, `apiKey`, and remote `selfHosted`) |
| `profiles` | global-only named bundles of model + harness + runtime settings — activate with `--profile <name>` (see [Named profiles](#named-profiles)) |
| `maxOutputTokens` | per-call output cap (default `65536`) |
| `temperature` | self-hosted model sampling temperature, `0`–`2` (default `1.0`; omitted from unmarked cloud APIs) |
| `effort` | reasoning effort (default `high`) |
| `autonomy` | default autonomy level (default `auto-edit`) |
| `lastTheme` | color theme |
| `mcpServers` | MCP servers to auto-connect |
| `web.token` | stable token for the `shadow web` console — ≥ 16 chars, no whitespace/control chars; default is a fresh random token each boot |
| `notify` | terminal ping on a long turn / waiting approval (default `auto`) — see below |
| `updateCheck` | opt-in update notice (default `false`) — see below |
| `diagnostics` | extension → linter/compiler command run after each successful file write — see below |
| `lsp` | LSP server diagnostics appended to write results (tsserver/pyright/gopls/rust-analyzer; detected, never installed) — see [Code intelligence](#code-intelligence-lsp--diagnostics) |
| `formatters` | auto-format after agent writes (prettier/biome/ruff/gofmt/rustfmt/shfmt; detected, never installed) |
| `hooks` | your own commands at lifecycle points (`pre_tool_use`, `stop`, …) — see below |
| `harnesses` | trusted add-on IDs loaded with the always-on Security foundation when a new session starts |
| `pluginIndexUrl` | optional plugin-index JSON for `shadow plugin search` / `add <name>` (off unless set; global-only) |
| `pluginIndexKey` | optional ECDSA P-256 public key (PEM) — require a valid detached signature on the index (fail-closed) |

Secrets live **outside** this file: either `credentials.json` (`chmod 600`) or, if you ran
`shadow onboard --web`, the encrypted `vault.enc` (see [Secure your keys](#secure-your-keys-encrypted-vault)).

Base URLs are sanitized on load — a stray `[http://…]` or quotes get normalized to a valid URL — so a
copy-paste slip won't silently break every request.

**Verify your privacy posture.** Run `shadow doctor --privacy` to see exactly what the active config can
send — every egress path (model provider, web tools, MCP servers, the opt-in update check) marked live or
inactive, where your keys live (encrypted vault vs plaintext), and whether offline mode is usable. It makes
**no network calls**. Add `--offline` to preview the offline posture.

> **Notifications (`notify`, default `auto`).** When a turn runs longer than ~20s, or an approval sits
> unanswered for ~12s, Shadow raises a terminal notification so you can tab away during a slow
> self-hosted run and be called back. `auto` uses your terminal's native desktop notification
> (iTerm2 / kitty / ghostty) and falls back to the terminal bell elsewhere; force a channel with
> `iterm2` · `kitty` · `ghostty` · `bell`, or set `"notify": "off"` to silence it. It is a **local**
> terminal escape — nothing leaves the machine, and it never fires into a pipe or redirect. Prefer a
> custom command? A `stop` hook runs at every turn end: `{"hooks": {"stop": ["printf '\\a'"]}}` (or any
> notifier you like, e.g. `terminal-notifier -message done`).

> **Update check (opt-in, off by default).** Set `"updateCheck": true` and Shadow will, at most **once a
> day**, do a single payload-free `GET` of the public `package.json` version and print a one-line notice if
> a newer release exists. It sends **no** identifiers, usage data, or key material, and never downloads
> anything on its own. Left at the default it makes **zero** network calls — this is the only outbound
> traffic Shadow can ever originate beyond your chosen model endpoint and the explicit web tools.

> **Diagnostics (`diagnostics`, off until you set it).** Map a file extension to a command and Shadow
> runs it after every **successful** `write_file` / `edit_file` / `multi_edit`, folding the output into
> the tool result — the model sees compiler and linter verdicts immediately and fixes them in-loop,
> instead of finding out at test time:
>
> ```json
> { "diagnostics": { "ts": "tsc --noEmit", "py": "ruff check {file}" } }
> ```
>
> `{file}` is replaced with the edited file's path (shell-quoted). Runs use the workspace as cwd, a
> scrubbed environment (no API keys are ever inherited), empty stdin, a 30-second timeout, and capped
> output. The timeout is **hard**: the diagnostic runs in its own process group and gets SIGTERM at
> the deadline, escalating to SIGKILL — even a hang-proof command cannot wedge your turn, and
> identical concurrent runs (parallel writes, one `tsc`) share a single invocation. On Windows, a
> filename with shell-active characters is **skipped with an advisory** rather than guessed at.
> A clean, silent run folds nothing — it costs zero context. Diagnostics only ever run from
> this **global** file; a project-local config cannot set them. They are advisory: a red linter is
> information for the model, never a failure of the write.

> **Hooks (`hooks`, off until you set it).** Run your own commands at lifecycle points:
> `session_start`, `session_end`, `user_prompt_submit`, `pre_tool_use`, `post_tool_use`,
> `pre_compact`, `post_compact`, `stop`, `subagent_stop`, `notification`. Each phase maps to an
> array of entries. An entry is a command string, or an object
> `{ "command": "…", "matcher": "edit_*|multi_edit" }` whose matcher filters the TOOL phases by
> tool name (`|`-separated globs; `*` = any run, `?` = one char; case-sensitive; ignored on
> non-tool phases). Every hook receives the phase payload as JSON on stdin
> (`{ "phase", "workspaceRoot", "tool", "input", "prompt", … }`), runs with the workspace as cwd,
> a scrubbed environment (no API keys are ever inherited), and a hard 30-second timeout.
>
> **The stdout contract.** A hook that exits 0 may print ONE JSON object on stdout (logs belong on
> stderr; anything that isn't a single JSON object is ignored, exactly like plain-log hooks have
> always been):
>
> - `{"decision": "block", "reason": "…"}` — blocks the action on the deny phases (`pre_tool_use`,
>   `user_prompt_submit`) even though the exit code was 0.
> - `{"context": "…"}` — folded into what the model sees (tool phases: the tool result;
>   `user_prompt_submit`: the prompt), control-characters stripped and clamped to 8 000 chars.
>
> Hooks can only ever make an action MORE restricted: a `decision` can never approve past the
> autonomy gate, which already ran before `pre_tool_use`. Fail-closed throughout — a non-zero exit
> blocks on deny phases, and a crashed hook contributes neither verdict nor context.
>
> **Trust rules.** Only the global `~/.shadow/config.json` can set hooks; a project-local config
> cannot. Hook commands must use ABSOLUTE script paths — a relative path is refused, never
> executed and never resolved against the workspace (a cloned repo shipping that same relative
> path would be a zero-interaction drive-by).
>
> ```json
> { "hooks": {
>     "pre_tool_use": [
>       { "command": "/usr/local/bin/guard-edits.sh", "matcher": "write_file|edit_*|multi_edit" }
>     ],
>     "stop": [ "printf '\\a'" ]
> } }
> ```

> **Trust boundary:** your global `~/.shadow/config.json` is trusted. A project-local config inside a repo
> is **de-fanged** — it cannot set base URLs, keys, hooks, diagnostics, or MCP command servers — so cloning
> an untrusted repo can't redirect your key or run code.

---

## Editor integration (ACP)

Editors that speak the **Agent Client Protocol** — Zed first among them — can drive Shadow as their
agent. Point your editor's ACP agent command at `shadow acp` and it speaks JSON-RPC 2.0 over
stdin/stdout, one message per line. Shadow becomes the model behind your editor's agent panel: you
prompt it there, it streams replies, tool calls, and a todo/plan list back, and asks you for
permission before running tools — all inside the editor.

### Set it up

1. **Allowlist your project.** A session may only be created inside an allowlisted directory. Either
   pass the path when you configure the agent, or add it ahead of time:

   ```sh
   shadow acp --add-project /path/to/your/repo
   ```

   The flag is repeatable and idempotent (adding the same path twice is a no-op), and it's safe to
   include in your editor's agent configuration. If you try to open a session in a directory that
   isn't allowlisted, Shadow refuses with a message naming the exact command to run.

2. **Point the editor at Shadow.** In your editor's ACP/agent settings, set the agent command to
   `shadow acp` (use the full path if `shadow` isn't on the editor's `PATH`). That's it — the editor
   spawns the process and talks to it over stdio.

3. **Unlock the vault once.** Under an editor, stdin is the RPC wire, so Shadow can never pop an
   interactive password prompt there. Unlock once from a real terminal first (`shadow` and follow the
   prompt, or set `SHADOW_VAULT_PASSWORD` in the editor's environment) so the OS keychain caches the
   key. If the vault is still locked when the editor starts, Shadow keeps serving but any session
   build that needs credentials fails with a clear error — it never hangs or prompts.

### Using it

- **Prompting.** Send a message and Shadow streams text back as it's produced. Tool calls appear with
  a status (running → completed/failed) and, for file edits and shell commands, a kind badge.
- **Permission prompts.** Before a tool that needs approval runs, the editor shows a permission
  dialog: **Reject**, **Allow once**, or **Allow for this session**. Allow-for-session is remembered
  for the rest of that session. Anything ambiguous — a dismissed dialog, an editor error, a cancelled
  turn — is treated as **deny**.
- **Cancelling.** The editor's stop/cancel action interrupts the current turn. Shadow stops the turn
  and reports it as cancelled.
- **Delegation.** When Shadow spins up sub-agents, their events are tagged `[subagent <id>]` so you
  can see delegated work in the stream.

### v0 limitations (by design)

- **Text-only prompts.** Images and other non-text blocks aren't accepted yet — the editor sends
  text, Shadow replies with text.
- **No session restore, mode, or model switching.** `session/load`, `session/set_mode`, and
  `session/set_model` return a clear "not supported" error rather than silently doing nothing.
  Each new editor session starts fresh.
- **Shell output is delivered when the command finishes,** not streamed live. Long-running commands
  report their result in the final tool-call update.
- **Unsaved editor buffers.** Shadow reads files from disk. If you have unsaved changes in an editor
  buffer, save first — Shadow sees what's on disk, not what's in your editor's memory.

---

## Mission mode (`/goal`)

`/goal <text>` turns a vague objective into a tracked mission: Shadow enters **plan mode**
automatically, the agent explores and writes the plan with `plan_write` (including a concrete
`tasks` list — the plan file renders them as checkboxes), and `exit_plan_mode` asks for your
approval as usual. Approve, and the harness seeds the task list: the mission moves to
**executing** and the HUD pins one line — `🎯 <mission> · executing 1/5` — in the status row
while turns run, and in the pinned block while idle.

From there the agent works the list: it advances tasks and phases with `mission_update`
(`executing → verifying → done` or `failed`), dispatches sub-tasks to background agents when
that helps, and is instructed to **verify with real evidence before calling anything done** —
a mission is not complete while tasks remain or the end state is unverified, and the agent
must report failures honestly. The mission block is pinned into every lead-agent turn
(summarization can't lose it), and it survives `/resume` — mission state journals with the
session and rehydrates on the way back in.

- `/goal` — full status: mission, phase, plan file, and every task with its evidence.
- `/goal clear` — end the mission (the plan file stays on disk).
- `/goal <text>` while a turn is running is safe: the mission begins immediately, its kickoff
  turn queues behind the current one.

Two deliberate limits: **sub-agents never see the mission** (only the lead agent orchestrates —
their `mission_update` calls are inert), and **a mission inherits your session autonomy** —
nothing about a mission softens a permission gate, budget, or the sandbox.

---

## Code intelligence (LSP + diagnostics)

After the agent successfully writes or edits a file, Shadow gives the model a compiler's view of
its own work, in three advisory layers (none can fail the write or widen permissions):

1. **Auto-format** (`formatters`) — the project's detected formatter rewrites the file
   (prettier/biome/ruff/gofmt/rustfmt/shfmt). Kill switch: `SHADOW_NO_FORMAT=1`.
2. **Diagnostics command** (`diagnostics`) — a configured per-extension command (e.g.
   `"ts": "tsc --noEmit"`) runs and its verdict rides the result.
3. **LSP diagnostics** (`lsp`, 8.4) — the richest layer: a real language server diagnoses the
   file, so the model sees `src/foo.ts:12:5 — Property 'bar' does not exist (error, TS2339)`
   inside the tool result and can fix it on the next turn — no extra prompt, no round-trip.

**Which servers?** Only ones already on your machine — Shadow never installs anything:
- TypeScript: `typescript-language-server` on PATH — or the project's own
  `node_modules/typescript` (tsserver) **if you opt in** with `"trustNodeModules": true` below
  (that file is repo content; a cloned repo must never be able to make Shadow run it on its own.
  Without the opt-in Shadow skips it and tells you once per session).
- Python: `pyright-langserver` · Go: `gopls` · Rust: `rust-analyzer` (each on PATH)

Nothing relevant detected → the feature is silently dormant.

**Tuning** (`~/.shadow/config.json`, global — a cloned repo cannot touch this block):

```json
{
  "lsp": {
    "enabled": true,
    "timeoutMs": 3000,
    "trustNodeModules": false,
    "notes": { "maxTurnChars": 8000, "maxSessionChars": 60000 }
  }
}
```

Notes are deduped (an identical diagnostic never repeats) and budget-capped, so a broken file
can't flood the context — the #1 complaint about LSP-rich agents. When the session budget trips,
notes pause for the session and one notice says so. Kill switch: `SHADOW_NO_LSP=1`.

**Privacy:** servers run as local stdio children with a scrubbed environment (no credentials
inherited), reading only workspace files; Shadow makes no network request for them. They run as
your user, like any dev tool — `shadow doctor --privacy` lists exactly which servers would spawn
in the current directory.

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

**Can't scroll with the mouse.** In Ink, mouse tracking is off by default so Shadow does not take
over normal terminal selection. Use PageUp/PageDown, or opt in with `"mouse": true` in config (or
`SHADOW_MOUSE=1` for one run). Snowfall scrolls the pane under the pointer; PageUp/PageDown scroll
the conversation and End returns to the latest output. Use your terminal's mouse-bypass modifier
for native selection. The complete conversation enters native scrollback when Snowfall exits.

**Text looks too dim / low-contrast.** Update — recent builds use a WCAG-AA palette with white primary
text and a readable secondary gray.

**Vault won't unlock / keeps asking for the master password.** The OS-keychain cache may be missing (a
headless box, or a machine with no keychain). Either type the password each session, or set
`SHADOW_VAULT_PASSWORD` in your environment for unattended runs. If you've genuinely forgotten the master
password there's no recovery by design — delete `~/.shadow/vault.enc` and re-run `shadow onboard --web`
(or `shadow onboard` to go back to a plaintext key). An `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in the
environment bypasses the vault entirely.
