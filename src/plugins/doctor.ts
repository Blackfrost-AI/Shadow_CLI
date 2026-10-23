/**
 * `shadow plugin doctor` — report what a plugin actually ships versus what Shadow installs.
 *
 * Shadow's plugin boundary is DATA-only: `copyTree` copies `.md` files and nothing else. That
 * is a deliberate security property, but it is silent. A plugin whose `hooks/` directory is
 * dropped still installs, still lists as enabled, and still reads as if it works — while any
 * skill that says "the hook enforces X" is describing something that is not running.
 *
 * This module makes that gap visible and measurable. It never executes plugin content and
 * never writes to the plugin tree; it only reads and reports.
 */
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  PLUGIN_CONTENT_DIRS,
  PLUGIN_MAX_BYTES,
  PLUGIN_MAX_FILES,
  PLUGIN_META_FILE,
} from './manager.js';

/**
 * Resolve which tree to diagnose for an installed plugin.
 *
 * An installed plugin has already had every non-`.md` file dropped, so diagnosing the installed
 * copy cannot answer the two questions doctor exists for — "what will Shadow drop?" and "what
 * will dangle?" — because the drops already happened and every script reference already looks
 * `missing`. When provenance records a local source path that still exists, that is the tree
 * worth diagnosing. Anything else (git installs, a vanished source, a bare path argument) is
 * diagnosed as given.
 *
 * Returns the tree to diagnose plus a note when a source was substituted, so the report can say
 * which tree the numbers describe.
 */
export function resolveDiagnosisRoot(
  root: string,
): { root: string; sourceOf?: string } {
  let meta: unknown;
  try {
    meta = JSON.parse(readFileSync(join(root, PLUGIN_META_FILE), 'utf8'));
  } catch {
    return { root };
  }
  const source = (meta as { source?: unknown } | null)?.source as
    | { kind?: string; path?: string }
    | undefined;
  if (source?.kind !== 'path' || typeof source.path !== 'string') return { root };
  const candidate = resolve(source.path);
  if (candidate === resolve(root)) return { root };
  try {
    if (!lstatSync(candidate).isDirectory()) return { root };
  } catch {
    return { root };
  }
  return { root: candidate, sourceOf: resolve(root) };
}

/** A path referenced from plugin markdown that will not exist after install. */
export interface DanglingRef {
  /** Markdown file containing the reference, relative to the plugin root. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** The referenced path as written. */
  ref: string;
  /** Why it dangles. */
  reason: 'non-markdown' | 'missing';
}

export interface PluginDoctorReport {
  /** Absolute path inspected. */
  root: string;
  /** Files that will be installed (`.md` + manifest + readme/license). */
  installed: number;
  /** Bytes that will be installed. */
  installedBytes: number;
  /** Files Shadow will NOT copy, grouped by extension ('' for extensionless). */
  dropped: { ext: string; count: number; bytes: number }[];
  /** Content surfaces present in the source. */
  surfaces: { name: string; present: boolean; files: number }[];
  /** Symlinks — skipped by the copier, so their targets never arrive. */
  symlinks: string[];
  /** References from markdown to paths that will not exist post-install. */
  dangling: DanglingRef[];
  /** Cap usage; `over` is true when an install would be refused. */
  caps: { files: number; maxFiles: number; bytes: number; maxBytes: number; over: boolean };
  /** True when nothing is silently lost and nothing dangles. */
  clean: boolean;
}

const SKIPPED_EXT_HINT = new Set(['.md']);

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i).toLowerCase();
}

/**
 * Walk the source tree collecting everything the copier would keep and everything it would
 * drop. Mirrors `copyTree`'s rules exactly: symlinks skipped, dot-entries skipped, only `.md`
 * files copied from content dirs.
 */
function walk(root: string): {
  installed: string[];
  dropped: Map<string, { count: number; bytes: number }>;
  symlinks: string[];
} {
  const installed: string[] = [];
  const dropped = new Map<string, { count: number; bytes: number }>();
  const symlinks: string[] = [];

  const visit = (dir: string): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        symlinks.push(relative(root, full));
        continue;
      }
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      let size = 0;
      try {
        size = statSync(full).size;
      } catch {
        continue;
      }
      if (SKIPPED_EXT_HINT.has(extOf(entry.name)) || entry.name === 'manifest.json') {
        installed.push(full);
      } else {
        const ext = extOf(entry.name);
        const cur = dropped.get(ext) ?? { count: 0, bytes: 0 };
        cur.count += 1;
        cur.bytes += size;
        dropped.set(ext, cur);
      }
    }
  };
  visit(root);
  return { installed, dropped, symlinks };
}

/**
 * Find markdown references to relative paths that will not exist after install.
 *
 * Only the five content surfaces are scanned — root docs (CHANGELOG, AGENTS.md) describe the
 * repo rather than the installed plugin, and scanning them produced ~6k refs of pure noise.
 * Code extensions additionally require a path separator, so prose like "Node.js" or "Vue.js"
 * is not mistaken for a file reference.
 */
export function findDanglingRefs(root: string, installed: Set<string>): DanglingRef[] {
  const out: DanglingRef[] = [];
  const surfaces = PLUGIN_CONTENT_DIRS.map((d) => join(root, d) + '/');
  const inSurface = (f: string): boolean => surfaces.some((s) => f.startsWith(s));

  // A directory-qualified path (`hooks/x.sh`, `scripts/y.py`) or a directory-qualified `.md`
    // reference (`references/notes.md`). Bare `foo.js` is deliberately excluded — that is how
    // prose names frameworks. A bare `*.md` basename is excluded for the same reason: `CLAUDE.md`,
    // `SOUL.md`, `todo.md` and friends overwhelmingly name files in the CONSUMING project, and
    // resolving them against the plugin root is a guess. Suppressing unresolvable bare basenames
    // loses nothing — a bare `.md` that does resolve is copied, so it was never reported anyway.
    const REF = /(?:^|[\s`'"([])((?:\.\/)?(?:hooks|scripts|bin|lib|tests|test|references|assets)\/[A-Za-z0-9._/-]+|[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/[A-Za-z0-9._-]+\.md)(?=[\s`'"),.:;]|$)/g;

  for (const file of installed) {
    if (!inSurface(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      REF.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = REF.exec(line)) !== null) {
        const ref = m[1].replace(/^\.\//, '');
        // A relative reference resolves against the file that contains it, not the plugin
        // root — `references/notes.md` inside skills/alpha/ means skills/alpha/references/.
        const fromFile = join(dirname(file), ref);
        const fromRoot = join(root, ref);
        let resolved: string | null = null;
        for (const candidate of [fromFile, fromRoot]) {
          try {
            if (lstatSync(candidate).isFile()) {
              resolved = candidate;
              break;
            }
          } catch {
            /* try the next base */
          }
        }
        if (!resolved) {
          out.push({ file: relative(root, file), line: i + 1, ref, reason: 'missing' });
        } else if (!SKIPPED_EXT_HINT.has(extOf(ref))) {
          // It exists in the source, but the copier will not bring it across.
          out.push({ file: relative(root, file), line: i + 1, ref, reason: 'non-markdown' });
        }
      }
    }
  }
  return out;
}

/** Inspect a plugin source directory. Read-only: never executes, never writes. */
export function diagnosePlugin(root: string): PluginDoctorReport {
  const st = lstatSync(root);
  if (!st.isDirectory()) throw new Error(`not a directory: ${root}`);

  const { installed, dropped, symlinks } = walk(root);
  const installedSet = new Set(installed);

  let installedBytes = 0;
  for (const f of installed) {
    try {
      installedBytes += statSync(f).size;
    } catch {
      /* ignore */
    }
  }

  const surfaces = PLUGIN_CONTENT_DIRS.map((name) => {
    const dir = join(root, name);
    let files = 0;
    let present = false;
    try {
      present = lstatSync(dir).isDirectory();
    } catch {
      present = false;
    }
    if (present) files = installed.filter((f) => f.startsWith(dir + '/')).length;
    return { name, present, files };
  });

  const dangling = findDanglingRefs(root, installedSet);
  const caps = {
    files: installed.length,
    maxFiles: PLUGIN_MAX_FILES,
    bytes: installedBytes,
    maxBytes: PLUGIN_MAX_BYTES,
    over: installed.length > PLUGIN_MAX_FILES || installedBytes > PLUGIN_MAX_BYTES,
  };

  return {
    root,
    installed: installed.length,
    installedBytes,
    dropped: [...dropped.entries()]
      .map(([ext, v]) => ({ ext, ...v }))
      .sort((a, b) => b.count - a.count),
    surfaces,
    symlinks,
    dangling,
    caps,
    clean: dropped.size === 0 && symlinks.length === 0 && dangling.length === 0 && !caps.over,
  };
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Render a report for the terminal. Plain text; no colour codes. */
export function formatDoctorReport(r: PluginDoctorReport, sourceOf?: string): string {
  const lines: string[] = [];
  lines.push(`plugin doctor: ${r.root}`);
  if (sourceOf) {
    lines.push(`source tree — the installed copy is at ${sourceOf}`);
  }
  lines.push('');
  lines.push(
    `installs   ${r.installed} files, ${fmtBytes(r.installedBytes)}  ` +
      `(cap ${r.caps.maxFiles} files / ${fmtBytes(r.caps.maxBytes)})`,
  );

  const present = r.surfaces.filter((s) => s.present);
  if (present.length) {
    lines.push(`surfaces   ${present.map((s) => `${s.name} (${s.files})`).join(', ')}`);
  } else {
    lines.push('surfaces   none — no commands/, skills/, agents/, workflows/ or output-styles/');
  }

  if (r.caps.over) {
    lines.push('');
    lines.push('CAPS EXCEEDED — this plugin will NOT install as-is:');
    if (r.caps.files > r.caps.maxFiles) {
      lines.push(`  files  ${r.caps.files} > ${r.caps.maxFiles}`);
    }
    if (r.caps.bytes > r.caps.maxBytes) {
      lines.push(`  bytes  ${fmtBytes(r.caps.bytes)} > ${fmtBytes(r.caps.maxBytes)}`);
    }
  }

  if (r.dropped.length) {
    lines.push('');
    lines.push('DROPPED — not copied by Shadow (markdown-only boundary):');
    for (const d of r.dropped) {
      lines.push(`  ${(d.ext || '(no ext)').padEnd(10)} ${String(d.count).padStart(5)} files  ${fmtBytes(d.bytes)}`);
    }
  }

  if (r.symlinks.length) {
    lines.push('');
    lines.push(`SYMLINKS — skipped (${r.symlinks.length}), targets will not arrive:`);
    for (const s of r.symlinks.slice(0, 10)) lines.push(`  ${s}`);
    if (r.symlinks.length > 10) lines.push(`  … ${r.symlinks.length - 10} more`);
  }

  if (r.dangling.length) {
    lines.push('');
    lines.push(`DANGLING REFERENCES — ${r.dangling.length} path(s) referenced but absent after install:`);
    for (const d of r.dangling.slice(0, 20)) {
      lines.push(`  ${d.file}:${d.line}  ${d.ref}  (${d.reason})`);
    }
    if (r.dangling.length > 20) lines.push(`  … ${r.dangling.length - 20} more`);
  }

  lines.push('');
  lines.push(r.clean ? 'clean — nothing is silently lost.' : 'NOT CLEAN — see the sections above.');
  return lines.join('\n');
}