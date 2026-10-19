/**
 * `shadow corpus` — the user-facing surface for local training-data capture.
 *
 * Design constraint that shapes every choice here: **the user owns the data and the machine.**
 * Shadow ships the tool, not a dataset. Nothing in this file opens a network socket, and
 * nothing leaves the workspace unless the user explicitly runs `export` and takes the file.
 *
 * Three safety properties matter more than features:
 *
 *  1. **Capture is an explicit, enforced consent gate.** `on` writes a per-workspace opt-in;
 *     `export` and `stats` refuse to read session logs without it. A user who never ran
 *     `shadow corpus on` gets nothing built from their work, including the checkout they were
 *     merely passing through.
 *  2. **Export is reviewed before it is trusted.** `--review` writes to a staging directory and
 *     prints exactly which redaction patterns fired, so a user can look before shipping.
 *  3. **Capture is retroactive, and we say so.** Session logs already exist on disk; enabling
 *     capture projects them. Saying "on" does not mean "from now on" — it means "these too".
 */
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SessionLog } from '../state/session.js';
import {
  CORPUS_SCHEMA,
  REDACTION_VERSION,
  buildRecords,
  corpusDir,
  dedupe,
  readCorpusConfig,
  stats,
  workspaceBucket,
  writeCorpusConfig,
} from '../state/corpus.js';

export const CORPUS_USAGE = `shadow corpus — capture your own sessions as training data (local only)

  shadow corpus on                 Enable capture for this workspace (opt-in)
  shadow corpus off                Disable capture for this workspace
  shadow corpus status             Show whether capture is on, and where the corpus lives
  shadow corpus export [options]   Build a redacted, deduped, split dataset
  shadow corpus stats              Summarize what an export would contain

Export options:
  --out <dir>        Output directory (default: <corpus>/export)
  --review           Stage to <corpus>/review and print a redaction report
  --min-score <n>    Drop examples below this quality score (0..1, default 0)
  --label <l>        Keep only gold | negative | neutral
  --include-neutral  Include neutral examples (excluded by default)

Nothing here contacts a network. Shadow collects no data of its own; this is a tool you run
on your own machine, and the output is yours.`;

function fmtCounts(map: Record<string, number>): string {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return '  (none)';
  return entries.map(([k, v]) => `  ${k.padEnd(20)} ${v}`).join('\n');
}

/** `shadow corpus on|off|status` — config-only, no session reading. */
async function cmdConfig(sub: 'on' | 'off' | 'status', workspace: string): Promise<void> {
  const cfg = readCorpusConfig(workspace);

  if (sub === 'on') {
    await writeCorpusConfig(workspace, {
      enabled: true,
      enabledAt: new Date().toISOString(),
      redactionVersion: REDACTION_VERSION,
      schema: CORPUS_SCHEMA,
    });
    process.stdout.write(
      `Capture enabled for ${workspace}\n` +
        `  config:  ${join(workspace, '.shadow', 'corpus.json')}\n` +
        `  corpus:  ${corpusDir(workspace)}\n` +
        `\nCapture is retroactive: export projects the session logs already in this workspace,\n` +
        `not just future ones. Nothing is written until you run \`shadow corpus export\`.\n` +
        `Use \`--review\` to inspect what would leave the machine before it does.\n`,
    );
    return;
  }

  if (sub === 'off') {
    await writeCorpusConfig(workspace, {
      enabled: false,
      ...(cfg.enabledAt ? { enabledAt: cfg.enabledAt } : {}),
      redactionVersion: REDACTION_VERSION,
      schema: CORPUS_SCHEMA,
    });
    process.stdout.write(
      `Capture disabled for ${workspace}\n` +
        `  \`export\` and \`stats\` now refuse to read this workspace's sessions.\n` +
        `  Previously exported files are untouched — remove them yourself if you want them gone.\n`,
    );
    return;
  }

  const dir = corpusDir(workspace);
  process.stdout.write(
    `Capture: ${cfg.enabled ? 'ON' : 'off'}\n` +
      `  workspace:  ${workspace}\n` +
      `  bucket:     ${workspaceBucket(workspace)}\n` +
      `  config:     ${join(workspace, '.shadow', 'corpus.json')}\n` +
      `  corpus:     ${dir}\n` +
      (cfg.enabledAt ? `  enabled at: ${cfg.enabledAt}\n` : '') +
      `  redaction:  v${cfg.redactionVersion ?? REDACTION_VERSION}\n`,
  );
}

/**
 * Refuse to touch session logs unless capture was explicitly enabled for this workspace.
 *
 * This is the consent gate, and it is deliberately in one place so `export` and `stats` cannot
 * drift apart on it.
 */
function requireEnabled(workspace: string): boolean {
  const cfg = readCorpusConfig(workspace);
  if (!cfg.enabled) {
    process.stderr.write(
      `Capture is off for ${workspace}.\n` +
        `Run \`shadow corpus on\` first — this command will not read your session logs without it.\n`,
    );
    process.exitCode = 1;
    return false;
  }
  return true;
}

function parseExportArgs(args: string[]): {
  outDir?: string;
  review: boolean;
  minScore: number;
  label?: string;
  includeNeutral: boolean;
} {
  let outDir: string | undefined;
  let review = false;
  let minScore = 0;
  let label: string | undefined;
  let includeNeutral = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--out') outDir = args[++i];
    else if (a === '--review') review = true;
    else if (a === '--min-score') minScore = Number(args[++i] ?? '0');
    else if (a === '--label') label = args[++i];
    else if (a === '--include-neutral') includeNeutral = true;
  }
  if (!Number.isFinite(minScore)) minScore = 0;
  return { ...(outDir ? { outDir } : {}), review, minScore, ...(label ? { label } : {}), includeNeutral };
}

/** `shadow corpus export` — read → normalize → score → redact → dedupe → split → write. */
async function cmdExport(args: string[], workspace: string): Promise<void> {
  if (!requireEnabled(workspace)) return;

  const opts = parseExportArgs(args);
  const sessionPaths = SessionLog.list(resolve(workspace));
  if (sessionPaths.length === 0) {
    process.stderr.write('No session logs found in this workspace — nothing to export.\n');
    process.exitCode = 1;
    return;
  }

  // Redaction happens inside buildRecords, BEFORE dedup, so the digest is computed over
  // redacted content — otherwise two sessions differing only in a secret would hash apart
  // and both survive dedup.
  const built = await buildRecords(sessionPaths, {
    ...(opts.includeNeutral ? { includeNeutral: true } : {}),
    minScore: opts.minScore,
    ...(opts.label ? { label: opts.label } : {}),
  });
  const { kept, dropped } = dedupe(built.records);
  const s = stats(kept);

  const target = opts.outDir
    ? resolve(workspace, opts.outDir)
    : opts.review
      ? join(corpusDir(workspace), 'review')
      : join(corpusDir(workspace), 'export');
  mkdirSync(target, { recursive: true });

  for (const split of ['train', 'val', 'test'] as const) {
    const rows = kept.filter((r) => r.split === split);
    if (rows.length === 0) continue;
    await writeFile(join(target, `${split}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  }

  await writeFile(
    join(target, 'manifest.json'),
    `${JSON.stringify(
      {
        schema: CORPUS_SCHEMA,
        redactionVersion: REDACTION_VERSION,
        createdAt: new Date().toISOString(),
        workspaceBucket: workspaceBucket(workspace),
        sessionsExamined: built.sessionsExamined,
        examplesKept: kept.length,
        duplicatesDropped: dropped,
        skipped: {
          empty: built.skippedEmpty,
          neutralOrFiltered: built.skippedLabel,
          belowMinScore: built.skippedScore,
        },
        redactionHits: built.redactionHits,
        byLabel: s.byLabel,
        bySplit: s.bySplit,
        byModel: s.byModel,
        warnings: built.warnings,
        note:
          'Shadow collects no data of its own. This file was produced locally by the user and ' +
          'contains only redacted session content from this workspace.',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  process.stdout.write(
    `${opts.review ? 'STAGED FOR REVIEW' : 'Export complete'}: ${target}\n\n` +
      `  sessions examined   ${built.sessionsExamined}\n` +
      `  examples kept       ${kept.length}\n` +
      `  duplicates dropped  ${dropped}\n` +
      `  skipped empty       ${built.skippedEmpty}\n` +
      `  skipped neutral     ${built.skippedLabel}\n` +
      `  below min-score     ${built.skippedScore}\n` +
      `  redactions applied  ${built.redactionHits}\n` +
      `\n  by label:\n${fmtCounts(s.byLabel)}\n` +
      `\n  by split:\n${fmtCounts(s.bySplit)}\n` +
      `\n  by model:\n${fmtCounts(s.byModel)}\n`,
  );

  if (built.warnings.length > 0) {
    process.stdout.write(`\n  ${built.warnings.length} session(s) produced warnings:\n`);
    for (const w of built.warnings.slice(0, 10)) process.stdout.write(`    ${w}\n`);
  }
  if (opts.review) {
    process.stdout.write(
      `\nReview the staged files under ${target} before moving them anywhere.\n` +
        `Nothing was uploaded — this command has no network path.\n`,
    );
  }
}

/** `shadow corpus stats` — what an export would contain, without writing anything. */
async function cmdStats(workspace: string): Promise<void> {
  if (!requireEnabled(workspace)) return;

  const sessionPaths = SessionLog.list(resolve(workspace));
  if (sessionPaths.length === 0) {
    process.stdout.write(`No session logs found for ${workspace}.\n`);
    return;
  }

  const built = await buildRecords(sessionPaths);
  if (built.records.length === 0) {
    process.stdout.write(
      `Examined ${built.sessionsExamined} session(s); none produced a usable example.\n` +
        `(${built.skippedEmpty} empty, ${built.skippedLabel} neutral.) ` +
        `Try \`--include-neutral\` on export.\n`,
    );
    return;
  }

  const { kept, dropped } = dedupe(built.records);
  const s = stats(kept);
  process.stdout.write(
    `Corpus preview: ${workspace}\n\n` +
      `  sessions examined  ${built.sessionsExamined}\n` +
      `  usable examples    ${kept.length}\n` +
      `  duplicates         ${dropped}\n` +
      `  unique digests     ${s.uniqueDigests}\n` +
      `  redaction hits     ${built.redactionHits}\n` +
      `\n  by label:\n${fmtCounts(s.byLabel)}\n` +
      `\n  by split:\n${fmtCounts(s.bySplit)}\n` +
      `\n  by model:\n${fmtCounts(s.byModel)}\n` +
      `\nNothing was written. Run \`shadow corpus export\` to build the files.\n`,
  );
}

export async function runCorpus(args: string[], workspace: string): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    process.stdout.write(`${CORPUS_USAGE}\n`);
    return;
  }

  const ws = resolve(workspace);
  switch (sub) {
    case 'on':
    case 'off':
    case 'status':
      await cmdConfig(sub, ws);
      return;
    case 'export':
      await cmdExport(args.slice(1), ws);
      return;
    case 'stats':
      await cmdStats(ws);
      return;
    default:
      process.stderr.write(`Unknown corpus subcommand: ${sub}\n\n${CORPUS_USAGE}\n`);
      process.exitCode = 1;
  }
}