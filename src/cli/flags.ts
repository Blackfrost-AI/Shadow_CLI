import { type AutonomyLevel } from '../safety/permissions.js';
import { type OutputStyle } from '../styles.js';

/** Parsed CLI flags for an interactive / one-shot `shadow` run. */
export interface Flags {
  system?: string;
  autonomy?: AutonomyLevel;
  provider?: string;
  model?: string;
  baseUrl?: string;
  effort?: string;
  maxOutputTokens?: number;
  maxIterations?: number;
  contextBudget?: number;
  maxWallSec?: number;
  workspace?: string;
  addDir?: string[];
  fast?: boolean;
  logLevel?: string;
  dryRun?: boolean;
  task?: string;
  repl?: boolean;
  yolo?: boolean;
  offline?: boolean;
  noSandbox?: boolean;
  style?: OutputStyle;
  planMode?: boolean;
  /** --web: also mirror this session to a loopback browser console (read-only). */
  web?: boolean;
  /** --web-port N: port for the mirror; 0/absent picks a free one. */
  webPort?: number;
  help?: boolean;
  version?: boolean;
}

export function parseArgs(argv: string[]): Flags {
  const f: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--web':
        f.web = true;
        break;
      case '--web-port':
        f.webPort = Number(next());
        f.web = true;
        break;
      case '--system':
        f.system = next();
        break;
      case '--autonomy':
        f.autonomy = next() as AutonomyLevel;
        break;
      case '--provider':
        f.provider = next();
        break;
      case '--model':
        f.model = next();
        break;
      case '--base-url':
        f.baseUrl = next();
        break;
      case '--effort':
        f.effort = next();
        break;
      case '--max-output-tokens':
        f.maxOutputTokens = Number(next());
        break;
      case '--max-iterations':
        f.maxIterations = Number(next());
        break;
      case '--context-budget':
        f.contextBudget = Number(next());
        break;
      case '--max-wall-sec':
        f.maxWallSec = Number(next());
        break;
      case '--workspace':
        f.workspace = next();
        break;
      case '--add-dir': {
        const d = next();
        if (d) (f.addDir ??= []).push(d);
        break;
      }
      case '--fast':
        f.fast = true;
        break;
      case '--log-level':
        f.logLevel = next();
        break;
      case '--dry-run':
        f.dryRun = true;
        break;
      case '--task':
        f.task = next();
        break;
      case '--repl':
        f.repl = true;
        break;
      case '--offline':
        f.offline = true;
        break;
      case '--no-sandbox':
        f.noSandbox = true;
        break;
      case '--style':
        f.style = next() as OutputStyle;
        break;
      case '--plan-mode':
        f.planMode = true;
        break;
      case '--yolo':
      case '--nuke':
      case '--dangerously-skip-permissions':
        f.yolo = true;
        break;
      case '-v':
      case '--version':
        f.version = true;
        break;
      case '-h':
      case '--help':
        f.help = true;
        break;
      default:
        break;
    }
  }
  return f;
}
