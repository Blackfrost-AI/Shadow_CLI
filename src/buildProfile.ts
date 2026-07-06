/**
 * Guardrails (filesystem jail + OS sandbox) ship ON by default. Dropping them is OPT-IN:
 * set `SHADOW_DEV_UNRESTRICTED=1` to run the unrestricted dev/dangerous mode. A default
 * install (env unset) is always guardrails-ON — the public release never ships with them off.
 */
export const DEV_UNRESTRICTED = process.env.SHADOW_DEV_UNRESTRICTED === '1';

/**
 * Whether a run drops the filesystem jail + OS sandbox ("unrestricted"). True when:
 *   • --yolo (and aliases), OR
 *   • full autonomy ("full auto", `autonomy==='full'`), OR
 *   • the dev build (DEV_UNRESTRICTED=true) unless guardrails are force-enabled
 *     (SHADOW_GUARDRAILS=on → `guardrailsForced`).
 * The sterile public build (DEV_UNRESTRICTED=false) is guardrails-ON by default, so there only
 * --yolo or full-auto remove them. NOTE: this governs jail+sandbox only — the catastrophic-command
 * denylist and permission gating are separate (denylist is dropped only by --yolo).
 */
export function resolveUnrestricted(opts: { yolo?: boolean; autonomy?: string; guardrailsForced?: boolean }): boolean {
  return !!opts.yolo || opts.autonomy === 'full' || (DEV_UNRESTRICTED && !opts.guardrailsForced);
}