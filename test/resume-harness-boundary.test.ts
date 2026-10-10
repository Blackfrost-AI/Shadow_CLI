import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '../src/agent/context.js';
import { ShadowApp } from '../src/app/app.js';
import { SessionLog } from '../src/state/session.js';
import {
  captureSessionState,
  inProcessResumeHarnessIssue,
  inProcessResumeHarnessMessage,
  type SessionHarnessSnapshot,
} from '../src/state/sessionState.js';
import { listResumableSessions } from '../src/state/resume.js';
import { recordSessionHarnessBinding } from '../src/state/sessionHarnessBinding.js';
import { findSlashCommand, runSlashCommand, type SlashCtx } from '../src/tui/slash.js';

const contextOptions = { contextBudget: 10_000, triggerRatio: 0.75, keepLastTurns: 4 };

function harness(id = 'incident-response', digest = 'stack-a'): SessionHarnessSnapshot {
  return {
    foundation: { id: 'shadow-security', version: '1', digest: 'foundation-a' },
    addons: id ? [{ id, version: '1.0.0', digest: `${id}-a` }] : [],
    digest,
  };
}

function seedSession(root: string, savedHarness?: SessionHarnessSnapshot) {
  const bindingsDir = join(root, 'bindings');
  const log = SessionLog.open(root);
  const context = new Context(contextOptions);
  context.append({ role: 'user', content: [{ type: 'text', text: 'saved context' }] });
  log.bindSessionState(context, () => captureSessionState({ harness: savedHarness }));
  log.recordSnapshot(context, 0);
  log.close();
  if (savedHarness) recordSessionHarnessBinding(log.path, savedHarness, { bindingsDir });
  return { pick: listResumableSessions(root)[0]!, bindingsDir };
}

test('in-process harness boundary requires exact ordered identities and handles legacy sessions safely', () => {
  const active = harness();
  assert.equal(inProcessResumeHarnessIssue(active, structuredClone(active)), undefined);

  const changed = structuredClone(active);
  changed.addons[0]!.digest = 'changed-on-disk';
  assert.equal(inProcessResumeHarnessIssue(active, changed), 'harness-mismatch');

  const reordered: SessionHarnessSnapshot = {
    ...active,
    addons: [
      { id: 'second', version: '1.0.0', digest: 'second-a' },
      ...active.addons,
    ],
  };
  const reorderedActive = { ...reordered, addons: [...reordered.addons].reverse() };
  assert.equal(inProcessResumeHarnessIssue(reorderedActive, reordered), 'harness-mismatch');

  assert.equal(inProcessResumeHarnessIssue(harness('', 'foundation-only'), undefined), undefined);
  assert.equal(inProcessResumeHarnessIssue(active, undefined), 'legacy-session-with-active-addons');
  assert.equal(inProcessResumeHarnessIssue(undefined, active), 'active-harness-unknown');
  assert.equal(inProcessResumeHarnessIssue(undefined, undefined), undefined);

  const message = inProcessResumeHarnessMessage(active, changed, 'session-123');
  assert.match(message ?? '', /shadow resume session-123/);
  assert.match(message ?? '', /prompt, tools, and skills/);
  assert.match(message ?? '', /exact version and digest/);
});

test('Ink /resume refuses a saved context from a different harness before mutating live state', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-ink-resume-harness-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { pick, bindingsDir } = seedSession(root, harness('target', 'target-stack'));
  const output: string[] = [];
  let loaded = false;
  const ctx: Partial<SlashCtx> = {
    setLine: () => {},
    setMenuIndex: () => {},
    pushLine: (line) => output.push(line.text),
    runningRef: { current: false },
    opts: {
      workspaceRoot: root,
      cfg: contextOptions,
      harness: harness('active', 'active-stack'),
      harnessBindingsDir: bindingsDir,
    } as unknown as SlashCtx['opts'],
    context: { loadState: () => { loaded = true; } } as unknown as SlashCtx['context'],
  };

  runSlashCommand(ctx as SlashCtx, findSlashCommand('/resume')!, `/resume ${pick.id}`);

  assert.equal(loaded, false);
  assert.match(output.join('\n'), /Cannot resume in this process/);
  assert.match(output.join('\n'), new RegExp(`shadow resume ${pick.id}`));
});

test('Snowfall /resume refuses a saved context from a different harness before adopting its log', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-snowfall-resume-harness-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { pick, bindingsDir } = seedSession(root, harness('target', 'target-stack'));
  const output: string[] = [];
  let loaded = false;
  const app = Object.assign(Object.create(ShadowApp.prototype), {
    opts: {
      workspaceRoot: root,
      cfg: contextOptions,
      harness: harness('active', 'active-stack'),
      harnessBindingsDir: bindingsDir,
      context: { loadState: () => { loaded = true; } },
    },
    pushLine: (line: { text: string }) => output.push(line.text),
  });

  (app as { applyResume(session: typeof pick): void }).applyResume(pick);

  assert.equal(loaded, false);
  assert.match(output.join('\n'), /Cannot resume in this process/);
  assert.match(output.join('\n'), new RegExp(`shadow resume ${pick.id}`));
});
