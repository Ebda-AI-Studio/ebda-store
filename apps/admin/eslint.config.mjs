import { dirname } from 'path';
import { fileURLToPath } from 'url';
import nextPlugin from '@next/eslint-plugin-next';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
import { slopRules } from '../../eslint.slop.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default [
  {
    ignores: ['.next/**', 'node_modules/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
      '@next/next': nextPlugin,
    },
    languageOptions: {
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      'react/react-in-jsx-scope': 'off',
      '@next/next/no-img-element': 'off',
      'react/no-unescaped-entities': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': 'warn',
      // Flag hardcoded Tailwind semantic colors so admin pages honor the
      // design tokens (bg-primary / bg-destructive / bg-muted / …). Orange
      // specifically is zero-tolerance now (all replaced by bg-primary).
      // Red / green / blue / etc. are warnings so we surface the ~143
      // semantic-status-badge debt without blocking builds.
      'no-restricted-syntax': [
        'warn',
        {
          selector: 'Literal[value=/bg-(red|green|blue|yellow|orange|purple|pink|indigo)-[0-9]/]',
          message:
            'Use design tokens (bg-primary / bg-destructive / bg-success / etc.) instead of hardcoded Tailwind colors.',
        },
        {
          selector: 'Literal[value=/text-(red|green|blue|yellow|orange|purple|pink|indigo)-[0-9]/]',
          message:
            'Use design tokens (text-primary / text-destructive / etc.) instead of hardcoded Tailwind colors.',
        },
      ],
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
  },
  ...slopRules,
];
