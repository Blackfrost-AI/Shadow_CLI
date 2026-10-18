import { existsSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { buildLandlockArgs, probeLandlock, standardReadRoots, standardWritableDevices } from './landlock.js';

/**
 * OS-level sandbox for run_shell — the real boundary the env-allowlist/denylist
 * can't provide (an arbitrary subprocess is otherwise unconfined). Mirrors how
 * the reference client sandboxes bash: macOS seatbelt (`sandbox-exec`), Linux bubblewrap
 * (`bwrap`). Policy: filesystem WRITES are confined to the workspace + /tmp;
 * reads of ~/.shadow (the credentials store) are denied; network is allowed by
 * default (agent tasks need installs/fetches) and can be turned off.
 *
 * Under --yolo: explicitly disabled (passthrough, no sandbox).
 *
 * Claude-parity review: profiles match research (deny writes except allowed, tmpfs for creds).
 * Added denies for typical injection paths via model policy (see classifier/denylist).
 * Gaps: Win no sandbox (documented); could add more proc/exec denies but would break agent needs (e.g. installs).
 *
 * Fail-open with a note when no sandbox tool is available (so run_shell still
 * works on a bare system) — never on macOS, where sandbox-exec ships built in.
 */
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

export interface SandboxResult {
  argv: string[]; // argv[0] is the program to spawn
  sandboxed: boolean;
  note?: string; // populated when sandboxing was requested but unavailable
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

const hasBwrap = (): boolean =>
  ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap'].some((p) => existsSync(p));

/**
 * Credential/token locations no agent-run shell should ever read. Absolute, resolved once at
 * module load. These are DENY rules layered over `(allow default)` — nothing here is granted by
 * the workspace allow, so adding a path only ever removes access.
 *
 * The list is a curated enumeration (the structural inversion — deny $HOME reads by default,
 * allow workspace + grants — is tracked as P3-04 v1; it breaks legitimate tooling reads until
 * the grant model catches up). Entries are credential-bearing ONLY: key material, registry/API
 * tokens, cloud CLI credential caches. Deliberately NOT listed: .gitconfig, .bashrc/.zshrc,
 * .npm (cache), package-manager caches — useful, not secret.
 */
export const SECRET_READ_DENY: readonly string[] = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.config/gh',
  '.netrc',
  '.docker/config.json',
  '.kube',
  // P3-04 (F07-06 structural half): widen past the original seven. Each entry is a known
  // token/credential store that a self-hosted-model injection could otherwise be steered into
  // reading and folding into a tool result (i.e. handing to the provider).
  '.npmrc', // registry auth tokens
  '.pypirc', // PyPI upload credentials
  '.git-credentials', // plaintext git passwords
  '.config/gcloud', // Google Cloud ADC + tokens
  '.azure', // Azure CLI tokens
  '.config/huggingface', // HF tokens
  '.m2/settings.xml', // Maven repository credentials (a file, subpath-of-file denies fine)
  // F07-06 (P2-07): the password-manager + browser/keychain tier. Browsers keep saved passwords
  // and session cookies here; the macOS Keychain holds EVERYTHING an app chose to store there.
  // Whole-directory denies are deliberate: the secret files sit several levels deep and move
  // between browser versions (Chrome's Login Data / Cookies / Web Data), so per-file rules would
  // rot silently. The cost — a sandboxed shell can't read browser history/bookmarks either — is
  // the correct trade: agent tasks never legitimately need those. There is NO per-command waiver
  // for a single read — the only escapes are deliberate all-or-nothing choices (sandbox: "off" in
  // config, --no-sandbox / --yolo, or full autonomy), each of which drops the WHOLE sandbox.
  '.password-store', // `pass` — GPG-encrypted, but gpg-agent may hold an unlocked key
  '.config/google-chrome', // Linux Chrome
  '.config/chromium', // Linux Chromium
  '.config/microsoft-edge', // Linux Edge
  '.mozilla/firefox', // Linux Firefox (logins.json + key4.db)
  'Library/Application Support/Google/Chrome', // macOS Chrome
  'Library/Application Support/Chromium', // macOS Chromium
  'Library/Application Support/Microsoft Edge', // macOS Edge
  'Library/Application Support/Firefox', // macOS Firefox
  'Library/Keychains', // macOS Keychain — the OS credential store itself
  '.local/share/keyrings', // GNOME keyrings (login.keyring holds saved passwords)
  // BYPASS review (P2-07): the third-party-store tier the first pass missed. rclone configs hold
  // PLAINTEXT cloud credentials for every configured remote; the rest are the same class —
  // tokens, key material, password-manager stores, wallet files.
  '.config/rclone', // rclone.conf — plaintext cloud credentials for every remote
  '.vault-token', // HashiCorp Vault token
  '.oci', // Oracle Cloud config + API-key PEMs
  '.config/BraveSoftware', // Linux Brave (Chromium-based)
  'Library/Application Support/BraveSoftware', // macOS Brave
  'Library/Application Support/1Password', // 1Password app data
  'Library/Application Support/1Password 8', // separate component name — seatbelt subpath is component-exact
  'Library/Group Containers/2BUA8C4S2C.com.agilebits', // 1Password browser-extension store
  '.electrum/wallets', // Electrum wallets
  '.bitcoin/wallets', // Bitcoin Core wallets
].map((rel) => join(homedir(), rel));

/** The macOS seatbelt profile, parameterized by WS (workspace) and SD (~/.shadow). */
function seatbeltProfile(
  allowNetwork: boolean,
  extraWrite: string[],
  socketDeny?: boolean,
  exclusiveWriteRoot?: string,
  readOnly?: boolean,
): string {
  // READ-ONLY MODE: the fail-safe default from sandboxPolicy.ts. The workspace is NOT writable —
  // only /dev/null and friends, so ordinary `2>/dev/null` redirection still works but nothing can
  // persist. This is the mode a caller gets when they never said "yes, let the agent write".
  if (readOnly) {
    return [
      '(version 1)',
      '(allow default)',
      '(deny file-write*)',
      '(allow file-write*',
      '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/urandom")',
      '  (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty"))',
      '(deny file-write* (subpath (param "SD")))',
      '(deny file-read* (subpath (param "SD")))',
      ...SECRET_READ_DENY.map((p) => `(deny file-read* (subpath ${JSON.stringify(p)}))`),
      ...(socketDeny
        ? [
            '(deny file-write* (regex "^/private/tmp/com\\.apple\\.launchd\\."))',
            '(deny file-write* (regex "^/private/tmp/ssh-"))',
            '(deny file-write* (regex "^/private/var/folders/[^/]+/[^/]+/T/com\\.apple\\.launchd\\."))',
            '(deny file-write* (regex "^/private/var/folders/[^/]+/[^/]+/T/ssh-"))',
            '(deny file-write* (regex "^/private/var/folders/[^/]+/[^/]+/T/gpg-"))',
          ]
        : []),
      allowNetwork ? '' : '(deny network*)',
    ]
      .filter(Boolean)
      .join('\n');
  }
  // DENOTATION MODE (exclusiveWriteRoot): writes are confined to ONE scratch dir and the
  // workspace itself is NOT writable. This is deliberately tighter than the run_shell profile —
  // detonating an untrusted sample should not be able to touch the repo it was triaged from, and
  // /tmp + /private/var/folders are a shared, predictable escape surface. The caller sets TMPDIR
  // into the scratch dir, so runtimes that need temp space still work.
  const writeAllow = exclusiveWriteRoot
    ? [
        `  (subpath ${JSON.stringify(exclusiveWriteRoot)})`,
        '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/urandom")',
        '  (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty")',
      ]
    : [
        '  (subpath (param "WS"))',
        ...extraWrite.map((p) => `  (subpath ${JSON.stringify(p)})`),
        '  (subpath "/private/tmp")',
        '  (subpath "/private/var/folders")',
        '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/urandom")',
        '  (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty") (literal "/dev/dtracehelper")',
      ];
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write*',
    ...writeAllow.slice(0, -1),
    `${writeAllow[writeAllow.length - 1]})`,
    // Protect the credential store even when ~/.shadow sits INSIDE the workspace (the common `shadow`
    // run-from-$HOME case): these denies come AFTER the workspace file-write* allow, and in seatbelt the
    // LAST matching rule wins — so writes/reads to ~/.shadow are blocked regardless of WS containment.
    // Without the write deny, a sandboxed run_shell could overwrite config.json with an attacker baseUrl+key.
    '(deny file-write* (subpath (param "SD")))',
    '(deny file-read* (subpath (param "SD")))',
    // …EXCEPT in detonation mode, where the scratch dir lives under ~/.shadow/security/detonation
    // and the workspace may itself BE $HOME. Re-allowing it here (last match wins) keeps the
    // credential store sealed while still letting the sample write where it is supposed to. Scoped
    // to the exact run directory, so config.json and the rest of ~/.shadow stay unreadable.
    ...(exclusiveWriteRoot
      ? [
          `(allow file-write* (subpath ${JSON.stringify(exclusiveWriteRoot)}))`,
          `(allow file-read* (subpath ${JSON.stringify(exclusiveWriteRoot)}))`,
        ]
      : []),
    // Credential stores OUTSIDE ~/.shadow get the same treatment, and for the same reason: the
    // profile is `(allow default)` minus writes, so a sandboxed read of ~/.ssh/id_rsa or
    // ~/.aws/credentials was permitted and its contents would be handed to the provider as a tool
    // result. Independent of the read-only classifier's path scoping — that stops the AUTO-run,
    // this stops the read even when the user approves a shell command that reaches for them.
    ...SECRET_READ_DENY.map((p) => `(deny file-read* (subpath ${JSON.stringify(p)}))`),
    // P3-08 (MCP children): `(deny network*)` covers INET sockets only — AF_UNIX connect() is
    // mediated as file-write*, and /private/tmp + /private/var/folders stay WRITABLE in this
    // profile. A trojaned stdio server could otherwise reach agent sockets living under tmp
    // (launchd Listeners, ssh-agent, gpg). Deny the common socket shapes for jailed children.
    // SBPL note: the `glob` matcher does not exist in this seatbelt dialect (profile fails to
    // compile: "unbound variable: glob") — `regex` does, and is what we use.
    ...(socketDeny
      ? [
          '(deny file-write* (regex "^/private/tmp/com\\.apple\\.launchd\\."))',
                    '(deny file-write* (regex "^/private/tmp/ssh-"))',
          '(deny file-write* (regex "^/private/var/folders/[^/]+/[^/]+/T/com\\.apple\\.launchd\\."))',
                    '(deny file-write* (regex "^/private/var/folders/[^/]+/[^/]+/T/ssh-"))',
                    '(deny file-write* (regex "^/private/var/folders/[^/]+/[^/]+/T/gpg-"))',
        ]
      : []),
    allowNetwork ? '' : '(deny network*)',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The macOS seatbelt argv prefix (profile included) shared by run_shell and MCP confinement. */
function seatbeltPrefix(
  ws: string,
  shadowDir: string,
  allowNetwork: boolean,
  extraWrite: string[],
  socketDeny?: boolean,
  exclusiveWriteRoot?: string,
  readOnly?: boolean,
): string[] {
  return [
    'sandbox-exec',
    '-D',
    `WS=${ws}`,
    '-D',
    `SD=${shadowDir}`,
    '-p',
    seatbeltProfile(allowNetwork, extraWrite, socketDeny, exclusiveWriteRoot, readOnly),
  ];
}

// bwrap needs every --tmpfs mountpoint to exist (it mkdirs it under the read-only root), and it
// needs the PARENT to be writable in the new root. Neither is guaranteed: ~/.shadow may not exist
// yet, and /root is read-only inside the sandbox. Mount a tmpfs only where the directory already
// exists; masking a path that isn't there would be a no-op anyway.
const maskable = (p: string): boolean => {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** The bubblewrap flag list shared by run_shell and MCP confinement. */
function bwrapFlags(
  ws: string,
  shadowDir: string,
  extra: string[],
  allowNetwork: boolean,
  privateTmp?: boolean,
  exclusiveWriteRoot?: string,
  readOnly?: boolean,
): string[] {
  // READ-ONLY MODE: whole fs read-only, no writable binds at all. /dev and /proc are re-mounted by
  // bwrap itself so ordinary redirection and process inspection still work; nothing else can be
  // written. A private tmpfs keeps scratch writes out of the host /tmp (which would otherwise be a
  // writable escape hatch and defeat the point).
  if (readOnly) {
    const flags = [
      '--die-with-parent',
      '--new-session',
      '--unshare-pid',
      '--ro-bind',
      '/',
      '/',
      '--dev',
      '/dev',
      '--proc',
      '/proc',
      '--tmpfs',
      '/tmp',
      ...(maskable(shadowDir) ? ['--tmpfs', shadowDir] : []),
      ...SECRET_READ_DENY.filter(maskable).flatMap((d) => ['--tmpfs', d]),
      '--chdir',
      ws,
    ];
    if (!allowNetwork) flags.push('--unshare-net');
    return flags;
  }
  // DENOTATION MODE (exclusiveWriteRoot): the workspace is bound READ-ONLY and only the scratch dir is writable.
  // /tmp gets a private tmpfs rather than the host bind, so a sample cannot drop files into a
  // shared, predictable location and cannot see another process's scratch state.
  if (exclusiveWriteRoot) {
    const flags = [
      '--die-with-parent',
      '--new-session',
      '--unshare-pid',
      '--ro-bind',
      '/',
      '/', // whole fs read-only…
      '--dev',
      '/dev',
      '--proc',
      '/proc',
      '--bind',
      exclusiveWriteRoot,
      exclusiveWriteRoot, // …scratch dir writable…
      '--tmpfs',
      '/tmp', // …private tmp, not the host's…
      // ~/.shadow is masked by an empty tmpfs so no credentials are readable… but when the
      // workspace is $HOME the scratch dir lives under it, and bwrap's LAST bind for a path wins.
      // Re-bind the run directory after the tmpfs so the sample can write where it should while
      // config.json and the rest of ~/.shadow stay hidden.
      ...(maskable(shadowDir) ? ['--tmpfs', shadowDir] : []),
      '--bind',
      exclusiveWriteRoot,
      exclusiveWriteRoot,
      ...SECRET_READ_DENY.filter(maskable).flatMap((d) => ['--tmpfs', d]),
      '--chdir',
      exclusiveWriteRoot,
    ];
    if (!allowNetwork) flags.push('--unshare-net');
    return flags;
  }
  const flags = [
    '--die-with-parent',
    '--new-session',
    // New PID namespace (+ the fresh --proc below) so a sandboxed child cannot read the parent
    // agent's environment via /proc/<agent-pid>/environ and exfiltrate the provider API key.
    '--unshare-pid',
    '--ro-bind', '/', '/', // whole fs read-only…
    '--dev', '/dev',
    '--proc', '/proc',
    '--bind', ws, ws, // …workspace writable…
    // P3-08 (MCP children): `--unshare-net` does NOT cover AF_UNIX — ssh-agent sockets live in
    // /tmp/ssh-*, so a jailed child given the host /tmp could still reach them. MCP children get
    // a PRIVATE tmpfs instead; run_shell keeps the host /tmp bind (approved interactive commands
    // legitimately exchange scratch files there).
    ...(privateTmp ? ['--tmpfs', '/tmp'] : ['--bind', '/tmp', '/tmp']), // …and /tmp…
    ...extra.flatMap((d) => ['--bind', d, d]), // …and any granted dirs writable…
    ...(maskable(shadowDir) ? ['--tmpfs', shadowDir] : []), // …and ~/.shadow hidden behind an empty tmpfs (no creds read)
    // Same treatment for the credential stores outside ~/.shadow. A tmpfs makes them read as
    // empty rather than erroring, which is the friendlier failure and still leaks nothing.
    // Only bind paths that EXIST and are directories — bwrap aborts otherwise.
    ...SECRET_READ_DENY.filter(maskable).flatMap((d) => ['--tmpfs', d]),
    '--chdir', ws,
  ];
  if (!allowNetwork) flags.push('--unshare-net');
  return flags;
}

export function wrapCommand(opts: {
  command: string;
  workspaceRoot: string;
  /** Extra granted roots (additionalDirectories / --add-dir); bound writable in the sandbox. */
  additionalRoots?: string[];
  allowNetwork: boolean;
  enabled: boolean;
  /**
   * DETONATION MODE. When set, writes are confined to this single directory and the workspace
   * itself is NOT writable — the sample under analysis cannot touch the tree it came from, and
   * /tmp is not a shared escape hatch. The caller is responsible for pointing TMPDIR/HOME inside
   * it. `sandboxed: false` in the result means CONTAINMENT FAILED and the caller must refuse to
   * run rather than detonate unconfined.
   */
  exclusiveWriteRoot?: string;
  /**
   * Execute exactly this argv instead of `[shell, '-c', command]`.
   *
   * Detonation needs the sample to be the process, not an argument to a shell: a compiled Mach-O
   * or ELF run as `sh <sample>` is a syntax error (exit 126), and a filename reaching a shell
   * string is an injection surface. Passing the argv explicitly keeps this out of the shell
   * entirely and makes the sandbox prefix impossible to mis-slice.
   */
  execArgv?: string[];
  /**
   * READ-ONLY MODE from sandboxPolicy.ts — no writes anywhere except /dev/null and friends.
   * Ignored when `exclusiveWriteRoot` is set (that is a stricter, more specific mode).
   */
  readOnly?: boolean;
  /**
   * Fence the READ side too (untrusted execution). On Linux this prefers Landlock, which needs no
   * user namespaces; on macOS it tightens the seatbelt profile to deny reads outside the runtime.
   */
  readConfined?: boolean;
}): SandboxResult {
  const { command, workspaceRoot, allowNetwork, enabled, readOnly, readConfined } = opts;
  const shell = process.env.SHELL || '/bin/sh';
  const tail = opts.execArgv ?? [shell, '-c', command];
  const ws = real(workspaceRoot);
  const shadowDir = real(join(homedir(), '.shadow'));
  // Real, existing, de-duplicated extra roots — bwrap can't bind a missing path.
  const extra = [...new Set((opts.additionalRoots ?? []).map(real))].filter((p) => p !== ws && existsSync(p));

  const passthrough = (note?: string): SandboxResult => ({
    argv: IS_WIN ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command] : tail,
    sandboxed: false,
    note,
  });

  if (!enabled) return passthrough();
  // --yolo (or explicit noSandbox/unrestricted) means the caller wants no sandbox at all.
  if (IS_WIN) return passthrough('no OS sandbox on Windows — run_shell runs unconfined');

  // Detonation mode: resolve the exclusive root once; a missing dir is a hard error, not a silent
  // fallback to the workspace-wide profile.
  const exclusive = opts.exclusiveWriteRoot ? real(opts.exclusiveWriteRoot) : undefined;
  if (opts.exclusiveWriteRoot && !existsSync(exclusive!)) {
    throw new Error(`exclusiveWriteRoot does not exist: ${opts.exclusiveWriteRoot}`);
  }

  if (IS_MAC) {
    if (!existsSync('/usr/bin/sandbox-exec')) {
      return passthrough('sandbox-exec not found — run_shell runs unconfined');
    }
    return {
      argv: [
        ...seatbeltPrefix(
          ws,
          shadowDir,
          allowNetwork,
          exclusive || readOnly ? [] : extra,
          undefined,
          exclusive,
          readOnly && !exclusive,
        ),
        ...tail,
      ],
      sandboxed: true,
    };
  }

  // Linux
  //
  // Read-confined (untrusted) execution prefers Landlock: it needs no unprivileged user
  // namespaces, which are routinely disabled in containers and on hardened hosts — the exact
  // environments where bwrap silently degrades to "no sandbox". Falling through to bwrap is still
  // correct (its --ro-bind / gives the same read fence) so we try it only after Landlock.
  if (readConfined) {
    const ll = probeLandlock();
    if (ll.ok && ll.launcher) {
      const writable = readOnly ? standardWritableDevices() : [ws, ...standardWritableDevices()];
      return {
        argv: [
          ll.launcher,
          ...buildLandlockArgs(command, {
            launcher: ll.launcher,
            allowedRead: standardReadRoots(ws),
            writableRoots: writable,
          }),
        ],
        sandboxed: true,
      };
    }
  }
  if (hasBwrap()) {
    return {
      argv: [
        'bwrap',
        ...bwrapFlags(
          ws,
          shadowDir,
          exclusive || readOnly ? [] : extra,
          allowNetwork,
          undefined,
          exclusive,
          readOnly && !exclusive,
        ),
        ...tail,
      ],
      sandboxed: true,
    };
  }
  // Neither Landlock nor bwrap. For a read-confined (untrusted) run this is a real failure: the
  // caller asked for a read fence and must not detonate unconfined. Say so explicitly rather than
  // reusing the generic message, so the refusal reason is legible in the tool result.
  if (readConfined) {
    return passthrough(
      'READ CONFINEMENT UNAVAILABLE: neither Landlock nor bwrap is usable here — untrusted ' +
        'execution must not proceed unconfined (install bubblewrap, or use a kernel with Landlock)',
    );
  }
  return passthrough('bubblewrap (bwrap) not found — run_shell runs unconfined');
}

/**
 * P3-08 Phase 3 — OS confinement for MCP STDIO CHILDREN. Same jail tiers as run_shell
 * (workspace+/tmp writes, credential stores denied, ~/.shadow hidden), but the argv tail is the
 * server's own argv — no shell in between. Network is OFF unless the caller grants it: a stdio
 * server speaks over its pipes and needs no sockets by default, so a trojaned/broken server
 * can't beacon. The grant is the server's `network: true` (global config); `sandbox: false`
 * skips the jail entirely for that one server (the caller decides both).
 */
export function wrapMcpArgv(opts: {
  command: string;
  args: string[];
  workspaceRoot: string;
  additionalRoots?: string[];
  allowNetwork: boolean;
  enabled: boolean;
}): SandboxResult {
  const { command, args, workspaceRoot, allowNetwork, enabled } = opts;
  const ws = real(workspaceRoot);
  const shadowDir = real(join(homedir(), '.shadow'));
  const extra = [...new Set((opts.additionalRoots ?? []).map(real))].filter((p) => p !== ws && existsSync(p));

  const passthrough = (note?: string): SandboxResult => ({
    argv: [command, ...args],
    sandboxed: false,
    note,
  });

  if (!enabled) return passthrough();
  if (IS_WIN) return passthrough('no OS sandbox on Windows — MCP server runs unconfined');

  if (IS_MAC) {
    if (!existsSync('/usr/bin/sandbox-exec')) {
      return passthrough('sandbox-exec not found — MCP server runs unconfined');
    }
    // socketDeny: AF_UNIX agent sockets under tmp are denied for jailed children (see seatbeltProfile).
    return { argv: [...seatbeltPrefix(ws, shadowDir, allowNetwork, extra, true), command, ...args], sandboxed: true };
  }

  if (hasBwrap()) {
    // privateTmp: fresh tmpfs over /tmp so the child can't reach host agent sockets (ssh-agent).
    return { argv: ['bwrap', ...bwrapFlags(ws, shadowDir, extra, allowNetwork, true), command, ...args], sandboxed: true };
  }
  return passthrough('bubblewrap (bwrap) not found — MCP server runs unconfined');
}

/**
 * Whether an OS sandbox tool is actually present on this host. The sandbox
 * fails open (run_shell runs UNCONFINED) when the platform tool is missing —
 * most Linux container images ship no bubblewrap — so any surface that
 * *advertises* the sandbox status (e.g. the system prompt) must probe this,
 * not assume "ON". Mirrors the platform branches in wrapCommand exactly.
 */
export function sandboxToolAvailable(): boolean {
  if (IS_WIN) return false;
  if (IS_MAC) return existsSync('/usr/bin/sandbox-exec');
  return hasBwrap();
}

/**
 * Truthful OS-sandbox status string for the system prompt / status surfaces.
 * `requested` is whether the sandbox is meant to be on (i.e. not --yolo /
 * --no-sandbox / full autonomy). When it's requested but the host has no
 * sandbox tool, run_shell silently runs unconfined — say so, rather than
 * claiming "ON" (the prompt must not lie about the boundary).
 */
export function osSandboxStatus(requested: boolean): string {
  if (!requested) return 'OFF';
  if (sandboxToolAvailable()) return 'ON (bwrap or seatbelt where available)';
  return 'REQUESTED but UNAVAILABLE — run_shell runs UNCONFINED';
}

/**
 * P2-12 — the confinement state as ONE value, for every surface that reports or acts on it
 * (/status, doctor, the loop's approval escalation, the startup banner):
 *   'off'        — confinement not requested (sandbox: 'off' / --no-sandbox / --yolo / full autonomy).
 *   'confined'   — requested AND this host has the tool to enforce it.
 *   'unconfined' — requested but NO tool on this host: run_shell would run unconfined. This is
 *                  the state the failure policy (`sandboxFailurePolicy`) decides what to do about.
 */
export function sandboxConfinement(sandboxMode: 'auto' | 'off'): 'off' | 'confined' | 'unconfined' {
  if (sandboxMode === 'off') return 'off';
  return sandboxToolAvailable() ? 'confined' : 'unconfined';
}

/**
 * The loud, user-facing startup banner for the 'unconfined' state (P3-04: the unconfined state
 * must be impossible to miss). Empty string when there is nothing to warn about.
 */
export function unconfinedBanner(mode: 'auto' | 'off', failurePolicy: 'auto' | 'fail-closed' | 'warn'): string {
  if (sandboxConfinement(mode) !== 'unconfined') return '';
  const consequence =
    failurePolicy === 'warn'
      ? 'run_shell will execute WITHOUT confinement (policy: warn — warning folded into results only).'
      : failurePolicy === 'fail-closed'
        ? 'EVERY run_shell will stop at the approval gate, every time (policy: fail-closed).'
        : 'run_shell will stop at the approval gate until you approve it (policy: auto).';
  return (
    `⚠ OS SANDBOX UNAVAILABLE on this host — ${consequence} ` +
    `Install bubblewrap (Linux) or set sandboxFailurePolicy / sandbox in ~/.shadow/config.json to change this.`
  );
}
