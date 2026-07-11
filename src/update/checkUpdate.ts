/**
 * OPT-IN, payload-free update discovery — the honest reconciliation of "zero telemetry" with "know
 * about updates."
 *
 * OFF by default (`updateCheck` config). When the user turns it on: at most ONCE A DAY, on launch, a
 * plain `GET` of the PUBLIC repo's version — no query params, no identifiers, no body, no cookies. If a
 * newer version exists it prints ONE line telling the user to run `shadow update`. ANY error/timeout/
 * offline is swallowed silently — a check never disrupts a session, and the network only moves because
 * the user chose to opt in.
 *
 * This is NOT telemetry: nothing ABOUT the user leaves the machine. It is an auditable request for a
 * PUBLIC version string, the same class as `curl <public-file>` — and because the source is public,
 * anyone can verify exactly that. Telemetry is a black box that reports the user TO the vendor; this
 * reports nothing and benefits only the user.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { GLOBAL_DIR } from '../state/globalStore.js';

/** The authoritative version lives in the public repo's package.json (bumped every release). Reading
 *  it needs no bespoke endpoint and is trivially auditable. */
const VERSION_URL = 'https://raw.githubusercontent.com/Blackfrost-AI/Shadow_CLI/main/package.json';
const DAY_MS = 24 * 60 * 60 * 1000;

function statePath(): string {
  return join(GLOBAL_DIR, 'update-check.json');
}

/** `a` newer than `b` for dotted versions (2.5.10 > 2.5.9). A pure numeric-tuple compare; if either
 *  carries a non-numeric pre-release segment we fall back to a string compare rather than guess. */
export function versionGreater(a: string, b: string): boolean {
  const seg = (v: string): number[] => v.split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? parseInt(x, 10) : NaN));
  const pa = seg(a);
  const pb = seg(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return a > b; // odd suffix → lexical fallback
    if (x !== y) return x > y;
  }
  return false;
}

function lastCheckAt(path: string): number {
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as { at?: number }).at ?? 0;
  } catch {
    return 0;
  }
}

function recordCheckAt(path: string, at: number): void {
  try {
    mkdirSync(GLOBAL_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({ at }) + '\n');
  } catch {
    /* best-effort — a failed write just means we might re-check sooner */
  }
}

/**
 * When enabled AND not already checked in the last 24h, GET the public version and, if newer than
 * `currentVersion`, call `notify` with a one-line message. Never throws; never blocks meaningfully
 * (3s cap). Returns the latest version it saw (for tests) or null.
 *
 * `now`/`fetchImpl` are injectable for tests (no real clock/network in the suite).
 */
export async function maybeNotifyUpdate(
  currentVersion: string,
  enabled: boolean,
  notify: (line: string) => void,
  opts: { now?: number; fetchImpl?: typeof fetch; statePath?: string } = {},
): Promise<string | null> {
  if (!enabled) return null; // OFF by default — the user must opt in
  const now = opts.now ?? Date.now();
  const state = opts.statePath ?? statePath();
  if (now - lastCheckAt(state) < DAY_MS) return null; // at most once a day
  recordCheckAt(state, now); // record BEFORE the request so a hang/offline can't re-fire every launch
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 3000);
    // Plain GET — no query string, no custom identifying headers, no body, no credentials.
    const res = await doFetch(VERSION_URL, { signal: ac.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const latest = (JSON.parse(await res.text()) as { version?: string }).version ?? null;
    if (latest && versionGreater(latest, currentVersion)) {
      notify(`◆ Shadow v${latest} is available (you have v${currentVersion}) — run \`shadow update\`.`);
    }
    return latest;
  } catch {
    return null; // offline / timeout / parse error — a check must never disrupt the session
  }
}
