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
  /** --profile <name>: activate a named profile from ~/.shadow/config.json (P2-11). */
  profile?: string;
  /** Provider-neutral harness add-ons selected for this new session. Repeatable/comma-separated. */
  harnesses?: string[];
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
  /** Machine output is opt-in; ordinary text output remains the default. */
  outputFormat?: 'text' | 'json' | 'jsonl';
  outputSchema?: string;
  /** Disable conversation journals and their sidecars for this one-shot run. */
  ephemeral?: boolean;
  repl?: boolean;
  screenReader?: boolean;
  reducedMotion?: boolean;
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

export const VALUE_TAKING_FLAGS: ReadonlySet<string> = new Set([
  '--web-port',
  '--system',
  '--autonomy',
  '--provider',
  '--model',
  '--base-url',
  '--effort',
  '--profile',
  '--harness',
  '--addon',
  '--max-output-tokens',
  '--max-iterations',
  '--context-budget',
  '--max-wall-sec',
  '--workspace',
  '--add-dir',
  '--log-level',
  '--task',
  '--output-format',
  '--output-schema',
  '--style',
]);

export function parseArgs(argv: string[]): Flags {
  const f: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    if (raw === '--') {
      const rest = argv.slice(i + 1);
      if (!rest.length) break;
      if (f.task !== undefined) throw new Error('arguments after -- conflict with --task');
      f.task = rest.join(' ');
      break;
    }
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const a = eq > 2 ? raw.slice(0, eq) : raw;
    let inline = eq > 2 ? raw.slice(eq + 1) : undefined;
    const next = (): string => {
      const value = inline !== undefined ? inline : argv[++i];
      inline = undefined;
      if (value === undefined || value === '' || /^-{1,2}[A-Za-z]/.test(value)) {
        throw new Error(`${a} requires a value`);
      }
      return value;
    };
    const noInlineValue = (): void => {
      if (inline !== undefined) throw new Error(`${a} does not take a value`);
    };
    switch (a) {
      case '--web':
        noInlineValue();
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
      case '--profile':
        f.profile = next();
        break;
      case '--harness':
      case '--addon': {
        const ids = next().split(',').map((id) => id.trim()).filter(Boolean);
        (f.harnesses ??= []).push(...ids);
        break;
      }
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
        noInlineValue();
        f.fast = true;
        break;
      case '--log-level':
        f.logLevel = next();
        break;
      case '--dry-run':
        noInlineValue();
        f.dryRun = true;
        break;
      case '--task':
        f.task = next();
        break;
      case '--output-format': {
        const format = next();
        if (!['text', 'json', 'jsonl'].includes(format)) throw new Error('--output-format must be text, json, or jsonl');
        f.outputFormat = format as Flags['outputFormat'];
        break;
      }
      case '--json':
        noInlineValue();
        f.outputFormat = 'jsonl';
        break;
      case '--output-schema':
        f.outputSchema = next();
        break;
      case '--ephemeral':
        noInlineValue();
        f.ephemeral = true;
        break;
      case '--repl':
        noInlineValue();
        f.repl = true;
        break;
      case '--screen-reader':
        noInlineValue();
        f.screenReader = true;
        break;
      case '--reduced-motion':
        noInlineValue();
        f.reducedMotion = true;
        break;
      case '--offline':
        noInlineValue();
        f.offline = true;
        break;
      case '--no-sandbox':
        noInlineValue();
        f.noSandbox = true;
        break;
      case '--style':
        f.style = next() as OutputStyle;
        break;
      case '--plan-mode':
        noInlineValue();
        f.planMode = true;
        break;
      case '--yolo':
      case '--nuke':
      case '--dangerously-skip-permissions':
        noInlineValue();
        f.yolo = true;
        break;
      case '-v':
      case '--version':
        noInlineValue();
        f.version = true;
        break;
      case '-h':
      case '--help':
        noInlineValue();
        f.help = true;
        break;
      default:
        throw new Error(`unknown option: ${raw}`);
    }
  }
  if (f.outputSchema && !f.outputFormat) f.outputFormat = 'json';
  if (f.outputSchema && f.outputFormat === 'text') throw new Error('--output-schema requires json or jsonl output');
  if (f.outputFormat && f.outputFormat !== 'text' && (f.repl || f.screenReader || f.web)) {
    throw new Error('machine output requires a one-shot task or piped input; --repl, --screen-reader, and --web are incompatible');
  }
  return f;
}
