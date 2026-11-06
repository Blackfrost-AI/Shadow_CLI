# Steering & queue release-slice evidence — 2026-11-06

## Scope of this slice (ships as v11.2.0)
1. Snowfall busy-Enter no longer bypasses explicit controls: `/steer` and `/queue` are decoded in `submit()` before any busy barrier stores input; all other commands keep the baseline queue-and-replay contract (queued `/compact` still replays at the safe boundary in FIFO order).
2. New `/steer <text>` (both renderers): steers the active turn at a safe boundary; refused when no turn is active; never overtakes earlier queued work.
3. New `/queue <text>` (both renderers): queues without requesting steering under any state; starts a normal turn when idle.
4. Ink opt-in configurable actions `chat:steer` / `chat:queue` with NO default bindings (existing keybinding loader/normalizer reused; reserved-key protection intact).
5. Shared policy module `src/tui/promptControl.ts` (renderer-shared decode + gate logic); Snowfall-specific tail in `src/agent/promptControl.ts`; single source of truth in `src/agent/steerQueue.ts`.
6. Catalog rows updated in `src/tui/commandCatalog.ts` and `docs/TERMINAL_RENDERERS.md` (contract test enforces agreement).
7. Payload policy: multiline preserved; nested slash rejected; `off`/`status`/`clear` are ordinary text.

## Verification (final gate, after fixes)
- `bash scripts/check-release-gate.sh`: **OK** — typecheck:all clean, lint clean, README matches package.json.
- Full suite `node --import tsx/esm --test "test/**/*.test.ts"`: **3,802 pass / 0 fail / 0 cancelled**.
- Focused regression evidence: `snowfall-followup.test.ts` + `snowfall-contract.test.ts` + `prompt-control-dispatch.test.ts` + `prompt-control.test.ts` → 24/24, including "fullscreen keeps queued messages in order across an asynchronous slash command" and "published command and key matrix agrees with the actual capability inventory".

## Regressions found and fixed during this release
1. Busy-Enter routing through `submit()` made a queued `/compact` dispatch immediately and get dropped by the running-refusal — broke FIFO async-command contract. Fixed: only `/steer|/queue` decode early; running-turn commands return to queue-replay (`submit` now queues any `/`-command while a turn runs).
2. Missing `docs/TERMINAL_RENDERERS.md` rows failed the command/key matrix contract test. Fixed: rows added.
3. Parked mutation files tripped lint (`digest` unused). Fixed in parked copy; parking preserved for future m-3 work.

## Explicitly NOT in this release
- Mutation journal (m-3): parked under `.shadow/parked/` — security review found approval-binding/concurrency/TOCTOU defects; NOT shipped.
- Shell escape, LSP mutations, commit proposals, RPC, crash restore, AST, DAP, browser relay, SSH, advisors — not started/not shipped.
- Snowfall configurable keyboard bindings: Ink-only in this slice; Snowfall's fixed keymap intentionally untouched.
