import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import { PendingDialog, type DialogHost } from '../src/app/dialogs.js';
import type { ApprovalRequest } from '../src/agent/approval.js';

// Layout contract for the Snowfall question/approval dialog: a centered, fully framed panel that
// never exceeds the terminal, word-wraps instead of truncating, and keeps an over-long question
// fully reachable (PgUp/PgDn) instead of silently cutting it.

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
const PGDN = '\x1b[6~';
const PGUP = '\x1b[5~';

const LONG_Q =
  'We found three candidate root causes for the dropped tool calls. The first is the provider ' +
  'output cap, the second is the model narrating intent before ending its turn, and the third ' +
  'is a server-side token ceiling. Which should we fix first, and should we add a regression ' +
  'test before we ship to both channels? END-SENTINEL';

function host(): DialogHost {
  return {
    decide() {},
    onQuestionIndexChange() {},
    repaint() {},
    getAutonomy: () => 'auto-read' as never,
    selections: {},
    cursors: {},
  } as unknown as DialogHost;
}

function question(q = LONG_Q): ApprovalRequest {
  return {
    kind: 'user_question',
    preview: 'q',
    risk: 'low',
    reason: '',
    questions: [
      {
        header: 'Priority',
        question: q,
        options: [
          {
            label: 'Output cap (Recommended)',
            description: 'Clamp and retry on the advertised cap, then remember it',
          },
          { label: 'Narration', description: 'nudge the model' },
          { label: 'Server ceiling', description: 'raise the serve limit' },
        ],
      },
    ],
  } as unknown as ApprovalRequest;
}

const SIZES: Array<[number, number]> = [
  [200, 50],
  [120, 30],
  [90, 22],
  [70, 16],
  [40, 12],
  [30, 10],
  [24, 8],
  [160, 12],
];

test('dialog: fits the terminal, fully framed, horizontally centered at every size', () => {
  for (const [W, H] of SIZES) {
    const lines = new PendingDialog(question(), host(), () => ({ cols: W, rows: H })).render(W);
    const plain = lines.map(strip);
    assert.ok(lines.length <= H, `${W}x${H}: ${lines.length} rows exceeds terminal`);
    for (const l of lines) assert.ok(visibleWidth(l) <= W, `${W}x${H}: row wider than terminal`);
    assert.ok(plain[0]!.includes('╭') && plain[0]!.includes('╮'), `${W}x${H}: top border`);
    assert.ok(
      plain.at(-1)!.includes('╰') && plain.at(-1)!.includes('╯'),
      `${W}x${H}: bottom border`,
    );
    const leftGutter = plain[0]!.length - plain[0]!.trimStart().length;
    const rightGutter = W - visibleWidth(plain[0]!.trimEnd());
    assert.ok(
      Math.abs(leftGutter - rightGutter) <= 1,
      `${W}x${H}: not centered (${leftGutter}/${rightGutter})`,
    );
  }
});

test('dialog: a question that fits is shown whole — no ellipsis, no scroll marker', () => {
  const lines = new PendingDialog(question(), host(), () => ({ cols: 120, rows: 40 }))
    .render(120)
    .map(strip)
    .join('\n');
  assert.ok(lines.includes('END-SENTINEL'), 'tail of the question is visible');
  assert.ok(!lines.includes('PgUp/PgDn'), 'no scroll hint when nothing is hidden');
});

test('dialog: an over-long question scrolls with PgDn/PgUp and every word is reachable', () => {
  const W = 60;
  const H = 14;
  const q = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ') + ' END-SENTINEL';
  const d = new PendingDialog(question(q), host(), () => ({ cols: W, rows: H }));
  const first = d.render(W).map(strip).join('\n');
  assert.match(first, /more line/, 'tells the user more of the question exists');
  assert.match(first, /PgUp\/PgDn/, 'tells the user how to read it');
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const r = d.render(W);
    assert.ok(r.length <= H, 'scrolling never grows the dialog past the terminal');
    for (const l of r) for (const w of strip(l).split(/[\s│]+/)) seen.add(w);
    d.handleInput(PGDN);
  }
  for (const w of q.split(' ')) assert.ok(seen.has(w), `word "${w}" was never shown`);
  for (let i = 0; i < 40; i++) d.handleInput(PGUP);
  assert.ok(d.render(W).map(strip).join(' ').includes('w0 '), 'PgUp returns to the start');
});

test('dialog: option descriptions wrap instead of being cut, recommended badge shown once', () => {
  const lines = new PendingDialog(question('Short?'), host(), () => ({ cols: 50, rows: 30 }))
    .render(50)
    .map(strip)
    .join('\n');
  assert.ok(lines.includes('remember it'), 'end of a long description is visible');
  assert.equal((lines.match(/recommended/gi) ?? []).length, 1, 'one recommended marker');
});

test('dialog: approval keeps the hidden-text warning and command tail on tiny terminals', () => {
  const preview = 'rm -rf build && ' + 'x'.repeat(2000) + ' TAIL';
  for (const [W, H] of SIZES) {
    const req = {
      kind: 'shell',
      preview,
      risk: 'high',
      reason: 'deletes files',
      questions: [],
    } as unknown as ApprovalRequest;
    const lines = new PendingDialog(req, host(), () => ({ cols: W, rows: H })).render(W);
    const plain = lines.map(strip).join('\n');
    assert.ok(lines.length <= H, `${W}x${H}: fits`);
    assert.ok(plain.includes('TAIL'), `${W}x${H}: command tail visible`);
    assert.match(plain, /not shown|hidden|partial/, `${W}x${H}: says the preview is partial`);
  }
});

// ── Review regressions: below 8 rows / 24 columns, emoji, and inert commit keys ─────────────────

function permission(preview: string, extra: Record<string, unknown> = {}): ApprovalRequest {
  return {
    kind: 'permission',
    preview,
    risk: 'high',
    reason: 'deletes files',
    questions: [],
    ...extra,
  } as unknown as ApprovalRequest;
}

function deciding(): DialogHost & { got: unknown[] } {
  const got: unknown[] = [];
  return { ...host(), got, decide: (d: unknown) => got.push(d) } as unknown as DialogHost & {
    got: unknown[];
  };
}

test('dialog: every size either shows the command tail + partial marker, or refuses to decide', () => {
  const previews = [
    'rm -rf build && ' + 'x'.repeat(2000) + ' TAIL',
    'echo ' + '❤\uFE0F'.repeat(300) + ' TAIL',
  ];
  for (let W = 10; W <= 200; W += 7) {
    for (let H = 1; H <= 30; H++) {
      for (const p of previews) {
        const h = deciding();
        const d = new PendingDialog(permission(p), h, () => ({ cols: W, rows: H }));
        const lines = d.render(W);
        const plain = lines.map(strip).join('\n');
        assert.ok(lines.length <= Math.max(1, H - 1), `${W}x${H}: ${lines.length} rows`);
        for (const l of lines)
          assert.ok(visibleWidth(l) <= W, `${W}x${H}: row wider than terminal`);
        const small = (d as unknown as { tooSmall: boolean }).tooSmall;
        d.handleInput('y');
        if (small) {
          assert.ok(
            !plain.includes('approve?') && !plain.includes('(y)es'),
            `${W}x${H}: too-small frame offers no verbs`,
          );
          assert.equal(h.got.length, 0, `${W}x${H}: y must not approve an unshown command`);
        } else {
          assert.ok(plain.includes('TAIL'), `${W}x${H}: tail visible`);
          const complete =
            (plain.match(/x/g) ?? []).length >= 2000 || (plain.match(/❤/g) ?? []).length >= 300;
          if (!complete) assert.match(plain, /partial/, `${W}x${H}: partial marker visible`);
          assert.match(plain, /\[high\]/, `${W}x${H}: risk/reason line visible`);
          assert.deepEqual(h.got, ['approve'], `${W}x${H}: y approves once shown`);
        }
      }
    }
  }
});

test('dialog: emoji with variation selectors never hide command text without counting it', () => {
  // `❤` + VS16 is two columns wide as a grapheme but measured 1+0 per code point.
  const secret = '; rm -rf ~/precious';
  for (const n of [10, 37, 38, 39, 40, 41, 60, 90]) {
    const p = 'echo ' + '❤\uFE0F'.repeat(n) + ' ' + secret + ' ' + 'y'.repeat(200);
    for (const W of [60, 80, 120]) {
      const lines = new PendingDialog(permission(p), host(), () => ({ cols: W, rows: 40 }))
        .render(W)
        .map(strip);
      const shown = lines.join('');
      const hidden = Number(/(\d+) more characters not shown/.exec(shown)?.[1] ?? 0);
      assert.ok(
        !lines.some((l) => l.includes('…') && !l.includes('…y') && !l.includes('more')),
        `${W} n=${n}: a row was ellipsised by the frame`,
      );
      if (!shown.replace(/[│\s]/g, '').includes(secret.replace(/\s/g, ''))) {
        assert.ok(hidden > 0, `${W} n=${n}: "${secret}" not shown and not counted`);
      }
    }
  }
});

test('dialog: the highlighted option is always on screen, or Enter is inert', () => {
  for (let W = 14; W <= 120; W += 9) {
    for (let H = 3; H <= 24; H++) {
      for (const c of [0, 3, 7]) {
        const h = deciding();
        h.cursors[0] = c;
        const opts = Array.from({ length: 8 }, (_, i) => ({
          label: `Opt${i}`,
          description: 'detail '.repeat(i * 3),
        }));
        const req = {
          kind: 'user_question',
          preview: 'q',
          risk: 'low',
          reason: '',
          questions: [{ question: 'long '.repeat(80), options: opts }],
        } as unknown as ApprovalRequest;
        const d = new PendingDialog(req, h, () => ({ cols: W, rows: H }));
        const plain = d.render(W).map(strip).join('\n');
        const small = (d as unknown as { tooSmall: boolean }).tooSmall;
        d.handleInput('\r');
        if (small) assert.equal(h.got.length, 0, `${W}x${H}: Enter committed an unseen option`);
        else {
          assert.ok(
            plain.includes(`Opt${c}`),
            `${W}x${H} cursor ${c}: highlighted option not visible`,
          );
          assert.equal(h.got.length, 1, `${W}x${H}: Enter commits once visible`);
        }
      }
    }
  }
});

test('dialog: acknowledge-only offers no approve verbs and every key answers deny', () => {
  for (const key of ['y', 's', 'a', 'f', '\r']) {
    const h = deciding();
    const d = new PendingDialog(
      permission('rm -rf /', { acknowledgeOnly: true, reason: '⛔ BLOCKED — acknowledge only' }),
      h,
      () => ({ cols: 100, rows: 30 }),
    );
    const plain = d.render(100).map(strip).join('\n');
    assert.match(plain, /any key/);
    assert.doesNotMatch(plain, /\(y\)es|\(s\)ession|\(a\)lways/);
    d.handleInput(key);
    assert.deepEqual(h.got, ['deny'], `key ${JSON.stringify(key)}`);
  }
});

test('dialog: PgDn presses between paints clamp, so one PgUp moves back immediately', () => {
  const W = 60;
  const H = 14;
  const q = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ') + ' END-SENTINEL';
  const d = new PendingDialog(question(q), host(), () => ({ cols: W, rows: H }));
  d.render(W);
  for (let i = 0; i < 50; i++) d.handleInput(PGDN); // no render in between
  const atEnd = d.render(W).map(strip).join(' ');
  assert.ok(atEnd.includes('END-SENTINEL'));
  d.handleInput(PGUP);
  assert.notEqual(d.render(W).map(strip).join(' '), atEnd, 'first PgUp after the end is not dead');
});

test('dialog: degenerate requests (no options, empty text, 1x1 terminal) render without throwing', () => {
  const reqs = [
    {
      kind: 'user_question',
      preview: 'q',
      risk: 'low',
      reason: '',
      questions: [{ question: 'no options?', options: [] }],
    },
    {
      kind: 'user_question',
      preview: 'q',
      risk: 'low',
      reason: '',
      questions: [{ question: '', options: [{ label: '' }] }],
    },
    { kind: 'permission', preview: '', risk: 'low', reason: '', questions: [] },
  ] as unknown as ApprovalRequest[];
  for (const req of reqs) {
    for (const [W, H] of [
      [1, 1],
      [10, 1],
      [30, 3],
      [80, 24],
      [300, 100],
    ] as const) {
      const d = new PendingDialog(req, deciding(), () => ({ cols: W, rows: H }));
      const lines = d.render(W);
      assert.ok(lines.length <= Math.max(1, H - 1), `${req.kind} ${W}x${H}`);
      d.handleInput('\r');
    }
  }
});
