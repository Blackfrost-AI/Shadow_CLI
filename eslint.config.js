import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.tmp/**', 'eval/**/*.mjs', 'src/web/ui/vendor/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Build/CI scripts are plain Node — give them the Node globals so URL/console/process/etc. resolve.
    files: ['scripts/**/*.{mjs,js}'],
    languageOptions: {
      globals: {
        URL: 'readonly',
        URLSearchParams: 'readonly',
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        module: 'readonly',
        require: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
  {
    // The web console's front-end is hand-written BROWSER JavaScript. Without a globals block every
    // fetch/document/location/window reference was a `no-undef` ERROR — 49 of them, which is why
    // `npm run lint` could never exit 0, which is why nobody ran it, which is how 5 REAL errors sat
    // hidden behind the noise. These files also get no tsc (no allowJs/checkJs), so lint is the
    // only static analysis they have.
    files: ['src/web/ui/**/*.js'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        location: 'readonly',
        history: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        Headers: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        EventSource: 'readonly',
        WebSocket: 'readonly',
        AbortController: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        FileReader: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        queueMicrotask: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        CustomEvent: 'readonly',
        Event: 'readonly',
        MutationObserver: 'readonly',
        ResizeObserver: 'readonly',
        IntersectionObserver: 'readonly',
        getComputedStyle: 'readonly',
        matchMedia: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
      },
    },
  },
  {
    // ── Egress broker guard (P2-01) ───────────────────────────────────────────
    // Every outbound HTTP request Shadow makes must flow through `shadowFetch()` in
    // src/safety/egress.ts — that is how the offline wall, SSRF policy, DNS pinning, and the
    // egress receipt stay REAL instead of aspirational. A bare `fetch(` or a direct undici
    // import anywhere else in src/ is a policy bypass, so it fails lint. The broker itself,
    // and the web console's browser-side JS (which runs in the user's tab, not in Shadow's
    // Node process), are exempt.
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/safety/egress.ts', 'src/web/ui/**', 'src/web/bundledAssets.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'undici',
              message:
                'Route egress through shadowFetch() in src/safety/egress.ts — the offline wall, SSRF policy, DNS pinning and the receipt live there.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='fetch']",
          message: 'Raw fetch() is banned outside the egress broker — use shadowFetch() from src/safety/egress.ts.',
        },
        {
          selector: "CallExpression[callee.object.name='globalThis'][callee.property.name='fetch']",
          message: 'Raw globalThis.fetch() is banned outside the egress broker — use shadowFetch() from src/safety/egress.ts.',
        },
        {
          // Bracket access: globalThis['fetch'](url)
          selector: "CallExpression[callee.object.name='globalThis'][callee.property.value='fetch']",
          message: 'Raw globalThis.fetch() is banned outside the egress broker — use shadowFetch() from src/safety/egress.ts.',
        },
        {
          // Aliasing fetch away: const f = fetch; f(url)
          selector: "VariableDeclarator[init.name='fetch']",
          message: 'Aliasing fetch is banned outside the egress broker — use shadowFetch() from src/safety/egress.ts.',
        },
        {
          // Aliasing fetch away via member read: const g = globalThis.fetch / globalThis['fetch']
          selector: "VariableDeclarator[init.object.name='globalThis'][init.property.name='fetch']",
          message: 'Aliasing globalThis.fetch is banned outside the egress broker — use shadowFetch() from src/safety/egress.ts.',
        },
        {
          selector: "VariableDeclarator[init.object.name='globalThis'][init.property.value='fetch']",
          message: 'Aliasing globalThis.fetch is banned outside the egress broker — use shadowFetch() from src/safety/egress.ts.',
        },
        {
          // Dynamic import('undici')
          selector: "ImportExpression[source.value='undici']",
          message: 'Direct undici use is banned outside the egress broker — use shadowFetch() from src/safety/egress.ts.',
        },
        {
          // require('undici')
          selector: "CallExpression[callee.name='require'][arguments.0.value='undici']",
          message: 'Direct undici use is banned outside the egress broker — use shadowFetch() from src/safety/egress.ts.',
        },
      ],
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // Shadow is a terminal tool: it intentionally matches ANSI/control characters (\x1b, \x07, NUL…)
      // in regexes to strip/handle them. Those matches are deliberate, so this rule is off project-wide.
      'no-control-regex': 'off',
    },
  },
);
