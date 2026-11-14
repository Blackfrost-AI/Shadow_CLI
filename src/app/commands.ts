// 11.7.0 TUI immersion commands: Ctrl+P model cycling, named roles (/role), and the repository
// browser (/repo). Extracted from app.ts so the Snowfall shell stays under its structural
// line-budget ratchet (test/tui-line-budget.test.ts). Each command takes a minimal structural
// view of the shell; the app passes an object literal (private members are accessible there),
// reusing the shell's single selectModel / closePicker / pushLine paths rather than duplicating.

import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { OverlayHandle, Terminal, TuiAltScreen } from '@earendil-works/pi-tui';
import type { ModelEntry } from '../config.js';
import type { TuiOpts } from '../tui.js';
import { modelEntries } from '../util/modelGroups.js';
import { cycleEntries, nextCycleEntry } from '../util/modelCycle.js';
import { resolveEditor } from '../tui/externalEditor.js';
import { C } from '../tui/theme.js';
import { ChoicePicker } from './picker.js';
import type { FlattenItem } from '../tui/flatten.js';
import type { ModelSwitcher } from './modelSwitch.js';
import type { SnowfallEditor } from './snowfall.js';

type PushLine = (partial: Partial<FlattenItem> & { text: string }) => void;

/** Ctrl+P quick model cycling — OMP parity. Cycles the --models allowlist (or every enabled
 *  model when unset) through the shell's single model switcher. Idle-only, like the picker. */
export function cycleModel(app: { opts: TuiOpts; switcher: ModelSwitcher; pushLine: PushLine; selectModel: (e: ModelEntry) => void }): void {
  if (app.switcher.isSwitching) {
    app.pushLine({ text: '  A model switch is already in progress.', dimColor: true });
    return;
  }
  const entries = cycleEntries(app.opts.cfg, app.opts.models);
  const next = nextCycleEntry(entries, app.opts.cfg.model);
  if (!next) {
    app.pushLine({ text: '  No models available to cycle. Configure models or pass --models.', color: C.yellow });
    return;
  }
  if (next.label === app.opts.cfg.model) {
    app.pushLine({ text: `  Only one model in the cycle: ${next.label}`, dimColor: true });
    return;
  }
  app.selectModel(next);
}

/** /role [smol|slow|plan]: switch to a named model role (OMP parity). Bare /role lists
 *  the configured roles and which is active. Roles map to model labels in config.roles. */
export function doRole(app: { opts: TuiOpts; pushLine: PushLine; selectModel: (e: ModelEntry) => void }, arg: string): void {
  const roles = app.opts.cfg.roles ?? {};
  const names = (['smol', 'slow', 'plan'] as const).filter((r) => roles[r]);
  if (!arg) {
    if (names.length === 0) {
      app.pushLine({ text: '  No roles configured. Set roles.smol/slow/plan in config to model labels.', dimColor: true });
      return;
    }
    for (const r of names) {
      const active = roles[r] === app.opts.cfg.model ? ' (active)' : '';
      app.pushLine({ text: `  ${r} → ${roles[r]}${active}`, dimColor: !active });
    }
    return;
  }
  const name = arg.trim().toLowerCase() as 'smol' | 'slow' | 'plan';
  const label = roles[name];
  if (!label) {
    app.pushLine({ text: `  Unknown role "${arg}". Configured: ${names.join(', ') || '(none)'}.`, color: C.yellow });
    return;
  }
  const entry = modelEntries(app.opts.cfg).find((e) => e.label === label);
  if (!entry) {
    app.pushLine({ text: `  Role "${name}" points to "${label}", which is not a configured model.`, color: C.yellow });
    return;
  }
  app.selectModel(entry);
}

/** The shell services the repository browser drives. pickerHandle is a live accessor pair so
 *  the overlay assignment writes back to the shell (a plain field would be pass-by-value). */
export interface RepoHost {
  opts: TuiOpts;
  terminal: Terminal;
  tui: TuiAltScreen;
  editor: SnowfallEditor;
  /** Live busy check — read at file-choose time, not a snapshot from /repo invocation, so a
   *  turn that starts while the picker is open still blocks the blocking editor spawn. */
  isBusy(): boolean;
  getPickerHandle(): OverlayHandle | null;
  setPickerHandle(h: OverlayHandle | null): void;
  pushLine: PushLine;
  closePicker(): void;
}

/** /repo — browse the repository's tracked files in a picker (OMP repository-menu parity).
 *  Choosing a file opens it in the user's editor. Git actions live in the menu's Repository submenu. */
export function openRepoBrowser(app: RepoHost): void {
  let files: string[] = [];
  try {
    files = execFileSync('git', ['-C', app.opts.workspaceRoot, 'ls-files'], { encoding: 'utf8', timeout: 5000 })
      .split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 500);
  } catch {
    app.pushLine({ text: '  /repo needs a git repository.', color: C.yellow });
    return;
  }
  if (files.length === 0) {
    app.pushLine({ text: '  No tracked files.', dimColor: true });
    return;
  }
  app.closePicker();
  const picker = new ChoicePicker<string>({
    title: 'Repository files',
    items: files,
    label: (f) => f,
    choose: (file) => { app.closePicker(); openFileInEditor(app, join(app.opts.workspaceRoot, file)); },
    close: () => app.closePicker(),
    repaint: () => app.tui.requestRender(),
    rows: () => app.terminal.rows,
  });
  app.getPickerHandle()?.hide();
  app.setPickerHandle(app.tui.showOverlay(picker, { anchor: 'center', width: 76 }));
}

/** Open a repository file in $EDITOR (read/edit), suspending the TUI like the composer
 *  editor does. The path is passed as a single argv element with NO shell, so a hostile
 *  git-tracked filename (quotes, $(…), backticks) cannot inject commands. */
export function openFileInEditor(app: RepoHost, absPath: string): void {
  if (app.isBusy()) {
    app.pushLine({ text: '  Finish the current operation before opening the editor.', dimColor: true });
    return;
  }
  if (!process.stdout.isTTY) {
    app.pushLine({ text: '  External editor needs an interactive terminal.', dimColor: true });
    return;
  }
  // Split $EDITOR into program + fixed args (e.g. "code --wait"); the file is appended as
  // one literal argv element. No shell is involved.
  const parts = (resolveEditor() ?? 'vi').trim().split(/\s+/).filter(Boolean);
  const cmd = parts[0] || 'vi';
  const args = [...parts.slice(1), absPath];
  try {
    app.tui.stop({ preserveScreen: true });
    const r = spawnSync(cmd, args, { stdio: 'inherit' });
    if (r.error) {
      app.pushLine({ kind: 'error', text: `  Couldn't launch "${cmd}": ${r.error.message}. Set $EDITOR.`, color: C.red });
    }
  } catch (e) {
    app.pushLine({ kind: 'error', text: `  External editor failed: ${(e as Error).message}`, color: C.red });
  } finally {
    try {
      app.tui.start();
      app.tui.setFocus(app.editor);
      app.tui.renderNow(true);
    } catch {
      /* the terminal may have gone away */
    }
  }
}