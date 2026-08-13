import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig } from 'eslint/config';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';

export default defineConfig([
  eslintPluginPrettierRecommended,
  {
    files: ['src/**/*.ts'],
    ignores: ['**/node_modules/**', '**/dist/**', '**/*.d.ts', 'src/relay/generated/**'],
    plugins: { js },
    extends: ['js/recommended'],
    rules: {
      /* Every outbound request must carry a host policy, timeout, redirect re-validation and a
         response size cap. `src/net/guarded-fetch.ts` is the one place allowed to call the
         global, and is exempted below. */
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            'Use guardedFetch from src/net so the request is host-checked, bounded and redirect-safe.'
        }
      ],
      'prefer-arrow-callback': 1,
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
    languageOptions: { globals: { ...globals.browser, ...globals.node } }
  },
  tseslint.configs.recommended,
  {
    // Ambient vendor typings (twitter.d.ts, bluesky.d.ts) are loaded via `///` refs.
    files: ['src/helpers/link-fixer.ts', 'src/helpers/palette.ts'],
    rules: {
      '@typescript-eslint/triple-slash-reference': 'off'
    }
  },
  {
    // The guard itself has to call the global it is wrapping.
    files: ['src/net/guarded-fetch.ts'],
    rules: {
      'no-restricted-globals': 'off'
    }
  }
]);
