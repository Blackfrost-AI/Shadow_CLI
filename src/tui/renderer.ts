import type { TerminalRenderer } from './commandCatalog.js';

/** Snowfall is the interactive default. Ink remains an explicit fallback for the v10 cycle. */
export function terminalRenderer(env: NodeJS.ProcessEnv = process.env): TerminalRenderer {
  return env.SHADOW_TUI === 'ink' ? 'ink' : 'pi';
}
