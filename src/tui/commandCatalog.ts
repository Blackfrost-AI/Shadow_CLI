/**
 * Renderer-neutral command inventory.
 *
 * A command may be implemented by one renderer only, but it must still live here with an
 * explicit reason. This keeps autocomplete/help honest and prevents a switch case from becoming
 * unreachable because a second, private catalog forgot to advertise it.
 */
export type TerminalRenderer = 'ink' | 'pi';
export type CommandHandler = string;

export type CommandCapability =
  | { handler: CommandHandler; unavailable?: never }
  | { handler?: never; unavailable: string };

export interface TerminalCommand {
  name: string;
  desc: string;
  /** Canonical command name for aliases. */
  dispatch?: string;
  renderers: Record<TerminalRenderer, CommandCapability>;
}

const both = (handler: string): TerminalCommand['renderers'] => ({
  ink: { handler },
  pi: { handler },
});

const inkOnly = (handler: string, unavailable: string): TerminalCommand['renderers'] => ({
  ink: { handler },
  pi: { unavailable },
});

const piOnly = (handler: string, unavailable: string): TerminalCommand['renderers'] => ({
  ink: { unavailable },
  pi: { handler },
});

export const TERMINAL_COMMANDS: readonly TerminalCommand[] = [
  { name: '/help', desc: 'Show keybindings and commands', renderers: both('help') },
  { name: '/keybindings', desc: 'Show renderer keybindings; Ink can also write a starter config', renderers: both('keybindings') },
  { name: '/clear', desc: 'Clear the screen and reset the conversation', renderers: both('clear') },
  { name: '/new', desc: 'Start a fresh conversation (alias for /clear)', dispatch: '/clear', renderers: both('clear') },
  { name: '/goal', desc: 'Start a mission: plan, tasks, then verify', renderers: both('goal') },
  { name: '/model', desc: 'Switch, list, add, remove, enable, disable, default, or test model presets', renderers: both('model') },
  { name: '/table', desc: 'Open collaboration (Snowfall presets; legacy Ink roundtable)', renderers: both('table') },
  { name: '/provider', desc: 'Show active provider, endpoint, auth status, and model presets', renderers: both('provider') },
  { name: '/local', desc: 'Add, test, switch, list, or remove a local model', renderers: both('local') },
  { name: '/onboard', desc: 'Show provider setup guidance', renderers: both('onboard') },
  { name: '/style', desc: 'Cycle output style', renderers: both('style') },
  { name: '/output-style', desc: 'Cycle output style (alias for /style)', dispatch: '/style', renderers: both('style') },
  { name: '/autonomy', desc: 'Cycle autonomy: manual, auto-read, auto-edit, full', renderers: both('autonomy') },
  { name: '/plan', desc: 'Toggle plan mode: /plan [on|off|status]', renderers: both('plan') },
  { name: '/compact', desc: 'Summarize earlier turns to free context', renderers: both('compact') },
  { name: '/summary', desc: 'Summarize earlier turns (alias for /compact)', dispatch: '/compact', renderers: both('compact') },
  { name: '/fast', desc: 'Toggle Anthropic fast mode', renderers: both('fast') },
  { name: '/effort', desc: 'Choose reasoning effort: low, medium, high, xhigh, max', renderers: both('effort') },
  { name: '/cost', desc: 'Show session token usage and cost', renderers: both('cost') },
  { name: '/usage', desc: 'Show session usage (alias for /cost)', dispatch: '/cost', renderers: both('cost') },
  { name: '/stats', desc: 'Show session usage (alias for /cost)', dispatch: '/cost', renderers: both('cost') },
  { name: '/context', desc: 'Show context-window usage', renderers: both('context') },
  { name: '/connections', desc: 'Show the session egress receipt', renderers: both('connections') },
  { name: '/export', desc: 'Export the session to markdown or HTML', renderers: both('export') },
  { name: '/copy', desc: 'Copy the last answer or code block', renderers: both('copy') },
  { name: '/session', desc: 'Show the current session name, id, log path, and message count', renderers: both('session') },
  { name: '/sessions', desc: 'List resumable sessions in this workspace', renderers: both('sessions') },
  { name: '/resume', desc: 'Find and resume a named session', renderers: both('resume') },
  { name: '/rename', desc: 'Set a name for the current session', renderers: both('rename') },
  { name: '/rewind', desc: 'Rewind to a turn and optionally restore files or chat', renderers: both('rewind') },
  { name: '/fork', desc: 'Fork this transcript to a new session and switch to it', renderers: both('fork') },
  { name: '/init', desc: 'Scaffold SHADOW.md in the workspace', renderers: both('init') },
  { name: '/agents', desc: 'List or stop running background agents', renderers: both('agents') },
  { name: '/work', desc: 'List, inspect, and control agents, shells, and plan items', renderers: both('work') },
  { name: '/jobs', desc: 'Inspect persistent jobs, blockers, evidence, and explicit retries', renderers: piOnly('jobs', 'Use Snowfall for the job browser; project_jobs is available through tool_search in every renderer.') },
  { name: '/room', desc: 'Read and write local project messages, replies, and unread history', renderers: piOnly('room', 'Use Snowfall for the room browser; project_room is available through tool_search in every renderer.') },
  { name: '/consult', desc: 'Consult a model profile and continue a read-only review', renderers: piOnly('consult', 'Use Snowfall for interactive consultation; the native agent tool supports model profiles in every renderer.') },
  { name: '/team', desc: 'Run a bounded collaboration preset with persistent jobs and evidence', renderers: piOnly('team', 'Use Snowfall for the preset picker; collaborate is available through tool_search in every renderer.') },
  { name: '/skills', desc: 'List discovered repository skills', renderers: both('skills') },
  { name: '/workflows', desc: 'List workflow files', renderers: both('workflows') },
  { name: '/plugins', desc: 'List, enable, or disable installed plugins', renderers: both('plugins') },
  { name: '/mcp', desc: 'List, inspect, enable, or disable MCP servers', renderers: both('mcp') },
  { name: '/memory', desc: 'Show project memory facts', renderers: both('memory') },
  { name: '/tasks', desc: 'Show or clear the planning checklist (execution is under /work)', renderers: both('tasks') },
  { name: '/permissions', desc: 'List or edit permission rules', renderers: both('permissions') },
  { name: '/doctor', desc: 'Diagnose environment, credentials, and guardrails', renderers: both('doctor') },
  { name: '/status', desc: 'Show session status', renderers: both('status') },
  { name: '/diff', desc: 'Show the working-tree git diff summary', renderers: both('diff') },
  { name: '/files', desc: 'Show changed files from git status', renderers: both('files') },
  { name: '/branch', desc: 'Show current git branch and status', renderers: both('branch') },
  { name: '/config', desc: 'Show or set safe config values; secrets stay hidden', renderers: both('config') },
  { name: '/hooks', desc: 'Show configured lifecycle hooks', renderers: both('hooks') },
  { name: '/login', desc: 'Show subscription credential status and setup guidance', renderers: both('login') },
  { name: '/logout', desc: 'Clear supported subscription credentials', renderers: both('logout') },
  { name: '/version', desc: 'Show Shadow version', renderers: both('version') },
  { name: '/color', desc: 'Switch color theme (alias for /theme)', dispatch: '/theme', renderers: both('theme') },
  { name: '/theme', desc: 'Switch color theme', renderers: both('theme') },
  { name: '/activity', desc: 'Inspect activity and complete tool output', renderers: both('activity') },
  { name: '/act', desc: 'Inspect activity (alias for /activity)', dispatch: '/activity', renderers: both('activity') },
  { name: '/expand', desc: 'Expand or fold output', renderers: both('expand') },
  { name: '/accessibility', desc: 'Set accessibility options', renderers: both('accessibility') },
  { name: '/logo', desc: 'Show or hide the welcome wordmark', renderers: both('logo') },
  { name: '/terminal-setup', desc: 'Configure Shift+Enter newline behavior', renderers: both('terminal-setup') },
  { name: '/editor', desc: 'Open the current draft in $EDITOR', renderers: piOnly('editor', 'Ink exposes the external editor through its configured keybinding.') },
  { name: '/vim', desc: 'Toggle modal composer editing', renderers: inkOnly('vim', 'Modal composer editing is Ink-only in v10. Start SHADOW_TUI=ink shadow to use it.') },
  { name: '/statusline', desc: 'Set a custom footer line command', renderers: inkOnly('statusline', 'Custom shell-driven footer commands are Ink-only in v10. Start SHADOW_TUI=ink shadow to use it.') },
  { name: '/add-dir', desc: 'Grant an extra directory to file tools for this session', renderers: both('add-dir') },
  { name: '/image', desc: 'Attach an image file to the next message', renderers: both('image') },
  { name: '/review', desc: 'Review the current uncommitted changes', renderers: both('review') },
  { name: '/quit', desc: 'Exit Shadow', renderers: both('quit') },
  { name: '/exit', desc: 'Exit Shadow (alias for /quit)', dispatch: '/quit', renderers: both('quit') },
] as const;

export function terminalCommandsFor(renderer: TerminalRenderer): TerminalCommand[] {
  return TERMINAL_COMMANDS.filter((command) => command.renderers[renderer].handler !== undefined);
}

export function findTerminalCommand(name: string): TerminalCommand | undefined {
  return TERMINAL_COMMANDS.find((command) => command.name === name);
}

export function commandHandler(command: TerminalCommand, renderer: TerminalRenderer): CommandHandler | undefined {
  return command.renderers[renderer].handler;
}
