import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      'web/**',
      'scripts/**',
      '.dev-data/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  {
    files: [
      'src/**/*.{ts,tsx}',
      'electron-tests/**/*.ts',
      '*.config.{ts,mts}',
      'eslint.config.mjs',
    ],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
  },
);
