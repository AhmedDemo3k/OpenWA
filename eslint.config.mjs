// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  {
    // `require-await` is a heuristic, and it misfires on test doubles. `FakeEngine` has to
    // mirror `IWhatsAppEngine`'s async signatures exactly, so ~40 of its methods are
    // `async` and return a constant with nothing to await. Rewriting them as
    // `return Promise.resolve(x)` would add churn to every stub for no behavioural change.
    //
    // This is deliberately narrow: it only relaxes the one stylistic rule, so the
    // type-safety rules (no-unsafe-*, no-unnecessary-assertion, etc.) still apply to tests.
    // That matters -- it is how the fake engine's non-existent status values
    // ('QR_RECEIVED', 'INITIALIZED', 'LOGGED_OUT') and the `revokeGroupInviteCode`
    // return-type mismatch were caught.
    files: ['test/**/*.ts', 'src/**/*.spec.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
    },
  },
);
