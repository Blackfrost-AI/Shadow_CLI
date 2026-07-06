import { z } from 'zod';
import type { Tool } from './types.js';
import { ok } from './types.js';

const optionSchema = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
});

const questionSchema = z.object({
  question: z.string().min(1),
  header: z.string().optional(),
  options: z.array(optionSchema).min(2),
  multiSelect: z.boolean().optional(),
});

const inputSchema = z.object({
  questions: z.array(questionSchema).min(1),
});

export type AskUserInput = z.infer<typeof inputSchema>;
export type AskUserQuestion = z.infer<typeof questionSchema>;

/** Claude AskUserQuestion parity — answers collected by the approval gate, not in run(). */
export function makeAskUserQuestionTool(): Tool<AskUserInput, { answers: unknown }> {
  return {
    name: 'ask_user_question',
    description:
      'Ask the user structured multiple-choice questions when blocked on a decision only they can make. ' +
      'Users can always pick "Other" for custom input. Put the recommended option first with "(Recommended)" in the label. ' +
      'In plan mode, use this to clarify requirements before finalizing the plan — not to ask if the plan is ready.',
    risk: 'read',
    inputSchema,
    async run(input) {
      return ok('ask_user_question', 'read', 0, 'Questions presented to user.', { answers: input.questions });
    },
  };
}

export { inputSchema as askUserInputSchema };