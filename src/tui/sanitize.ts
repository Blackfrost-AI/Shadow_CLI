// src/tui/sanitize.ts — display-scrubbing shared by the TUI stream path and the headless
// renderer. Lives outside tui.tsx so headless.ts never imports the TUI module itself.
import { stripTextualToolIntent } from '../provider/textToolCalls.js';
import { extractPatchBlock } from '../provider/applyPatch.js';
import { scrubForDisplay } from '../util/scrub.js';

/** Display-safe assistant text. Textual/native-looking calls are execution intent, never prose. */
export function sanitizeAssistantText(text: string): string {
  let visible = stripTextualToolIntent(text);
  const patch = extractPatchBlock(visible);
  if (patch) visible = patch.cleaned;
  else {
    const partialPatch = visible.indexOf('*** Begin Patch');
    if (partialPatch >= 0) visible = visible.slice(0, partialPatch);
  }
  return scrubForDisplay(visible);
}
