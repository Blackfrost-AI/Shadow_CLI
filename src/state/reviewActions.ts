import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ChangedFile } from './gitChanges.js';
import { resolveWithin } from '../safety/workspaceJail.js';
import { scrubbedEnv } from '../util/safeEnv.js';

export type ReviewAction = 'stage' | 'unstage' | 'restore';
export interface ReviewActionPreview {
  id: string; action: ReviewAction; path: string; scope: 'file' | 'hunk'; hunkIndex?: number;
  summary: string; diff: string; backupRequired: boolean;
}
export interface ReviewActionResult { action: ReviewAction; path: string; backupPath?: string; }
interface Entry { mode: string; oid: string; }
interface FileSnapshot { hash: string; bytes: Buffer | null; mode: number; }
interface Prepared {
  public: ReviewActionPreview; root: string; file: ChangedFile; path: string; repoPath: string; repoRoot: string;
  indexPath: string; indexHash: string; head: string; original: FileSnapshot; indexEntry?: Entry; headEntry?: Entry;
  patch?: string; restoreBytes?: Buffer; restoreMode?: number;
}
const previews = new Map<string, Prepared>();
const LIMIT = 8 * 1024 * 1024;
function sha(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex'); }
function git(root: string, args: string[], input?: Buffer | string, index?: string): Buffer {
  return execFileSync('git', ['--literal-pathspecs', '-C', root, '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], {
    input, maxBuffer: LIMIT * 2, timeout: 10_000,
    env: scrubbedEnv(undefined, { GIT_OPTIONAL_LOCKS: '0', ...(index ? { GIT_INDEX_FILE: index } : {}) }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
function textGit(root: string, args: string[], input?: Buffer | string, index?: string): string { return git(root, args, input, index).toString('utf8'); }
function readIndex(path: string): Buffer { return existsSync(path) ? readFileSync(path) : Buffer.alloc(0); }
function head(root: string): string {
  try { return textGit(root, ['rev-parse', '--verify', 'HEAD']).trim(); }
  catch { return ''; } // A repository with an unborn branch has no HEAD entry to unstage to.
}
function noSymlink(root: string, requested: string): string {
  if (!requested || isAbsolute(requested) || requested.split(/[\\/]/).some((part) => part === '..') || requested.includes('\0')) throw new Error('Review actions require an exact workspace-relative file path.');
  const lexical = resolve(root, requested);
  const abs = resolveWithin(root, requested);
  if (relative(resolve(root), lexical).split(sep).some((part) => part === '.git' || part === '.shadow')) throw new Error('Review actions cannot modify Git metadata or Shadow evidence.');
  let current = resolve(root);
  for (const part of relative(current, lexical).split(sep)) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error('Review actions do not follow symlinks.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return abs;
}
function snapshot(path: string): FileSnapshot {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error('Review actions support regular files only.');
    if (stat.size > LIMIT) throw new Error('File exceeds the 8 MiB scoped-action limit; use Git directly.');
    const bytes = readFileSync(path); const mode = stat.mode & 0o777;
    return { hash: sha(Buffer.concat([Buffer.from(`${mode}:`), bytes])), bytes, mode };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { hash: 'absent', bytes: null, mode: 0o644 };
    throw error;
  }
}
function indexEntry(root: string, path: string): Entry | undefined {
  const entries = textGit(root, ['ls-files', '--stage', '-z', '--', path]).split('\0').filter(Boolean);
  if (entries.length > 1 || entries.some((entry) => !/^\d+ [a-f0-9]+ 0\t/.test(entry))) throw new Error('Resolve the merge conflict before a scoped review action.');
  const match = entries[0]?.match(/^(\d+) ([a-f0-9]+) 0\t/);
  return match ? { mode: match[1]!, oid: match[2]! } : undefined;
}
function headEntry(root: string, path: string, revision: string): Entry | undefined {
  if (!revision) return undefined;
  const entry = textGit(root, ['ls-tree', '-z', revision, '--', path]).split('\0').filter(Boolean)[0];
  const match = entry?.match(/^(\d+) blob ([a-f0-9]+)\t/);
  return match ? { mode: match[1]!, oid: match[2]! } : undefined;
}
function regular(entry?: Entry): boolean { return !entry || entry.mode === '100644' || entry.mode === '100755'; }
function stagedFileMode(root: string, original: FileSnapshot, current?: Entry): string {
  // Honor Git's filesystem contract: Windows and some mounted filesystems do not
  // provide meaningful executable bits. Preserve the index mode in that case.
  let fileMode = '';
  try { fileMode = textGit(root, ['config', '--bool', '--get', 'core.filemode']).trim(); } catch { /* Git defaults to true when unset. */ }
  if (fileMode === 'false') return current?.mode ?? '100644';
  return original.mode & 0o111 ? '100755' : '100644';
}
function requireLiteralFile(root: string, path: string): void {
  // Staging/restoring raw bytes cannot honestly emulate LFS/clean filters, text encodings or
  // newline conversion. Refuse before diff can invoke a configured clean filter during preview.
  const attrs = textGit(root, ['check-attr', '-z', 'filter', 'text', 'eol', 'working-tree-encoding', '--', path]).split('\0');
  for (let i = 0; i + 2 < attrs.length; i += 3) {
    if (!['unspecified', 'unset'].includes(attrs[i + 2]!)) throw new Error(`File uses Git ${attrs[i + 1]} conversion (${attrs[i + 2]}). Use Git directly so its configured filters/conversions are preserved.`);
  }
  let autocrlf = '';
  try { autocrlf = textGit(root, ['config', '--get', 'core.autocrlf']).trim(); } catch { /* unset */ }
  if (autocrlf === 'true' || autocrlf === 'input') throw new Error('Git newline conversion is enabled. Use Git directly so its configured conversions are preserved.');
}
interface Hunk { header: string; body: string; oldStart: number; newStart: number; oldLines: string[]; newLines: string[]; }
function hunks(diff: string): { prefix: string; hunks: Hunk[] } {
  const starts = [...diff.matchAll(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@.*$/gm)];
  if (!starts.length) throw new Error('No supported text hunks in this diff.');
  const result = starts.map((match, i): Hunk => {
    const offset = match.index!; const end = starts[i + 1]?.index ?? diff.length;
    const text = diff.slice(offset, end); const lineEnd = text.indexOf('\n');
    const body = lineEnd >= 0 ? text.slice(lineEnd + 1) : '';
    const oldLines: string[] = []; const newLines: string[] = [];
    let previous = '';
    for (const line of body.split('\n')) {
      if (line.startsWith('\\ No newline at end of file')) {
        if (previous === ' ' || previous === '-') oldLines[oldLines.length - 1] = oldLines.at(-1)!.slice(0, -1);
        if (previous === ' ' || previous === '+') newLines[newLines.length - 1] = newLines.at(-1)!.slice(0, -1);
      } else if (line[0] === ' ' || line[0] === '+' || line[0] === '-') {
        previous = line[0];
        if (previous !== '+') oldLines.push(line.slice(1) + '\n');
        if (previous !== '-') newLines.push(line.slice(1) + '\n');
      } else if (line !== '') throw new Error('Unsupported patch content; use Git directly.');
    }
    return { header: match[0], body, oldStart: Number(match[1]), newStart: Number(match[2]), oldLines, newLines };
  });
  return { prefix: diff.slice(0, starts[0]!.index!), hunks: result };
}
function reverseHunk(bytes: Buffer, hunk: Hunk): Buffer {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes) || bytes.includes(0)) throw new Error('Hunk restore supports UTF-8 text only.');
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const at = Math.max(0, hunk.newStart - 1);
  if (lines.slice(at, at + hunk.newLines.length).join('') !== hunk.newLines.join('')) throw new Error('Hunk no longer matches the working file. Refresh the review.');
  lines.splice(at, hunk.newLines.length, ...hunk.oldLines);
  return Buffer.from(lines.join(''));
}

/** Read-only, exact-path preview. The returned token is valid only in this process and cannot be
 * reconstructed from untrusted project data. No mutation occurs until applyReviewAction. */
export function previewReviewAction(root: string, file: ChangedFile, action: ReviewAction, hunkIndex?: number): ReviewActionPreview {
  const path = noSymlink(root, file.path);
  if (!['stage', 'unstage', 'restore'].includes(action)) throw new Error('Unknown review action.');
  if (file.area === 'revision') throw new Error('Historical revisions are read-only. Switch to working changes.');
  if (file.previousPath || /^[RCU]/.test(file.status)) throw new Error('Renames, copies and merge conflicts require Git directly; scoped review actions leave them untouched.');
  if (action === 'stage' && file.area === 'staged') throw new Error('This entry is already staged. Select its unstaged entry.');
  if (action === 'unstage' && file.area !== 'staged') throw new Error('Only staged changes can be unstaged.');
  if (action === 'restore' && file.area !== 'unstaged') throw new Error('Restore applies only to unstaged tracked changes, back to the index. Unstage first; untracked files are never deleted.');
  const repoRoot = realpathSync.native(textGit(root, ['rev-parse', '--show-toplevel']).trim());
  // Git can report a long Windows username while TEMP/root uses its DOS alias.
  // Native realpath expands both spellings; the non-native implementation does
  // not reliably do so. Keep the jailed inner path relative to the caller's root,
  // then anchor it under the canonical workspace (also supports deleted files).
  const canonicalPath = join(realpathSync.native(root), relative(resolve(root), path));
  const repoPath = relative(repoRoot, canonicalPath).split(sep).join('/');
  if (repoPath === '..' || repoPath.startsWith('../') || isAbsolute(repoPath)) throw new Error('File is outside the selected Git worktree.');
  if (action !== 'unstage') requireLiteralFile(repoRoot, repoPath);
  const indexPath = textGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).trim();
  const indexHash = sha(readIndex(indexPath)); const revision = head(root); const original = snapshot(path);
  const current = indexEntry(repoRoot, repoPath); const committed = headEntry(repoRoot, repoPath, revision);
  if (!regular(current) || !regular(committed)) throw new Error('Symlinks and submodules are not supported by scoped review actions.');
  if (action === 'restore' && !current) throw new Error('No indexed version exists to restore; untracked files are never deleted.');
  const binary = original.bytes?.includes(0) ?? false;
  const rawDiff = textGit(repoRoot, ['diff', ...(action === 'unstage' ? ['--cached'] : []), '--binary', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', '--', repoPath]);
  const preview: ReviewActionPreview = { id: randomUUID(), action, path: file.path, scope: hunkIndex == null ? 'file' : 'hunk', hunkIndex,
    summary: `${action === 'restore' ? 'Restore unstaged changes from the index in' : action === 'stage' ? 'Stage' : 'Unstage'} ${hunkIndex == null ? 'only this file' : `only hunk ${hunkIndex + 1}`}: ${file.path}.${action === 'restore' ? ' A private backup is retained before replacement.' : ' Other paths remain unchanged.'}`,
    diff: rawDiff || (file.area === 'untracked' ? `New ${binary ? 'binary' : 'text'} file: ${file.path}\n${original.bytes?.length ?? 0} bytes · SHA-256 ${sha(original.bytes ?? Buffer.alloc(0))}\n${binary ? '' : original.bytes?.toString('utf8').slice(0, 32_000) ?? ''}` : 'No patch content.'), backupRequired: action === 'restore' };
  const prepared: Prepared = { public: { ...preview }, root: resolve(root), repoRoot, repoPath, file: { ...file }, path, indexPath, indexHash, head: revision, original, indexEntry: current, headEntry: committed };
  if (hunkIndex != null) {
    if (!Number.isInteger(hunkIndex) || hunkIndex < 0) throw new Error('Choose a valid hunk index.');
    if (file.status !== 'M' || !current || !original.bytes || binary || /^(?:GIT binary patch|Binary files|old mode|new mode)/m.test(rawDiff)) throw new Error('Hunk actions require an ordinary modified text file; use the whole-file action for new, deleted, binary or mode-only changes.');
    const parsed = hunks(rawDiff); const selected = parsed.hunks[hunkIndex];
    if (!selected) throw new Error('The selected hunk is unavailable. Refresh the review.');
    prepared.patch = parsed.prefix + selected.header + '\n' + selected.body;
    preview.diff = prepared.patch; prepared.public.diff = preview.diff;
    if (action === 'restore') prepared.restoreBytes = reverseHunk(original.bytes, selected);
  } else if (action === 'restore') {
    prepared.restoreBytes = git(repoRoot, ['cat-file', 'blob', current!.oid]);
    prepared.restoreMode = current!.mode === '100755' ? 0o755 : 0o644;
  }
  if (sha(readIndex(indexPath)) !== indexHash || head(root) !== revision || snapshot(path).hash !== original.hash) throw new Error('Changes moved while preparing this review; refresh before applying.');
  // Bound in-memory previews; evicted previews require a fresh review rather than unsafe reuse.
  if (previews.size >= 100) previews.delete(previews.keys().next().value!);
  previews.set(preview.id, prepared);
  return preview;
}

/** Apply exactly the reviewed operation. The real Git index lock protects staging against
 * concurrent Git writers. Worktree hashes are checked again immediately before replacement;
 * editor changes made since preview cause a conflict, never a best-effort overwrite. */
export function applyReviewAction(preview: ReviewActionPreview): ReviewActionResult {
  const p = previews.get(preview.id);
  if (!p || JSON.stringify(p.public) !== JSON.stringify(preview)) throw new Error('Review preview expired or changed. Prepare a fresh preview.');
  previews.delete(preview.id); // single-use, including failure: an explicit retry needs fresh evidence
  const lock = `${p.indexPath}.lock`; let fd: number | undefined; let tempIndex: string | undefined; let ownsLock = false;
  try {
    try { fd = openSync(lock, 'wx', 0o600); ownsLock = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Git index is busy. Finish the other Git operation and refresh.'); throw error; }
    const assertFresh = (): void => {
      if (noSymlink(p.root, p.file.path) !== p.path || snapshot(p.path).hash !== p.original.hash || sha(readIndex(p.indexPath)) !== p.indexHash || head(p.root) !== p.head) throw new Error('File, index, or HEAD changed since preview. Refresh; nothing was overwritten.');
      if (p.public.action !== 'unstage') requireLiteralFile(p.repoRoot, p.repoPath);
    };
    assertFresh();
    if (p.public.action === 'restore') {
      const dir = resolveWithin(p.root, '.shadow/review-backups'); mkdirSync(dir, { recursive: true, mode: 0o700 });
      const backupPath = resolveWithin(p.root, join(dir, `${preview.id}.json`));
      writeFileSync(backupPath, JSON.stringify({ version: 1, path: p.file.path, recordedAt: new Date().toISOString(), originalHash: p.original.hash, mode: p.original.mode, absent: p.original.bytes === null, contentBase64: p.original.bytes?.toString('base64') ?? null }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      assertFresh();
      const temporary = join(dirname(p.path), `.shadow-restore-${preview.id}.tmp`);
      try {
        mkdirSync(dirname(p.path), { recursive: true });
        writeFileSync(temporary, p.restoreBytes!, { flag: 'wx', mode: p.restoreMode ?? p.original.mode });
        assertFresh();
        renameSync(temporary, p.path);
      } finally { if (existsSync(temporary)) unlinkSync(temporary); }
      return { action: preview.action, path: preview.path, backupPath };
    }
    tempIndex = join(dirname(p.indexPath), `shadow-review-index-${preview.id}`);
    const index = readIndex(p.indexPath);
    if (index.length) writeFileSync(tempIndex, index, { flag: 'wx', mode: 0o600 });
    else textGit(p.repoRoot, ['read-tree', '--empty'], undefined, tempIndex);
    if (p.patch) {
      const flags = ['apply', '--cached', ...(preview.action === 'unstage' ? ['--reverse'] : []), '--whitespace=nowarn'];
      textGit(p.repoRoot, [...flags, '--check', '-'], p.patch, tempIndex);
      textGit(p.repoRoot, [...flags, '-'], p.patch, tempIndex);
    } else {
      let entry = p.headEntry;
      if (preview.action === 'stage') entry = p.original.bytes ? { mode: stagedFileMode(p.repoRoot, p.original, p.indexEntry), oid: textGit(p.repoRoot, ['hash-object', '-w', '--stdin'], p.original.bytes).trim() } : undefined;
      const emptyOid = '0'.repeat((entry ?? p.indexEntry ?? p.headEntry)?.oid.length ?? 40);
      const record = `${entry?.mode ?? '0'} ${entry?.oid ?? emptyOid}\t${p.repoPath}\0`;
      textGit(p.repoRoot, ['update-index', '-z', '--index-info'], record, tempIndex);
    }
    assertFresh();
    const updated = readFileSync(tempIndex);
    writeFileSync(fd, updated); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(lock, p.indexPath);
    ownsLock = false;
    return { action: preview.action, path: preview.path };
  } finally {
    if (fd !== undefined) closeSync(fd);
    // Only files exclusively created by this operation are removed; never another Git lock.
    if (ownsLock && existsSync(lock)) unlinkSync(lock);
    if (tempIndex && existsSync(tempIndex)) unlinkSync(tempIndex);
    if (tempIndex && existsSync(`${tempIndex}.lock`)) unlinkSync(`${tempIndex}.lock`);
  }
}
