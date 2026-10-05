// Run with Node/tsx and as a Bun --compile executable; compare stdout byte-for-byte.
import assert from 'node:assert/strict';
import { SHADOW_LOGOTYPE, SHADOW_ICON_ART, SHADOW_COMPACT, SHADOW_LOGOTYPE_WIDTH, SHADOW_ICON_WIDTH } from '../src/tui/brand.js';
import { THEMES } from '../src/tui/theme.js';
import { renderBrand } from '../src/tui/rows.js';
import { displayWidth } from '../src/util/width.js';

const frames = Object.entries(THEMES).flatMap(([name, theme]) =>
  [20, 28, 40, 80, 120, 200].map((width) => {
    const rows = renderBrand({ version: '10', providerModel: 'mock/frost', workspace: '/workspace', help: '/help', art: SHADOW_LOGOTYPE }, theme, width);
    for (const row of rows) {
      const text = row.map((s) => s.text).join('');
      assert.ok(displayWidth(text) <= width, `${name} at ${width}: ${text}`);
      assert.doesNotMatch(text, /\\u[0-9a-f]{4}/i);
    }
    return { name, width, rows };
  }),
);
process.stdout.write(JSON.stringify({ SHADOW_LOGOTYPE, SHADOW_ICON_ART, SHADOW_COMPACT, SHADOW_LOGOTYPE_WIDTH, SHADOW_ICON_WIDTH, frames }) + '\n');
