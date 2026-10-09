import test from 'node:test';
import assert from 'node:assert/strict';
import { stripInvisible as stripAnsi } from '../src/util/width.js';
import { GLYPHS } from '../src/tui/glyphs.js';
import { ChoicePicker } from '../src/app/picker.js';
import { ShadowAutocompleteProvider } from '../src/app/autocomplete.js';

test('pickers repaint arrow selection and require Enter for multi-digit choices', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ name: `Model ${i + 1}` }));
  items[11]!.name += '\x1b]52;c;fake\x07\u202e';
  let chosen: typeof items[number] | undefined;
  let closed = false;
  let paints = 0;
  const picker = new ChoicePicker({
    title: 'Models', items, label: (item) => item.name, rows: () => 30,
    choose: (item) => { chosen = item; }, close: () => { closed = true; }, repaint: () => paints++,
  });
  const frame = () => picker.render(100).map(stripAnsi).join('\n');
  assert.ok(frame().includes(`${GLYPHS.promptPrefix}1. Model 1`));
  picker.handleInput('\x1b[B');
  assert.ok(frame().includes(`${GLYPHS.promptPrefix}2. Model 2`));
  picker.handleInput('1');
  picker.handleInput('2');
  assert.equal(chosen, undefined, 'typing a number alone must never commit a choice');
  assert.ok(frame().includes(`${GLYPHS.promptPrefix}12. Model 12\\x1b`));
  assert.match(frame(), /\\u202e/);
  picker.handleInput('\x1b[13;1:3u'); // Kitty Enter release
  assert.equal(chosen, undefined);
  picker.handleInput('\r');
  assert.equal(chosen, items[11], 'selection retains the unmodified value');
  assert.equal(paints, 3);
  picker.handleInput('\x1b');
  assert.equal(closed, true);
});

test('autocomplete renders hostile controls visibly while inserting the original value', async () => {
  const raw = 'preset\x1b]52;c;fake\x07\u202e';
  const provider = new ShadowAutocompleteProvider([
    { name: '/model', desc: 'Pick a model', args: () => [{ value: raw, label: raw, description: raw }] },
  ], process.cwd());
  const line = '/model ';
  const found = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
  const item = found!.items[0]!;
  assert.equal(item.value, raw);
  assert.match(item.label!, /\\x1b/);
  assert.match(item.description!, /\\u202e/);
  assert.equal(provider.applyCompletion([line], 0, line.length, item, found!.prefix).lines[0], line + raw);
});

test('search filters choices, arrows select the filtered item, and Escape clears before closing', () => {
  let chosen = ''; let closed = false;
  const picker = new ChoicePicker({ title: 'Profiles', items: ['Local reviewer', 'Remote implementer', 'Remote reviewer'],
    label: (item) => item, choose: (item) => { chosen = item; }, close: () => { closed = true; }, repaint: () => {}, rows: () => 18 });
  picker.handleInput('/'); picker.handleInput('remote');
  assert.doesNotMatch(picker.render(80).map(stripAnsi).join('\n'), /Local reviewer/);
  picker.handleInput('\x1b[B'); picker.handleInput('\r');
  assert.equal(chosen, 'Remote reviewer');
  picker.handleInput('\x1b'); assert.equal(closed, false);
  assert.match(picker.render(80).map(stripAnsi).join('\n'), /Local reviewer/);
  picker.handleInput('\x1b'); assert.equal(closed, true);
});
