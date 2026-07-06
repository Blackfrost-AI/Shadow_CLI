export type LogLevel = 'silent' | 'error' | 'info' | 'debug';

const ORDER: Record<LogLevel, number> = { silent: 0, error: 1, info: 2, debug: 3 };

/**
 * Local-only structured logger. Writes JSON lines to stderr (never the network,
 * never stdout — stdout belongs to the REPL/HUD). No telemetry, ever.
 */
export class Logger {
  constructor(private readonly level: LogLevel = 'info') {}

  private should(l: Exclude<LogLevel, 'silent'>): boolean {
    return ORDER[this.level] >= ORDER[l];
  }

  private write(l: string, msg: string, meta?: Record<string, unknown>): void {
    const line = JSON.stringify({ t: new Date().toISOString(), level: l, msg, ...meta });
    process.stderr.write(line + '\n');
  }

  error(msg: string, meta?: Record<string, unknown>): void {
    if (this.should('error')) this.write('error', msg, meta);
  }
  info(msg: string, meta?: Record<string, unknown>): void {
    if (this.should('info')) this.write('info', msg, meta);
  }
  debug(msg: string, meta?: Record<string, unknown>): void {
    if (this.should('debug')) this.write('debug', msg, meta);
  }
}
