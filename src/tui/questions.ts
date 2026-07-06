// Pure question/answer logic for the interactive AskUserQuestion dialog — no React/Ink, so it is
// unit-testable in isolation. The TUI imports these; the idle countdown uses buildAutoAnswers() to
// answer on an away user's behalf with the recommended option(s).
import type { UserQuestion, UserAnswer } from '../agent/approval.js';

/** Per-question selected labels, keyed by the question's index in the dialog. */
export type QuestionSelection = Record<number, string[]>;

/**
 * Index of the recommended option: the one whose label carries "(Recommended)" (case-insensitive),
 * else the first — Claude's AskUserQuestion convention puts the recommended choice first, and the
 * ask_user_question tool tells the model to mark it "(Recommended)".
 */
export function recommendedIndex(q: UserQuestion): number {
  const i = q.options.findIndex((o) => /\(recommended\)/i.test(o.label));
  return i >= 0 ? i : 0;
}

/** Single-select pre-highlights the recommended option; multi-select starts unchecked. */
export function defaultQuestionSelection(q: UserQuestion): string[] {
  const r = q.options[recommendedIndex(q)];
  return q.multiSelect ? [] : r ? [r.label] : [];
}

/** What the idle countdown picks on the user's behalf: the recommended option(s), never empty. */
export function autoAnswerSelection(q: UserQuestion): string[] {
  if (!q.multiSelect) {
    const r = q.options[recommendedIndex(q)];
    return r ? [r.label] : [];
  }
  const rec = q.options.filter((o) => /\(recommended\)/i.test(o.label)).map((o) => o.label);
  return rec.length ? rec : q.options[0] ? [q.options[0].label] : [];
}

/** Map current selections to answers; an unanswered question falls back to its default. */
export function buildQuestionAnswers(
  questions: UserQuestion[],
  selections: QuestionSelection,
): UserAnswer[] {
  return questions.map((q, i) => ({
    question: q.question,
    selected: selections[i] ?? defaultQuestionSelection(q),
  }));
}

/**
 * Like buildQuestionAnswers, but any UNanswered question falls back to the recommended option
 * (never empty/skipped) — used when the idle countdown answers for an away user. A question the
 * user already touched keeps their selection.
 */
export function buildAutoAnswers(
  questions: UserQuestion[],
  selections: QuestionSelection,
): UserAnswer[] {
  return questions.map((q, i) => ({
    question: q.question,
    selected: selections[i]?.length ? selections[i]! : autoAnswerSelection(q),
  }));
}
