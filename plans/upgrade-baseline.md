# Upgrade baseline — 2026-11-06

Source and isolated checkout both resolve to c99c7e109d65fb141557373aa1e503df5affac5b. Earlier claims of differing current revisions are superseded by git rev-parse results this session.

Source checkout: /Users/craigmac/shadow-oss (main), only untracked docs/OMP_FEATURE_COMPARISON.md. Isolated checkout: /Users/craigmac/.shadow/worktrees/daily-upgrade (shadow/daily-upgrade), modified app.ts and commandCatalog.ts; untracked promptControl.ts, mutation.ts, their tests and progress plans. No source integration performed.

Native test runner: node --import tsx/esm --test. Vitest is not a project dependency; mutation tests must migrate. Current npm run typecheck passed; native test/prompt-control.test.ts passed 4/4. This is not full-suite evidence.

Read-only swarm review identified an actual Snowfall busy-Enter bypass of slash handlers and missing Ink gates. Mutation review identified missing rollback-in-progress durability, journal symlink reads, no concurrency claim, reconciliation coupled to live target validation and UTF-8 roundtrip issues. Approval hash is integrity metadata, not an authentication boundary against a same-user process able to rewrite journal state. Address before integration. Full findings retained in task agent_1793946305174_z2g8lg_sync.

Next: finish actual renderer routing and integration tests (m-2); no shell escape until full policy integration; no claimed mutation release.
