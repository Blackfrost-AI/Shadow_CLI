/**
 * A Shadow harness is a declarative add-on discovered directly from
 * `~/.shadow/harnesses/<id>`. The security foundation is built in and is
 * always present; packages may add instructions/content and request compiled
 * capabilities, but they never carry executable code or provider settings.
 */

export const HARNESS_SCHEMA_VERSION = 1 as const;

export const HARNESS_CONTENT_DIR_NAMES = {
  skills: 'skills',
  // Reference files are package-owned evidence/resources included in the immutable digest for
  // provenance and local inspection. V1 does not auto-inject, execute, or expose them as tools.
  references: 'references',
} as const;

export type HarnessContentKind = keyof typeof HARNESS_CONTENT_DIR_NAMES;

export interface HarnessToolPolicy {
  /** Tools that must already exist in Shadow (including tools supplied by a compiled adapter). */
  add: string[];
  /** Existing tools removed from the effective session registry by the integration layer. */
  remove: string[];
}

export interface HarnessManifest {
  schemaVersion: typeof HARNESS_SCHEMA_VERSION;
  id: string;
  version: string;
  title: string;
  description: string;
  /** Relative Markdown files, applied in order after the built-in security foundation. */
  instructions: string[];
  /** IDs compiled into Shadow. An add-on cannot name a script or executable here. */
  requiredAdapters: string[];
  tools: HarnessToolPolicy;
}

export interface HarnessFileDigest {
  path: string;
  bytes: number;
  sha256: string;
}

export interface HarnessInstruction {
  addonId: string;
  path: string;
  text: string;
  sha256: string;
}

/**
 * A model-visible skill captured by the same validated package scan that
 * produced the package digest. Sessions consume `body` directly and never
 * reopen `absolutePath`, so the recorded digest and exposed instructions
 * cannot diverge if an installed package changes after resolution.
 */
export interface HarnessSkillSnapshot {
  addonId: string;
  name: string;
  /** Package-relative path, always `skills/<name>/SKILL.md` in schema v1. */
  path: string;
  /** Display/provenance path only; session skill loading uses the captured body. */
  absolutePath: string;
  root: string;
  body: string;
  sha256: string;
}

export interface HarnessPackage {
  id: string;
  dir: string;
  manifestPath: string;
  manifest: HarnessManifest;
  digest: string;
  bytes: number;
  files: HarnessFileDigest[];
  instructions: HarnessInstruction[];
  skills: HarnessSkillSnapshot[];
  contentDirs: Partial<Record<HarnessContentKind, string>>;
}

export interface HarnessCatalogIssue {
  /** Direct child directory name, when one could be identified safely. */
  directory?: string;
  message: string;
}

export interface HarnessCatalog {
  root: string;
  packages: HarnessPackage[];
  issues: HarnessCatalogIssue[];
}

/** Minimal interface keeps the harness core independent of ToolRegistry implementation details. */
export interface HarnessCapabilityRegistry {
  has(id: string): boolean;
}

export interface HarnessFoundation {
  id: 'shadow-security';
  version: string;
  title: string;
  description: string;
  instruction: string;
  digest: string;
}

export interface HarnessCapabilityReadiness {
  required: string[];
  available: string[];
  missing: string[];
}

export interface ResolvedHarnessStack {
  foundation: HarnessFoundation;
  addons: HarnessPackage[];
  /** Add-on IDs in effective prompt order. */
  selectedIds: string[];
  /** Foundation first, followed by each selected add-on's instruction files. */
  instructionText: string;
  instructions: Array<
    | { source: 'foundation'; id: string; text: string; sha256: string }
    | { source: 'addon'; id: string; path: string; text: string; sha256: string }
  >;
  /** Skill bodies captured by the package scan represented by `digest`. */
  skills: HarnessSkillSnapshot[];
  contentDirs: Record<HarnessContentKind, string[]>;
  adapters: HarnessCapabilityReadiness;
  tools: HarnessCapabilityReadiness & { remove: string[]; conflicts: string[] };
  ready: boolean;
  digest: string;
}

/**
 * Readiness against one concrete host registry. Package loading is structural;
 * this check happens only after that host has registered its complete tool set.
 */
export interface HarnessRuntimeReadiness {
  adapters: HarnessCapabilityReadiness;
  tools: HarnessCapabilityReadiness & { remove: string[]; conflicts: string[] };
  ready: boolean;
}

export interface HarnessRuntimeReadinessOptions {
  /** The effective tools for this session/host, after native and connector registration. */
  availableTools: HarnessCapabilityRegistry;
  /** Omit to retain the adapter result captured when the stack was resolved. */
  adapterRegistry?: HarnessCapabilityRegistry;
}

export interface HarnessLimits {
  manifestBytes: number;
  instructionBytes: number;
  packageBytes: number;
  packageFiles: number;
  packageEntries: number;
  maxDepth: number;
}

export interface HarnessCatalogOptions {
  homeDir?: string;
  limits?: Partial<HarnessLimits>;
}

export interface ResolveHarnessOptions extends HarnessCatalogOptions {
  catalog?: HarnessCatalog;
  adapterRegistry?: HarnessCapabilityRegistry;
  availableTools?: HarnessCapabilityRegistry;
}
