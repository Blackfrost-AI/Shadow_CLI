import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface TmuxPane {
  sessionId: string;
  session: string;
  window: string;
  windowIndex: number;
  id: string;
  index: number;
  command: string;
  pid: number;
  active: boolean;
}

const FORMAT = '#{session_id}\t#{session_name}\t#{window_name}\t#{window_index}\t#{pane_id}\t#{pane_index}\t#{pane_current_command}\t#{pane_pid}\t#{pane_active}';
export function parseTmuxPanes(text: string): TmuxPane[] {
  return text.trimEnd().split('\n').flatMap((line) => {
    const [sessionId, session, window, wi, id, pi, command, pid, active, ...extra] = line.split('\t');
    if (extra.length || !/^\$\d+$/.test(sessionId ?? '') || !/^%\d+$/.test(id ?? '') ||
        !/^\d+$/.test(pid ?? '') || !/^\d+$/.test(wi ?? '') || !/^\d+$/.test(pi ?? '') || !session || !command) return [];
    return [{ sessionId: sessionId!, session, window: window ?? '', windowIndex: Number(wi), id: id!, index: Number(pi), command,
      pid: Number(pid), active: active === '1' }];
  });
}

export function isCodexPane(pane: TmuxPane): boolean {
  return /^(?:codex|codex-cli)(?:\.exe)?$/i.test(pane.command.split(/[\\/]/).pop() ?? '');
}

export interface TmuxConnection {
  list(): Promise<TmuxPane[]>;
  capture(pane: TmuxPane): Promise<string>;
  send(pane: TmuxPane, text: string): Promise<void>;
  keys(pane: TmuxPane, data: string): Promise<void>;
}

/** Human-operated local terminal bridge. No model tools, network access, or agent restarts. */
export class TmuxClient implements TmuxConnection {
  private pending: Promise<unknown> = Promise.resolve();
  private inventory: { until: number; value: TmuxPane[] } | undefined;
  private listing: Promise<TmuxPane[]> | undefined;
  constructor(private options: { socket?: string; executable?: string; timeoutMs?: number } = {}) {}

  private run(args: string[], input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.executable ?? 'tmux', [...(this.options.socket ? ['-S', this.options.socket] : []), ...args],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const chunks: Buffer[] = []; let bytes = 0; let errorText = ''; let failure: Error | undefined;
      const timer = setTimeout(() => { failure = new Error('tmux did not respond. Reconnect to retry.'); child.kill(); }, this.options.timeoutMs ?? 3000);
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) { failure = new Error('tmux output is too large to display.'); child.kill(); }
        else chunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => { errorText = (errorText + chunk.toString()).slice(0, 2000); });
      child.on('error', (error: NodeJS.ErrnoException) => {
        failure = new Error(error.code === 'ENOENT' ? 'tmux is not installed or is not on PATH.' : error.message);
      });
      child.stdin.on('error', () => {}); // early process exit is reported by close
      child.on('close', (code) => {
        clearTimeout(timer);
        if (failure || code !== 0) reject(failure ?? new Error(errorText.trim() || `tmux exited ${code}`));
        else resolve(Buffer.concat(chunks).toString('utf8'));
      });
      child.stdin.end(input);
    });
  }

  async list(): Promise<TmuxPane[]> {
    if (this.inventory && this.inventory.until > Date.now()) return this.inventory.value;
    if (this.listing) return this.listing;
    this.listing = this.discover();
    try {
      const value = await this.listing;
      this.inventory = { until: Date.now() + 1000, value };
      return value;
    } finally { this.listing = undefined; }
  }

  private async discover(): Promise<TmuxPane[]> {
    try { return parseTmuxPanes(await this.run(['list-panes', '-a', '-F', FORMAT])); }
    catch (error) {
      if (/no server running|no sessions|error connecting to .*No such file/i.test((error as Error).message)) return [];
      throw error;
    }
  }

  private async verify(pane: TmuxPane, write = false): Promise<void> {
    const current = parseTmuxPanes(await this.run(['display-message', '-p', '-t', pane.id, FORMAT]))[0];
    if (!current || current.id !== pane.id || current.pid !== pane.pid || current.sessionId !== pane.sessionId) {
      throw new Error('The selected pane has changed or closed. Reconnect with /tmux.');
    }
    if ((write || isCodexPane(pane)) && !isCodexPane(current)) throw new Error('Codex is no longer running in this pane. Input was not sent.');
  }

  async capture(pane: TmuxPane): Promise<string> {
    await this.verify(pane);
    // Joined soft wraps can be reflowed to Shadow's width without resizing the live agent.
    const text = await this.run(['capture-pane', '-p', '-J', '-S', '-50000', '-t', pane.id]);
    return text.length > 1_500_000 ? '[Showing the most recent terminal history.]\n' + text.slice(-1_500_000) : text;
  }

  private serialize(work: () => Promise<void>): Promise<void> {
    const next = this.pending.then(work);
    this.pending = next.catch(() => {});
    return next;
  }

  send(pane: TmuxPane, text: string): Promise<void> {
    return this.serialize(async () => {
      if (!text.trim()) return;
      if (Buffer.byteLength(text) > 128_000 || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text)) {
        throw new Error('Message is too large or contains terminal control characters.');
      }
      await this.verify(pane, true);
      if ((await this.run(['display-message', '-p', '-t', pane.id, '#{pane_in_mode}'])).trim() === '1') {
        throw new Error('tmux copy mode is open. Use F2, then q to leave copy mode, then F2 to return to the composer.');
      }
      const buffer = `shadow-${randomUUID()}`;
      let pasted = false;
      try {
        await this.run(['load-buffer', '-b', buffer, '-'], text);
        await this.verify(pane, true);
        await this.run(['paste-buffer', '-p', '-r', '-d', '-b', buffer, '-t', pane.id]);
        pasted = true;
        // Codex distinguishes paste bursts from submit. Enter must arrive after the paste.
        await new Promise((resolve) => setTimeout(resolve, 200));
        await this.verify(pane, true);
        await this.run(['send-keys', '-t', pane.id, 'Enter']);
      } catch (error) {
        if (pasted) throw new Error('Text reached the Codex composer but submission could not be confirmed. Check the pane before resending.');
        throw error;
      } finally {
        // Only our unique transient buffer; never touch the user's clipboard or other buffers.
        await this.run(['delete-buffer', '-b', buffer]).catch(() => {});
      }
    });
  }

  keys(pane: TmuxPane, data: string): Promise<void> {
    return this.serialize(async () => {
      if (!data || Buffer.byteLength(data) > 4096) throw new Error('Key input is too large; use the message composer for pastes.');
      await this.verify(pane, true);
      await this.run(['send-keys', '-H', '-t', pane.id, ...Array.from(Buffer.from(data), (byte) => byte.toString(16).padStart(2, '0'))]);
    });
  }
}
