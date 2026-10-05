import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { terminalRenderer } from '../src/tui/renderer.js';
import { TERMINAL_COMMANDS } from '../src/tui/commandCatalog.js';
import { PI_KEYS } from '../src/app/keymap.js';

test('Snowfall is default and explicit Ink remains the compatibility renderer', () => {
  assert.equal(terminalRenderer({}), 'pi');
  assert.equal(terminalRenderer({ SHADOW_TUI: 'pi' }), 'pi');
  assert.equal(terminalRenderer({ SHADOW_TUI: 'ink' }), 'ink');
  assert.equal(terminalRenderer({ SHADOW_TUI: 'fullscreen' }), 'pi');
});

test('published command and key matrix agrees with the actual capability inventory', () => {
  const doc = readFileSync(new URL('../docs/TERMINAL_RENDERERS.md', import.meta.url), 'utf8');
  for (const command of TERMINAL_COMMANDS) {
    const row = `| \`${command.name}\` | ${command.desc} | ${command.renderers.pi.handler ? 'Available' : command.renderers.pi.unavailable} | ${command.renderers.ink.handler ? 'Available' : command.renderers.ink.unavailable} |`;
    assert.ok(doc.includes(row), `${command.name} capability changed; regenerate the contract`);
  }
  for (const { key, action } of PI_KEYS) assert.ok(doc.includes(`| ${key} | ${action} |`), key);
  assert.match(doc, /SHADOW_TUI=ink npm start/);
});
