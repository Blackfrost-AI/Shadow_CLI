# Shadow 10.0.1 release verification

Version 10.0.1 adds guided terminal onboarding and persistent session names to Snowfall.
The original thick banner and full-width conversation remain.

## Reproducible checks

Run `npm ci`, `npm run typecheck:all`, `npm run lint`, `npm test`, `npm run build`,
`npm run preview:snowfall`, `npm run check:release-gate`, and `npm pack --dry-run`.
Use Node for tests; Bun's test runner does not preserve the suite's HOME isolation.

On macOS and Linux, run `python3 scripts/smoke-onboard-pty.py node dist/index.js` and
`python3 scripts/smoke-snowfall-pty.py node dist/index.js`. The onboarding check uses a disposable
loopback provider and isolated profile. It covers a failed connection followed by retry and save,
masked key entry, resize, cancellation, signal cleanup, and piped setup. It sends no cloud requests.
The same scripts accept a compiled binary path for standalone-runtime verification.

The [source workflow](https://github.com/Blackfrost-AI/Shadow_CLI/actions/workflows/snowfall.yml)
runs the full suite on Linux, macOS and Windows with Node 22.19.0 and 26.5.0, plus both PTY checks
on POSIX platforms. Native Windows skips remain explicit for POSIX-only semantics.

The [signed release workflow](https://github.com/Blackfrost-AI/Shadow_CLI/actions/workflows/release-smoke.yml)
verifies the signed release on Linux x64/ARM64, macOS Intel/ARM64 and Windows Server 2022 with
PowerShell 5.1 and 7. It covers clean and repeated installation, launch, offline-update refusal,
signed self-update, and rejection of invalid manifests and binaries.

The [10.0.1 release](https://github.com/Blackfrost-AI/Shadow_CLI/releases/tag/v10.0.1) records
completed check runs and publication evidence. The [10.0.0 record](V10_VERIFICATION.md) describes
the base terminal release and its coverage boundaries.

## Coverage boundaries

Provider presets follow their documented compatible endpoints. Automated onboarding tests use
controlled loopback servers; they do not qualify every provider account or real self-hosted server.
Terminal tests do not cover every emulator, Windows edition or graphics protocol.
