// Snowfall's shared visual vocabulary. Keep terminal-cell geometry separate from color.
import { displayWidth } from '../util/width.js';

export const GLYPHS = {
  assistant: '✻',
  tool: '✦',
  prompt: '▸',
  promptPrefix: '▸ ',
  result: '╰─',
  // Four cells, matching the expanded result body's continuation indentation.
  resultPrefix: ' ╰─ ',
  user: '◇',
  cursor: '▸',
  spinner: ['✻', '✦', '✧', '✦'],
  effortMedium: '◇',
  effortHigh: '◆',
  // A mathematical bar-chart fraction, not a user-turn marker.
  halfBlock: '▌',
  // Read old saved transcripts without keeping their presentation vocabulary live.
  legacyPromptPrefix: '❯ ',
} as const;

export const EFFORT_GLYPHS = { low: '·', medium: '◇', high: '◆', xhigh: '✧', max: '✦' } as const;
export const SPACING = { page: 2, inkPage: 4, child: 2, section: 1 } as const;
export const BORDER = { topLeft: '╭', topRight: '╮', bottomLeft: '╰', bottomRight: '╯', horizontal: '─', vertical: '│' } as const;
export const PROMPT_WIDTH = displayWidth(GLYPHS.promptPrefix);

export function stripPrompt(text: string): string {
  for (const prefix of [GLYPHS.promptPrefix, GLYPHS.legacyPromptPrefix]) {
    if (text.startsWith(prefix)) return text.slice(prefix.length);
  }
  return text;
}
