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
