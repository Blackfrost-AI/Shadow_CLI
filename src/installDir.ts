import { fileURLToPath } from 'node:url';

/**
 * Package root. Same depth as index.ts:101 (`src/` → parent), so the expression is unchanged.
 * Web files import THIS rather than index.ts — importing index.ts from src/web/* would pull in
 * its top-level main().
 */
export const INSTALL_DIR = fileURLToPath(new URL('..', import.meta.url));
