/** Config keys that may be inspected and changed from an interactive renderer. */
export const SAFE_CONFIG_KEYS = [
  'temperature',
  'fastMode',
  'effort',
  'cacheTtl',
  'maxIterations',
  'maxOutputTokens',
  'autoClassifier',
  'parallelTools',
  'costWarnUSD',
] as const;

export type SafeConfigKey = (typeof SAFE_CONFIG_KEYS)[number];

function parseBool(value: string): boolean | null {
  const normalized = value.toLowerCase();
  if (['on', 'true', 'yes', '1'].includes(normalized)) return true;
  if (['off', 'false', 'no', '0'].includes(normalized)) return false;
  return null;
}

export function parseSafeConfig(
  key: string,
  raw: string,
): { ok: true; key: SafeConfigKey; value: unknown } | { ok: false; message: string } {
  if (!(SAFE_CONFIG_KEYS as readonly string[]).includes(key)) {
    return { ok: false, message: `Config key "${key}" is not editable here. Editable: ${SAFE_CONFIG_KEYS.join(', ')}` };
  }
  const safeKey = key as SafeConfigKey;
  if (safeKey === 'fastMode' || safeKey === 'autoClassifier' || safeKey === 'parallelTools') {
    const value = parseBool(raw);
    return value === null ? { ok: false, message: `Use on/off for ${safeKey}.` } : { ok: true, key: safeKey, value };
  }
  if (safeKey === 'effort') {
    const allowed = ['low', 'medium', 'high', 'xhigh', 'max'];
    return allowed.includes(raw)
      ? { ok: true, key: safeKey, value: raw }
      : { ok: false, message: `effort must be one of: ${allowed.join(', ')}` };
  }
  if (safeKey === 'cacheTtl') {
    return raw === '5m' || raw === '1h'
      ? { ok: true, key: safeKey, value: raw }
      : { ok: false, message: 'cacheTtl must be 5m or 1h.' };
  }
  if (safeKey === 'costWarnUSD') {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0
      ? { ok: true, key: safeKey, value }
      : { ok: false, message: 'costWarnUSD must be a positive number (e.g. 5).' };
  }
  if (safeKey === 'temperature') {
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 && value <= 2
      ? { ok: true, key: safeKey, value }
      : { ok: false, message: 'temperature must be a number from 0 to 2 (default 1.0).' };
  }
  if (safeKey === 'maxOutputTokens') {
    const value = Number(raw);
    return Number.isInteger(value) && value >= 256
      ? { ok: true, key: safeKey, value }
      : { ok: false, message: 'maxOutputTokens must be an integer ≥ 256 (e.g. 65536).' };
  }
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0
    ? { ok: true, key: safeKey, value }
    : { ok: false, message: `${safeKey} must be a non-negative integer.` };
}

/** Keep the documented default visibly `1.0` while preserving useful fractional precision. */
export function formatTemperature(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}
