import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig } from 'eslint/config';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';

export default defineConfig([
  eslintPluginPrettierRecommended,
  {
    files: ['src/**/*.ts'],
    ignores: ['**/node_modules/**', '**/dist/**', '**/*.js', '**/*.mjs', '**/*.cjs'],
    plugins: { js },
    extends: ['js/recommended'],
    rules: {
      /* Every outbound request must carry a host policy, timeout, redirect re-validation and a
         response size cap. Bare `fetch` had none of those, which is how several SSRF and
         unbounded-read issues got in. Use `guardedFetch` from `@fxembed/atmosphere/net`. */
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            'Use guardedFetch from @fxembed/atmosphere/net so the request is host-checked, bounded and redirect-safe.'
        }
      ],
      'prefer-arrow-callback': 1,
      'jsdoc/require-jsdoc': 0,
      'jsdoc/require-param': 0,
      'jsdoc/require-returns': 0,
      '@typescript-eslint/no-non-null-assertion': 0,
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ]
    },
    // ignorePatterns: ['**/node_modules/**'],
    languageOptions: { globals: globals.browser }
  },
  tseslint.configs.recommended
]);
