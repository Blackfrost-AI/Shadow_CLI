# m-4 Shell Escape — Implementation and Evidence

Worktree: `/Users/craigmac/.shadow/worktrees/daily-upgrade` (HEAD `df0ba8e3e8a500251325be2f5266544f8f941db4`, branch `shadow/daily-upgrade`).

## Design

`/!` is an explicit operator-only shell escape. The ONLY entry is a typed `/!` prefix in the
composer; the raw command routes through the complete execution-policy pipeline — the same
`AgentLoop.runToolCall` machinery every model-initiated shell goes through: permissions,
plan mode, the risk classifier, the catastrophic denylist, config-touch detection,
autonomy floor, hooks, sandbox wrapping, environment scrubbing, and the timeout. Nothing
is bypassed: a `/!` command that the policy would refuse for the model is refused for the
operator too.

New files:
- `src/tui/shellEscapeCore.ts` — recognition/rejection core: ONLY `/!`-prefixed lines are
  shell escapes; empty payloads, paste chips (`[Pasted text #N …]`), and multiline payloads
  are refused with specific reasons before any state changes. No-space form (`/!ls`)
  matches bash `!`-style muscle memory.
- `src/tui/shellEscape.ts` — the shared dispatch runner: refusal order (unsafe input → busy)
  happens before any lock/composer change; then lock acquisition with terminal priority;
  then ONE `runNativeTool('run_shell', …)` call; the lock always releases in `finally`.
  No retries, no queueing, no replay.

Modified:
- `src/tui/commandCatalog.ts` — `/!` catalog entry (handler `shell`, both renderers).
- `src/tui/keys/types.ts` — `shellEscape` in the KeyEnv contract.
- `src/tui/keys/composerOwner.ts` — typed `/!` interception BEFORE busy barriers: refused
  busy escapes never queue; never steered; never fall to unknown-command handling.
- `src/app/app.ts` (Snowfall) — `runSlash` intercepts the raw line before token lookup;
  new `shellEscape` method mirrors `runFeatureTool`'s live-turn state discipline exactly
  (closePicker/commitBrandLine/running/runStart/controller/startTicker before the lock,
  `endTurn()` in the renderer's finally); submit decodes `/!` before busy queueing.
- `src/tui.tsx` (Ink) — same interception via composerOwner; `shellEscape` hook mirrors
  `runOne`'s state discipline (runStart/interruptionReported/running/controller before the
  lock; controller out, running down, queue drained in finally); SlashCtx gets a
  late-bound seam like `startTurnRef`; `runSlashCommand` maps the `/shell` dispatch arm to
  the same core so a menu-completed bare `/!` gets the usage message.
- `src/tui/slash.ts` — `shellEscape` member on SlashCtx; `/shell` dispatch arm.

## Why the full pipeline matters (and what was kept)

`executeNativeTool` builds a real `AgentLoop` with the real gate, registry, sessionLog and
approvals. `/checks run` already uses it; `/!` now uses it too. The operator's command is
subject to the same prefix classifier (an injected `echo $(pwned)` is denied as
`command_injection_detected`), the same sandbox wrapping, and the same denial reasons. The
shell output renders through the same bus events (`tool_start`/`tool_end`) both renderers
already display faithfully (Ctrl-O expandable, /activity inspectable).

## Test evidence

### test/shell-escape.test.ts — 7 native tests

| # | Test | Verifies |
|---|------|----------|
| 1 | only an explicit /! prefix is a shell escape | recognition |
| 2 | unsafe inputs are rejected before any state changes | rejection reasons |
| 3 | runShellEscape refuses busy state without touching the pipeline | busy refusal |
| 4 | runShellEscape refuses unsafe input without clearing the composer | no state change |
| 5 | runShellEscape dispatches exactly once and releases the lock | single dispatch |
| 6 | operator shell commands go through the REAL pipeline | no bypass |
| 7 | a cancelled escape settles: the executor honours the abort signal | cancellation |

Test 6 is the no-bypass proof: a real `AgentLoop` with a real `ToolRegistry` denies
`echo $(pwned)` (injection classification) while a typed benign command executes.

### test/shell-escape-dispatch.test.ts — 9 mounted dispatch tests

| # | Test | Verifies |
|---|------|----------|
| 1-2 | busy /! refused with reason, never queued (both renderers) | busy gating |
| 3-4 | unsafe payloads refused with specific reasons (both renderers) | rejection reasons |
| 5-6 | typed valid /! dispatches run_shell exactly once (both renderers) | single dispatch |
| 7 | menu-completed bare /! gets the usage message via the same core | no unknown-command |
| 8-9 | /! never sits in the replay queue while busy (both renderers) | no replay |

Commands:
```sh
cd /Users/craigmac/.shadow/worktrees/daily-upgrade
npm run typecheck                          # PASS
node --import tsx/esm --test test/shell-escape.test.ts test/shell-escape-dispatch.test.ts
# ℹ tests 16  ℹ pass 16  ℹ fail 0
node --import tsx/esm --test test/snowfall-contract.test.ts test/tui-line-budget.test.ts test/tui-slash.test.ts
# ℹ tests 47  ℹ pass 47  ℹ fail 0
```

### Regression battery (touched surfaces)

```sh
timeout 600 node --import tsx/esm --test test/steer-queue.test.ts test/prompt-control.test.ts \
  test/prompt-control-dispatch.test.ts test/keybinding-liveness.test.ts test/keybindings.test.ts \
  test/keybindings-loader.test.ts test/tui-composer-keys.test.ts test/app-command-routing.test.ts \
  test/command-catalog.test.ts test/custom-commands.test.ts test/onboard-command.test.ts \
  test/slash-arg-menus.test.ts test/tui-custom-commands.test.ts test/tui-slash.test.ts \
  test/tui-steer-focus.test.ts test/loop.test.ts
# ℹ tests 225  ℹ pass 225  ℹ fail 0
```

### Full-suite gate

```sh
npm test
# ℹ tests 3834  ℹ pass 3834  ℹ fail 0  ℹ cancelled 0
```

Two legitimate gates surfaced by the full suite and satisfied during hardening:
1. `snowfall-contract.test.ts` — the published command/key matrix must list the new `/!`
   capability; `docs/TERMINAL_RENDERERS.md` now documents `/!` for both renderers.
2. `tui-line-budget.test.ts` — src/tui.tsx crossed its 4000-line structural budget; the Ink
   shell-escape hook was extracted to `src/tui/useShellEscape.ts` (plan-2.4 convention),
   leaving tui.tsx at 3976 lines.

## Corrections made during hardening (negative evidence, retained)

- The first pre-check in both renderer adapters collapsed busy state into the "unavailable"
  message, hiding the real busy refusal — fixed: busy belongs to the shared core.
- `runSlashCommand` fires `ctx.shellEscape` fire-and-forget (like the real TUI seam); the
  menu-path test asserted synchronously and failed — the test now awaits the async settle.
- Snowfall's mounted harness lacked `closePicker`/`commitBrandLine`/`startTicker`/
  `endTurn`/`featureError` stubs the live-turn state path touches — added.
- A stray double `break` left by an edit in slash.ts was removed.
- The initial `tui-slash` menu test asserted `/provider` on the first menu page; `/!` sorts
  before letters now (the menu filter still reaches `/quit`) — updated the expectation.
