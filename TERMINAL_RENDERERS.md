# Terminal renderer support for Shadow v9

This document is the renderer contract for the `9.0.0` line. It describes what
Shadow supports in this release, including the experimental preview's explicit limits.

## Release decision

**Ink remains Shadow v9's supported, default interactive terminal.** Running `shadow` in a capable
TTY selects Ink. The pi renderer is an opt-in experimental preview selected at launch:

```sh
SHADOW_TUI=pi shadow
```

Unset `SHADOW_TUI`, or set it to `ink`, to return to the supported renderer. Headless `--task`,
`--repl`, piped input, `--screen-reader`, the web companion, and ACP do not use either interactive
renderer contract.

The preview designation is a support boundary, not a statement about the quality of individual pi
features. Pi has a calmer row renderer, strong width enforcement, safe approval dialogs, and the
daily commands listed below. It has not completed the command, keybinding, platform, and live-terminal
qualification required to replace Ink.

The release package is `9.0.0`. A version change alone does not publish an artifact; source and
signed binary publication are separate gated steps described in [Deployment](DEPLOYMENT.md).

## Command capability matrix

The table groups aliases with the command they invoke. “Preview” means the command is implemented in
pi but remains covered by pi's experimental support level. “Ink only” means pi recognizes the command
as unavailable and directs the user to the default renderer; it must never silently run another
command.

| Command or group | Ink default | pi preview | v9 decision |
| --- | --- | --- | --- |
| `/help`, `/clear`, `/new`, `/quit`, `/exit`, `/version` | Supported | Preview | Core shell lifecycle is available in both. |
| `/model` list, picker, switch, add, remove, enable, disable, default, test | Supported | Preview | Model changes use the same credential, endpoint, offline, and running-turn guards. |
| `/provider`, `/local` | Supported | Preview | Pi exposes provider status and local-model management. |
| `/autonomy`, `/plan`, `/effort`, `/fast` | Supported | Preview | State changes must update the running loop as well as the display. |
| `/compact`, `/summary` | Supported | Preview | Manual compaction is part of the daily pi surface; automatic compaction remains available in both. |
| `/cost`, `/usage`, `/stats`, `/context`, `/status` | Supported | Preview | Read-only session status is available in both. |
| `/session`, `/sessions`, `/resume`, `/rewind`, `/fork` | Supported | Preview | Resume, rewind, and fork must move context, log ownership, read tracking, and approval scope together. |
| `/export`, `/copy` | Supported | Preview | Markdown/HTML transcript export and answer/code copy are available in both; export paths remain workspace-confined. |
| `/editor` | The slash command is unavailable; use `Ctrl+X`, then `Ctrl+E` | Preview; `/editor` or `Ctrl+G` opens the external editor | Pi refuses the external editor while a turn is running. |
| `/diff`, `/files`, `/branch`, `/review`, `/init`, `/add-dir`, `/image` | Supported | Preview | Workspace commands are independent routes and never enter session resume. |
| `/permissions` | Supported | Preview | Persisted rules and the running loop update together; a failed save leaves both unchanged. |
| `/config` | Supported | Preview | Only the established safe configuration keys are editable; secret values remain hidden. |
| `/plugins`, `/mcp` | Supported | Preview | Pi uses the same enable, disable, validation, and persistence paths as Ink. |
| `/memory`, `/doctor` | Supported | Preview | Pi exposes the same project-memory and diagnostic reports. |
| `/work` | Supported | Preview | Work Center lists active and historical work and provides safe pause, resume, priority, and confirmed retry controls. |
| `/agents`, `/skills`, `/workflows`, `/hooks`, `/connections` | Supported | Preview | Inventory and activity commands remain available in both. |
| `/activity`, `/act`, `/expand`, `/tasks`, `/goal` | Supported | Preview | The visual presentation differs, while the underlying task and mission state is shared. |
| `/theme`, `/color`, `/style`, `/output-style`, `/logo`, `/accessibility`, `/terminal-setup` | Supported | Preview | Renderer-specific help may differ where terminal engines handle input differently. |
| `/login`, `/logout`, `/onboard` | Supported | Preview | Both report credential state without displaying secrets. Pi directs credential import to `shadow login` outside the preview shell. |
| `/keybindings` | Supported, including `~/.shadow/keybindings.json` customization | Preview listing of pi's actual fixed keys | Custom Shadow key mappings remain Ink only for v9; pi must not claim to load them. |
| `/vim` | Supported | Ink only | Pi's editor has no compatible Vim mode. Use Ink when modal editing is required. |
| `/table` | Supported, experimental | Ink only | Round-table mode stays experimental and is not part of the pi preview. |
| `/statusline` | Supported | Ink only | The user-supplied footer command remains confined to Ink for v9. |
| Custom slash commands from workspace, global, or plugin command files | Supported | Ink only | Pi does not advertise custom-command parity for v9. |

## Key behavior matrix

Keys are part of the renderer contract. Help text must describe the active renderer rather than
presenting one renderer's shortcuts as universal.

| Behavior | Ink default | pi preview |
| --- | --- | --- |
| Submit while idle; queue or steer while working | `Enter` | `Enter` |
| Insert a newline | Terminal-dependent Shift+Enter setup; see `/terminal-setup` | `Shift+Enter` or `Ctrl+J`; see `/terminal-setup` |
| Interrupt a running turn | `Esc` | `Esc` |
| Clear draft / abort / exit | `Ctrl+C`; press twice to exit | `Ctrl+C`; press twice to exit |
| Toggle plan mode directly | `Shift+Tab` | `Shift+Tab` |
| Cycle the full autonomy/plan ring | `Tab` when no completion menu owns it | Use `/autonomy` or `/plan`; Tab belongs to completion |
| Model picker shortcut | `Ctrl+X`, then `M` | Use `/model` or `/model picker` |
| Prompt history | `Up`/`Down` at the draft boundary; `Ctrl+R` searches | `Up`/`Down`; no history-search shortcut |
| Complete slash commands, arguments, and `@` files | `Tab` | `Tab` |
| Open the external editor | `Ctrl+X`, then `Ctrl+E` | `Ctrl+G` or `/editor` while idle |
| Inspect or expand activity | `Ctrl+O`; `Alt+O` opens the latest detail | `Ctrl+O` toggles transcript detail; `/activity` opens the activity view |
| Show tasks | `Ctrl+T` | `Ctrl+T` |
| Copy last answer | `Alt+C` or `/copy` | `/copy` |
| Copy current draft | `Ctrl+X`, then `C` | Use terminal selection or the external editor |
| Paste | Bracketed terminal paste or `Ctrl+V` system-clipboard paste | Bracketed terminal paste; no Shadow clipboard shortcut |
| Page keys | PageUp/PageDown navigate the Ink transcript | PageUp/PageDown move through a long pi draft; use native terminal scrollback for transcript history |
| Approval choices | `y` once, `n` deny, `s` session, `f` shell prefix, `a` raise autonomy | Same approval choices |
| User keybinding file | Loaded and hot-reloaded | Not loaded; `/keybindings` reports the fixed pi mapping |
| Vim composer | `/vim on` | Unavailable; use Ink |
| Mouse mode | Optional Ink mouse handling through config or `SHADOW_MOUSE=1` | Native terminal selection only; no Shadow mouse mode contract |

## Gates before pi can become the default

Changing the default is a later release decision. All of these conditions must be met and recorded
against the same candidate build:

1. The shared command catalog has unique names, valid aliases, and an explicit handler or unavailable
   state for every renderer. Both `/help` and completion derive their claims from that catalog.
2. Every command pi advertises has a behavior test, including mutation failure paths. No command may
   fall through to a generic handler, change the wrong session, or report success before persistence.
3. `/vim`, `/table`, `/statusline`, custom commands, and custom keybindings are either implemented or
   deliberately removed from the supported default surface with release notes and a migration path.
4. Active-renderer help is generated from tested behavior. History, paste, scrolling, approval keys,
   external-editor ownership, and running-turn guards agree with the displayed key guide.
5. Live PTY qualification passes on every supported operating system and the minimum Node runtime:
   startup/exit, narrow widths, resize, Unicode, large paste, queued steering, interruption, approval,
   model switch, manual compact, resume, rewind, fork, MCP/config mutation, and terminal restoration.
6. The full source/all-project checks, lint, Node suite, asset/build/pack checks, and installed-artifact
   smoke run with pi selected. Renderer-specific security tests cover hostile controls and preserve
   raw tool input and question values.
7. The release candidate documents any remaining differences, and `SHADOW_TUI=ink` remains a tested
   fallback for at least one release after a future default flip.

Until those gates pass, release notes, support answers, screenshots, and examples should identify Ink
as the supported v9 terminal and pi as the preview.
