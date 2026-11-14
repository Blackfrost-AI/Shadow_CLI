import { readFileSync, writeFileSync, unlinkSync, openSync, closeSync, statSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWrite } from '../tools/util.js';
import { redactString } from '../util/redact.js';

// Project memory: a flat string→string KV of durable facts about the workspace
// (build/test commands, key file locations, conventions). Backed by
// <workspaceRoot>/.shadow/memory.json so it survives restarts. Every mutation
// persists atomically (temp file + rename) — a reader never sees a half-written
// file. `asContext` renders the facts for injection into the system prompt at
// startup, so the model recalls them without being re-told each session.
//
// 11.6.0 durability + privacy hardening:
//  • A corrupt memory.json is QUARANTINED (preserved at memory.json.corrupt-<ISO>,
//    owner-only) before the store starts empty — the next write can no longer
//    silently annihilate it. A MISSING file is not corruption and is never
//    quarantined. An UNREADABLE file (e.g. EACCES) blocks persistence rather than
//    being overwritten with bytes we could not preserve.
//  • Each persist keeps a single-generation memory.json.bak of the last good file.
//  • Values AND source are scrubbed through redactString at WRITE time.
//  • Every file we write (store, bak, quarantine) is explicitly mode 0o600.
//  • Concurrent writers merge under a best-effort lockfile so interleaved
//    set()/delete() from two ProjectMemory instances lose no keys.

const MEMORY_FILE = join('.shadow', 'memory.json');
/** Owner-only perms for every file this store writes (store, bak, quarantine, lock). */
const MEMORY_MODE = 0o600;
/** A lock older than this is presumed abandoned (holder crashed) and may be stolen. */
const LOCK_STALE_MS = 5000;
/** Total time we wait for a live lock before proceeding unlocked (best-effort). */
const LOCK_WAIT_MS = 2000;
/** Poll interval while waiting for the lock. */
const LOCK_POLL_MS = 20;

/** F08-05: soft cap on index lines in the system prompt. */
export const MEMORY_INDEX_CAP = 40;
/** F08-05: per-fact value cap in the index — enough to recognize the fact, recall fetches the rest. */
const MEMORY_INDEX_VALUE_CHARS = 100;
/** Fact-key cap — bounds both the stored key and its rendered line (a 5k-char key would ride
 *  into every request's index forever; line-count caps alone never see it). */
export const MEMORY_KEY_MAX = 200;

/**
 * Flatten whitespace AND control characters to single spaces. `\s` alone misses U+0085 (NEL)
 * and the C0/C1 control blocks — an ESC sequence or NEL in a fact must not survive into the
 * system prompt (line-break spoofing / terminal mangling), so both values AND keys render
 * through this.
 */
function flatten(s: string): string {
  return s.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
}

/** Truncate at `max` chars without ever splitting a surrogate pair (no lone half in the prompt). */
function capPairSafe(flat: string, max: number): string {
  if (flat.length <= max) return flat;
  let cut = flat.slice(0, max);
  const last = cut.charCodeAt(max - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // trailing high surrogate — drop it
  return cut;
}

/** Flatten a fact value to one truncated line for the index. */
function oneLine(value: string): string {
  const flat = flatten(value);
  return flat.length > MEMORY_INDEX_VALUE_CHARS ? `${capPairSafe(flat, MEMORY_INDEX_VALUE_CHARS)}…` : flat;
}

/** One-line rendering of a KEY — keys are USER/MODEL data (they can carry '\n', '## ', ESC). */
function keyLabel(key: string): string {
  const flat = flatten(key);
  return flat.length > MEMORY_KEY_MAX ? `${capPairSafe(flat, MEMORY_KEY_MAX)}…` : flat;
}

/** Own-property assignment that also works for `__proto__` (plain `=` would hit the prototype
 *  setter and silently drop the fact). */
function setFact(facts: Record<string, string>, key: string, value: string): void {
  if (key === '__proto__') {
    Object.defineProperty(facts, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    facts[key] = value;
  }
}

export interface MemoryMetadata {
  author: 'user' | 'generated' | 'legacy';
  scope: 'workspace';
  source?: string;
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string;
}
export interface MemoryEntry extends MemoryMetadata { key: string; value: string }
export type MemoryWriteOptions = Partial<Pick<MemoryMetadata, 'author' | 'source' | 'reviewedAt'>>;

/** Outcome of reading the on-disk store. ENOENT ('missing') is NOT corruption. */
type StoreStatus = 'ok' | 'missing' | 'unreadable' | 'corrupt';
interface StoreRead {
  status: StoreStatus;
  facts: Record<string, string>;
  metadata: Map<string, MemoryMetadata>;
  /** Raw bytes, present only when status === 'corrupt' (for quarantine). */
  raw?: string;
}

/** Parse the on-disk envelope (v2 entries or legacy v1 string-map) into facts + metadata. */
function parseStore(raw: string): { facts: Record<string, string>; metadata: Map<string, MemoryMetadata> } {
  const facts: Record<string, string> = {};
  const metadata = new Map<string, MemoryMetadata>();
  const parsed: unknown = JSON.parse(raw);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const envelope = parsed as Record<string, unknown>;
    const versioned = envelope.version === 2 && envelope.entries && typeof envelope.entries === 'object' && !Array.isArray(envelope.entries);
    const entries = versioned ? envelope.entries as Record<string, unknown> : envelope;
    for (const [k, v] of Object.entries(entries)) {
      if (!versioned && typeof v === 'string') {
        setFact(facts, k, v);
        metadata.set(k, { author: 'legacy', scope: 'workspace', createdAt: '', updatedAt: '', source: 'legacy memory.json (origin unknown)' });
      } else if (versioned && v && typeof v === 'object') {
        const entry = v as Record<string, unknown>;
        if (typeof entry.value !== 'string') continue;
        setFact(facts, k, entry.value);
        metadata.set(k, {
          author: entry.author === 'user' || entry.author === 'generated' ? entry.author : 'legacy',
          scope: 'workspace',
          createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
          updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
          ...(typeof entry.source === 'string' ? { source: entry.source } : {}),
          ...(typeof entry.reviewedAt === 'string' ? { reviewedAt: entry.reviewedAt } : {}),
        });
      }
    }
  }
  return { facts, metadata };
}

/**
 * Read the store, distinguishing a MISSING file (ENOENT → not corruption) from an
 * UNREADABLE one (other fs error → do not overwrite bytes we could not read) from a
 * CORRUPT one (read OK but JSON.parse threw → quarantine the raw bytes).
 */
function readStore(filePath: string): StoreRead {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { status: 'missing', facts: {}, metadata: new Map() };
    return { status: 'unreadable', facts: {}, metadata: new Map() };
  }
  try {
    const { facts, metadata } = parseStore(raw);
    return { status: 'ok', facts, metadata };
  } catch {
    return { status: 'corrupt', facts: {}, metadata: new Map(), raw };
  }
}

/**
 * Preserve a corrupt store at `<filePath>.corrupt-<ISO>` (owner-only) BEFORE the caller
 * starts empty, then remove the original so later loads see a clean missing file.
 *
 * We reserve the quarantine name with O_EXCL ('wx') and write the raw bytes into it at
 * mode 0o600, rather than a bare rename: a POSIX rename would (a) clobber an existing
 * quarantine file and (b) carry over the corrupt file's possibly world-readable perms.
 * O_EXCL guarantees we NEVER overwrite an existing quarantine (collision → -1, -2, …)
 * and that the preserved bytes are owner-only. Best-effort: returns the quarantine path
 * on success, or null if the bytes could not be preserved (caller then refuses to write).
 */
function quarantineCorrupt(filePath: string, raw: string): string | null {
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  for (let i = 0; i < 1000; i++) {
    const target = `${filePath}.corrupt-${iso}${i === 0 ? '' : `-${i}`}`;
    try {
      // 'wx' = O_WRONLY|O_CREAT|O_EXCL: fails EEXIST if the name is taken (never clobber).
      writeFileSync(target, raw, { flag: 'wx', mode: MEMORY_MODE });
      // writeFileSync's create mode is umask-masked — force owner-only explicitly
      // (mirrors globalStore.ts). A chmod failure fails the quarantine closed: the
      // caller then refuses to overwrite the original rather than trust weak perms.
      chmodSync(target, MEMORY_MODE);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue; // same-ms collision → next suffix
      return null; // could not preserve the bytes — caller must not overwrite the original
    }
    // Bytes are preserved owner-only; drop the corrupt original so the next load is clean.
    try {
      unlinkSync(filePath);
    } catch {
      /* best-effort: bytes are already safe in the quarantine even if the original lingers */
    }
    return target;
  }
  return null;
}

/** Synchronous sleep that does not spin the CPU (same pattern as globalStore/endpoints store). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Best-effort exclusive lock around a read-merge-write. Acquires `<filePath>.lock` via
 * O_EXCL; a lock older than LOCK_STALE_MS is presumed abandoned and stolen. Waits up to
 * LOCK_WAIT_MS for a live lock, then proceeds UNLOCKED (best-effort — see known limits).
 * The lock file itself is owner-only. `fn` always runs exactly once; the lock is released
 * in finally even if fn throws.
 */
function withLock<T>(filePath: string, fn: () => T): T {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let acquired = false;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', MEMORY_MODE);
      try {
        writeFileSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      } catch (writeErr) {
        // openSync succeeded, so WE own this lock file. If filling it fails (ENOSPC,
        // EIO…), release our own orphan — the finally below only unlinks when
        // acquired === true, and an orphaned lock would stall every later writer.
        try {
          unlinkSync(lockPath);
        } catch {
          /* best-effort */
        }
        throw writeErr;
      } finally {
        closeSync(fd);
      }
      acquired = true;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') break; // can't lock here → proceed unlocked
      // Lock exists: steal it if stale, else wait and retry until the budget runs out.
      let stale = false;
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
      } catch {
        stale = true; // vanished between open and stat — treat as free
      }
      if (stale) {
        try {
          unlinkSync(lockPath);
        } catch {
          /* another writer may have stolen it first; loop and retry */
        }
        // Even the steal path must respect the wait budget: two writers can keep
        // re-creating a stale-looking lock for each other (double stale-steal) and
        // an unbounded continue would spin past the deadline forever.
        if (Date.now() >= deadline) break;
        continue;
      }
      if (Date.now() >= deadline) break; // budget exhausted → proceed unlocked
      sleepSync(LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    if (acquired) {
      try {
        unlinkSync(lockPath);
      } catch {
        /* best-effort release */
      }
    }
  }
}

export class ProjectMemory {
  /** Sticky one-shot warning (e.g. quarantine) surfaced via takeNotice(); refresh() never clobbers it with a clean load. */
  private pendingNotice: string | undefined;
  /** True when the on-disk bytes could not be read/preserved — persist() must not overwrite them. */
  private persistBlocked = false;
  /** Changes made by THIS instance since its last refresh, replayed onto fresh disk under the lock. null = deletion. */
  private readonly pending = new Map<string, { value: string; meta: MemoryMetadata } | null>();

  private constructor(
    private readonly filePath: string,
    private readonly facts: Record<string, string>,
    private readonly metadata: Map<string, MemoryMetadata>,
  ) {}

  /** Load from disk. A missing file starts empty silently; a corrupt file is quarantined
   *  (with a sticky notice) before starting empty; an unreadable file blocks persistence. */
  static load(workspaceRoot: string): ProjectMemory {
    const filePath = join(workspaceRoot, MEMORY_FILE);
    const read = readStore(filePath);
    const mem = new ProjectMemory(filePath, read.facts, read.metadata);
    if (read.status === 'corrupt') {
      const saved = quarantineCorrupt(filePath, read.raw ?? '');
      if (saved) {
        mem.pendingNotice = `memory.json was corrupt and could not be parsed; preserved the original at ${saved} and started a fresh store.`;
      } else {
        mem.persistBlocked = true;
        mem.pendingNotice = 'memory.json is corrupt and could not be quarantined; refusing to overwrite it. Fix or remove the file to resume saving memories.';
      }
    } else if (read.status === 'unreadable') {
      mem.persistBlocked = true;
      mem.pendingNotice = 'memory.json could not be read; refusing to overwrite it. Check file permissions to resume saving memories.';
    }
    return mem;
  }

  /** Consume the sticky warning (if any) so an explicit tool op surfaces it exactly once. */
  takeNotice(): string | undefined {
    const notice = this.pendingNotice;
    this.pendingNotice = undefined;
    return notice;
  }

  /** Read the sticky warning WITHOUT consuming it (11.6.0 adj1): the per-turn facts render
   *  surfaces it on EVERY provider request until an explicit memory op takes it — a corrupt
   *  store must not go silently unnoticed just because no memory tool call happened. */
  peekNotice(): string | undefined {
    return this.pendingNotice;
  }

  /** Slash commands and the model tool may hold separate stores in the same session. */
  private refresh(): void {
    const loaded = ProjectMemory.load(dirname(dirname(this.filePath)));
    for (const key of Object.keys(this.facts)) delete this.facts[key];
    for (const [key, value] of Object.entries(loaded.facts)) setFact(this.facts, key, value);
    this.metadata.clear();
    for (const [key, value] of loaded.metadata) this.metadata.set(key, value);
    // A later clean load must not erase a still-unconsumed quarantine warning.
    if (loaded.pendingNotice) this.pendingNotice = loaded.pendingNotice;
    this.persistBlocked = loaded.persistBlocked;
    // Disk just moved under us; our pending changes are relative to the NEW baseline.
    this.pending.clear();
  }

  get(key: string): string | undefined {
    this.refresh();
    // Own-property lookup only — without the guard, get('toString')/get('__proto__') would
    // return Object.prototype members (a function / the prototype), not a stored fact.
    if (!Object.prototype.hasOwnProperty.call(this.facts, key)) return undefined;
    return this.facts[key];
  }

  set(key: string, value: string, opts: MemoryWriteOptions = {}): void {
    this.refresh();
    // Keys are model/user-controlled and render into every future system prompt: sanitize at
    // WRITE time too (line breaks flattened, length capped) so a hostile key cannot fake new
    // index lines or `## ` sections. The render path sanitizes again for keys that arrive via
    // a hand-edited memory.json.
    const k = capPairSafe(flatten(key), MEMORY_KEY_MAX);
    if (!k) return; // nothing left after sanitizing — refuse rather than store a ghost key
    const previous = this.metadata.get(k);
    const now = new Date().toISOString();
    // Privacy: scrub secret shapes from the value AND source at WRITE time (keys are already
    // sanitized above). Best-effort shape matching — see util/redact.ts header.
    const safeValue = redactString(value);
    const safeSource = opts.source === undefined ? previous?.source : redactString(capPairSafe(flatten(opts.source), 500));
    const meta: MemoryMetadata = {
      author: opts.author ?? 'generated', scope: 'workspace',
      ...(safeSource === undefined ? {} : { source: safeSource }),
      createdAt: previous?.createdAt || now, updatedAt: now,
      ...(opts.reviewedAt ? { reviewedAt: opts.reviewedAt } : {}),
    };
    setFact(this.facts, k, safeValue);
    this.metadata.set(k, meta);
    this.pending.set(k, { value: safeValue, meta });
    this.persist();
  }

  delete(key: string): boolean {
    this.refresh();
    if (!Object.prototype.hasOwnProperty.call(this.facts, key)) return false;
    delete this.facts[key];
    this.metadata.delete(key);
    this.pending.set(key, null);
    this.persist();
    return true;
  }

  /** Full provenance is available without changing the legacy string-valued read API. */
  inspect(key: string): MemoryEntry | undefined {
    const value = this.get(key);
    const meta = this.metadata.get(key);
    return value === undefined || !meta ? undefined : { key, value, ...meta };
  }

  private entriesSnapshot(): MemoryEntry[] {
    return Object.keys(this.facts).map((key) => ({ key, value: this.facts[key]!, ...this.metadata.get(key)! }));
  }

  entries(): MemoryEntry[] {
    this.refresh();
    return this.entriesSnapshot();
  }

  /** Editing requires an existing key, so a typo cannot silently create a second memory. */
  update(key: string, value: string, opts: MemoryWriteOptions = {}): boolean {
    if (this.get(key) === undefined) return false;
    this.set(key, value, opts);
    return true;
  }

  /** Facts are stale when unreviewed since their last edit, or older than the supplied cutoff. */
  stale(before: string): MemoryEntry[] {
    return this.entries().filter((entry) => !entry.reviewedAt || entry.reviewedAt < entry.updatedAt || entry.reviewedAt < before);
  }

  /** A copy of all facts (callers cannot mutate the store through it). */
  all(): Record<string, string> {
    this.refresh();
    return { ...this.facts };
  }

  /** Render facts as a markdown bullet list for the system prompt, '' if empty. Keys render
   *  through the sanitizer (full values are this renderer's purpose, so they stay intact). */
  asContext(): string {
    this.refresh();
    const keys = Object.keys(this.facts);
    if (keys.length === 0) return '';
    return keys.map((k) => `- **${keyLabel(k)}**: ${this.facts[k]}`).join('\n');
  }

  /**
   * F08-05: one-line-per-fact INDEX for the system prompt — the model sees WHAT is remembered and
   * fetches full values on demand via the memory tool (recall). Full-value injection grows every
   * request linearly with every fact ever remembered; the index keeps the cost flat while recall
   * stays one tool call away. Soft-capped: beyond `cap` facts an overflow note points at
   * list/recall instead of silently dropping keys. '' if empty.
   */
  asIndex(cap: number = MEMORY_INDEX_CAP): string {
    this.refresh();
    const keys = Object.keys(this.facts);
    if (keys.length === 0) return '';
    // keyLabel on the KEY too — keys that arrived via a hand-edited memory.json (bypassing
    // set()) may still carry '\n'/ESC and would otherwise forge extra index lines or headings.
    const lines = keys.slice(0, cap).map((k) => `- ${keyLabel(k)}: ${oneLine(this.facts[k]!)}`);
    if (keys.length > cap) {
      lines.push(`… +${keys.length - cap} more — use the memory tool (action: list or recall)`);
    }
    return lines.join('\n');
  }

  /** Serialize facts + metadata to the v2 envelope. */
  private serialize(facts: Record<string, string>, metadata: Map<string, MemoryMetadata>): string {
    const entries = Object.fromEntries(
      Object.keys(facts).map((key) => [key, { value: facts[key]!, ...metadata.get(key)! }]),
    );
    return JSON.stringify({ version: 2, entries }, null, 2) + '\n';
  }

  /** Copy the current known-good on-disk file to memory.json.bak (owner-only, best-effort).
   *  A corrupt/unreadable current file is NOT backed up — quarantine handles corruption, and
   *  backing up bad bytes would defeat the .bak's purpose as a last-good restore point. */
  private backupPrevious(): void {
    try {
      const read = readStore(this.filePath);
      if (read.status !== 'ok') return;
      const raw = readFileSync(this.filePath, 'utf8');
      atomicWrite(`${this.filePath}.bak`, raw, MEMORY_MODE);
    } catch {
      /* best-effort: a failed backup must never block the write */
    }
  }

  /**
   * Persist under a best-effort lock: back up the last good file, re-read fresh disk, replay
   * THIS instance's pending changes onto it (so a concurrent writer's keys survive), and write
   * owner-only. Refuses to write when the on-disk bytes could not be read/preserved.
   */
  private persist(): void {
    if (this.persistBlocked) {
      this.pendingNotice = 'memory.json could not be read or quarantined; this change was NOT saved. Fix or remove the file to resume saving memories.';
      this.pending.clear();
      return;
    }
    withLock(this.filePath, () => {
      this.backupPrevious();
      const fresh = readStore(this.filePath);
      if (fresh.status === 'unreadable') {
        this.persistBlocked = true;
        this.pendingNotice = 'memory.json became unreadable; this change was NOT saved to avoid overwriting it.';
        this.pending.clear();
        return;
      }
      if (fresh.status === 'corrupt') {
        // The file was damaged externally between our refresh and this write (a concurrent
        // non-atomic editor, disk corruption). Preserve those bytes too — never overwrite
        // data we have not saved. If preservation fails, refuse the write entirely.
        const saved = quarantineCorrupt(this.filePath, fresh.raw ?? '');
        if (!saved) {
          this.persistBlocked = true;
          this.pendingNotice = 'memory.json became corrupt and could not be quarantined; this change was NOT saved to avoid overwriting it.';
          this.pending.clear();
          return;
        }
        this.pendingNotice = `memory.json became corrupt before this write; preserved the damaged file at ${saved}.`;
      }
      // Start from fresh disk (the shared truth) and replay our pending changes on top.
      const merged: Record<string, string> = fresh.status === 'ok' ? { ...fresh.facts } : {};
      const mergedMeta = new Map<string, MemoryMetadata>(fresh.status === 'ok' ? fresh.metadata : []);
      for (const [key, change] of this.pending) {
        if (change === null) {
          delete merged[key];
          mergedMeta.delete(key);
        } else {
          setFact(merged, key, change.value);
          mergedMeta.set(key, change.meta);
        }
      }
      atomicWrite(this.filePath, this.serialize(merged, mergedMeta), MEMORY_MODE);
      // Sync the in-memory cache to what actually landed on disk.
      for (const key of Object.keys(this.facts)) delete this.facts[key];
      for (const [key, value] of Object.entries(merged)) setFact(this.facts, key, value);
      this.metadata.clear();
      for (const [key, value] of mergedMeta) this.metadata.set(key, value);
      this.pending.clear();
    });
  }
}