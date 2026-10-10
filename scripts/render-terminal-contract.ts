import { writeFileSync } from 'node:fs';
import { TERMINAL_COMMANDS } from '../src/tui/commandCatalog.js';
import { PI_KEYS } from '../src/app/keymap.js';

const commands = TERMINAL_COMMANDS.map((command) => `| \`${command.name}\` | ${command.desc} | ${command.renderers.pi.handler ? 'Available' : command.renderers.pi.unavailable} | ${command.renderers.ink.handler ? 'Available' : command.renderers.ink.unavailable} |`).join('\n');
const keys = PI_KEYS.map(({ key, action }) => `| ${key} | ${action} |`).join('\n');
writeFileSync('docs/TERMINAL_RENDERERS.md', `# Shadow v10 terminal contract

Snowfall is the default interactive terminal in Shadow v10. It uses pi's
full-screen engine: a full-width scrollable conversation, a pinned composer and a compact
status bar. Session activity sits on the left of the footer; task, agent, context and cost
totals sit on the right as space allows. There is no sidebar. Use \`/tasks\`, \`/agents\`,
\`/context\` and \`/cost\` for details; the workspace path remains in the header.
Normal exit restores the complete conversation to the main terminal buffer. A saved theme
is respected; new installations start with the Snowfall palette. Use \`/theme snowfall\` to try it.

From a source checkout, run \`npm run build\`, then \`npm start\`. Installed builds use \`shadow\`.

\`\`\`sh
SHADOW_TUI=ink shadow   # compatibility renderer, retained through the v10 release cycle
SHADOW_TUI=pi shadow    # explicit selection of the default Snowfall renderer
\`\`\`

There is no third renderer or fullscreen development flag. Headless \`--task\`, \`--repl\`, piped
input, \`--screen-reader\`, web and ACP keep their existing paths. The v9 Work Center and
\`/work\` controls remain available. See [release verification](V10_VERIFICATION.md).

<a id="gates-before-pi-can-become-the-default"></a>

## Release qualification

The full-width layout and retro block-letter banner received founder visual approval.
Source checks and signed installer/update checks run separately on the supported platforms.
The verification report records their results and the limits of automated terminal coverage.

## Explicit migration decisions

Custom slash commands work in both renderers. Workspace, enabled plugin and global Markdown
commands use the same loader and argument expansion; builtins always win. New commands are
recognized when invoked; restart for a refreshed autocomplete inventory after adding files.

Vim composer mode, shell-driven \`/statusline\`, and
\`~/.shadow/keybindings.json\` customization remain Ink-only for v10. They are deliberately
excluded from the Snowfall surface. Start \`SHADOW_TUI=ink shadow\` (or
\`SHADOW_TUI=ink npm start\` in this checkout) to use those features. Snowfall's fixed keys
are listed below. \`/editor\` / Ctrl+G provides external-editor access while idle.

In Snowfall, \`/table\` opens the shared \`/team\` preset picker. Use \`/consult\` for a
read-only second model and follow-ups. Ink retains its legacy roundtable; new collaboration
tools are available to its agent through \`tool_search\`.

## Local collaboration

Shadow 10.0.3 adds keyboard-driven workflow overlays for local project work.

- \`/work\`: live workers, shell commands and plan items; Enter opens detail, A opens actions.
  \`/tasks\` filters the plan. \`/work artifacts\` inspects retained output and offers apply,
  keep or discard. Failed Git isolation stops the worker before any model call.
- \`/jobs\`: project-wide durable jobs, attempts, blockers, checks and explicit recovery/retry.
  Restart never automatically reruns a shell command. \`/room\` shows local project messages.
- \`/diff\` and \`/review\`: working changes (including untracked files), a comparison base or
  a commit. Enter opens files; N/P moves between hunks. R selects a reviewer. Model findings
  remain unverified opinions until independent check evidence exists.
- \`/consult "profile label" <question>\`, \`/consult list\`, and
  \`/consult follow <id> <question>\`: separate read-only model contexts with resumable history.
  Profiles resolve provider, endpoint, credential reference and model together.
- \`/team\`: choose second opinion, implement-and-review or parallel perspectives; advanced
  pipeline, debate and plan/solve presets use the same native workers. Every run has a deadline,
  token ceiling and at most eight stages. \`/team --json\` accepts profile labels, steps,
  expectedArtifacts and declared checks; see [collaboration guide](COLLABORATION.md).
- \`/mcp\`: add, test, reconnect and disable a connector live; set timeouts and small tool
  allowlists. Progress appears in Work Center. Cancellation is sent to the server; it is not
  proof that a remote worker stopped. Large results have bounded artifact retrieval.
- \`/skills\` and \`/memory\`: inspect skill sources/conflicts and fact provenance; memory
  supports show, set and delete. Agents discover semantic navigation and ranked excerpts with
  \`repository_context\`; lexical fallback is labeled when a language server is unavailable.

Pickers support arrow keys, numbered choices followed by Enter, and / to search. Escape clears
a search first, then closes the overlay. Active work is interrupted once the overlay is closed.
Elapsed time changes from seconds to minutes and hours. \`/effort\` shows a selectable list.
Thinking shows a bounded preview while streaming, then collapses to one summary line when the
answer or tool starts. Ctrl+O expands transcript detail, including completed thinking and grep
matches; /activity also retains tool output. Empty reasoning creates no block.

## Images and terminal behavior

Sessions take a short name from the opening prompt. \`/rename <name>\` overrides it; \`/resume\`
and its completions show searchable names alongside stable IDs. The terminal title shows the
active name followed by Shadow and restores the prior title on exit. \`/new\` preserves the
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

\`SHADOW_NO_BG=1\` disables terminal background changes. \`/accessibility\` includes reduced
motion; colorblind and high-contrast palettes remain available. Success, failure, queued,
working and approval states use words and shapes as well as color.

## Command matrix

Generated by \`npx tsx scripts/render-terminal-contract.ts\` from the shared capability catalog.

| Command | Purpose | Snowfall (default) | Ink fallback |
| --- | --- | --- | --- |
${commands}

## Snowfall keys

Generated from the same inventory used by \`/help\` and \`/keybindings\`.

| Key | Behavior |
| --- | --- |
${keys}

Permission decisions remain: \`y\` once, \`n\` deny, \`s\` session, \`f\` shell prefix, and
\`a\` raise autonomy where offered. Questions use Up/Down, Space for multi-select, and Enter.

Ink's key file and Vim mode retain their prior behavior. Its external editor uses Ctrl+X then
Ctrl+E; model picker Ctrl+X then M; draft history search Ctrl+R; last-answer copy Alt+C;
clipboard paste Ctrl+V. Consult \`/keybindings\` in Ink for its active customized mapping.
`);
