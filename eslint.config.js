import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/target/**',
      'apps/desktop/src-tauri/**',
      '.cache/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  { files: ['apps/**/*.{ts,tsx}'], languageOptions: { globals: { ...globals.browser } } },
  {
    files: ['scripts/**', '**/scripts/**', 'tests/**', '**/test/**', '**/*.config.{js,ts}'],
    rules: { 'no-console': 'off' },
  },
);
