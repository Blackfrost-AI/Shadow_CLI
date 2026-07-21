import { createAgentSession } from '../agent/bootstrap.js';
import { ensureLocalServer, isLocalServedEntry } from '../gguf.js';
import { redactString } from '../util/redact.js';
import { stripAnsi } from '../util/lc.js';
import type { ShadowConfig } from '../config.js';
import type { Flags } from '../cli/flags.js';
import { resolveJail } from './projects.js';
import { SessionStartupError, type AgentBuilder, type WebSession } from './registry.js';

/**
 * The real `AgentBuilder` for browser sessions — the ONLY web file that imports bootstrap.ts.
 * Built lazily on the first prompt (see the registry), so `shadow web` boots instantly and a
 * locked vault or misconfigured provider fails THIS session, not the server.
 *
 * Three things the boot snapshot buys (§8 Q3): the mcpServers + model presets are captured at
 * server start, never re-read from disk at build time, so a `POST /api/mcp` between boot and the
 * first prompt cannot inject a spawn command into this build. The allowlist (resolveJail) is the
 * one thing read FRESH every build — a revocation must take effect immediately (no TOCTOU) — and
 * credentials resolve live inside createAgentSession, so one vault unlock in the UI unblocks every
 * pending session.
 */
export function makeAgentBuilder(deps: { bootConfig: ShadowConfig; installDir: string }): AgentBuilder {
  return async (session: WebSession) => {
    // FRESH allowlist re-read: throws if the project was removed since create(). Returns the
    // frozen, realpath-pinned jail that must reach buildLoopDeps (never session.displayPath).
    const jail = resolveJail(session.displayPath);

    const chosenModel = session.model() || deps.bootConfig.model;
    // Boot snapshot for everything except the model choice. NEVER a fresh loadConfig here.
    const cfg: ShadowConfig = { ...deps.bootConfig, model: chosenModel };

    // Route startup notices onto THIS session's bus (the stream redacts at the wire).
    const notice = (s: string): void => {
      const msg = stripAnsi(s).trim();
      if (msg) session.bus.emit({ type: 'finding', title: 'startup', body: msg, severity: 'info' });
    };
    // fail THROWS (never process.exit) so the server, the config UI and every other session keep
    // serving. The `(m) => never` annotation is written on the variable because TS only narrows
    // past a never-returning call when the type is spelled out.
    const fail: (message: string) => never = (message) => {
      throw new SessionStartupError(redactString(stripAnsi(message).trim()));
    };

    // Web sessions never widen the jail: unrestricted stays false and no resolveUnrestricted /
    // fs-root push is on this path (trap #6). All Flags are optional; the security-relevant ones
    // are pinned off explicitly.
    const webFlags: Flags = { yolo: false, noSandbox: false, offline: false };

    const agent = await createAgentSession({
      cfg,
      flags: webFlags,
      installDir: deps.installDir,
      cwd: jail.workspaceRoot,
      workspaceRoot: jail.workspaceRoot,
      additionalRoots: [...jail.additionalRoots],
      activeStyle: cfg.style,
      unrestricted: false,
      write: notice,
      fail,
      sessionId: session.id,
      // Non-interactive local-model launch: no brew/TTY prompt behind a browser. A throw
      // propagates out as a startup failure (see the §5 caveat: a throw AFTER the server starts
      // leaves a gguf server in the module map that this session's close() can't reach — the
      // process-lifetime stopGgufServers cleans it up).
      launchLocalServer: async (entry, offline) => {
        if (!isLocalServedEntry(entry)) return null;
        const r = await ensureLocalServer(entry!, notice, { offline });
        return {
          provider: 'openai',
          baseUrl: r.baseUrl,
          apiKey: entry!.apiKey ?? 'sk-local',
          ctxWindow: entry!.ctx ?? 32_768,
        };
      },
    });

    // connectMcp's FIRST production consumer (dead code until now). Uses the snapshot config, so
    // the servers are the boot set — never whatever a later POST /api/mcp wrote.
    const mcp = await agent.connectMcp();

    return { agent, mcp, jail };
  };
}
