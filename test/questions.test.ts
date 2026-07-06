import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UserQuestion } from '../src/agent/approval.js';
import {
  recommendedIndex,
  defaultQuestionSelection,
  autoAnswerSelection,
  buildQuestionAnswers,
  buildAutoAnswers,
} from '../src/tui/questions.js';

const single = (opts: string[], multiSelect = false): UserQuestion => ({
  question: 'Pick one',
  options: opts.map((label) => ({ label })),
  multiSelect,
});

test('recommendedIndex: defaults to the first option when nothing is marked', () => {
  assert.equal(recommendedIndex(single(['A', 'B', 'C'])), 0);
});

test('recommendedIndex: finds the "(Recommended)" option, case-insensitively, at any position', () => {
  assert.equal(recommendedIndex(single(['A', 'B (Recommended)', 'C'])), 1);
  assert.equal(recommendedIndex(single(['A', 'B', 'C (RECOMMENDED)'])), 2);
});

test('defaultQuestionSelection: single-select pre-picks the recommended; multi-select starts empty', () => {
  assert.deepEqual(defaultQuestionSelection(single(['A', 'B (Recommended)'])), ['B (Recommended)']);
  assert.deepEqual(defaultQuestionSelection(single(['A', 'B'], true)), []);
});

test('autoAnswerSelection: single-select picks the recommended option', () => {
  assert.deepEqual(autoAnswerSelection(single(['A', 'B (Recommended)', 'C'])), ['B (Recommended)']);
  assert.deepEqual(autoAnswerSelection(single(['A', 'B', 'C'])), ['A']); // no marker → first
});

test('autoAnswerSelection: multi-select picks all recommended, else the first (never empty)', () => {
  assert.deepEqual(
    autoAnswerSelection(single(['A (Recommended)', 'B', 'C (recommended)'], true)),
    ['A (Recommended)', 'C (recommended)'],
  );
  assert.deepEqual(autoAnswerSelection(single(['A', 'B'], true)), ['A']); // none marked → first
});

test('buildQuestionAnswers: unanswered questions fall back to the default selection', () => {
  const qs = [single(['A', 'B (Recommended)']), single(['X', 'Y'])];
  const answers = buildQuestionAnswers(qs, { 1: ['X'] }); // only q1 answered
  assert.deepEqual(answers, [
    { question: 'Pick one', selected: ['B (Recommended)'] }, // q0 → default (recommended)
    { question: 'Pick one', selected: ['X'] }, // q1 → user's pick
  ]);
});

test('buildAutoAnswers: away user gets the recommended answer for every UNanswered question', () => {
  const qs = [single(['A', 'B (Recommended)']), single(['X', 'Y'], true)];
  const answers = buildAutoAnswers(qs, { 0: ['A'] }); // user touched q0 only
  assert.deepEqual(answers, [
    { question: 'Pick one', selected: ['A'] }, // kept the user's explicit pick
    { question: 'Pick one', selected: ['X'] }, // q1 unanswered → recommended (first, multi)
  ]);
});

test('buildAutoAnswers: an empty selection is treated as unanswered → recommended', () => {
  const qs = [single(['A', 'B (Recommended)'])];
  assert.deepEqual(buildAutoAnswers(qs, { 0: [] }), [{ question: 'Pick one', selected: ['B (Recommended)'] }]);
});
