import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SkillCandidateStore, type SkillRollbackFailpoint } from '../src/skills/candidateStore.js';
import { sha256Text } from '../src/skills/candidateValidator.js';
import type { DraftSkillCandidateInput } from '../src/skills/candidateTypes.js';
import { discoverSkills } from '../src/skills/loader.js';
import { inspectSkillCandidateLines } from '../src/skills/manage.js';

function isolatedStore(label: string): { root: string; store: SkillCandidateStore } {
  const base = mkdtempSync(join(tmpdir(), `shadow-skill-candidate-${label}-`));
  let tick = 0;
  return {
    root: join(base, 'skills'),
    store: new SkillCandidateStore({
      skillsRoot: join(base, 'skills'),
      now: () => new Date(Date.UTC(2026, 9, 9, 12, 0, tick++)),
    }),
  };
}

function markdown(name: string, instruction = 'Follow the observed workflow, then verify its output.'): string {
  return [
    '---',
    `name: ${name}`,
    'description: Reuse an evidence-backed workflow after checking its preconditions.',
    '---',
    '',
    `# ${name}`,
    '',
    instruction,
    '',
  ].join('\n');
}

function verifiedInput(name: string, instruction?: string): DraftSkillCandidateInput {
  return {
    name,
    rationale: 'The same successful sequence appeared in an inspected local workflow.',
    skillMarkdown: markdown(name, instruction),
    evidence: [
      {
        id: 'session-run-1',
        kind: 'session',
        reference: 'session://local/run-1',
        summary: 'Local session trace containing the successful sequence.',
      },
    ],
    claims: [
      {
        id: 'workflow-order',
        statement: 'This ordering is reusable when the documented preconditions hold.',
        evidenceRefs: ['session-run-1'],
      },
    ],
    verificationResults: [
      {
        id: 'replay-1',
        kind: 'replay',
        passed: true,
        validator: 'local-replay',
        summary: 'The workflow replay completed and produced the expected artifact.',
        evidenceRefs: ['session-run-1'],
        resultDigest: sha256Text('replay-result-1'),
      },
    ],
    source: { sessionId: 'local-run-1', turnIds: ['7', '8'], workflow: 'controlled local replay' },
  };
}

function activateTwoGenerations(
  store: SkillCandidateStore,
  name: string,
): { firstMarkdown: string; secondMarkdown: string } {
  const firstInput = verifiedInput(name, 'First verified workflow.');
  const first = store.draftCandidate(firstInput);
  const active1 = store.activateCandidate(name, {
    expectedVersion: first.version,
    approvedBy: 'operator-a',
    confirmation: 'activate',
  });
  const secondInput = verifiedInput(name, 'Second verified workflow.');
  const second = store.updateCandidate(name, active1.candidate.version, {
    skillMarkdown: secondInput.skillMarkdown,
    claims: secondInput.claims,
    evidence: secondInput.evidence,
    verificationResults: secondInput.verificationResults,
  });
  store.activateCandidate(name, {
    expectedVersion: second.version,
    approvedBy: 'operator-b',
    confirmation: 'activate',
    expectedActiveGeneration: 1,
  });
  return { firstMarkdown: firstInput.skillMarkdown, secondMarkdown: secondInput.skillMarkdown };
}

test('draft/update stores immutable versions and ignores candidate attempts to self-activate', () => {
  const { root, store } = isolatedStore('versions');
  const hostile = { ...verifiedInput('repeatable-check'), status: 'activated', decision: { kind: 'activated' } };
  const draft = store.draftCandidate(hostile as DraftSkillCandidateInput);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.version, 1);
  assert.equal(store.inspectCandidate('repeatable-check').status, 'draft');

  const changed = markdown('repeatable-check', 'Check the precondition, execute the sequence, and save a receipt.');
  const updated = store.updateCandidate('repeatable-check', 1, { skillMarkdown: changed });
  assert.equal(updated.version, 2);
  assert.equal(updated.skillMarkdown, changed);
  assert.equal(store.inspectCandidate('repeatable-check', 1).skillMarkdown, draft.skillMarkdown, 'v1 remains immutable');
  assert.equal(store.inspectCandidate('repeatable-check', 2).skillMarkdown, changed);
  assert.throws(() => store.updateCandidate('repeatable-check', 1, { rationale: 'stale edit' }), /version changed/i);
  assert.throws(() => store.draftCandidate(verifiedInput('repeatable-check')), /already exists/i);

  assert.deepEqual(store.listCandidates().map((item) => [item.name, item.version, item.status]), [
    ['repeatable-check', 2, 'draft'],
  ]);
  const versions = join(root, '.candidates', 'repeatable-check', 'versions');
  assert.deepEqual(readdirSync(versions).sort(), ['000001', '000002']);
  assert.ok(!readdirSync(versions).some((entry) => entry.includes('pending')), 'no staging directory leaked');
  assert.equal(lstatSync(join(versions, '000001', 'candidate.json')).isSymbolicLink(), false);
});

test('activation fails closed until evidence, claims, a passing result, and explicit approval exist', () => {
  const { root, store } = isolatedStore('gate');
  const draft = store.draftCandidate({
    name: 'gated-skill',
    rationale: 'A candidate awaiting evidence.',
    skillMarkdown: markdown('gated-skill'),
  });
  const report = store.validateCandidate('gated-skill');
  assert.equal(report.valid, true, 'an incomplete draft can remain structurally valid');
  assert.equal(report.activationReady, false);
  assert.match(report.activationIssues.map((issue) => issue.message).join(' '), /evidence.*claim.*validation|evidence/i);
  assert.throws(
    () => store.activateCandidate('gated-skill', { expectedVersion: draft.version, approvedBy: 'operator', confirmation: 'activate' }),
    /evidence|claim|validation/i,
  );
  assert.equal(existsSync(join(root, 'gated-skill')), false, 'a rejected activation writes no active skill');

  const ready = verifiedInput('gated-skill');
  const updated = store.updateCandidate('gated-skill', draft.version, {
    claims: ready.claims,
    evidence: ready.evidence,
    verificationResults: ready.verificationResults,
  });
  assert.equal(store.validateCandidate('gated-skill').activationReady, true);
  assert.throws(
    () => store.activateCandidate('gated-skill', {
      expectedVersion: updated.version,
      approvedBy: 'operator',
      confirmation: 'yes' as 'activate',
    }),
    /explicit confirmation/i,
  );

  const activated = store.activateCandidate('gated-skill', {
    expectedVersion: updated.version,
    approvedBy: 'operator',
    confirmation: 'activate',
    expectedActiveGeneration: 0,
  });
  assert.equal(activated.active.generation, 1);
  assert.equal(activated.candidate.status, 'activated');
  assert.equal(activated.candidate.version, updated.version + 1);
  assert.equal(readFileSync(join(root, 'gated-skill', 'SKILL.md'), 'utf8'), updated.skillMarkdown);
  assert.deepEqual(activated.active.claimIds, ['workflow-order']);
  assert.deepEqual(activated.active.evidenceRefs, ['session-run-1']);
  assert.deepEqual(activated.active.verificationResultIds, ['replay-1']);
});

test('a passing result must cover every declared claim, preventing unverified claim activation', () => {
  const { root, store } = isolatedStore('claims');
  const input = verifiedInput('claim-coverage');
  input.evidence!.push({
    id: 'unreplayed-note',
    kind: 'other',
    reference: 'note://local/unreplayed',
    summary: 'A note that was not part of the replay.',
  });
  input.claims!.push({
    id: 'unsupported-extension',
    statement: 'An additional behavior is claimed from an unreplayed note.',
    evidenceRefs: ['unreplayed-note'],
  });
  const draft = store.draftCandidate(input);
  const report = store.validateCandidate(input.name);
  assert.equal(report.valid, true);
  assert.equal(report.activationReady, false);
  assert.ok(report.activationIssues.some((issue) => issue.code === 'activation.unverified_claim'));
  assert.throws(
    () => store.activateCandidate(input.name, { expectedVersion: draft.version, approvedBy: 'operator', confirmation: 'activate' }),
    /not linked to evidence used by a passing/i,
  );
  assert.equal(existsSync(join(root, input.name)), false);
});

test('changing a candidate procedure or validation scope invalidates earlier receipts', () => {
  const { store } = isolatedStore('stale-proof');
  const draft = store.draftCandidate(verifiedInput('stale-proof'));
  assert.equal(store.validateCandidate('stale-proof').activationReady, true);

  const updated = store.updateCandidate('stale-proof', draft.version, {
    skillMarkdown: markdown('stale-proof', 'A materially changed procedure that needs a new replay.'),
  });
  assert.deepEqual(updated.verificationResults, []);
  const report = store.validateCandidate('stale-proof');
  assert.equal(report.activationReady, false);
  assert.ok(report.activationIssues.some((issue) => issue.code === 'activation.verification'));
  assert.throws(
    () => store.activateCandidate('stale-proof', {
      expectedVersion: updated.version,
      approvedBy: 'operator',
      confirmation: 'activate',
    }),
    /passing validation or replay/i,
  );

  const revalidated = verifiedInput('stale-proof', 'A materially changed procedure that needs a new replay.');
  const readyAgain = store.updateCandidate('stale-proof', updated.version, {
    verificationResults: revalidated.verificationResults,
  });
  assert.equal(store.validateCandidate('stale-proof').activationReady, true);
  const changedClaims = store.updateCandidate('stale-proof', readyAgain.version, {
    claims: [{
      id: 'broader-claim',
      statement: 'A broader reusable claim needs its own validation.',
      evidenceRefs: ['session-run-1'],
    }],
  });
  assert.deepEqual(changedClaims.verificationResults, []);
  assert.equal(store.validateCandidate('stale-proof').activationReady, false);
});

test('a string-shaped pass value cannot masquerade as a successful verification', () => {
  const { store } = isolatedStore('boolean-result');
  const input = verifiedInput('boolean-result');
  input.verificationResults![0]!.passed = 'true' as unknown as boolean;
  assert.throws(() => store.draftCandidate(input), /boolean pass\/fail/i);
  assert.deepEqual(store.listCandidates(), [], 'invalid verification metadata was never committed');
});

test('activation revisions are retained and rollback creates a new generation', () => {
  const { root, store } = isolatedStore('rollback');
  const first = store.draftCandidate(verifiedInput('receipt-workflow', 'First verified workflow.'));
  const active1 = store.activateCandidate('receipt-workflow', {
    expectedVersion: first.version,
    approvedBy: 'operator-a',
    confirmation: 'activate',
  });
  assert.equal(active1.active.generation, 1);

  const nextInput = verifiedInput('receipt-workflow', 'Second verified workflow.');
  nextInput.evidence![0]!.id = 'session-run-2';
  nextInput.evidence![0]!.reference = 'session://local/run-2';
  nextInput.claims![0]!.evidenceRefs = ['session-run-2'];
  nextInput.verificationResults![0]!.id = 'replay-2';
  nextInput.verificationResults![0]!.evidenceRefs = ['session-run-2'];
  nextInput.verificationResults![0]!.resultDigest = sha256Text('replay-result-2');
  const draft2 = store.updateCandidate('receipt-workflow', active1.candidate.version, {
    skillMarkdown: nextInput.skillMarkdown,
    evidence: nextInput.evidence,
    claims: nextInput.claims,
    verificationResults: nextInput.verificationResults,
  });
  const active2 = store.activateCandidate('receipt-workflow', {
    expectedVersion: draft2.version,
    approvedBy: 'operator-b',
    confirmation: 'activate',
    expectedActiveGeneration: 1,
  });
  assert.equal(active2.active.generation, 2);
  assert.equal(active2.active.skillMarkdown, nextInput.skillMarkdown);
  assert.equal(
    readFileSync(join(root, '.revisions', 'receipt-workflow', '000001', 'SKILL.md'), 'utf8'),
    first.skillMarkdown,
  );

  assert.throws(
    () => store.rollbackActiveSkill('receipt-workflow', {
      expectedGeneration: 1,
      targetGeneration: 1,
      approvedBy: 'operator-c',
      confirmation: 'rollback',
    }),
    /generation changed/i,
  );
  assert.throws(
    () => store.rollbackActiveSkill('receipt-workflow', {
      expectedGeneration: 2,
      targetGeneration: 1,
      approvedBy: 'operator-c',
      confirmation: 'yes' as 'rollback',
    }),
    /explicit confirmation/i,
  );
  const restored = store.rollbackActiveSkill('receipt-workflow', {
    expectedGeneration: 2,
    targetGeneration: 1,
    approvedBy: 'operator-c',
    confirmation: 'rollback',
  });
  assert.equal(restored.generation, 3, 'rollback appends history instead of rewinding its counter');
  assert.equal(restored.restoredFromGeneration, 1);
  assert.equal(restored.skillMarkdown, first.skillMarkdown);
  assert.equal(store.readActiveSkill('receipt-workflow')?.generation, 3);
  assert.equal(
    readFileSync(join(root, '.revisions', 'receipt-workflow', '000002', 'SKILL.md'), 'utf8'),
    nextInput.skillMarkdown,
  );
});

test('rollback I/O failures retain a complete prior generation and remain retryable at every boundary', async (t) => {
  const points: SkillRollbackFailpoint[] = [
    'before-transaction-publish',
    'before-current-archive',
    'before-current-move',
    'before-active-publish',
    'after-active-publish',
  ];
  for (const point of points) {
    await t.test(point, () => {
      const base = mkdtempSync(join(tmpdir(), `shadow-skill-rollback-io-${point}-`));
      const root = join(base, 'skills');
      let injected = false;
      const store = new SkillCandidateStore({
        skillsRoot: root,
        now: () => new Date('2026-10-09T12:00:00.000Z'),
        rollbackFailpoint: (at) => {
          if (injected && at === point) {
            const error = new Error(`injected rollback failure at ${point}`) as NodeJS.ErrnoException;
            error.code = 'EIO';
            throw error;
          }
        },
      });
      const snapshots = activateTwoGenerations(store, 'rollback-io');
      injected = true;
      assert.throws(
        () => store.rollbackActiveSkill('rollback-io', {
          expectedGeneration: 2,
          targetGeneration: 1,
          approvedBy: 'operator-c',
          confirmation: 'rollback',
        }),
        new RegExp(`injected rollback failure at ${point}`),
      );

      const unchanged = store.readActiveSkill('rollback-io');
      assert.equal(unchanged?.generation, 2);
      assert.equal(unchanged?.skillMarkdown, snapshots.secondMarkdown);
      assert.equal(
        readFileSync(join(root, 'rollback-io', '.shadow-skill.json'), 'utf8').includes('"generation": 2'),
        true,
        'the body and metadata remain one complete directory generation',
      );
      assert.deepEqual(
        readdirSync(join(root, '.transactions')).filter((entry) => entry.includes('rollback-')),
        [],
        'a synchronous failure leaves no journal that can replay unexpectedly',
      );

      injected = false;
      const retried = store.rollbackActiveSkill('rollback-io', {
        expectedGeneration: 2,
        targetGeneration: 1,
        approvedBy: 'operator-c',
        confirmation: 'rollback',
      });
      assert.equal(retried.generation, 3);
      assert.equal(retried.skillMarkdown, snapshots.firstMarkdown);
      assert.equal(
        readFileSync(join(root, '.revisions', 'rollback-io', '000002', 'SKILL.md'), 'utf8'),
        snapshots.secondMarkdown,
      );
    });
  }
});

test('process crashes at rollback boundaries recover to a complete discoverable generation', async (t) => {
  const points: SkillRollbackFailpoint[] = [
    'before-transaction-publish',
    'before-current-archive',
    'before-current-move',
    'before-active-publish',
    'after-active-publish',
    'before-transaction-retire',
    'after-transaction-retire',
  ];
  const storeUrl = pathToFileURL(resolve('src/skills/candidateStore.ts')).href;
  for (const point of points) {
    await t.test(point, () => {
      const base = mkdtempSync(join(tmpdir(), `shadow-skill-rollback-crash-${point}-`));
      const home = join(base, 'home');
      const workspace = join(base, 'workspace');
      const root = join(home, '.shadow', 'skills');
      mkdirSync(workspace, { recursive: true });
      const parentStore = new SkillCandidateStore({
        skillsRoot: root,
        now: () => new Date('2026-10-09T12:00:00.000Z'),
      });
      const snapshots = activateTwoGenerations(parentStore, 'rollback-crash');
      const childScript = [
        `import { SkillCandidateStore } from ${JSON.stringify(storeUrl)};`,
        `const store = new SkillCandidateStore({`,
        `  skillsRoot: ${JSON.stringify(root)},`,
        `  rollbackFailpoint: (point) => { if (point === ${JSON.stringify(point)}) process.exit(87); },`,
        `});`,
        `store.rollbackActiveSkill('rollback-crash', {`,
        `  expectedGeneration: 2,`,
        `  targetGeneration: 1,`,
        `  approvedBy: 'crashing-operator',`,
        `  confirmation: 'rollback',`,
        `});`,
      ].join('\n');
      const child = spawnSync(
        process.execPath,
        ['--import', 'tsx/esm', '--input-type=module', '--eval', childScript],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      assert.equal(child.status, 87, `child must stop at ${point}: ${child.stderr}`);

      const discovered = discoverSkills(workspace, { homedir: home });
      assert.deepEqual(discovered.map((skill) => skill.name), ['rollback-crash']);
      const recoveredStore = new SkillCandidateStore({ skillsRoot: root });
      const active = recoveredStore.readActiveSkill('rollback-crash');
      if (point === 'before-transaction-publish') {
        assert.equal(active?.generation, 2, 'an unpublished rollback leaves the prior generation authoritative');
        assert.equal(active?.skillMarkdown, snapshots.secondMarkdown);
        const retried = recoveredStore.rollbackActiveSkill('rollback-crash', {
          expectedGeneration: 2,
          targetGeneration: 1,
          approvedBy: 'retrying-operator',
          confirmation: 'rollback',
        });
        assert.equal(retried.generation, 3);
        assert.equal(retried.skillMarkdown, snapshots.firstMarkdown);
      } else {
        assert.equal(active?.generation, 3, 'a durable rollback intent recovers forward');
        assert.equal(active?.restoredFromGeneration, 1);
        assert.equal(active?.skillMarkdown, snapshots.firstMarkdown);
      }
      assert.equal(
        readFileSync(join(root, '.revisions', 'rollback-crash', '000002', 'SKILL.md'), 'utf8'),
        snapshots.secondMarkdown,
        'the displaced generation remains rollback history',
      );
      assert.deepEqual(readdirSync(join(root, '.transactions')), [], 'recovery cleans every rollback journal');
    });
  }
});

test('a crash while aborting a failed rollback recovers the complete prior generation', async (t) => {
  const cases: Array<{
    failureAt: SkillRollbackFailpoint;
    crashAt: SkillRollbackFailpoint;
  }> = [
    { failureAt: 'before-current-archive', crashAt: 'after-abort-marker' },
    { failureAt: 'after-active-publish', crashAt: 'after-restored-discard' },
    { failureAt: 'before-active-publish', crashAt: 'after-previous-restore' },
  ];
  const storeUrl = pathToFileURL(resolve('src/skills/candidateStore.ts')).href;
  for (const scenario of cases) {
    await t.test(`${scenario.failureAt} -> ${scenario.crashAt}`, () => {
      const base = mkdtempSync(join(tmpdir(), `shadow-skill-rollback-abort-${scenario.crashAt}-`));
      const home = join(base, 'home');
      const workspace = join(base, 'workspace');
      const root = join(home, '.shadow', 'skills');
      mkdirSync(workspace, { recursive: true });
      const parentStore = new SkillCandidateStore({
        skillsRoot: root,
        now: () => new Date('2026-10-09T12:00:00.000Z'),
      });
      const snapshots = activateTwoGenerations(parentStore, 'rollback-abort-crash');
      const childScript = [
        `import { SkillCandidateStore } from ${JSON.stringify(storeUrl)};`,
        `let aborting = false;`,
        `const store = new SkillCandidateStore({`,
        `  skillsRoot: ${JSON.stringify(root)},`,
        `  rollbackFailpoint: (point) => {`,
        `    if (!aborting && point === ${JSON.stringify(scenario.failureAt)}) {`,
        `      aborting = true;`,
        `      throw new Error('injected rollback I/O failure');`,
        `    }`,
        `    if (aborting && point === ${JSON.stringify(scenario.crashAt)}) process.exit(88);`,
        `  },`,
        `});`,
        `store.rollbackActiveSkill('rollback-abort-crash', {`,
        `  expectedGeneration: 2,`,
        `  targetGeneration: 1,`,
        `  approvedBy: 'crashing-operator',`,
        `  confirmation: 'rollback',`,
        `});`,
      ].join('\n');
      const child = spawnSync(
        process.execPath,
        ['--import', 'tsx/esm', '--input-type=module', '--eval', childScript],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      assert.equal(child.status, 88, `child must stop at ${scenario.crashAt}: ${child.stderr}`);

      const discovered = discoverSkills(workspace, { homedir: home });
      assert.deepEqual(discovered.map((skill) => skill.name), ['rollback-abort-crash']);
      const recoveredStore = new SkillCandidateStore({ skillsRoot: root });
      const active = recoveredStore.readActiveSkill('rollback-abort-crash');
      assert.equal(active?.generation, 2);
      assert.equal(active?.skillMarkdown, snapshots.secondMarkdown);
      assert.deepEqual(readdirSync(join(root, '.transactions')), []);

      const retried = recoveredStore.rollbackActiveSkill('rollback-abort-crash', {
        expectedGeneration: 2,
        targetGeneration: 1,
        approvedBy: 'retrying-operator',
        confirmation: 'rollback',
      });
      assert.equal(retried.generation, 3);
      assert.equal(retried.skillMarkdown, snapshots.firstMarkdown);
      assert.equal(
        readFileSync(join(root, '.revisions', 'rollback-abort-crash', '000002', 'SKILL.md'), 'utf8'),
        snapshots.secondMarkdown,
      );
    });
  }
});

test('an active-publication I/O failure restores the draft and prior generation, then remains retryable', () => {
  const base = mkdtempSync(join(tmpdir(), 'shadow-skill-activation-failure-'));
  const root = join(base, 'skills');
  let failPublication = false;
  let tick = 0;
  const store = new SkillCandidateStore({
    skillsRoot: root,
    now: () => new Date(Date.UTC(2026, 9, 9, 12, 0, tick++)),
    activationFailpoint: (point) => {
      if (failPublication && point === 'before-active-publish') {
        const error = new Error('injected active-directory rename failure') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
    },
  });

  const first = store.draftCandidate(verifiedInput('transactional-skill', 'First verified workflow.'));
  const generation1 = store.activateCandidate('transactional-skill', {
    expectedVersion: first.version,
    approvedBy: 'operator-a',
    confirmation: 'activate',
  });

  const replacementInput = verifiedInput('transactional-skill', 'Second verified workflow.');
  const replacement = store.updateCandidate('transactional-skill', generation1.candidate.version, {
    skillMarkdown: replacementInput.skillMarkdown,
    claims: replacementInput.claims,
    evidence: replacementInput.evidence,
    verificationResults: replacementInput.verificationResults,
  });
  failPublication = true;
  assert.throws(
    () => store.activateCandidate('transactional-skill', {
      expectedVersion: replacement.version,
      approvedBy: 'operator-b',
      confirmation: 'activate',
      expectedActiveGeneration: 1,
    }),
    /injected active-directory rename failure/,
  );

  assert.equal(store.inspectCandidate('transactional-skill').status, 'draft');
  assert.equal(store.inspectCandidate('transactional-skill').version, replacement.version);
  assert.equal(store.readActiveSkill('transactional-skill')?.generation, 1);
  assert.equal(store.readActiveSkill('transactional-skill')?.skillMarkdown, first.skillMarkdown);
  assert.deepEqual(
    readdirSync(join(root, '.candidates', 'transactional-skill', 'versions')).sort(),
    ['000001', '000002', '000003'],
    'the rolled-back activation decision is not left as apparent candidate history',
  );
  assert.equal(
    readFileSync(join(root, '.revisions', 'transactional-skill', '000001', 'SKILL.md'), 'utf8'),
    first.skillMarkdown,
    'the prior generation remains archived for rollback',
  );

  failPublication = false;
  const retried = store.activateCandidate('transactional-skill', {
    expectedVersion: replacement.version,
    approvedBy: 'operator-b',
    confirmation: 'activate',
    expectedActiveGeneration: 1,
  });
  assert.equal(retried.candidate.status, 'activated');
  assert.equal(retried.active.generation, 2);
  assert.equal(retried.active.skillMarkdown, replacementInput.skillMarkdown);

  const restored = store.rollbackActiveSkill('transactional-skill', {
    expectedGeneration: 2,
    targetGeneration: 1,
    approvedBy: 'operator-c',
    confirmation: 'rollback',
  });
  assert.equal(restored.generation, 3);
  assert.equal(restored.skillMarkdown, first.skillMarkdown);
});

test('a process crash after the activation receipt is recovered forward from the durable transaction', () => {
  const base = mkdtempSync(join(tmpdir(), 'shadow-skill-activation-crash-'));
  const home = join(base, 'home');
  const workspace = join(base, 'workspace');
  const root = join(home, '.shadow', 'skills');
  mkdirSync(workspace, { recursive: true });
  const parentStore = new SkillCandidateStore({
    skillsRoot: root,
    now: () => new Date('2026-10-09T12:00:00.000Z'),
  });
  const first = parentStore.draftCandidate(verifiedInput('crash-recovery', 'First crash-safe workflow.'));
  const generation1 = parentStore.activateCandidate('crash-recovery', {
    expectedVersion: first.version,
    approvedBy: 'operator-a',
    confirmation: 'activate',
  });
  const replacementInput = verifiedInput('crash-recovery', 'Second crash-safe workflow.');
  parentStore.updateCandidate('crash-recovery', generation1.candidate.version, {
    skillMarkdown: replacementInput.skillMarkdown,
    claims: replacementInput.claims,
    evidence: replacementInput.evidence,
    verificationResults: replacementInput.verificationResults,
  });

  const storeUrl = pathToFileURL(resolve('src/skills/candidateStore.ts')).href;
  const childScript = [
    `import { SkillCandidateStore } from ${JSON.stringify(storeUrl)};`,
    `const store = new SkillCandidateStore({`,
    `  skillsRoot: ${JSON.stringify(root)},`,
    `  activationFailpoint: (point) => { if (point === 'before-active-publish') process.exit(86); },`,
    `});`,
    `const candidate = store.inspectCandidate('crash-recovery');`,
    `store.activateCandidate('crash-recovery', {`,
    `  expectedVersion: candidate.version,`,
    `  approvedBy: 'crashing-operator',`,
    `  confirmation: 'activate',`,
    `  expectedActiveGeneration: 1,`,
    `});`,
  ].join('\n');
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', '--input-type=module', '--eval', childScript],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  assert.equal(child.status, 86, `child must stop at the simulated crash boundary: ${child.stderr}`);
  assert.equal(existsSync(join(root, 'crash-recovery')), false, 'the prior generation was staged before the crash boundary');

  const discovered = discoverSkills(workspace, { homedir: home });
  assert.deepEqual(discovered.map((skill) => skill.name), ['crash-recovery'], 'session startup recovers before discovery');
  const recoveredStore = new SkillCandidateStore({ skillsRoot: root });
  const candidate = recoveredStore.inspectCandidate('crash-recovery');
  const active = recoveredStore.readActiveSkill('crash-recovery');
  assert.equal(candidate.status, 'activated');
  assert.equal(candidate.decision?.activeGeneration, 2);
  assert.equal(active?.generation, 2);
  assert.equal(active?.contentDigest, candidate.contentDigest);
  assert.equal(active?.skillMarkdown, replacementInput.skillMarkdown);
  assert.equal(
    readFileSync(join(root, '.revisions', 'crash-recovery', '000001', 'SKILL.md'), 'utf8'),
    first.skillMarkdown,
    'the pre-crash generation remains available for rollback',
  );
  assert.deepEqual(readdirSync(join(root, '.transactions')), [], 'the recovered transaction is cleaned up');
});

test('candidate review exposes bounded sanitized body, claims, evidence, and verification receipts', () => {
  const { store } = isolatedStore('review-output');
  const input = verifiedInput(
    'reviewable-skill',
    `\u001b[31mREVIEW BODY\u001b[0m\n${'x'.repeat(20_000)}`,
  );
  store.draftCandidate(input);

  const lines = inspectSkillCandidateLines('reviewable-skill', store);
  const output = lines.join('\n');
  assert.match(output, /\[workflow-order\] This ordering is reusable/);
  assert.match(output, /evidence: session-run-1/);
  assert.match(output, /reference: session:\/\/local\/run-1/);
  assert.match(output, /\[replay-1\] PASS replay · local-replay/);
  assert.match(output, /result digest: [a-f0-9]{64}/);
  assert.match(output, /SKILL\.md preview:/);
  assert.match(output, /REVIEW BODY/);
  assert.match(output, /preview truncated/);
  assert.doesNotMatch(output, /\u001b|\u202e|\u200b/, 'terminal and bidi controls are stripped from review output');
  assert.ok(output.length < 30_000, `review output must stay bounded (received ${output.length} chars)`);
});

test('reject and archive are versioned decisions that can be listed and inspected', () => {
  const { store } = isolatedStore('decisions');
  const draft = store.draftCandidate(verifiedInput('decision-log'));
  const rejected = store.rejectCandidate('decision-log', {
    expectedVersion: draft.version,
    by: 'reviewer',
    reason: 'The replay environment does not match the intended target.',
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.version, 2);
  assert.deepEqual(store.listCandidates({ statuses: ['rejected'] }).map((item) => item.name), ['decision-log']);
  assert.equal(store.inspectCandidate('decision-log', 1).status, 'draft');

  const reopened = store.updateCandidate('decision-log', rejected.version, {
    rationale: 'The candidate was revised for the matching environment.',
  });
  assert.equal(reopened.status, 'draft');
  const archived = store.archiveCandidate('decision-log', {
    expectedVersion: reopened.version,
    by: 'reviewer',
    reason: 'Superseded by a narrower candidate.',
  });
  assert.equal(archived.status, 'archived');
  assert.equal(store.listCandidates({ statuses: ['rejected'] }).length, 0);
  assert.equal(store.listCandidates({ statuses: ['archived'] })[0]?.version, archived.version);
});

test('candidate and revision internals stay invisible to normal skill discovery', () => {
  const base = mkdtempSync(join(tmpdir(), 'shadow-skill-discovery-'));
  const home = join(base, 'home');
  const workspace = join(base, 'workspace');
  const root = join(home, '.shadow', 'skills');
  mkdirSync(workspace, { recursive: true });
  const store = new SkillCandidateStore({ skillsRoot: root, now: () => new Date('2026-10-09T12:00:00.000Z') });
  const draft = store.draftCandidate(verifiedInput('discovered-after-approval'));
  assert.deepEqual(discoverSkills(workspace, { homedir: home }), [], 'a draft is never loaded as a skill');

  store.activateCandidate('discovered-after-approval', {
    expectedVersion: draft.version,
    approvedBy: 'operator',
    confirmation: 'activate',
  });
  const discovered = discoverSkills(workspace, { homedir: home });
  assert.deepEqual(discovered.map((skill) => skill.name), ['discovered-after-approval']);
  assert.equal(discovered[0]?.body, draft.skillMarkdown.trim());
  assert.ok(!discovered.some((skill) => skill.name === '.candidates' || skill.name === '.revisions'));
});

test('path traversal and symlinked candidate or active paths fail closed', {
  skip: process.platform === 'win32' ? 'symlink creation requires platform-specific privileges' : false,
}, () => {
  const { root, store } = isolatedStore('symlinks');
  assert.throws(() => store.draftCandidate({ ...verifiedInput('safe-name'), name: '../escape' }), /invalid skill name/i);

  const draft = store.draftCandidate(verifiedInput('safe-name'));
  const outside = mkdtempSync(join(tmpdir(), 'shadow-skill-outside-'));
  const outsideFile = join(outside, 'outside.md');
  writeFileSync(outsideFile, 'secret', 'utf8');
  const storedSkill = join(root, '.candidates', 'safe-name', 'versions', '000001', 'SKILL.md');
  unlinkSync(storedSkill);
  symlinkSync(outsideFile, storedSkill);
  assert.throws(() => store.inspectCandidate('safe-name'), /symlink/i);

  const second = store.draftCandidate(verifiedInput('active-link'));
  const activeOutside = join(outside, 'active');
  mkdirSync(activeOutside);
  symlinkSync(activeOutside, join(root, 'active-link'));
  assert.throws(
    () => store.activateCandidate('active-link', {
      expectedVersion: second.version,
      approvedBy: 'operator',
      confirmation: 'activate',
    }),
    /symlink/i,
  );
  assert.deepEqual(readdirSync(activeOutside), [], 'the symlink target was never written');
  assert.equal(draft.version, 1);

  const realRoot = join(outside, 'real-skill-root');
  const linkedRoot = join(outside, 'linked-skill-root');
  mkdirSync(realRoot);
  symlinkSync(realRoot, linkedRoot);
  const linkedStore = new SkillCandidateStore({ skillsRoot: linkedRoot });
  assert.throws(() => linkedStore.draftCandidate(verifiedInput('root-link')), /symlink/i);
});
