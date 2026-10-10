# Shadow v10 terminal contract

Snowfall is the default interactive terminal in Shadow v10. It uses pi's
full-screen engine: a full-width scrollable conversation, a pinned composer and a compact
status bar. Session activity sits on the left of the footer; task, agent, context and cost
totals sit on the right as space allows. There is no sidebar. Use `/tasks`, `/agents`,
`/context` and `/cost` for details; the workspace path remains in the header.
Normal exit restores the complete conversation to the main terminal buffer. A saved theme
is respected; new installations start with the Snowfall palette. Use `/theme snowfall` to try it.

From a source checkout, run `npm run build`, then `npm start`. Installed builds use `shadow`.

```sh
SHADOW_TUI=ink shadow   # compatibility renderer, retained through the v10 release cycle
SHADOW_TUI=pi shadow    # explicit selection of the default Snowfall renderer
```

There is no third renderer or fullscreen development flag. Headless `--task`, `--repl`, piped
input, `--screen-reader`, web and ACP keep their existing paths. The v9 Work Center and
`/work` controls remain available. See [release verification](V10_VERIFICATION.md).

<a id="gates-before-pi-can-become-the-default"></a>

## Release qualification

The full-width layout and retro block-letter banner received founder visual approval.
Source checks and signed installer/update checks run separately on the supported platforms.
The verification report records their results and the limits of automated terminal coverage.

## Explicit migration decisions

Custom slash commands work in both renderers. Workspace, enabled plugin and global Markdown
commands use the same loader and argument expansion; builtins always win. New commands are
recognized when invoked; restart for a refreshed autocomplete inventory after adding files.

Vim composer mode, shell-driven `/statusline`, and
`~/.shadow/keybindings.json` customization remain Ink-only for v10. They are deliberately
excluded from the Snowfall surface. Start `SHADOW_TUI=ink shadow` (or
`SHADOW_TUI=ink npm start` in this checkout) to use those features. Snowfall's fixed keys
are listed below. `/editor` / Ctrl+G provides external-editor access while idle.

In Snowfall, `/table` opens the shared `/team` preset picker. Use `/consult` for a
read-only second model and follow-ups. Ink retains its legacy roundtable; new collaboration
tools are available to its agent through `tool_search`.

## Local collaboration

Shadow 10.0.3 adds keyboard-driven workflow overlays for local project work.

- `/work`: live workers, shell commands and plan items; Enter opens detail, A opens actions.
  `/tasks` filters the plan. `/work artifacts` inspects retained output and offers apply,
  keep or discard. Failed Git isolation stops the worker before any model call.
- `/jobs`: project-wide durable jobs, attempts, blockers, checks and explicit recovery/retry.
  Restart never automatically reruns a shell command. `/room` shows local project messages.
- `/diff` and `/review`: working changes (including untracked files), a comparison base or
  a commit. Enter opens files; N/P moves between hunks. R selects a reviewer. Model findings
  remain unverified opinions until independent check evidence exists.
- `/consult "profile label" <question>`, `/consult list`, and
  `/consult follow <id> <question>`: separate read-only model contexts with resumable history.
  Profiles resolve provider, endpoint, credential reference and model together.
- `/team`: choose second opinion, implement-and-review or parallel perspectives; advanced
  pipeline, debate and plan/solve presets use the same native workers. Every run has a deadline,
  token ceiling and at most eight stages. `/team --json` accepts profile labels, steps,
  expectedArtifacts and declared checks; see [collaboration guide](COLLABORATION.md).
- `/mcp`: add, test, reconnect and disable a connector live; set timeouts and small tool
  allowlists. Progress appears in Work Center. Cancellation is sent to the server; it is not
  proof that a remote worker stopped. Large results have bounded artifact retrieval.
- `/skills` and `/memory`: inspect skill sources/conflicts and fact provenance; memory
  supports show, set and delete. Agents discover semantic navigation and ranked excerpts with
  `repository_context`; lexical fallback is labeled when a language server is unavailable.

Pickers support arrow keys, numbered choices followed by Enter, and / to search. Escape clears
a search first, then closes the overlay. Active work is interrupted once the overlay is closed.
Elapsed time changes from seconds to minutes and hours. `/effort` shows a selectable list.
Thinking shows a bounded preview while streaming, then collapses to one summary line when the
answer or tool starts. Ctrl+O expands transcript detail, including completed thinking and grep
matches; /activity also retains tool output. Empty reasoning creates no block.

## Images and terminal behavior

Sessions take a short name from the opening prompt. `/rename <name>` overrides it; `/resume`
and its completions show searchable names alongside stable IDs. The terminal title shows the
active name followed by Shadow and restores the prior title on exit. `/new` preserves the
previous named session. Naming runs locally and makes no additional model request.

Kitty, Ghostty and WezTerm can display PNG images using pi's managed graphics placements,
including cropping and cleanup while scrolling. Other formats, iTerm2, unknown terminals,
tmux and oversized images retain a text description and source path. Use an OS viewer for
those files. Ink retains its existing inline-image path. Pixel graphics are not promised in
saved scrollback. No automatic remote image fetching is performed by Snowfall.

Mouse wheel scrolls the pane under the pointer; dragging selects text and release copies it.
Use the terminal's own mouse-bypass modifier for native selection if needed. Search belongs
to Ctrl+Shift+F; a terminal must forward that modified chord. Page keys and End work without it.
Snowfall preserves your draft while you navigate. Search/picker typing cannot answer a
waiting permission dialog. Long approvals preserve both ends and label omitted characters;
terminal controls and bidi characters are escaped only in the display projection.

`SHADOW_NO_BG=1` disables terminal background changes. `/accessibility` includes reduced
motion; colorblind and high-contrast palettes remain available. Success, failure, queued,
working and approval states use words and shapes as well as color.

## Command matrix

Generated by `npx tsx scripts/render-terminal-contract.ts` from the shared capability catalog.

| Command | Purpose | Snowfall (default) | Ink fallback |
| --- | --- | --- | --- |
| `/help` | Show keybindings and commands | Available | Available |
| `/keybindings` | Show renderer keybindings; Ink can also write a starter config | Available | Available |
| `/clear` | Clear the screen and reset the conversation | Available | Available |
| `/new` | Start a fresh conversation (alias for /clear) | Available | Available |
| `/goal` | Start a mission: plan, tasks, then verify | Available | Available |
| `/model` | Switch, list, add, remove, enable, disable, default, or test model presets | Available | Available |
| `/table` | Open collaboration (Snowfall presets; legacy Ink roundtable) | Available | Available |
| `/provider` | Show active provider, endpoint, auth status, and model presets | Available | Available |
| `/local` | Add, test, switch, list, or remove a local model | Available | Available |
| `/onboard` | Show provider setup guidance | Available | Available |
| `/style` | Cycle output style | Available | Available |
| `/output-style` | Cycle output style (alias for /style) | Available | Available |
| `/autonomy` | Cycle autonomy: manual, auto-read, auto-edit, full | Available | Available |
| `/plan` | Toggle plan mode: /plan [on|off|status] | Available | Available |
| `/compact` | Summarize earlier turns to free context | Available | Available |
| `/summary` | Summarize earlier turns (alias for /compact) | Available | Available |
| `/fast` | Toggle Anthropic fast mode | Available | Available |
| `/effort` | Choose reasoning effort: low, medium, high, xhigh, max | Available | Available |
| `/cost` | Show session token usage and cost | Available | Available |
| `/usage` | Show session usage (alias for /cost) | Available | Available |
| `/stats` | Show session usage (alias for /cost) | Available | Available |
| `/context` | Show context-window usage | Available | Available |
| `/connections` | Show the session egress receipt | Available | Available |
| `/export` | Export the session to markdown or HTML | Available | Available |
| `/copy` | Copy the last answer or code block | Available | Available |
| `/session` | Show the current session name, id, log path, and message count | Available | Available |
| `/sessions` | List resumable sessions in this workspace | Available | Available |
| `/resume` | Find and resume a named session | Available | Available |
| `/rename` | Set a name for the current session | Available | Available |
| `/rewind` | Rewind to a turn and optionally restore files or chat | Available | Available |
| `/fork` | Fork this transcript to a new session and switch to it | Available | Available |
| `/init` | Scaffold SHADOW.md in the workspace | Available | Available |
| `/agents` | List or stop running background agents | Available | Available |
| `/work` | List, inspect, and control agents, shells, and plan items | Available | Available |
| `/jobs` | Inspect persistent jobs, blockers, evidence, and explicit retries | Available | Use Snowfall for the job browser; project_jobs is available through tool_search in every renderer. |
| `/room` | Read and write local project messages, replies, and unread history | Available | Use Snowfall for the room browser; project_room is available through tool_search in every renderer. |
| `/consult` | Consult a model profile and continue a read-only review | Available | Use Snowfall for interactive consultation; the native agent tool supports model profiles in every renderer. |
| `/team` | Run a bounded collaboration preset with persistent jobs and evidence | Available | Use Snowfall for the preset picker; collaborate is available through tool_search in every renderer. |
| `/skills` | List discovered repository skills | Available | Available |
| `/learn` | Draft an evidence-backed reusable skill from this session | Available | Available |
| `/workflows` | List workflow files | Available | Available |
| `/plugins` | List, enable, or disable installed plugins | Available | Available |
| `/harness` | List or select trusted local harness add-ons for new sessions | Available | Available |
| `/mcp` | List, inspect, enable, or disable MCP servers | Available | Available |
| `/memory` | Show project memory facts | Available | Available |
| `/tasks` | Show or clear the planning checklist (execution is under /work) | Available | Available |
| `/permissions` | List or edit permission rules | Available | Available |
| `/doctor` | Diagnose environment, credentials, and guardrails | Available | Available |
| `/status` | Show session status | Available | Available |
| `/diff` | Show the working-tree git diff summary | Available | Available |
| `/files` | Show changed files from git status | Available | Available |
| `/branch` | Show current git branch and status | Available | Available |
| `/config` | Show or set safe config values; secrets stay hidden | Available | Available |
| `/hooks` | Show configured lifecycle hooks | Available | Available |
| `/login` | Show subscription credential status and setup guidance | Available | Available |
| `/logout` | Clear supported subscription credentials | Available | Available |
| `/version` | Show Shadow version | Available | Available |
| `/color` | Switch color theme (alias for /theme) | Available | Available |
| `/theme` | Switch color theme | Available | Available |
| `/activity` | Inspect activity and complete tool output | Available | Available |
| `/act` | Inspect activity (alias for /activity) | Available | Available |
| `/expand` | Expand or fold output | Available | Available |
| `/accessibility` | Set accessibility options | Available | Available |
| `/logo` | Show or hide the welcome wordmark | Available | Available |
| `/terminal-setup` | Configure Shift+Enter newline behavior | Available | Available |
| `/editor` | Open the current draft in $EDITOR | Available | Ink exposes the external editor through its configured keybinding. |
| `/vim` | Toggle modal composer editing | Modal composer editing is Ink-only in v10. Start SHADOW_TUI=ink shadow to use it. | Available |
| `/statusline` | Set a custom footer line command | Custom shell-driven footer commands are Ink-only in v10. Start SHADOW_TUI=ink shadow to use it. | Available |
| `/add-dir` | Grant an extra directory to file tools for this session | Available | Available |
| `/image` | Attach an image file to the next message | Available | Available |
| `/review` | Review the current uncommitted changes | Available | Available |
| `/quit` | Exit Shadow | Available | Available |
| `/exit` | Exit Shadow (alias for /quit) | Available | Available |

## Snowfall keys

Generated from the same inventory used by `/help` and `/keybindings`.

| Key | Behavior |
| --- | --- |
| Enter | send; queue a follow-up while busy |
| Shift+Enter / Ctrl+J | insert a newline |
| Tab | complete /commands, arguments and @files |
| Shift+Tab | toggle plan mode |
| Esc | close an overlay; otherwise interrupt a turn or compaction |
| Ctrl+C | abort work or clear draft; twice on an empty draft exits |
| Ctrl+G | edit draft in $VISUAL/$EDITOR while idle; next match in search |
| Ctrl+O | expand or collapse transcript details |
| Ctrl+T | show all tasks |
| Up / Down | composer history at the draft boundary |
| PgUp / PgDn | scroll transcript; wheel also scrolls the pane under the pointer |
| Home / End | transcript start / latest output |
| Ctrl+Up / Ctrl+Down | jump to previous / next user prompt |
| Ctrl+Shift+F | search transcript; Enter next; Shift+Enter previous; Esc close |
| Mouse drag | select text; release copies the selection |
| Bracketed paste | insert clipboard text as one draft, without submitting |

Permission decisions remain: `y` once, `n` deny, `s` session, `f` shell prefix, and
`a` raise autonomy where offered. Questions use Up/Down, Space for multi-select, and Enter.

Ink's key file and Vim mode retain their prior behavior. Its external editor uses Ctrl+X then
Ctrl+E; model picker Ctrl+X then M; draft history search Ctrl+R; last-answer copy Alt+C;
clipboard paste Ctrl+V. Consult `/keybindings` in Ink for its active customized mapping.
