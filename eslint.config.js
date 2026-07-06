import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.tmp/**', 'eval/**/*.mjs'] },
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
