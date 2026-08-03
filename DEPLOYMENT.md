# Deployment / Release Guide

How to build Shadow from source and cut a verifiable release. This is the **public** side of the
process — everything here runs against this repository alone, with no private infrastructure.

**Audience:** contributors and anyone building their own artifacts.

**Current release baseline:** `v5.0.0`.

> **Maintainer note:** the *official* release pipeline (binary hosting, signing keys) is private
> and intentionally not part of this repo. This guide covers the parts that are.

---

## Prerequisites

- **Node.js ≥ 20**
- **[Bun](https://bun.sh)** — only needed for the single-file binary (`scripts/build-binary.sh`)
- **git**

## 1. Install + verify the toolchain

```bash
git clone https://github.com/Blackfrost-AI/Shadow_CLI.git && cd Shadow_CLI
npm ci            # reproducible install from package-lock.json
npm test          # full suite (currently 1,298 tests) — must be 100% green before any release
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
- a checked-in `dist/` differs from a fresh production build (a clean mirror with no `dist/` is
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

1. Bump `package.json` and `package-lock.json`, then update the README current-build line and release notes.
2. `npm test` && `npm run typecheck:all` && `npm run lint` — all green.
3. `npm run check:release-gate` — green.
4. Build the binaries you intend to distribute and smoke-test `--version` on each.
5. Commit the release and push.

There's no CI — the gate + staged builds above *are* the pipeline.

---

## See also

- [README.md](README.md) — installation + model setup
- [USER_GUIDE.md](USER_GUIDE.md) — day-to-day usage
- [THREAT_MODEL.md](THREAT_MODEL.md) — the security model this release process protects
- [TESTING.md](TESTING.md) — testing conventions
