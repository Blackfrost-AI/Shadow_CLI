// A faithful-enough VT emulator to REPLAY the PinnedRegion escape stream onto a grid, so we can
// SEE whether the chrome painter stacks/scrolls frames. Run: npx tsx scripts/vt-repro.ts
import { PinnedRegion } from '../src/tui/pinnedRegion.js';

class Screen {
  rows: number; cols: number; grid: string[][];
  cr = 1; cc = 1; top = 1; bot: number;
  constructor(rows: number, cols: number) {
    this.rows = rows; this.cols = cols; this.bot = rows;
    this.grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ' '));
  }
  private scrollUp() {
    // shift rows top..bot up by one, blank the bottom margin row
    for (let r = this.top; r < this.bot; r++) this.grid[r - 1] = this.grid[r]!.slice();
    this.grid[this.bot - 1] = Array.from({ length: this.cols }, () => ' ');
  }
  private lf() {
    if (this.cr === this.bot) this.scrollUp();
    else if (this.cr < this.rows) this.cr++;
  }
  private put(ch: string) {
    if (this.cc <= this.cols && this.cr >= 1 && this.cr <= this.rows) this.grid[this.cr - 1]![this.cc - 1] = ch;
    this.cc++;
  }
  private edToEnd() {
    for (let c = this.cc; c <= this.cols; c++) this.grid[this.cr - 1]![c - 1] = ' ';
    for (let r = this.cr + 1; r <= this.rows; r++) this.grid[r - 1] = Array.from({ length: this.cols }, () => ' ');
  }
  private ed2() { this.grid = Array.from({ length: this.rows }, () => Array.from({ length: this.cols }, () => ' ')); }
  private el2() { this.grid[this.cr - 1] = Array.from({ length: this.cols }, () => ' '); }
  feed(s: string) {
    let i = 0;
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === '\x1b') {
        if (s[i + 1] === '[') {
          const m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(s.slice(i));
          if (m) {
            const params = m[1]!; const cmd = m[2]!;
            const nums = params.split(';').map((x) => (x === '' ? undefined : parseInt(x, 10)));
            if (cmd === 'H') { this.cr = nums[0] ?? 1; this.cc = nums[1] ?? 1; }
            else if (cmd === 'r') {
              if (params === '') { this.top = 1; this.bot = this.rows; }
              else { this.top = nums[0] ?? 1; this.bot = nums[1] ?? this.rows; }
              this.cr = this.top; this.cc = 1; // DECSTBM homes cursor
            }
            else if (cmd === 'J') { const n = nums[0] ?? 0; if (n === 2 || n === 3) this.ed2(); else this.edToEnd(); }
            else if (cmd === 'K') { this.el2(); }
            // ignore SGR (m), cursor hide/show (?25), sync (?2026), etc.
            i += m[0].length; continue;
          }
        }
        // DECSC/DECRC (ESC7/ESC8), OSC, title — skip 2 chars or to BEL
        if (s[i + 1] === '7' || s[i + 1] === '8') { i += 2; continue; }
        if (s[i + 1] === ']') { const bel = s.indexOf('\x07', i); i = bel < 0 ? s.length : bel + 1; continue; }
        i += 1; continue;
      }
      if (ch === '\n') { this.lf(); i++; continue; }
      if (ch === '\r') { this.cc = 1; i++; continue; }
      if (ch === '\x07') { i++; continue; }
      this.put(ch); i++;
    }
  }
  render(): string {
    return this.grid.map((r, i) => `${String(i + 1).padStart(2)}|${r.join('').replace(/\s+$/, '')}`).join('\n');
  }
}

// ── replay a realistic streaming turn ──
const ROWS = 24, COLS = 60;
const chunks: string[] = [];
const region = new PinnedRegion({ write: (c: string) => (chunks.push(c), true), rows: ROWS, columns: COLS }, 4);
const line = (s: string) => s.slice(0, COLS);

region.enter();
region.insert(Array.from({ length: 8 }, (_, i) => line(`banner-row-${i + 1}`)));   // banner
region.paintChrome('❯ input\nhint\nstrip');                                          // idle composer (k=3)
region.insert([line('❯ show me the weather')]);                                       // user prompt
region.paintChrome('✻ thinking… (1 line)\n  esc to interrupt\n❯ \nhint\nstrip');       // thinking (k=5)
region.insert([line('✻ thought  ⌄ 1 line · ^O')]);                                     // reasoning commit
// streaming a TALL tool preview — this is where the crossing-margin \n would scroll:
region.paintChrome('preview-1\npreview-2\npreview-3\npreview-4\npreview-5\npreview-6\npreview-7\n◐ working…\n❯ \nhint\nstrip'); // k=11
region.insert([line('✓ web_fetch wttr.in/NYC — HTTP 200 (0.6s)')]);                    // tool commit
region.paintChrome('preview-A\npreview-B\npreview-C\npreview-D\npreview-E\n◐ working…\n❯ \nhint\nstrip'); // k=9
region.insert([line('answer line one'), line('answer line two')]);                     // answer blocks commit
region.paintChrome('❯ \nType to queue\nstrip');                                        // turn end, composer only

const screen = new Screen(ROWS, COLS);
screen.feed(chunks.join(''));
console.log(screen.render());

// duplication check: count how many rows contain each distinct non-empty payload token
const counts = new Map<string, number>();
for (const row of screen.grid) {
  const s = row.join('').trim();
  if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
}
const dups = [...counts.entries()].filter(([, n]) => n > 1);
console.log('\n── DUPLICATED ROWS (should be empty) ──');
console.log(dups.length ? dups.map(([s, n]) => `  ${n}×  ${s}`).join('\n') : '  none ✓');
