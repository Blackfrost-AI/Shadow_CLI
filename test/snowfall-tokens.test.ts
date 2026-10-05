import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { GLYPHS, PROMPT_WIDTH, stripPrompt } from '../src/tui/glyphs.js';
import { THEMES, applyTheme, paletteSnapshot } from '../src/tui/theme.js';
import { displayWidth } from '../src/util/width.js';

test('Snowfall tokens preserve the two-cell composer and old saved prompts', () => {
  assert.equal(PROMPT_WIDTH, 2);
  for (const frame of GLYPHS.spinner) assert.equal(displayWidth(frame), 1);
  assert.equal(displayWidth(GLYPHS.resultPrefix), 4);
  assert.equal(stripPrompt(`${GLYPHS.promptPrefix}hello`), 'hello');
  assert.equal(stripPrompt(`${GLYPHS.legacyPromptPrefix}hello`), 'hello');
  assert.equal(stripPrompt('plain text'), 'plain text');
});

test('presentation literals cannot reintroduce the borrowed vocabulary outside glyphs.ts', () => {
  const forbidden = /[\u23fa\u276f\u23bf\u258c\u25d0\u25d1\u25d2\u25d3]/;
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'vendor') walk(path); continue; }
      if (!/\.tsx?$/.test(path) || /(?:glyphs|bundledAssets|bundledPrompts)\.ts$/.test(path)) continue;
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node) || ts.isRegularExpressionLiteral(node) ||
            [ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail, ts.SyntaxKind.JsxText].includes(node.kind)) {
          assert.doesNotMatch(node.getText(source), forbidden, `${path}: tokenize this presentation literal`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  walk(new URL('../src', import.meta.url).pathname);
});

test('Snowfall text clears AA on its background and panel surfaces', () => {
  const t = THEMES.snowfall;
  const lum = (hex: string) => hex.slice(1).match(/../g)!.map(x => parseInt(x, 16) / 255)
    .map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4)
    .reduce((n, x, i) => n + x * [.2126, .7152, .0722][i]!, 0);
  for (const bg of [t.bg, t.panel, t.menuBg, t.userBg]) {
    for (const key of ['fg', 'body', 'dim', 'accent', 'user', 'cyan', 'green', 'red', 'yellow', 'purple'] as const) {
      const [lo, hi] = [lum(bg), lum(t[key])].sort((a, b) => a - b);
      assert.ok((hi! + .05) / (lo! + .05) >= 4.5, `${key} on ${bg}`);
    }
  }
  applyTheme('snowfall');
  applyTheme('light');
  assert.equal(paletteSnapshot().panel, undefined, 'optional chrome roles must not leak between palettes');
  applyTheme('og');
});
