# Shadow 10.0.0 release verification

Version 10.0.0 makes Snowfall the default terminal. The approved design uses the original thick
SHADOW banner, a full-width conversation and a compact footer. The v9 Work Center remains available.

## Reproducible checks

Run `npm ci`, `npm run typecheck:all`, `npm run lint`, `npm test`, `npm run build`,
`npm run preview:snowfall`, `npm run check:release-gate`, and `npm pack --dry-run`.
Use Node for tests; Bun's test runner does not preserve the suite's HOME isolation.

The [Snowfall verification workflow](https://github.com/Blackfrost-AI/Shadow_CLI/actions/workflows/snowfall.yml)
runs source and terminal checks on Linux, macOS and Windows with Node 22.19.0 and 26.5.0.
Linux and macOS also exercise the terminal lifecycle through a native PTY. Deterministic frame
fixtures cover layout widths, themes, dialogs and transcript behavior.

The [signed release workflow](https://github.com/Blackfrost-AI/Shadow_CLI/actions/workflows/release-smoke.yml)
verifies the exact signed candidate on Linux x64/ARM64, macOS Intel/ARM64 and Windows Server 2022
with PowerShell 5.1 and 7. It covers installation to paths containing spaces, version/help/mock
launch, repeat installation, offline refusal, self-update and rejection of tampered artifacts.

The [v10.0.0 release](https://github.com/Blackfrost-AI/Shadow_CLI/releases/tag/v10.0.0) records the
completed check runs and publication evidence for this version.

## Coverage boundaries

The full-width layout and retro banner received visual approval on macOS. Native CI checks do
not qualify every terminal emulator, Windows edition or terminal graphics protocol. Follow the
[terminal contract](../TERMINAL_RENDERERS.md) for image fallbacks, fixed Snowfall keys and features
that require the Ink compatibility renderer. Modified key chords must be forwarded by the terminal.

The runtime dependency audit and full development-tool audit are recorded separately in the release
notes. Neither replaces the source, signed-manifest or native installer checks.
