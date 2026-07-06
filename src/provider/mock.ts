import {
  estimateTokensFromMessages,
  type Message,
  type Provider,
  type ProviderEvent,
} from './provider.js';

export type MockTurn = ProviderEvent[] | ((messages: Message[]) => ProviderEvent[]);

/**
 * Deterministic provider for tests and M0. Constructed with an ordered list of
 * "turn scripts" — each call to send() emits the next script's events. When the
 * scripts run out it emits a clean end_turn so loops always terminate.
 */
export class MockProvider implements Provider {
  readonly name = 'mock';
  private i = 0;

  /**
   * @param turns ordered turn scripts; each send() emits the next.
   * @param repeatLast when scripts run out, replay the LAST script instead of a
   *   clean end_turn — used by the demo mock so an interactive/piped REPL keeps
   *   responding to every input rather than going silent after turn 1.
   */
  constructor(
    private readonly turns: MockTurn[] = [],
    private readonly repeatLast = false,
  ) {}

  async *send(req: { messages: Message[] }): AsyncIterable<ProviderEvent> {
    const fallback =
      this.repeatLast && this.turns.length ? this.turns[this.turns.length - 1]! : defaultDoneTurn();
    const turn = this.turns[this.i] ?? fallback;
    this.i += 1;
    const events = typeof turn === 'function' ? turn(req.messages) : turn;
    for (const e of events) {
      yield e;
    }
  }

  estimateTokens(messages: Message[]): number {
    return estimateTokensFromMessages(messages);
  }
}

function defaultDoneTurn(): ProviderEvent[] {
  return [
    { type: 'usage', inputTokens: 0, outputTokens: 0 },
    { type: 'done', stopReason: 'end_turn' },
  ];
}

/** Deterministic provider-error script for headless/CI when SHADOW_MOCK_ERROR=1. */
function hasToolResults(messages: Message[]): boolean {
  const last = messages[messages.length - 1];
  return !!last && last.role === 'user' && last.content.some((b) => b.type === 'tool_result');
}

function doneTurn(): ProviderEvent[] {
  return [
    { type: 'text', delta: 'done' },
    { type: 'usage', inputTokens: 1, outputTokens: 1 },
    { type: 'done', stopReason: 'end_turn' },
  ];
}

/**
 * Scripted mock for dialect eval: emits foreign tool names (shell_command, update_plan)
 * on the first turn, then end_turn after tool results are committed.
 */
export function dialectMock(): MockProvider {
  return new MockProvider([
    (messages) => {
      if (hasToolResults(messages)) return doneTurn();
      const task = lastUserText(messages).toLowerCase();
      if (task.includes('shell_command') || task.includes('dialect-ok')) {
        return [
          {
            type: 'tool_call',
            call: {
              id: 'dialect-shell',
              name: 'shell_command',
              input: { command: 'echo DIALECT-OK > dialect-ok.txt', working_directory: '.' },
            },
          },
          { type: 'usage', inputTokens: 10, outputTokens: 5 },
          { type: 'done', stopReason: 'tool_use' },
        ];
      }
      if (task.includes('update_plan')) {
        return [
          {
            type: 'tool_call',
            call: {
              id: 'dialect-plan',
              name: 'update_plan',
              input: {
                items: [
                  { subject: 'alpha', status: 'in_progress' },
                  { subject: 'beta', status: 'pending' },
                ],
              },
            },
          },
          { type: 'usage', inputTokens: 10, outputTokens: 5 },
          { type: 'done', stopReason: 'tool_use' },
        ];
      }
      return doneTurn();
    },
  ]);
}

/**
 * Recovery scenario mock for headless/CI verification.
 * Set SHADOW_MOCK_RECOVERY to `unknown` | `bad_patch`.
 */
export function recoveryMock(): MockProvider {
  const mode = process.env.SHADOW_MOCK_RECOVERY ?? 'unknown';
  return new MockProvider([
    (messages) => {
      if (hasToolResults(messages)) return doneTurn();
      if (mode === 'bad_patch') {
        return [
          {
            type: 'tool_call',
            call: {
              id: 'bad-patch',
              name: 'apply_patch',
              input: { patch: '*** Begin Patch\n*** Update File: missing.txt\n@@\n-bad\n+line\n*** End Patch' },
            },
          },
          { type: 'usage', inputTokens: 8, outputTokens: 4 },
          { type: 'done', stopReason: 'tool_use' },
        ];
      }
      return [
        {
          type: 'tool_call',
          call: { id: 'unknown-tool', name: 'totally_fake_tool_xyz', input: { probe: true } },
        },
        { type: 'usage', inputTokens: 8, outputTokens: 4 },
        { type: 'done', stopReason: 'tool_use' },
      ];
    },
  ]);
}

export function errorMock(): MockProvider {
  return new MockProvider([
    (messages) => {
      const task = lastUserText(messages) || 'x';
      return [
        {
          type: 'error',
          recoverable: true,
          code: 'mock_provider_error',
          message: `injected provider failure for "${task}"`,
        },
        { type: 'done', stopReason: 'end_turn' },
      ];
    },
  ], true);
}

/**
 * A friendly default mock for `shadow --provider mock` with no script: it streams
 * a short acknowledgement of the task and ends the turn. Proves the REPL/HUD render
 * streamed text and that the loop terminates — no network, no tools.
 */
export function demoMock(): MockProvider {
  return new MockProvider([
    (messages) => {
      const task = lastUserText(messages) || 'your task';
      if (task === 'print ok') {
        return [
          { type: 'text', delta: 'ok' },
          { type: 'usage', inputTokens: 1, outputTokens: 1 },
          { type: 'done', stopReason: 'end_turn' },
        ];
      }
      const reply = `Shadow (mock): I received "${task}". With a real provider and tools I would now read, search, edit, and run commands to complete it.`;
      const events: ProviderEvent[] = [];
      for (const word of reply.split(' ')) events.push({ type: 'text', delta: word + ' ' });
      events.push({ type: 'usage', inputTokens: 20, outputTokens: 40 });
      events.push({ type: 'done', stopReason: 'end_turn' });
      return events;
    },
  ], true /* repeatLast: reply to every turn, not just the first */);
}

function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user') {
      const t = m.content.find((b) => b.type === 'text');
      if (t && t.type === 'text') return t.text;
    }
  }
  return '';
}
