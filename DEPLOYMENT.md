# Deployment / Release Guide

How to build Shadow from source and cut a verifiable release. This is the **public** side of the
process — everything here runs against this repository alone, with no private infrastructure.

**Audience:** contributors and anyone building their own artifacts.

**Release version:** `v10.0.3`. The commands below are required checks, not a record that they passed.

> **Maintainer note:** the *official* release pipeline (binary hosting, signing keys) is private
> and intentionally not part of this repo. This guide covers the parts that are.

---

## Prerequisites

- **Node.js ≥ 22.19** (matches `engines.node` in `package.json`)
- **[Bun](https://bun.sh) 1.4.2** — the standalone binary compiler (`scripts/build-binary.sh` checks runtime compatibility)
- **git**

## 1. Install + verify the toolchain

```bash
git clone https://github.com/Blackfrost-AI/Shadow_CLI.git && cd Shadow_CLI
npm ci            # reproducible install from package-lock.json
npm test          # full suite — must be 100% green before any release
npm run typecheck # production source typecheck
npm run typecheck:all # strict source + test typecheck
npm run lint      # style (0 errors)
```

> ⚠️ **Use `npm test`, not `bun test`.** The Bun runner can ignore the isolated test HOME and
> touch real local state.

### Release gate

Before building shippable artifacts, run the safety gate:

```bash
npm run check:release-gate
```

This refuses to proceed if, in shipped code:

- `DEV_UNRESTRICTED` is hard-coded on (the workspace jail + OS sandbox would be silently off),
- the embedded web UI assets are stale,
- a generated `dist/` differs from a fresh production build (a clean mirror with no `dist/` is
  built and validated in the same pass),
- the test script no longer globs the whole suite with a timeout.

`scripts/build-binary.sh` invokes this gate automatically for real builds
(skip for a scratch build with `SHADOW_SKIP_GATE=1`).

## 2. Build

### Node build (runs with your local Node)

```bash
npm run build     # compiles to dist/ — exposes the `shadow` bin entry
npm link          # optional: put it on your PATH
```

### Standalone binary (no Node needed to run Shadow)

```bash
# host platform
bash scripts/build-binary.sh dist-bin/shadow

# cross-compile a specific target (bun-<os>-<arch>)
bash scripts/build-binary.sh dist-bin/shadow-linux-x64  bun-linux-x64
bash scripts/build-binary.sh dist-bin/shadow-darwin-arm64 bun-darwin-arm64
bash scripts/build-binary.sh dist-bin/shadow-windows-x64.exe bun-windows-x64
# (see scripts/build-binary.sh header for the full target list)
```

> Build **one platform per command** and confirm distinct output sizes — do not loop a
> space-separated target list through shells that don't word-split (zsh).

## 3. Release checklist

1. Set `package.json` and `package-lock.json` to the intended version; update the README current-build
   line and release notes. Review the public snapshot without importing private history or local state.
2. Run `npm test`, `npm run typecheck`, `npm run typecheck:all` and `npm run lint`.
3. Run `npm run build`, `npm run check:assets` and `npm run check:release-gate`.
4. On POSIX, exercise the compiled entrypoint with the terminal, onboarding, interruption and
   collaboration smoke scripts used by `.github/workflows/snowfall.yml`, including
   `python3 scripts/smoke-parity-pty.py node dist/index.js`.
5. Build the binaries through `scripts/build-binary.sh`; smoke-test the exact artifacts to distribute.
6. Commit the reviewed public source. Upload an immutable signed candidate for that source revision,
   then run the signed-release validation below before promoting it.

The `Signed release smoke` workflow runs on `release/**` branches and version tags. Maintainers
upload a complete signed candidate to `releases/<version>/<full-source-commit>/` first.
Each candidate is immutable, so a failed candidate can be retained while its replacement is tested. All six
native jobs must pass before promoting the matching set to the current installer/updater channel.
Darwin signing precedes checksum generation; manifest signatures use the pinned release key.
After validation, publish the reviewed main commit and its exact `v<package-version>` tag together.
The public push hook checks that their versions agree.

Never merge private working history into the public repository. Prepare a reviewed, public-safe
snapshot on public history, retain rollback artifacts, and verify live signed downloads after
promotion. The website's version, source provenance and installer copies must match the release.

### Dependency audit

Run `npm audit --omit=dev` for shipped dependencies and `npm audit` for the complete toolchain.
Record the source revision, date and results for the artifacts being released; an older release's
audit result does not validate the current lockfile or advisory database.

---

## See also

- [README.md](README.md) — installation + model setup
- [USER_GUIDE.md](USER_GUIDE.md) — day-to-day usage
- [THREAT_MODEL.md](THREAT_MODEL.md) — the security model this release process protects
- [TESTING.md](TESTING.md) — testing conventions
- [TERMINAL_RENDERERS.md](TERMINAL_RENDERERS.md) — Snowfall and compatibility renderer controls
- [Collaboration](docs/COLLABORATION.md) — jobs, consultations, retained work and runtime limits
- [CHANGELOG.md](CHANGELOG.md) — release notes
