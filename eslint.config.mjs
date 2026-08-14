import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig } from 'eslint/config';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';

export default defineConfig([
  {
    /* Global ignore. In flat config an `ignores` key alongside `files` only scopes that one block,
       so machine-generated output has to be excluded here to be excluded at all.
       `src/generated/**` is written by tools/make-logo.mjs and never hand-edited. */
    ignores: ['src/generated/**']
  },
  eslintPluginPrettierRecommended,
  {
    files: ['src/**/*.ts'],
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs',
      /* Machine output from tools/make-logo.mjs — regenerated, never hand-edited, and its long
         base64 literals are not worth reformatting. Mirrors the atmosphere config's exclusion of
         src/relay/generated. */
      'src/generated/**'
    ],
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
