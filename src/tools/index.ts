import type { ToolRegistry } from './registry.js';
import { readFile } from './readFile.js';
import { viewImage } from './viewImage.js';
import { writeFile } from './writeFile.js';
import { editFile } from './editFile.js';
import { multiEdit } from './multiEdit.js';
import { applyPatch } from './applyPatch.js';
import { grep } from './grep.js';
import { glob } from './glob.js';
import { makeRunShell } from './runShell.js';
import { BgRegistry, makeBashOutput, makeKillShell } from './bgShell.js';
import { webFetch } from './webFetch.js';
import { webSearch } from './webSearch.js';
import { makeWorktreeCreateTool, makeWorktreeRemoveTool, makeWorktreeListTool } from './worktree.js';

export {
  makeEnterPlanModeTool,
  makePlanWriteTool,
  makeExitPlanModeTool,
  type PlanData,
} from './planModeTools.js';
export { makeAskUserQuestionTool } from './askUser.js';
export { makeSkillTool } from './skillTool.js';
export { makeScheduleWakeupTool } from './scheduleWakeup.js';
export { makeAgentTool, type AgentToolDeps } from './agentTool.js';
export { makeToolSearch } from './toolSearch.js';

export { readFile } from './readFile.js';
export { viewImage } from './viewImage.js';
export { writeFile } from './writeFile.js';
export { editFile } from './editFile.js';
export { multiEdit } from './multiEdit.js';
export { applyPatch } from './applyPatch.js';
export { grep } from './grep.js';
export { glob } from './glob.js';
export { makeRunShell, runShell } from './runShell.js';
export { BgRegistry, makeBashOutput, makeKillShell } from './bgShell.js';
export { webFetch } from './webFetch.js';
export { webSearch } from './webSearch.js';
export { makeWorktreeCreateTool, makeWorktreeRemoveTool, makeWorktreeListTool } from './worktree.js';

/**
 * Register the built-in tool layer: read_file, write_file, edit_file, grep, glob
 * and run_shell, plus the network tools web_fetch + web_search (unless
 * `opts.network === false`). `opts.denylist` is threaded into run_shell so the
 * catastrophic-command guard can be plugged in at registration time, and
 * `opts.shellEnvAllowlist` / `opts.shellTimeoutMs` carry the config controls.
 */
export function registerBuiltinTools(
  registry: ToolRegistry,
  opts: {
    denylist?: (cmd: string) => string | null;
    network?: boolean;
    shellEnvAllowlist?: readonly string[];
    shellTimeoutMs?: number;
    sandbox?: 'auto' | 'off';
    sandboxNetwork?: boolean;
    /** Background-shell registry; pass one to enable run_in_background + bash_output/kill_shell. */
    bg?: BgRegistry;
  } = {},
): void {
  const bg = opts.bg ?? new BgRegistry();
  registry.register(readFile);
  registry.register(viewImage);
  registry.register(writeFile);
  registry.register(editFile);
  registry.register(multiEdit);
  registry.register(applyPatch);
  registry.register(grep);
  registry.register(glob);
  registry.register(
    makeRunShell({
      denylist: opts.denylist,
      envAllowlist: opts.shellEnvAllowlist,
      defaultTimeoutMs: opts.shellTimeoutMs,
      sandbox: opts.sandbox,
      allowNetwork: opts.sandboxNetwork,
      bg,
    }),
  );
  registry.register(makeBashOutput(bg));
  registry.register(makeKillShell(bg));
  if (opts.network !== false) {
    registry.register(webFetch);
    registry.register(webSearch);
  }
  // Worktree tools for agent isolation parity (always available; used by agent and direct)
  registry.register(makeWorktreeCreateTool());
  registry.register(makeWorktreeRemoveTool());
  registry.register(makeWorktreeListTool());
}
