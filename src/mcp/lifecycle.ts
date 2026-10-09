import { randomUUID } from 'node:crypto';
import type { McpArtifactStore } from './artifacts.js';

export interface McpProgress {
  server: string; requestId: number; progressToken: string; tool: string;
  progress: number; total?: number; message?: string; lastActivityAt: number;
}
export interface McpCallEvent {
  server: string; requestId: number; progressToken: string; tool: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled'; startedAt: number; lastActivityAt: number;
}
export interface McpRuntimeOptions {
  onProgress?: (event: McpProgress) => void;
  onCallStart?: (event: McpCallEvent) => void;
  onCallEnd?: (event: McpCallEvent) => void;
  artifacts?: McpArtifactStore;
  /** Registration can be superseded by disable/reconnect while initialization is pending. */
  isActive?: () => boolean;
  onRegistered?: (server: string, name: string) => void;
}
const safe = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 300);

/** Tokens exist only for active requests; late/unknown/regressive progress is ignored. */
export class McpLifecycle {
  private readonly active = new Map<string, McpCallEvent & { progress: number }>();
  constructor(private readonly server: string, private readonly runtime: McpRuntimeOptions) {}
  start(requestId: number, tool: string): string {
    const progressToken = randomUUID();
    const now = Date.now();
    const call = { server: this.server, requestId, progressToken, tool, status: 'running' as const, startedAt: now, lastActivityAt: now, progress: -1 };
    this.active.set(progressToken, call);
    try { this.runtime.onCallStart?.({ ...call }); } catch { /* UI observers cannot break transport */ }
    return progressToken;
  }
  progress(params: unknown): void {
    if (!params || typeof params !== 'object') return;
    const p = params as Record<string, unknown>;
    if (typeof p.progressToken !== 'string') return;
    const call = this.active.get(p.progressToken);
    if (!call || typeof p.progress !== 'number' || !Number.isFinite(p.progress) || p.progress < 0 || p.progress <= call.progress) return;
    if (p.total !== undefined && (typeof p.total !== 'number' || !Number.isFinite(p.total) || p.total < p.progress)) return;
    call.progress = p.progress;
    call.lastActivityAt = Date.now();
    try { this.runtime.onProgress?.({ server: call.server, requestId: call.requestId, progressToken: call.progressToken, tool: call.tool,
      progress: call.progress, ...(typeof p.total === 'number' ? { total: p.total } : {}),
      ...(typeof p.message === 'string' ? { message: safe(p.message) } : {}), lastActivityAt: call.lastActivityAt }); }
    catch { /* observer failures do not affect a request */ }
  }
  finish(token: string | undefined, status: 'completed' | 'failed' | 'cancelled'): void {
    if (!token) return;
    const call = this.active.get(token);
    if (!call) return;
    this.active.delete(token);
    try { this.runtime.onCallEnd?.({ ...call, status, lastActivityAt: Date.now() }); } catch { /* observer */ }
  }
}

export function mcpCallDeadline(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(100, Math.min(600_000, value)) : 180_000;
}
