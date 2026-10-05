// One published inventory for /help, /keybindings and the generated renderer contract.
export const PI_KEYS = [
  { key: 'Enter', action: 'send; queue a follow-up while busy' },
  { key: 'Shift+Enter / Ctrl+J', action: 'insert a newline' },
  { key: 'Tab', action: 'complete /commands, arguments and @files' },
  { key: 'Shift+Tab', action: 'toggle plan mode' },
  { key: 'Esc', action: 'close an overlay; otherwise interrupt a turn or compaction' },
  { key: 'Ctrl+C', action: 'abort work or clear draft; twice on an empty draft exits' },
  { key: 'Ctrl+G', action: 'edit draft in $VISUAL/$EDITOR while idle; next match in search' },
  { key: 'Ctrl+O', action: 'expand or collapse transcript details' },
  { key: 'Ctrl+T', action: 'show all tasks' },
  { key: 'Up / Down', action: 'composer history at the draft boundary' },
  { key: 'PgUp / PgDn', action: 'scroll transcript; wheel also scrolls the pane under the pointer' },
  { key: 'Home / End', action: 'transcript start / latest output' },
  { key: 'Ctrl+Up / Ctrl+Down', action: 'jump to previous / next user prompt' },
  { key: 'Ctrl+Shift+F', action: 'search transcript; Enter next; Shift+Enter previous; Esc close' },
  { key: 'Mouse drag', action: 'select text; release copies the selection' },
  { key: 'Bracketed paste', action: 'insert clipboard text as one draft, without submitting' },
] as const;
