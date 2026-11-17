import tseslint from 'typescript-eslint';
import { slopRules } from '../../eslint.slop.mjs';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'src/foundation/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The B2B price resolver is a PURE function (docs/plans/done/2026-10-21-b2b-wholesale.md, Task 2): no imports at all,
    // so it cannot reach Prisma, the clock, the network or any other module.
    files: ['src/pricing/**/*.ts'],
    ignores: ['src/pricing/index.ts'], // the barrel only re-exports
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['*'], message: 'src/pricing is pure: no imports.' }] },
      ],
      'no-restricted-globals': ['error', 'Date', 'fetch', 'process'],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'src/pricing is deterministic.' },
      ],
    },
  },
  ...slopRules,
];
