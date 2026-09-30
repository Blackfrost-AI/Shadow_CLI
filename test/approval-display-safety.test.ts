import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { previewOf } from '../src/agent/loop.js';
import { approvalText } from '../src/util/approvalText.js';
import { PendingDialog, previewRows, type DialogHost } from '../src/app/dialogs.js';
import { PendingOverlay, buildApprovalDiff } from '../src/tui/overlays.js';
import { ReplGate } from '../src/replGate.js';
import type { ApprovalDecision, ApprovalRequest, UserQuestion } from '../src/agent/approval.js';

const colors = {
  fg: '#ffffff',
  dim: '#999999',
  green: '#00ff00',
  cyan: '#00ffff',
  yellow: '#ffff00',
  red: '#ff0000',
  purple: '#ff00ff',
};
const plain = (text: string) => text.replace(/\x1b\[[0-9;:]*m/g, '');
const controls = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;
const request = (preview: string): ApprovalRequest => ({
  id: 'display-test',
  kind: 'permission',
  risk: 'exec',
  preview,
  reason: 'policy\x1b[8m\u202e',
  call: { id: 'call-test', name: 'run_shell', input: { command: preview } },
});
const question: UserQuestion = {
  header: 'H\x1b[2J',
  question: 'Q\u202e?',
  options: [{ label: 'A\x1b[8mB', description: 'D\u2066' }, { label: 'Other' }],
};

function pi(req: ApprovalRequest) {
  const decisions: ApprovalDecision[] = [];
  const host: DialogHost = {
    decide: (d) => decisions.push(d),
    onQuestionIndexChange: () => {},
    repaint: () => {},
    getAutonomy: () => 'manual',
    selections: {},
    cursors: {},
  };
  const dialog = new PendingDialog(req, host, () => ({ cols: 120, rows: 40 }));
  return { dialog, decisions, frame: plain(dialog.render(120).join('\n')) };
}

function ink(req: ApprovalRequest) {
  const view = render(
    React.createElement(PendingOverlay, {
      pending: req,
      cols: 120,
      rows: 40,
      pageMargin: 4,
      colors,
      activeQuestion: req.questions?.[0],
      activeQuestionIndex: 0,
      pendingQuestionsLength: req.questions?.length ?? 0,
      activeQuestionSelection: [],
      questionCursor: {},
      autoAnswerSecs: null,
    }),
  );
  const frame = plain(view.lastFrame() ?? '');
  view.unmount();
  return frame;
}

test('approval projection exposes controls without consuming an unterminated escape payload', () => {
  const value = 'echo safe\x1b]52;c;unterminated; echo ACTUAL\r\b\x9b2J\u202e\u2066\u200b';
  const req = request(value);
  const before = JSON.stringify(req.call);
  const preview = previewOf(req.call);
  assert.doesNotMatch(preview, controls);
  assert.match(preview, /echo ACTUAL/);
  for (const escaped of ['\\x1b]52', '\\x0d', '\\x08', '\\x9b', '\\u202e', '\\u2066', '\\u200b']) {
    assert.ok(preview.includes(escaped), escaped);
  }
  assert.equal(JSON.stringify(req.call), before, 'display must never rewrite the approved input');
  assert.equal(approvalText('漢字 café'), '漢字 café');
});

test('tool names, descriptions, operative arguments and fallback previews all receive the same projection', () => {
  for (const input of [
    { command: 'echo \x1b[8mREAL', description: '\u202eDESC' },
    { description: '\u202eDESC' },
    { custom: '\u202eREAL' },
    '\x1b[2J',
  ]) {
    const preview = previewOf({ id: 't', name: 'tool\u202e', input });
    assert.doesNotMatch(preview, controls);
    assert.ok(preview.includes('\\u202e') || preview.includes('\\x1b'));
  }
});

test('Ink and pi sanitize direct approval requests before clipping and retain a long command tail', () => {
  const req = request('echo \x1b[8mhead\u202e ' + 'x'.repeat(800) + '; echo ACTUAL_TAIL');
  const snapshot = JSON.stringify(req);
  for (const frame of [ink(req), pi(req).frame]) {
    assert.doesNotMatch(frame, controls);
    assert.match(frame, /\\x1b\[8mhead\\u202e/);
    assert.match(frame, /ACTUAL_TAIL/);
    assert.match(frame, /more characters not shown/);
    assert.match(frame, /policy\\x1b\[8m\\u202e/);
  }
  assert.equal(JSON.stringify(req), snapshot);
  const rows = previewRows('echo \x1b]52;c;unterminated; echo tail', 74, 74, 3);
  assert.match(rows.rows.join(''), /echo tail/);
  assert.doesNotMatch(rows.rows.join(''), controls);
});

test('question titles, bodies, options and descriptions are safe while pi answers keep original values', () => {
  const req = { ...request('fallback'), kind: 'user_question' as const, questions: [question] };
  const view = pi(req);
  for (const frame of [view.frame, ink(req)]) {
    assert.doesNotMatch(frame, controls);
    for (const text of ['H\\x1b[2J', 'Q\\u202e?', 'A\\x1b[8mB', 'D\\u2066'])
      assert.ok(frame.includes(text), frame);
  }
  view.dialog.handleInput('\r');
  assert.deepEqual(view.decisions, [
    { answers: [{ question: question.question, selected: [question.options[0]!.label] }] },
  ]);
});

test('approval diff headers and added/removed text cannot inject terminal or bidi controls', () => {
  const call = {
    name: 'edit_file',
    input: {
      path: 'p\u202e.ts',
      old_string: 'old\x1b[2J',
      new_string: '\x1b]0;unterminated;REAL\u2066',
    },
  };
  const before = JSON.stringify(call);
  const diff = buildApprovalDiff(call, 20);
  assert.ok(diff);
  assert.match(diff.header, /p\\u202e\.ts/);
  const body = diff.lines.map((line) => line.text).join('\n');
  assert.doesNotMatch(body, controls);
  assert.match(body, /REAL\\u2066/);
  assert.equal(JSON.stringify(call), before);
});

for (const plainMode of [false, true]) {
  test(`REPL approval and question display are safe (plain=${plainMode}) and preserve decisions`, async () => {
    const oldWrite = process.stdout.write;
    let output = '';
    process.stdout.write = ((value: string) => {
      output += value;
      return true;
    }) as typeof oldWrite;
    try {
      const req = request('echo \x1b[2J\u202eACTUAL');
      const gate = new ReplGate({ question: async () => 'y' } as never, () => 'auto-read', {
        plain: plainMode,
      });
      assert.equal(await gate.request(req), 'approve');
      const qgate = new ReplGate({ question: async () => '1' } as never, () => 'auto-read', {
        plain: plainMode,
      });
      const result = await qgate.request({ ...req, kind: 'user_question', questions: [question] });
      assert.deepEqual(result, {
        answers: [{ question: question.question, selected: [question.options[0]!.label] }],
      });
      assert.doesNotMatch(plain(output), controls);
      assert.match(output, /\\x1b\[2J\\u202eACTUAL/);
      if (plainMode) assert.doesNotMatch(output, /\x1b/);
    } finally {
      process.stdout.write = oldWrite;
    }
  });
}
