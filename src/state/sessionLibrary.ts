import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { resolveWithin } from '../safety/workspaceJail.js';

export interface SessionLibraryProject {
  path: string;
  sessionDir: string;
  current: boolean;
  workspaceKnown: boolean;
}

export interface LibrarySession {
  path: string;
  id: string;
  title: string;
  projectRoot: string | null;
  sessionDir: string;
  modifiedAt: number;
  pinned: boolean;
  tags: string[];
  snippet: string;
  match?: { timestamp?: string; byteOffset: number; kind: string };
  lineage?: { kind: 'forked_from' | 'resumed_from'; parentId: string; parentPath?: string };
  /** A snapshot marker was observed. Actual resume still authenticates the saved snapshot. */
  resumable: boolean;
  truncated: boolean;
  canResumeHere: boolean;
  navigation: { workspaceRoot?: string; sessionPath: string; command: string };
}

export interface SessionLibrarySearch {
  sessions: LibrarySession[];
  notices: string[];
  scannedFiles: number;
  scannedBytes: number;
  truncated: boolean;
}

export interface SessionLibraryLimits {
  maxFiles: number;
  maxDirectoryEntries: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxLineBytes: number;
}
const DEFAULT_LIMITS: SessionLibraryLimits = { maxFiles: 1000, maxDirectoryEntries: 3000,
  maxFileBytes: 4 * 1024 * 1024, maxTotalBytes: 24 * 1024 * 1024, maxLineBytes: 1024 * 1024 };
const quote = (value: string): string => `'${value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`;
function navigationCommand(workspace: string | undefined, session: string): string {
  const resume = `shadow resume --session ${quote(session)}`;
  if (!workspace) return resume;
  // Windows PowerShell 5.1 has no &&; require a successful location change so a
  // pasted command cannot resume a foreign session in the previous workspace.
  return process.platform === 'win32'
    ? `if (Set-Location -LiteralPath ${quote(workspace)} -PassThru -ErrorAction Stop) { ${resume} }`
    : `cd ${quote(workspace)} && ${resume}`;
}
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const cleanSnippet = (value: string): string => value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
const canonicalProject = (value: string): string => {
  const path = realpathSync(resolve(value));
  if (!statSync(path).isDirectory()) throw new Error('A session project must be a directory.');
  return path;
};

/** Return complete JSONL records from bounded head/tail reads. No transcript copies persist. */
function readWindows(fd: number, size: number, limit: number): { windows: Array<{ text: string; offset: number }>; bytes: number } {
  const spans = size <= limit ? [{ start: 0, count: size }] : [
    { start: 0, count: Math.floor(limit / 2) }, { start: size - Math.ceil(limit / 2), count: Math.ceil(limit / 2) },
  ];
  const windows: Array<{ text: string; offset: number }> = [];
  let bytes = 0;
  for (const { start, count } of spans) {
    const buffer = Buffer.alloc(count);
    const read = readSync(fd, buffer, 0, count, start); bytes += read;
    const data = buffer.subarray(0, read);
    const first = start ? data.indexOf(0x0a) + 1 : 0;
    const last = data.lastIndexOf(0x0a);
    if ((start && first === 0) || last < first) continue;
    windows.push({ text: data.subarray(first, last + 1).toString('utf8'), offset: start + first });
  }
  return { windows, bytes };
}

function transcriptText(record: Record<string, unknown>): string {
  if (record.kind === 'user' || (record.kind === 'event' && record.type === 'user')) return string(record.task) || string(record.text);
  if (record.kind === 'event' && ['assistant_done', 'reasoning_done', 'task_notification', 'error'].includes(string(record.type))) return string(record.text) || string(record.answer) || string(record.message);
  if (record.kind === 'event' && record.type === 'tool_end') {
    const result = record.result as Record<string, unknown> | undefined;
    if (result && typeof result === 'object') return [string(result.summary), result.data === undefined ? '' : JSON.stringify(result.data), result.error === undefined ? '' : JSON.stringify(result.error)].join('\n');
  }
  return '';
}

/** A local, opt-in project catalog. SQLite stores roots and user metadata only, never transcript text. */
export class SessionLibrary {
  readonly path: string;
  readonly currentWorkspace: string;
  private readonly db: DatabaseSync;
  private readonly limits: SessionLibraryLimits;
  private readonly override: string | undefined;
  private includeCurrent = true;

  constructor(workspaceRoot: string, options: { stateDir?: string; sessionDirOverride?: string | null; limits?: Partial<SessionLibraryLimits> } = {}) {
    this.currentWorkspace = canonicalProject(workspaceRoot);
    const dir = resolve(options.stateDir ?? join(homedir(), '.shadow'));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, 'session-library.sqlite');
    if (existsSync(this.path) && lstatSync(this.path).isSymbolicLink()) throw new Error('Refusing a symlinked session library database.');
    this.db = new DatabaseSync(this.path); chmodSync(this.path, 0o600);
    this.db.exec('PRAGMA busy_timeout=5000;');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 1) { this.db.close(); throw new Error(`Session library schema ${version} is newer than this Shadow build.`); }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS projects (path TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS session_metadata (path TEXT PRIMARY KEY, project_root TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '[]');
      PRAGMA user_version=1;`);
    for (const suffix of ['-wal', '-shm']) { try { chmodSync(this.path + suffix, 0o600); } catch { /* SQLite creates these lazily. */ } }
    const override = options.sessionDirOverride === undefined ? process.env.SHADOW_SESSION_DIR?.trim() : options.sessionDirOverride;
    this.override = override ? resolve(override, 'sessions') : undefined;
    this.limits = { ...DEFAULT_LIMITS };
    for (const key of Object.keys(DEFAULT_LIMITS) as Array<keyof SessionLibraryLimits>) {
      const value = options.limits?.[key];
      if (value !== undefined && Number.isInteger(value) && value > 0) this.limits[key] = Math.min(DEFAULT_LIMITS[key], value);
    }
  }

  close(): void { this.db.close(); }

  projects(): SessionLibraryProject[] {
    const paths = (this.db.prepare('SELECT path FROM projects ORDER BY path').all() as { path: string }[]).map((row) => row.path);
    if (this.includeCurrent && !paths.includes(this.currentWorkspace)) paths.unshift(this.currentWorkspace);
    return paths.map((path) => ({ path, current: path === this.currentWorkspace,
      sessionDir: path === this.currentWorkspace && this.override ? this.override : join(path, '.shadow', 'sessions'),
      workspaceKnown: !(path === this.currentWorkspace && this.override),
    }));
  }

  addProject(path: string): void {
    const root = canonicalProject(path);
    if (this.projects().length >= 32 && !this.projects().some((project) => project.path === root)) throw new Error('Session library supports up to 32 explicitly selected projects. Remove one first.');
    this.db.prepare('INSERT OR IGNORE INTO projects(path) VALUES (?)').run(root);
    if (root === this.currentWorkspace) this.includeCurrent = true;
  }

  removeProject(path: string): void {
    // A removed/moved project must still be removable from the catalog.
    let root = resolve(path); try { root = realpathSync(root); } catch { /* retain saved spelling */ }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM projects WHERE path=?').run(root);
      this.db.prepare('DELETE FROM session_metadata WHERE project_root=?').run(root);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    if (root === this.currentWorkspace) this.includeCurrent = false;
  }

  private selectedSession(path: string): { path: string; project: SessionLibraryProject } {
    // Canonicalize parent aliases (/var vs /private/var on macOS), preserving the final
    // component so lstat can still reject a symlink masquerading as a session file.
    const absolute = join(realpathSync(dirname(resolve(path))), basename(path));
    for (const project of this.projects()) {
      let directory: string;
      try { directory = project.workspaceKnown ? resolveWithin(project.path, '.shadow/sessions') : realpathSync(project.sessionDir); }
      catch { continue; }
      if (resolve(join(directory, basename(absolute))) !== absolute || !absolute.endsWith('.jsonl')) continue;
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Session metadata requires a regular session file.');
      return { path: absolute, project };
    }
    throw new Error('Session is not in a selected project store.');
  }

  setPinned(path: string, pinned: boolean): void {
    const session = this.selectedSession(path);
    this.db.prepare(`INSERT INTO session_metadata(path,project_root,pinned) VALUES (?,?,?)
      ON CONFLICT(path) DO UPDATE SET pinned=excluded.pinned,project_root=excluded.project_root`).run(session.path, session.project.path, pinned ? 1 : 0);
  }

  setTags(path: string, tags: string[]): void {
    const normalized = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
    if (normalized.length > 20 || normalized.some((tag) => tag.length > 64 || /[\x00-\x1f\x7f]/.test(tag))) throw new Error('Use up to 20 tags, at most 64 characters each, without control characters.');
    const session = this.selectedSession(path);
    this.db.prepare(`INSERT INTO session_metadata(path,project_root,tags) VALUES (?,?,?)
      ON CONFLICT(path) DO UPDATE SET tags=excluded.tags,project_root=excluded.project_root`).run(session.path, session.project.path, JSON.stringify(normalized));
  }

  async search(query = '', options: { limit?: number; pinnedOnly?: boolean; tag?: string; signal?: AbortSignal } = {}): Promise<SessionLibrarySearch> {
    const needle = query.trim().toLocaleLowerCase();
    if (needle.length > 2000) throw new Error('Session search is limited to 2,000 characters.');
    const limit = Math.max(1, Math.min(100, options.limit ?? 50));
    const result: SessionLibrarySearch = { sessions: [], notices: [], scannedFiles: 0, scannedBytes: 0, truncated: false };
    const seenStores = new Set<string>();
    const metadata = new Map((this.db.prepare('SELECT path,pinned,tags FROM session_metadata').all() as { path: string; pinned: number; tags: string }[]).map((row) => [row.path, row]));
    let invalid = 0;
    for (const project of this.projects()) {
      options.signal?.throwIfAborted();
      if (result.scannedFiles >= this.limits.maxFiles || result.scannedBytes >= this.limits.maxTotalBytes) {
        result.notices.push('Search limit reached; some selected projects or sessions were not searched.'); result.truncated = true; break;
      }
      let directory: string;
      try {
        directory = project.workspaceKnown ? resolveWithin(project.path, '.shadow/sessions') : realpathSync(project.sessionDir);
        const identity = realpathSync(directory);
        if (project.workspaceKnown) resolveWithin(project.path, identity);
        if (seenStores.has(identity)) { result.notices.push(`Duplicate session store omitted: ${directory}`); continue; }
        seenStores.add(identity);
        directory = identity;
      } catch { result.notices.push(`Session store unavailable or outside its selected project: ${project.sessionDir}`); continue; }
      if (!project.workspaceKnown) result.notices.push('SHADOW_SESSION_DIR is searched once as a shared store; its sessions have unknown workspace ownership and cannot be resumed in place from this view.');
      const names: string[] = [];
      try {
        let count = 0;
        for await (const entry of await opendir(directory)) {
          if (++count > this.limits.maxDirectoryEntries) { result.notices.push(`Directory entry limit reached: ${directory}`); result.truncated = true; break; }
          if (entry.isFile() && entry.name.endsWith('.jsonl')) names.push(entry.name);
        }
      } catch { result.notices.push(`Cannot read session store: ${directory}`); continue; }
      names.sort((a, b) => {
        const aPin = metadata.get(join(directory, a))?.pinned ?? 0;
        const bPin = metadata.get(join(directory, b))?.pinned ?? 0;
        return bPin - aPin || b.localeCompare(a);
      });
      for (const name of names) {
        options.signal?.throwIfAborted();
        if (result.scannedFiles >= this.limits.maxFiles || result.scannedBytes >= this.limits.maxTotalBytes) {
          result.truncated = true; result.notices.push(`Session/byte limit reached in ${directory}; older sessions were omitted.`); break;
        }
        const path = join(directory, name);
        const userMetadata = metadata.get(path);
        const pinned = !!userMetadata?.pinned;
        let tags: string[] = [];
        try { const value: unknown = JSON.parse(userMetadata?.tags ?? '[]'); if (Array.isArray(value)) tags = value.filter((tag): tag is string => typeof tag === 'string'); } catch { /* corrupt metadata does not block transcript access */ }
        if ((options.pinnedOnly && !pinned) || (options.tag && !tags.includes(options.tag))) continue;
        let fd: number | undefined;
        try {
          fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          const st = fstatSync(fd); if (!st.isFile()) continue;
          const allowance = Math.min(this.limits.maxFileBytes, this.limits.maxTotalBytes - result.scannedBytes);
          const { windows, bytes } = readWindows(fd, st.size, allowance);
          result.scannedFiles++; result.scannedBytes += bytes;
          const session: LibrarySession = { path, id: name.slice(0, -6), title: 'Untitled session', projectRoot: project.workspaceKnown ? project.path : null,
            sessionDir: directory, modifiedAt: st.mtimeMs, pinned, tags, snippet: '', resumable: false, truncated: st.size > bytes,
            canResumeHere: project.workspaceKnown && project.path === this.currentWorkspace,
            navigation: { workspaceRoot: project.workspaceKnown ? project.path : undefined, sessionPath: path,
              command: navigationCommand(project.workspaceKnown ? project.path : undefined, path) },
          };
          let titleExplicit = false;
          let firstUser = false;
          let matching = !needle;
          for (const window of windows) {
            let offset = window.offset;
            for (const line of window.text.split('\n')) {
              const at = offset; offset += Buffer.byteLength(line) + 1;
              if (!line.trim()) continue;
              // Large snapshot payloads are never decoded or indexed; they duplicate the transcript.
              if (/"kind"\s*:\s*"context_snapshot"/.test(line.slice(0, 4096))) { session.resumable = true; continue; }
              if (Buffer.byteLength(line) > this.limits.maxLineBytes) { session.truncated = true; continue; }
              let record: Record<string, unknown>;
              try { const value: unknown = JSON.parse(line); if (!value || typeof value !== 'object' || Array.isArray(value)) { invalid++; continue; } record = value as Record<string, unknown>; }
              catch { invalid++; continue; }
              if (record.kind === 'session_title' && string(record.title).trim()) { session.title = cleanSnippet(string(record.title)).slice(0, 160); titleExplicit = true; }
              if ((record.kind === 'user' || (record.kind === 'event' && record.type === 'user')) && !firstUser) {
                firstUser = true;
                if (!titleExplicit) session.title = cleanSnippet(string(record.sessionTitle) || string(record.task) || string(record.text)).slice(0, 160) || session.title;
              }
              if (record.kind === 'forked_from' || record.kind === 'resumed_from') session.lineage = {
                kind: record.kind, parentId: string(record.sessionId).slice(0, 200), parentPath: string(record.path) || undefined,
              };
              const text = transcriptText(record);
              if (!text) continue;
              const match = needle ? text.toLocaleLowerCase().indexOf(needle) : -1;
              if (match >= 0) {
                matching = true;
                if (!session.match) {
                  const start = Math.max(0, match - 70);
                  session.snippet = `${start ? '…' : ''}${cleanSnippet(text.slice(start, start + 240))}${text.length > start + 240 ? '…' : ''}`;
                  session.match = { timestamp: string(record.ts) || undefined, byteOffset: at, kind: string(record.type) || string(record.kind) };
                }
              } else if (!needle && !session.snippet) session.snippet = cleanSnippet(text).slice(0, 240);
            }
          }
          if (session.truncated) { result.truncated = true; result.notices.push(`Bounded scan of ${name}: omitted middle bytes or oversized records; matches may be missing.`); }
          if (matching || `${session.id}\n${session.title}\n${tags.join('\n')}`.toLocaleLowerCase().includes(needle)) result.sessions.push(session);
        } catch { result.notices.push(`Unreadable session skipped: ${name}`); result.truncated = true; }
        finally { if (fd !== undefined) closeSync(fd); }
        await new Promise<void>((done) => setImmediate(done));
      }
    }
    result.sessions.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path));
    if (result.sessions.length > limit) { result.notices.push(`Showing ${limit} matching sessions; ${result.sessions.length - limit} additional matches omitted.`); result.truncated = true; result.sessions = result.sessions.slice(0, limit); }
    if (invalid) { result.notices.push(`${invalid} malformed JSONL record(s) skipped.`); result.truncated = true; }
    result.notices.push('Search covers recorded user messages, committed answers/reasoning, and tool output. Snapshot copies, raw provider frames, and unfinished streaming fragments are not indexed.');
    result.notices = [...new Set(result.notices)];
    if (result.notices.length > 30) result.notices = [...result.notices.slice(0, 29), `${result.notices.length - 29} further scan notices omitted; search coverage is incomplete.`];
    return result;
  }
}
