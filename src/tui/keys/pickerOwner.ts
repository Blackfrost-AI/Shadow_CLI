/**
 * P3-01 — focus-owner router: the MODEL PICKER owner (old onKey §1.5).
 *
 * Mirrors the approval-dialog gating: while the picker is open it captures navigation and
 * swallows the rest, so composer/menu keys can't leak through.
 */
import { firstSelectableRow, stepSelectableRow } from '../../util/modelGroups.js';
import type { ContextName } from '../keybindings/types.js';
import type { FocusOwnerHandler, InkKey, KeyEnv } from './types.js';

function handlePicker(env: KeyEnv, ch: string, key: InkKey): boolean {
  // F03-03: route bound picker keys through the resolver FIRST — the same pattern as the
  // dialog owner — so ~/.shadow/keybindings.json can rebind them the moment the picker:*
  // handlers register; unbound keys fall through to the inline nav below. Before that fix,
  // 'ModelPicker' was pushed into kbContexts further down the chain — a site this branch's
  // unconditional return made dead code, so ModelPicker bindings could never fire.
  const pickerCtx: ContextName[] = ['ModelPicker', 'Global'];
  if (env.kbConsume(ch, key, pickerCtx)) return true;
  const rows = env.modelRows(env.cfg);
  let sel = Math.min(env.pickerIndexRef.current, rows.length - 1);
  if (rows[sel]?.kind !== 'model') sel = firstSelectableRow(rows); // never land on a header
  if (key.upArrow) env.setPickerIndex(stepSelectableRow(rows, sel, -1));
  else if (key.downArrow) env.setPickerIndex(stepSelectableRow(rows, sel, 1));
  else if (key.return) {
    const row = rows[sel];
    if (row?.kind === 'model') env.selectModel(row.entry);
  } else if (key.escape) {
    env.setPickerOpen(false);
    env.pushLine({ text: 'Model unchanged.', dimColor: true });
  }
  return true;
}

export const pickerOwner: FocusOwnerHandler = {
  id: 'picker',
  active: (env) => env.pickerOpenRef.current,
  handle: handlePicker,
};
