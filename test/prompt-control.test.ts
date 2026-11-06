import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promptControlPayload, promptSteeringAction } from '../src/agent/promptControl.js';
import { findTerminalCommand, commandHandler } from '../src/tui/commandCatalog.js';

describe('explicit prompt controls', () => {
  it('preserves multiline payloads; rejects empty and nested commands', () => {
    assert.equal(promptControlPayload('  first\nsecond  '), 'first\nsecond');
    for (const text of ['status', 'off', 'clear']) assert.equal(promptControlPayload(text), text);
    assert.throws(() => promptControlPayload('  '));
    assert.throws(() => promptControlPayload(' \n /quit'), /nested/);
  });
  it('explicit queueing never interrupts, with or without a backlog', () => {
    for (const ahead of [0, 1, 3]) for (const pending of [true, false]) {
      assert.equal(promptSteeringAction('next', ahead, true, pending, false), 'none');
    }
  });
  it('preserves default steering and FIFO fairness', () => {
    assert.equal(promptSteeringAction('next', 0, true, false), 'inject');
    assert.equal(promptSteeringAction('next', 1, true, false), 'end-turn');
    assert.equal(promptSteeringAction('next', 1, true, true), 'none');
    assert.equal(promptSteeringAction('next', 0, false, false), 'none');
    assert.equal(promptSteeringAction('/compact', 0, true, false), 'none');
  });
  it('advertises exact names and only implemented renderer handlers', () => {
    for (const name of ['/queue', '/steer']) {
      const command = findTerminalCommand(name)!;
      assert.equal(commandHandler(command, 'pi'), name.slice(1));
      assert.equal(commandHandler(command, 'ink'), name.slice(1));
    }
    assert.ok(!findTerminalCommand('/queuefoo'));
    assert.ok(!findTerminalCommand('/steering'));
  });
});
