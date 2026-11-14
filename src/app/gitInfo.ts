// Read-only git status views (/files, /branch) for the Snowfall shell. Extracted from app.ts
// so the shell stays under its structural line-budget ratchet (test/tui-line-budget.test.ts).
// /diff opens the change-review overlay and stays in the shell; this module only renders the
// textual status views. All git calls are argv-safe (no shell) and time-bounded.

import { execFileSync } from 'node:child_process';
import { approvalText } from '../util/approvalText.js';
import { C } from '../tui/theme.js';
import type { FlattenItem } from '../tui/flatten.js';

export interface GitInfoHost {
  readonly workspaceRoot: string;
  pushLine(partial: Partial<FlattenItem> & { text: string }): void;
}

/** Render the /files or /branch status view. Never throws — git failures surface as an error line. */
export function showGitInfo(app: GitInfoHost, name: '/files' | '/branch'): void {
  const git = (...args: string[]): string => execFileSync(
    'git', ['-C', app.workspaceRoot, '--no-pager', ...args],
    { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] },
  ).trimEnd();
  try {
    let lines: string[];
    if (name === '/files') {
      const out = git('status', '--short');
      lines = out ? out.split('\n').slice(0, 40) : ['No changed files.'];
    } else {
      const branch = git('branch', '--show-current');
      const status = git('status', '--short', '--branch');
      lines = [`branch: ${branch || 'detached HEAD'}`, ...status.split('\n').slice(0, 20)];
    }
    app.pushLine({
      kind: 'system', text: name.slice(1),
      lines: lines.map((text) => ({ text: approvalText(text), dimColor: true })),
    });
  } catch (error) {
    app.pushLine({ kind: 'error', text: `${name} failed: ${approvalText((error as Error).message.split('\n')[0]!)}`, color: C.red });
  }
}