import type { FocusOwnerHandler } from './types.js';

export const activityOwner: FocusOwnerHandler = {
  id: 'activity',
  active: (env) => env.activity?.isOpen() ?? false,
  handle: (env, ch, key) => env.activity?.handleKey(ch, key) ?? false,
};
