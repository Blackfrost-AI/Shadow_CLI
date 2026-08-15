import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { resolveEditor, openEditorFile } from '../src/tui/externalEditor.js';

test('resolveEditor prefers $VISUAL, then $EDITOR, then a platform default', () => {
  assert.equal(resolveEditor({ VISUAL: 'nvim', EDITOR: 'nano' }), 'nvim');
  assert.equal(resolveEditor({ EDITOR: 'nano' }), 'nano');
  assert.equal(resolveEditor({ VISUAL: 'code --wait' }), 'code --wait', 'multi-word editors preserved');
  assert.equal(resolveEditor({}, 'darwin'), 'vi');
  assert.equal(resolveEditor({}, 'linux'), 'vi');
  assert.equal(resolveEditor({}, 'win32'), 'notepad');
  assert.equal(resolveEditor({ VISUAL: '  ' , EDITOR: '' }, 'linux'), 'vi', 'blank vars ignored');
});

test('openEditorFile round-trips the draft and trims one trailing newline', () => {
  const session = openEditorFile('hello\nworld');
  try {
    assert.ok(existsSync(session.file), 'temp file created');
    // Simulate the user editing + saving (editors add a trailing newline).
    writeFileSync(session.file, 'edited message\n', 'utf8');
    assert.equal(session.read(), 'edited message', 'one trailing newline trimmed');
  } finally {
    session.cleanup();
    assert.ok(!existsSync(session.file), 'cleanup removes the temp file');
    session.cleanup(); // idempotent — must not throw
  }
});

test('openEditorFile seeds the file with the initial draft', () => {
  const session = openEditorFile('seed content');
  try {
    assert.equal(session.read(), 'seed content');
  } finally {
    session.cleanup();
  }
});
