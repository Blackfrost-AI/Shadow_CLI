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
    // Browser JavaScript is not covered by TypeScript, so lint is its static-analysis boundary.
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
