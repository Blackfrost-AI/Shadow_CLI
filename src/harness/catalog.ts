import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { HARNESS_ID_RE, parseHarnessManifest } from './manifest.js';
import {
  HARNESS_CONTENT_DIR_NAMES,
  type HarnessCatalog,
  type HarnessCatalogOptions,
  type HarnessContentKind,
  type HarnessFileDigest,
  type HarnessLimits,
  type HarnessPackage,
  type HarnessSkillSnapshot,
} from './types.js';

export const DEFAULT_HARNESS_LIMITS: HarnessLimits = Object.freeze({
  manifestBytes: 64 * 1024,
  instructionBytes: 256 * 1024,
  packageBytes: 8 * 1024 * 1024,
  packageFiles: 500,
  packageEntries: 1_000,
  maxDepth: 16,
});

interface ScannedFile extends HarnessFileDigest {
  absolutePath: string;
  data: Buffer;
}

const UNSAFE_PATH_CHARACTER_RE = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

function displayPath(value: string): string {
  return value.replace(UNSAFE_PATH_CHARACTER_RE, '?');
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function effectiveLimits(overrides: Partial<HarnessLimits> = {}): HarnessLimits {
  const limits = { ...DEFAULT_HARNESS_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`invalid harness limit ${name}: expected a positive integer`);
    }
  }
  return limits;
}

/** Recomputed on each call so tests and embedders can use an isolated home. */
export function harnessesDir(homeDir: string = homedir()): string {
  return join(resolve(homeDir), '.shadow', 'harnesses');
}

function isContained(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Resolve the direct-drop root without allowing `~/.shadow` or `harnesses`
 * symlinks to redirect discovery outside the selected home directory.
 */
function validateCatalogRoot(homeDir: string, root: string): string {
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink()) throw new Error('harnesses root is a symlink — refused');
  if (!rootStat.isDirectory()) throw new Error('harnesses root is not a directory');
  const canonicalRoot = realpathSync(root);
  const canonicalHome = existsSync(homeDir) ? realpathSync(homeDir) : resolve(homeDir);
  if (!isContained(canonicalHome, canonicalRoot)) {
    throw new Error('harnesses root resolves outside the selected home directory');
  }
  return canonicalRoot;
}

function readRegularFile(path: string, maxBytes: number, label: string): Buffer {
  const before = lstatSync(path);
  if (before.isSymbolicLink()) throw new Error(`${label} is a symlink — refused`);
  if (!before.isFile()) throw new Error(`${label} is not a regular file`);
  if (before.size > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte cap`);

  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error(`${label} is not a regular file`);
    if (opened.size > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte cap`);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${label} changed while it was being inspected`);
    }
    const data = readFileSync(fd);
    if (data.length !== opened.size) throw new Error(`${label} changed while it was being read`);
    return data;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function scanPackage(dir: string, limits: HarnessLimits): ScannedFile[] {
  const files: ScannedFile[] = [];
  let entries = 0;
  let bytes = 0;

  const walk = (absoluteDir: string, relativeDir: string, depth: number): void => {
    if (depth > limits.maxDepth) throw new Error(`package exceeds the ${limits.maxDepth}-level depth cap`);
    const directoryStat = lstatSync(absoluteDir);
    if (directoryStat.isSymbolicLink()) {
      throw new Error(`${relativeDir || 'package root'} is a symlink — refused`);
    }
    if (!directoryStat.isDirectory()) throw new Error(`${relativeDir || 'package root'} is not a directory`);
    if (!isContained(dir, realpathSync(absoluteDir))) {
      throw new Error(`${relativeDir || 'package root'} resolves outside the harness package`);
    }
    const children = readdirSync(absoluteDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      entries += 1;
      if (entries > limits.packageEntries) {
        throw new Error(`package exceeds the ${limits.packageEntries}-entry cap`);
      }
      const absolutePath = join(absoluteDir, child.name);
      const relativePath = relativeDir ? `${relativeDir}/${child.name}` : child.name;
      if (UNSAFE_PATH_CHARACTER_RE.test(child.name)) {
        throw new Error(`${displayPath(relativePath)} contains unsafe path characters`);
      }
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) throw new Error(`${relativePath} is a symlink — refused`);
      if (stat.isDirectory()) {
        walk(absolutePath, relativePath, depth + 1);
        continue;
      }
      if (!stat.isFile()) throw new Error(`${relativePath} is not a regular file or directory`);
      if (files.length + 1 > limits.packageFiles) {
        throw new Error(`package exceeds the ${limits.packageFiles}-file cap`);
      }
      if (bytes + stat.size > limits.packageBytes) {
        throw new Error(`package exceeds the ${limits.packageBytes}-byte cap`);
      }
      const data = readRegularFile(absolutePath, limits.packageBytes - bytes, relativePath);
      bytes += data.length;
      files.push({
        path: relativePath,
        absolutePath,
        bytes: data.length,
        sha256: sha256(data),
        data,
      });
    }
  };

  walk(dir, '', 0);
  return files;
}

function packageDigest(files: ScannedFile[]): string {
  const inventory = files
    .map((file) => [file.path, file.bytes, file.sha256] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return sha256(`shadow-harness-package-v1\n${JSON.stringify(inventory)}`);
}

/** Load and fully validate one direct child package. */
export function loadHarnessPackage(id: string, options: HarnessCatalogOptions = {}): HarnessPackage {
  if (!HARNESS_ID_RE.test(id)) throw new Error(`invalid harness id: ${id}`);
  const homeDir = resolve(options.homeDir ?? homedir());
  const root = harnessesDir(homeDir);
  if (!existsSync(root)) throw new Error(`harness "${id}" is not installed`);
  const canonicalRoot = validateCatalogRoot(homeDir, root);
  const lexicalDir = join(root, id);

  let dirStat;
  try {
    dirStat = lstatSync(lexicalDir);
  } catch {
    throw new Error(`harness "${id}" is not installed`);
  }
  if (dirStat.isSymbolicLink()) throw new Error(`harness directory "${id}" is a symlink — refused`);
  if (!dirStat.isDirectory()) throw new Error(`harness "${id}" is not a directory`);
  const dir = realpathSync(lexicalDir);
  if (!isContained(canonicalRoot, dir) || relative(canonicalRoot, dir).split(sep).length !== 1) {
    throw new Error(`harness "${id}" is not a direct child of the harnesses directory`);
  }

  const limits = effectiveLimits(options.limits);
  const manifestPath = join(dir, 'harness.json');
  if (!existsSync(manifestPath)) throw new Error(`harness "${id}" has no harness.json`);
  const manifestBytes = readRegularFile(manifestPath, limits.manifestBytes, 'harness.json');
  let manifestText: string;
  try {
    manifestText = new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes);
  } catch {
    throw new Error('harness.json is not valid UTF-8');
  }
  const manifest = parseHarnessManifest(manifestText);
  if (manifest.id !== id) {
    throw new Error(`harness.json id "${manifest.id}" does not match directory "${id}"`);
  }

  const scanned = scanPackage(dir, limits);
  const byPath = new Map(scanned.map((file) => [file.path, file]));
  const scannedManifest = byPath.get('harness.json');
  if (!scannedManifest || scannedManifest.sha256 !== sha256(manifestBytes)) {
    throw new Error('harness.json changed while the package was being inspected');
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const instructions = manifest.instructions.map((instructionPath) => {
    const file = byPath.get(instructionPath);
    if (!file) throw new Error(`instruction file not found: ${instructionPath}`);
    if (file.bytes > limits.instructionBytes) {
      throw new Error(`instruction file ${instructionPath} exceeds the ${limits.instructionBytes}-byte cap`);
    }
    let text: string;
    try {
      text = decoder.decode(file.data);
    } catch {
      throw new Error(`instruction file ${instructionPath} is not valid UTF-8`);
    }
    return { addonId: id, path: instructionPath, text, sha256: file.sha256 };
  });

  const contentDirs: Partial<Record<HarnessContentKind, string>> = {};
  for (const [kind, name] of Object.entries(HARNESS_CONTENT_DIR_NAMES) as Array<
    [HarnessContentKind, string]
  >) {
    const candidate = join(dir, name);
    if (!existsSync(candidate)) continue;
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink()) throw new Error(`${name} is a symlink — refused`);
    if (!stat.isDirectory()) throw new Error(`${name} must be a directory`);
    const canonical = realpathSync(candidate);
    if (!isContained(dir, canonical)) throw new Error(`${name} resolves outside the harness package`);
    contentDirs[kind] = canonical;
  }

  // Capture model-visible skill bodies from this exact scan. Reopening these paths later would
  // allow package content to diverge from the digest recorded for the session (TOCTOU).
  const skills: HarnessSkillSnapshot[] = [];
  const skillsRoot = contentDirs.skills;
  if (skillsRoot) {
    for (const file of scanned) {
      const match = file.path.match(/^skills\/([^/]+)\/SKILL\.md$/);
      if (!match) continue;
      if (file.bytes > limits.instructionBytes) {
        throw new Error(`skill file ${file.path} exceeds the ${limits.instructionBytes}-byte cap`);
      }
      let body: string;
      try {
        body = decoder.decode(file.data);
      } catch {
        throw new Error(`skill file ${file.path} is not valid UTF-8`);
      }
      skills.push({
        addonId: id,
        name: match[1]!,
        path: file.path,
        absolutePath: file.absolutePath,
        root: skillsRoot,
        body,
        sha256: file.sha256,
      });
    }
  }

  const files = scanned.map(({ path, bytes, sha256: fileSha }) => ({ path, bytes, sha256: fileSha }));
  return {
    id,
    dir,
    manifestPath,
    manifest,
    digest: packageDigest(scanned),
    bytes: files.reduce((total, file) => total + file.bytes, 0),
    files,
    instructions,
    skills,
    contentDirs,
  };
}

/**
 * Discover valid direct children and retain actionable validation failures for
 * listing UIs. A broken package never becomes active by being silently parsed
 * as a partial package.
 */
export function discoverHarnessCatalog(options: HarnessCatalogOptions = {}): HarnessCatalog {
  const homeDir = resolve(options.homeDir ?? homedir());
  const root = harnessesDir(homeDir);
  if (!existsSync(root)) return { root, packages: [], issues: [] };
  try {
    validateCatalogRoot(homeDir, root);
    effectiveLimits(options.limits);
  } catch (err) {
    return { root, packages: [], issues: [{ message: (err as Error).message }] };
  }

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    return { root, packages: [], issues: [{ message: `cannot read harnesses directory: ${(err as Error).message}` }] };
  }

  const packages: HarnessPackage[] = [];
  const issues: HarnessCatalog['issues'] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      issues.push({ directory: entry.name, message: `harness directory "${displayPath(entry.name)}" is a symlink — refused` });
      continue;
    }
    if (!entry.isDirectory()) {
      issues.push({ directory: entry.name, message: `harness entry "${displayPath(entry.name)}" is not a directory` });
      continue;
    }
    if (!HARNESS_ID_RE.test(entry.name)) {
      issues.push({ directory: entry.name, message: `invalid harness directory name: ${displayPath(entry.name)}` });
      continue;
    }
    try {
      packages.push(loadHarnessPackage(entry.name, options));
    } catch (err) {
      issues.push({ directory: entry.name, message: (err as Error).message });
    }
  }
  return { root, packages, issues };
}
