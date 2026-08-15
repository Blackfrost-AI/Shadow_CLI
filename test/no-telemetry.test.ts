import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8');
}

test('CLI and TUI provider creation do not attach persistent user metadata', () => {
  const runtimeSources = ['src/index.ts', 'src/tui.tsx'].map(read).join('\n');

  assert.doesNotMatch(runtimeSources, /\bmetadataUserId\b/);
  assert.doesNotMatch(runtimeSources, /\binstallUserId\b|\bgetInstallId\b/);
});

test('global state does not create install identifiers', () => {
  const source = read('src/state/globalStore.ts');

  assert.doesNotMatch(source, /\binstallId\b/);
  assert.doesNotMatch(source, /\binstallUserId\b|\bgetInstallId\b/);
  assert.doesNotMatch(source, /\brandomUUID\b/);
});

test('Anthropic request shaping has no user identifier metadata wiring', () => {
  const source = read('src/provider/anthropic.ts');

  assert.doesNotMatch(source, /\bmetadataUserId\b/);
  assert.doesNotMatch(source, /metadata\s*=\s*\{\s*user_id/);
});

// ── P2-02.1 · Host snapshot guard ─────────────────────────────────────────────
// Shadow is zero-telemetry by contract. Every hardcoded remote host in src/ is part of the
// egress surface, so the EXACT set is pinned here: adding (or moving) a host fails this test
// and forces the deliberate-review path — a THREAT_MODEL.md row + a `doctor --privacy` update —
// before the snapshot may be re-pinned. Composes with P2-01's ESLint guard, which bans raw
// fetch()/undici imports outside the broker.

/** Walk src/ for TS sources, skipping the web console's browser-side assets (they run in the
 *  user's tab, not in Shadow's Node process, so their URLs are not Shadow's egress surface). */
function listSrcFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === 'ui') continue; // browser front-end
      listSrcFiles(p, out);
    } else if (/\.tsx?$/.test(entry) && entry !== 'bundledAssets.ts' && entry !== 'bundledPrompts.ts') {
      // bundledAssets.ts = browser-side JS; bundledPrompts.ts = policy prose (its "curl
      // https://evil.com" example is a documented attack, not Shadow's egress surface).
      out.push(p);
    }
  }
  return out;
}

/** Drop full-line comments so documented attack examples and UI hint placeholders
 *  ("https://evil.sh", "http://host:8813") don't count as live surface. */
function codeLines(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^\s*(?:\/\/|\/?\*)/.test(l))
    .join('\n');
}

/** The pinned snapshot of hardcoded remote hosts (loopback excluded — local serves are a
 *  deliberate, operator-configured feature, not egress surface). Alphabetical. */
const HOST_SNAPSHOT = [
  'aistudio.google.com', // Gemini console link
  'api.anthropic.com', // provider default
  'api.deepseek.com', // catalog preset
  'api.groq.com', // catalog preset
  'api.mistral.ai', // catalog preset
  'api.moonshot.ai', // catalog preset
  'api.openai.com', // provider default
  'api.together.xyz', // catalog preset
  'api.x.ai', // catalog preset
  'api.z.ai', // catalog preset (GLM)
  'auth.openai.com', // opt-in `shadow login codex` OAuth
  'bailian.console.aliyun.com', // catalog preset console link
  'chatgpt.com', // Codex OAuth client origin
  'console.anthropic.com', // catalog preset console link
  'console.groq.com', // catalog preset console link
  'console.mistral.ai', // catalog preset console link
  'console.x.ai', // catalog preset console link
  'dashscope.aliyuncs.com', // catalog preset (Qwen via Aliyun)
  'duckduckgo.com', // web_search tool (model-origin, netguard + pin)
  'generativelanguage.googleapis.com', // catalog preset
  'github.com', // Blackfrost-AI repo links
  'openrouter.ai', // catalog preset
  'platform.deepseek.com', // catalog preset console link
  'platform.moonshot.ai', // catalog preset console link
  'platform.openai.com', // catalog preset console link
  'raw.githubusercontent.com', // update channel metadata
  'shadow.redpillreader.com', // binary release origin (signed manifest)
  'z.ai', // catalog preset console link
];

test('hardcoded remote-host snapshot — new egress hosts require deliberate review (P2-02.1)', () => {
  const hosts = new Set<string>();
  for (const f of listSrcFiles(join(repoRoot, 'src'))) {
    for (const m of codeLines(readFileSync(f, 'utf8')).matchAll(/https?:\/\/([a-z0-9][a-z0-9.-]*)/gi)) {
      const h = m[1]!.toLowerCase().replace(/\.$/, '');
      if (h === 'localhost' || h === '127.0.0.1') continue;
      hosts.add(h);
    }
  }
  const actual = [...hosts].sort();
  assert.deepEqual(
    actual,
    HOST_SNAPSHOT,
    'The hardcoded remote-host snapshot changed. Shadow is zero-telemetry: every NEW egress ' +
      'destination needs a THREAT_MODEL.md row + a `doctor --privacy` update + deliberate review ' +
      'before it may ship. If this change was that deliberate review, re-pin HOST_SNAPSHOT in ' +
      'test/no-telemetry.test.ts.',
  );
});

test('raw fetch() call sites are capped: the broker transport + one inline browser template (P2-02.1)', () => {
  const offenders: string[] = [];
  for (const f of listSrcFiles(join(repoRoot, 'src'))) {
    if (/\bfetch\s*\(/.test(codeLines(readFileSync(f, 'utf8')))) offenders.push(relative(repoRoot, f));
  }
  offenders.sort();
  assert.deepEqual(
    offenders,
    ['src/onboard/webOnboard.ts', 'src/safety/egress.ts'],
    'A new raw fetch() call site appeared. All Node-side egress must flow through shadowFetch() ' +
      '(src/safety/egress.ts) so the offline wall, SSRF policy, DNS pinning and the receipt stay ' +
      'real. src/onboard/webOnboard.ts is pinned: its fetch is inline BROWSER JS in the onboard ' +
      "page template that POSTs to Shadow's own loopback server — not Shadow's egress.",
  );
});
