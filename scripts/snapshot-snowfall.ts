// Node-only deterministic review artifact. --update deliberately refreshes the checked-in goldens.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { THEME_NAMES, THEMES } from '../src/tui/theme.js';
import { fixture } from '../test/helpers/snowfallTerminal.js';

const out = join(process.cwd(), '.tmp/snowfall');
mkdirSync(out, { recursive: true });
const frames: Record<string, { lines: string[]; attributes: string }> = {};
const previews: Record<string, { background: string; rows: string[] }> = {};
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
for (const theme of THEME_NAMES) for (const width of [80, 120, 200]) for (const splash of [false, true]) {
  const f = fixture(theme, width, 36, splash);
  try {
    f.tui.renderNow(true);
    await f.terminal.flush();
    const cells = f.terminal.cells();
    const key = `${theme}/${width}`;
    if (!splash) frames[key] = {
      lines: f.terminal.lines(), attributes: createHash('sha256').update(JSON.stringify(cells)).digest('hex'),
    };
    const color = (mode: number, value: number, fallback: string) => mode === 0x3000000 ? `#${value.toString(16).padStart(6, '0')}` : fallback;
    const background = THEMES[theme].bg ?? (theme === 'light' ? '#ffffff' : '#11151c');
    previews[`${key}/${splash ? 'welcome' : 'conversation'}`] = {
      background,
      rows: cells.map((row) => {
        const runs: { css: string; text: string; width: number }[] = [];
        for (const [text, fgMode, fg, bgMode, bg, flags] of row) {
          let foreground = color(fgMode, fg, THEMES[theme].fg);
          let backdrop = color(bgMode, bg, background);
          if (flags & 4) [foreground, backdrop] = [backdrop, foreground];
          const css = `color:${foreground};background:${backdrop};${flags & 1 ? 'font-weight:bold;' : ''}${flags & 2 ? 'font-style:italic;' : ''}${flags & 8 ? 'text-decoration:underline;' : ''}`;
          const prev = runs.at(-1);
          if (prev?.css === css) { prev.text += text; prev.width++; }
          else runs.push({ css, text, width: 1 });
        }
        return runs.map((run) => `<span style="display:inline-block;width:${run.width}ch;${run.css}">${escape(run.text)}</span>`).join('');
      }),
    };
  } finally { f.tui.stop({ preserveScreen: true }); f.terminal.screen.dispose(); }
}
if (process.argv.includes('--update')) {
  mkdirSync('test/fixtures', { recursive: true });
  writeFileSync('test/fixtures/snowfall-frames.json', JSON.stringify(frames, null, 2) + '\n');
}
writeFileSync(join(out, 'frames.json'), JSON.stringify(frames, null, 2) + '\n');
writeFileSync(join(out, 'preview.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><title>Shadow Snowfall review</title>
<style>body{margin:28px;background:#0b121b;color:#d4dde7;font:15px system-ui}h1{font-size:22px}label{margin-right:20px}select{padding:6px;background:#233e54;color:#fff;border:1px solid #7893ad;border-radius:4px}pre{display:inline-block;font:12.5px/1.35 Menlo,Consolas,monospace;padding:16px;border:1px solid #7893ad;border-radius:8px}p{color:#9cadc1}</style>
<h1>✻ Shadow · Snowfall</h1><p>Recorded terminal frames from the production fullscreen engine. These are deterministic review fixtures.</p>
<label>Theme <select id="theme">${THEME_NAMES.map((name) => `<option>${name}</option>`).join('')}</select></label>
<label>Columns <select id="width"><option>80</option><option selected>120</option><option>200</option></select></label>
<label>View <select id="view"><option>conversation</option><option>welcome</option></select></label><div><pre id="screen"></pre></div>
<script>const frames=${JSON.stringify(previews).replaceAll('<', '\\u003c')};const ids=['theme','width','view'];function paint(){const f=frames[ids.map(id=>document.getElementById(id).value).join('/')];const s=document.getElementById('screen');s.style.background=f.background;s.innerHTML=f.rows.join(String.fromCharCode(10))}for(const id of ids)document.getElementById(id).onchange=paint;paint();</script></html>`);
console.log(`Snowfall: ${Object.keys(frames).length} golden frames; ${Object.keys(previews).length} review frames in ${out}/preview.html`);
