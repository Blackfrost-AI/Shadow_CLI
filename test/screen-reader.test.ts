import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/agent/events.js';
import { attachScreenReader } from '../src/tui/screenReader.js';
import { parseArgs } from '../src/cli/flags.js';
import { ReplGate } from '../src/replGate.js';
import { THEMES } from '../src/tui/theme.js';

test('screen-reader output has stable speaker labels and inspectable full tool results', () => {
  const bus = new EventBus();
  let output = '';
  const reader = attachScreenReader(bus, {
    model: 'fixture',
    write: (text) => {
      output += text;
    },
  });
  try {
    bus.emit({ type: 'mode', mode: 'thinking' });
    bus.emit({ type: 'text', delta: 'An answer' });
    assert.doesNotMatch(output, /An answer/, 'no per-token announcements');
    bus.emit({ type: 'assistant_done', text: 'An answer.' });
    bus.emit({ type: 'reasoning_done', text: 'PRIVATE_THOUGHT' });
    bus.emit({
      type: 'tool_end',
      call: { id: '1', name: 'run_shell', input: { command: 'cat /tmp/file' } },
      result: {
        ok: true,
        summary: 'Command exited 0.',
        data: { stdout: 'FIRST\n' + 'line\n'.repeat(300) + 'LAST' },
        meta: { tool: 'run_shell', risk: 'exec', durationMs: 0 },
      },
    });
    bus.emit({ type: 'shell_output', callId: '1', stream: 'stdout', chunk: 'NOISY_INCREMENT' });
    bus.emit({ type: 'stop', reason: 'end_turn', finalAnswer: '' });
    assert.match(output, /SHADOW · fixture\nAn answer\./);
    assert.match(output, /\[DONE\] 1 command/);
    assert.doesNotMatch(output, /PRIVATE_THOUGHT|NOISY_INCREMENT|\x1b/);
    assert.equal(reader.command('/activity 1 2'), true);
    assert.match(output, /FIRST[\s\S]*LAST/);
    assert.equal(reader.command('/activity invalid'), true);
    assert.match(output, /Use \/activity/);
    assert.equal(reader.command('ordinary task'), false);
  } finally {
    reader.dispose();
  }
});

test('text mode preserves interrupted answers and reports failures in text', () => {
  const bus = new EventBus();
  let output = '';
  const reader = attachScreenReader(bus, {
    model: 'fixture',
    write: (text) => {
      output += text;
    },
  });
  try {
    bus.emit({ type: 'text', delta: 'Partial answer' });
    bus.emit({ type: 'stop', reason: 'interrupted', finalAnswer: '' });
    bus.emit({ type: 'error', message: 'Fixture failed' });
    assert.match(output, /SHADOW · fixture\nPartial answer/);
    assert.match(output, /\[STOPPED\] interrupted/);
    assert.match(output, /\[ERROR\] Fixture failed/);
  } finally {
    reader.dispose();
  }
});

test('accessibility flags are explicit booleans', () => {
  assert.deepEqual(parseArgs(['--screen-reader', '--reduced-motion']), {
    screenReader: true,
    reducedMotion: true,
  });
  assert.throws(() => parseArgs(['--screen-reader=false']), /does not take a value/);
});

test('plain approvals remain interactive and have no ANSI formatting', async () => {
  const old = process.stdout.write;
  let output = '';
  process.stdout.write = ((value: string) => {
    output += value;
    return true;
  }) as typeof old;
  try {
    const gate = new ReplGate({ question: async () => 'y' } as never, () => 'auto-read', {
      plain: true,
    });
    const result = await gate.request({
      id: '1',
      kind: 'tool',
      preview: 'Run fixture',
      risk: 'exec',
      reason: 'Approval needed',
    } as never);
    assert.equal(result, 'approve');
    assert.match(output, /approve\?/);
    assert.doesNotMatch(output, /\x1b/);
  } finally {
    process.stdout.write = old;
  }
});

test('readable text tokens meet AA contrast on the supported dark and light backgrounds', () => {
  const lum = (hex: string) => {
    const rgb = hex
      .slice(1)
      .match(/../g)!
      .map((n) => parseInt(n, 16) / 255)
      .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4));
    return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
  };
  for (const [name, backgrounds] of [
    ['high-contrast', ['#000000', '#272b33']],
    ['light', ['#ffffff']],
  ] as const) {
    const theme = THEMES[name];
    for (const bg of backgrounds)
      for (const role of [
        'body',
        'dim',
        'bright',
        'red',
        'green',
        'cyan',
        'yellow',
        'purple',
      ] as const) {
        const a = lum(theme[role]),
          b = lum(bg);
        assert.ok(
          (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5,
          `${name}.${role} on ${bg}`,
        );
      }
  }
});
