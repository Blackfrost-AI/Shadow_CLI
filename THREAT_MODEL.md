# Shadow — Threat Model

**Status:** living document · matches Shadow **v2.6.x**
**Companion:** run `shadow doctor --privacy` to verify the egress posture of *your* config at any time.

Shadow is a coding agent: it runs a language model in a loop with tools that read files, write files,
and execute shell commands. This document states — honestly — what Shadow protects, **how**, and what
it does **not** protect. Claims here map to real mechanisms in the source; limits are stated with the
same prominence as guarantees. If a sentence in our marketing ever disagrees with this document, this
document wins.

---

## 1. The one-paragraph philosophy

**The model is untrusted input.** Everything a model emits — text, tool calls, "reasoning" — is
treated the way a browser treats a web page: potentially adversarial output that must be *contained*,
not trusted. Containment comes from four mechanisms working together: the **workspace jail** (file
tools), the **OS sandbox** (shell), the **approval gate** (autonomy levels), and **scoped secrets**
(env allowlist + encrypted vault). Nothing in Shadow's safety story depends on the model being
well-behaved.

## 2. Trust model

| Thing | Trust level | Why |
|---|---|---|
| The model's output | **Untrusted** | May be wrong, manipulated, or adversarial (prompt injection) |
| Fetched web content / search results | **Untrusted data** | Never instructions; see limits in §4.2 |
| A cloned repo's `shadow.config.json` | **Untrusted** | De-fanged on load (§3.7) |
| Your global `~/.shadow/` config | **Trusted by design** | It is *your* file on *your* machine (§4.9) |
| Configured MCP servers | **Trusted once added** | They run as your user; vet before adding (§4.7) |
| The provider endpoint you configure | **Fully trusted with your data** | The conversation goes there — that is the product working as designed (§4.8) |
| The local model runtime (llama.cpp, Ollama) | **Trusted infrastructure** | A trojaned runtime is out of scope (§4.8) |
| Env vars, CLI flags, the installer | **Trusted** | Standard local-machine trust (§4.11) |

**Assets protected:** your API keys; files outside the workspace; the workspace itself (from
catastrophic commands); your network posture (SSRF); the privacy of the session (no telemetry).

## 3. Mechanisms and their real guarantees

### 3.1 Workspace jail — file tools
Every file-tool path resolves to an absolute path that must stay inside the workspace root (plus any
explicitly granted `--add-dir` roots). Symlinks are collapsed against the deepest existing ancestor,
so a symlink pointing outside — or a **not-yet-created** path — cannot escape.
**Limit:** the jail governs *file tools only*. Shell commands are contained by the OS sandbox (§3.2),
not the jail.

### 3.2 OS sandbox — `run_shell`
- **macOS** (seatbelt): writes denied everywhere except the workspace, granted dirs, and temp dirs;
  reads *and* writes of `~/.shadow` denied (your keys are invisible to shell commands).
- **Linux** (bubblewrap): whole filesystem read-only; workspace + `/tmp` writable; `~/.shadow`
  masked by an empty tmpfs; PID namespace unshared (blocks `/proc/<pid>/environ` key theft).
- **Windows:** **no OS sandbox exists.** `run_shell` is unconfined. This is stated, not hidden.

**Limits:** the sandbox **fails open** — if `sandbox-exec`/`bwrap` is missing, commands run
unconfined (the status is reported, never silently faked). Reads outside the workspace are **allowed
by design** on macOS/Linux (builds need headers, node_modules, etc.) — so a sandboxed command can
still *read* `~/.ssh` or `~/.aws`; pair with `sandboxNetwork: false` or `--offline` to cut the
exfiltration path. Network egress from the sandbox is allowed by default (installs need it).

### 3.3 Secrets — scoped env + encrypted vault
Shell commands receive an **allowlist** of ~8 environment variables (`PATH`, `HOME`, `TERM`, …).
Provider API keys are **never** in a subprocess environment. At rest, keys live either in
`credentials.json` (0600) or the **encrypted vault**: scrypt (N=2¹⁶, r=8, p=1) → AES-256-GCM,
authenticated — a wrong password or a tampered file fails closed. The OS keychain caches the
*derived key*, never the password.
**Limits:** vault security is bounded by master-password strength (offline brute force of a stolen
`vault.enc` is feasible against weak passwords). Anyone inside your unlocked OS session can use the
keychain-cached key (that is what "unlocked session" means). `SHADOW_VAULT_PASSWORD` for headless use
sits in the environment in plaintext — prefer the keychain on interactive machines.

### 3.4 Network guard — web tools
`web_fetch`/`web_search` refuse non-HTTP schemes and any host resolving to loopback, RFC-1918,
link-local, CGNAT, cloud-metadata (`169.254.169.254`), or v6-transition addresses. The connection is
**pinned to the validated IP** (defeats DNS rebinding) and every redirect hop is re-validated and
re-pinned (5-hop cap).
**Limit:** a fetch to any *public* host is permitted once approved — a manipulated model with
`network` approval can still POST data to a public endpoint. The gate, not the guard, is the control
for that (§3.6).

### 3.5 Denylist — fat-finger guard, **not** a boundary
Catastrophic command patterns (`rm -rf /`, `mkfs`, `dd of=/dev/…`, fork bombs) are refused even at
full autonomy. The source code itself says what we repeat here: it is **trivially bypassed by
indirection** (env vars, subshells, base64). It exists to stop accidents, not attackers. The real
boundary is the sandbox.

### 3.6 Approval gate — autonomy levels
`manual` → every tool call approved; `auto-read` → reads free, writes/exec approved;
`auto-edit` (default) → edits free, exec approved; `full` → everything auto-approved except
denylist hits. Every gated call passes one seam (the ApprovalGate), which is also where session
and prefix approvals live.
**Limit:** at `full`, containment shrinks to sandbox + jail + denylist. That is a deliberate,
user-chosen trade.

### 3.7 Untrusted project config — drive-by defense
A cloned repo's `shadow.config.json` **cannot**: redirect your keys (`baseUrl` stripped), re-add
secrets, raise autonomy, weaken the denylist or sandbox, swap the system prompt, widen the jail, run
startup hooks, or register MCP servers (dropped entirely). Model presets from a project file are
stripped of `gguf`/`ggufServer`/`ggufArgs` — a preset that spawns a binary pre-LLM would be
zero-interaction RCE.

### 3.8 MCP — always execution-risk
MCP tools are always gated as `exec` risk. A server's self-declared `readOnlyHint` is deliberately
**not trusted** — a malicious server could label `delete_files` read-only. See §4.7 for what MCP
trust still means.

### 3.9 Offline mode — subtractive by construction
`--offline` requires a local model (or aborts), does **not register** web tools (the model can't
call what doesn't exist), skips MCP servers, denies sandbox network egress, and suppresses even the
opt-in update check. Mid-session `/model` switches to cloud endpoints are refused.
**Limit:** the shell-egress denial rides on the OS sandbox — on Windows (no sandbox), `--offline`
still drops web tools and MCP but **cannot** stop a shell command from reaching the network.

### 3.10 Zero telemetry — verifiable
No analytics, crash reporting, or phone-home. The only egress: your provider, the web tools when
invoked, and (opt-in, off by default, once daily, payload-free) the update check.
`shadow doctor --privacy` prints every egress path for the active config, live vs inactive, with **no
network calls**. A source-level test (`no-telemetry`) pins the absence of install identifiers.

## 4. What Shadow does NOT protect against

Stated with the same weight as the guarantees. If any of these matter to your threat environment,
compensate accordingly.

1. **Malicious/steered model output is contained, never prevented.** The gate + sandbox limit what
   it can *do*, not what it can *try*.
2. **Prompt injection has no mechanical fix.** "Fetched content is data, not instructions" is
   enforced by framing and the approval gate — a model that ignores the framing will follow injected
   instructions right up to the containment boundary. Treat `full` autonomy + web tools + sensitive
   workspace as a risk combination *you* are choosing.
3. **The sandbox fails open** where the OS tool is missing, and does not exist on Windows.
4. **Read-then-exfiltrate:** sandboxed commands can read most of your home directory and reach the
   network by default. Cut one of the two (`sandboxNetwork: false`, `--offline`) if that's in your
   threat model.
5. **Redaction is best-effort.** Session logs mask known key shapes and registered secrets; novel
   secret formats can leak into logs. Redaction is never the reason something is safe to log.
6. **A weak master password bounds the vault.** scrypt slows brute force; it does not defeat a
   dictionary password.
7. **MCP servers are your trust decision.** Once configured they run as your user, unsandboxed; the
   HTTP MCP transport is not SSRF-guarded. Vet what you add.
8. **The provider sees everything you send it** — that is the product working. Local models move
   this trust to your own hardware and runtime, which you likewise trust.
9. **Your own `~/.shadow` is trusted.** An attacker with home-directory write access owns the agent
   (and everything else you run).
10. **`--yolo` voids the warranty.** Jail, sandbox, denylist, approvals — all off, by explicit flag.
11. **Supply chain is out of scope of runtime mechanisms.** The installer verifies release
    signatures (ECDSA-P256, offline key, pinned in the installer); beyond that, the binary, Bun, and
    npm dependencies are trusted at build/install time.
12. **Side channels, kernel exploits, and a compromised OS** are out of scope entirely.

## 5. Platform matrix

| Capability | macOS | Linux | Windows |
|---|---|---|---|
| OS sandbox for `run_shell` | ✅ seatbelt | ✅ bubblewrap | ❌ none |
| `~/.shadow` invisible to shell | ✅ | ✅ (tmpfs mask) | ❌ |
| Denylist patterns | ✅ unix | ✅ unix | ⚠ unix-oriented — add PowerShell rules via `denylistExtra` |
| Keychain for vault key | ✅ Keychain | ✅ libsecret | ⚠ DPAPI (any process as your user can unprotect) |
| Workspace jail (file tools) | ✅ | ✅ | ✅ |
| Offline mode | ✅ full | ✅ full | ⚠ web/MCP dropped; shell egress not blockable |

**Windows is not at parity.** If your threat model needs OS-level shell containment, run Shadow on
macOS or Linux.

## 6. Operator responsibilities

- **Pick autonomy deliberately.** `auto-edit` is the shipped default; `full` is a trade you make.
- **Use a strong master password** if you use the vault; prefer the keychain over the env var.
- **Vet MCP servers** like you'd vet a shell script you `curl | bash`.
- **On Windows,** add PowerShell denylist rules (`denylistExtra`) and don't assume sandbox behavior.
- **For paranoid workloads:** `--offline` with a local model is the strongest posture Shadow offers —
  no cloud, no web tools, no MCP, no update check, sandbox egress denied.

## 7. Verification

- `shadow doctor --privacy` — the live egress report for your config (no network calls).
- `shadow doctor` — sandbox/tool availability (so a fail-open never surprises you).
- The test suite pins the security behaviors above (jail, netguard, denylist, vault crypto,
  de-fanging, no-telemetry) — 700+ tests run on every release.
- An internal adversarial audit (14-agent red team; 66 verified findings, all resolved or accepted
  and documented here) preceded the 2.5.x hardening line. Egress control today is enforced by
  construction (nothing phones home) and verified by test — not yet by an OS-level egress firewall;
  that distinction is why this section exists.

---

*If you find a gap between this document and the code, that's a bug in one of them — please report
it. Honesty here is a feature we ship.*
