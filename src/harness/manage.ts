import { loadGlobalConfig, saveGlobalConfig } from '../state/globalStore.js';
import { discoverHarnessCatalog, loadHarnessPackage } from './catalog.js';
import { MAX_SELECTED_HARNESS_ADDONS, SHADOW_SECURITY_FOUNDATION } from './resolver.js';

export type HarnessSelectionAction = 'enable' | 'disable' | 'use';

export function configuredHarnessIds(): string[] {
  const raw = loadGlobalConfig().harnesses;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((id): id is string => typeof id === 'string'))];
}

export function harnessInventoryLines(currentIds: readonly string[] = []): string[] {
  const selected = configuredHarnessIds();
  const catalog = discoverHarnessCatalog();
  const lines = [
    `● ${SHADOW_SECURITY_FOUNDATION.id} v${SHADOW_SECURITY_FOUNDATION.version} [always on] — ${SHADOW_SECURITY_FOUNDATION.description}`,
  ];
  for (const pkg of catalog.packages) {
    const next = selected.includes(pkg.id);
    const current = currentIds.includes(pkg.id);
    const state = [current ? 'current' : '', next ? 'next session' : 'disabled'].filter(Boolean).join(', ');
    lines.push(`${current || next ? '●' : '○'} ${pkg.id} v${pkg.manifest.version} [${state}] — ${pkg.manifest.description}`);
  }
  for (const issue of catalog.issues) lines.push(`! ${issue.directory ?? 'catalog'} — ${issue.message}`);
  if (catalog.packages.length === 0 && catalog.issues.length === 0) {
    lines.push(`No add-ons found under ${catalog.root}.`);
  }
  lines.push('Use /harness enable <id>, disable <id>, use <id>, or use security. Changes apply to a new session.');
  return lines;
}

export function harnessDetailLines(id: string): string[] {
  if (id === 'security' || id === SHADOW_SECURITY_FOUNDATION.id) {
    return [
      `${SHADOW_SECURITY_FOUNDATION.title} (${SHADOW_SECURITY_FOUNDATION.id}@${SHADOW_SECURITY_FOUNDATION.version})`,
      SHADOW_SECURITY_FOUNDATION.description,
      `digest: ${SHADOW_SECURITY_FOUNDATION.digest}`,
      'Always on · provider and endpoint neutral',
    ];
  }
  const pkg = loadHarnessPackage(id);
  return [
    `${pkg.manifest.title} (${pkg.id}@${pkg.manifest.version})`,
    pkg.manifest.description,
    `digest: ${pkg.digest}`,
    `files: ${pkg.files.length} · bytes: ${pkg.bytes} · instructions: ${pkg.instructions.length}`,
    `required tools: ${pkg.manifest.tools.add.join(', ') || '(none)'}`,
    `removed tools: ${pkg.manifest.tools.remove.join(', ') || '(none)'}`,
    `compiled adapters: ${pkg.manifest.requiredAdapters.join(', ') || '(none)'}`,
  ];
}

export function updateHarnessSelection(action: HarnessSelectionAction, id: string): string[] {
  const normalized = id.trim();
  if (!normalized) throw new Error(`usage: /harness ${action} <id>`);
  const selected = configuredHarnessIds();
  let next: string[];
  if (action === 'use' && (normalized === 'security' || normalized === SHADOW_SECURITY_FOUNDATION.id || normalized === 'none')) {
    next = [];
  } else {
    if (action !== 'disable') loadHarnessPackage(normalized);
    if (action === 'use') next = [normalized];
    else if (action === 'enable') {
      next = [...new Set([...selected, normalized])];
      if (next.length > MAX_SELECTED_HARNESS_ADDONS) {
        throw new Error(`at most ${MAX_SELECTED_HARNESS_ADDONS} harness add-ons may be selected`);
      }
    }
    else next = selected.filter((item) => item !== normalized);
  }
  saveGlobalConfig({ harnesses: next });
  return next;
}
