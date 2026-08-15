export type OutputStyle = 'proactive' | 'explanatory' | 'learning' | 'procedural';

interface StyleBlock {
  label: string;
  block: string;
}

const styles: Record<OutputStyle, StyleBlock> = {
  proactive: {
    label: 'Proactive',
    block: [
      '',
      '## Output style — Proactive',
      'Default behavior for Shadow.',
      'Reason briefly, call tools to act, observe results, and continue until the task is done, then stop.',
      '',
    ].join('\n'),
  },
  explanatory: {
    label: 'Explanatory',
    block: [
      '',
      '## Output style — Explanatory',
      'Make reasoning visible. Prefer explanations that show the current state, trade-offs, and why a next action is chosen.',
      'Still call tools to act; don’t let explanation replace verification.',
      '',
    ].join('\n'),
  },
  learning: {
    label: 'Learning',
    block: [
      '',
      '## Output style — Learning',
      'When information is uncertain, record the assumption and continue exploring. Prefer evidence-gathering over premature certainty.',
      'Use this when the task may reveal new constraints as you inspect files or run commands.',
      '',
    ].join('\n'),
  },
  procedural: {
    label: 'Procedural',
    block: [
      '',
      '## Output style — Procedural',
      'Do one concrete action, observe the result, then decide the next. Prefer simple, checkable work over cleverness.',
      'If stuck after two attempts, stop and report what you tried and what you observed.',
      '',
    ].join('\n'),
  },
};


export { styles };
export const outputStyles = ['proactive', 'explanatory', 'learning', 'procedural'] as const;
export type OutputStyleValue = (typeof outputStyles)[number];

// F08-12: user-defined output styles (loaded from .shadow/.claude output-styles dirs) live in a
// session registry so the pure buildStyledSystem + the /style picker can resolve them by name
// without widening the built-in union everywhere. Set once per session in bootstrap.
let customStyleRegistry: Record<string, { label: string; block: string }> = {};
export function setCustomStyles(list: ReadonlyArray<{ name: string; label: string; block: string }>): void {
  customStyleRegistry = {};
  for (const s of list) customStyleRegistry[s.name.toLowerCase()] = { label: s.label, block: s.block };
}
/** The prompt block for a custom style name, or undefined if it isn't one. */
export function customStyleBlock(name: string): string | undefined {
  return customStyleRegistry[name.toLowerCase()]?.block;
}
/** All registered custom style names (lowercased), for the /style picker. */
export function customStyleNames(): string[] {
  return Object.keys(customStyleRegistry);
}
/** True if `name` is a built-in or a registered custom style. */
export function isKnownStyle(name: string): boolean {
  return (outputStyles as readonly string[]).includes(name) || name.toLowerCase() in customStyleRegistry;
}
