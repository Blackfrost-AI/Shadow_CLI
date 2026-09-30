import { chmodSync, closeSync, fstatSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { SessionLog } from './session.js';
import { WorkCenter, type WorkCenterSnapshot, type WorkItem } from '../app/workCenter.js';
import { redact } from '../util/redact.js';

const CHUNK = 64 * 1024;
const MARKER = Buffer.from('"kind":"work_center_snapshot"');
const NL = 0x0a;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const snapshotCache = new Map<string, { size: number; mtimeMs: number; snapshot: WorkCenterSnapshot | null }>();

function sidecarPath(sessionPath: string): string {
  return `${sessionPath}.work.json`;
}

function readSidecar(sessionPath: string): WorkCenterSnapshot | null {
  try {
    const raw = JSON.parse(readFileSync(sidecarPath(sessionPath), 'utf8')) as WorkCenterSnapshot;
    return raw?.version === 1 && Array.isArray(raw.items) ? raw : null;
  } catch {
    return null;
  }
}

export interface HistoricalWorkItem {
  sessionId: string;
  item: WorkItem;
}

function parseLine(line: Buffer): WorkCenterSnapshot | null {
  if (!line.includes(MARKER)) return null;
  try {
    const record = JSON.parse(line.toString('utf8')) as { kind?: string; data?: WorkCenterSnapshot };
    const snapshot = record.kind === 'work_center_snapshot' ? record.data : undefined;
    return snapshot?.version === 1 && Array.isArray(snapshot.items) ? snapshot : null;
  } catch {
    return null;
  }
}

/** Read the newest Work Center record without parsing the rest of a potentially large session. */
export function readLatestWorkCenterSnapshot(path: string): WorkCenterSnapshot | null {
  const sidecar = readSidecar(path);
  if (sidecar) return sidecar;
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    let pos = size;
    let pending = Buffer.alloc(0);
    while (pos > 0) {
      const amount = Math.min(CHUNK, pos);
      pos -= amount;
      const buf = Buffer.alloc(amount);
      readSync(fd, buf, 0, amount, pos);
      const combined = pending.length ? Buffer.concat([buf, pending]) : buf;
      let end = combined.length;
      let newline = combined.lastIndexOf(NL, end - 1);
      while (newline !== -1) {
        const snapshot = parseLine(combined.subarray(newline + 1, end));
        if (snapshot) return snapshot;
        end = newline;
        if (end === 0) break;
        newline = combined.lastIndexOf(NL, end - 1);
      }
      if (pos === 0) {
        const snapshot = parseLine(combined.subarray(0, end));
        if (snapshot) return snapshot;
      } else {
        // A malicious/torn no-newline record must not make the reverse scan grow without bound.
        pending = Buffer.from(combined.subarray(Math.max(0, end - MAX_RECORD_BYTES), end));
      }
    }
    return null;
  } finally {
    try { closeSync(fd); } catch { /* best effort */ }
  }
}

export function recordWorkCenterSnapshot(log: SessionLog, snapshot: WorkCenterSnapshot): void {
  const target = sidecarPath(log.path);
  const temp = `${target}.tmp-${process.pid}`;
  try {
    writeFileSync(temp, `${JSON.stringify(redact(snapshot))}\n`, { mode: 0o600 });
    renameSync(temp, target);
    try { chmodSync(target, 0o600); } catch { /* best effort */ }
  } catch (error) {
    log.lastError = error instanceof Error ? error.message : String(error);
    try { unlinkSync(temp); } catch { /* best effort */ }
  }
}

/** Newest snapshot per session, with bounded items and optional exact/suffix session selection. */
export function queryWorkHistory(workspaceRoot: string, session?: string): HistoricalWorkItem[] {
  const out: HistoricalWorkItem[] = [];
  for (const path of SessionLog.list(workspaceRoot)) {
    const sessionId = SessionLog.sessionIdFromPath(path);
    if (session && sessionId !== session && !sessionId.endsWith(session)) continue;
    let stat: { size: number; mtimeMs: number };
    try {
      const transcript = statSync(path);
      let sidecar = { size: 0, mtimeMs: 0 };
      try { sidecar = statSync(sidecarPath(path)); } catch { /* legacy log-only snapshot */ }
      stat = { size: transcript.size + sidecar.size, mtimeMs: Math.max(transcript.mtimeMs, sidecar.mtimeMs) };
    } catch { continue; }
    const cached = snapshotCache.get(path);
    const snapshot = cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs
      ? cached.snapshot
      : readLatestWorkCenterSnapshot(path);
    if (!cached || cached.size !== stat.size || cached.mtimeMs !== stat.mtimeMs) {
      snapshotCache.set(path, { ...stat, snapshot });
      if (snapshotCache.size > 256) snapshotCache.delete(snapshotCache.keys().next().value as string);
    }
    if (!snapshot) continue;
    const sanitized = new WorkCenter();
    sanitized.restore(snapshot);
    for (const item of sanitized.list().slice(0, 1000)) out.push({ sessionId, item });
  }
  return out;
}
