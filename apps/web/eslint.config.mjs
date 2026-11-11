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
      // Block hardcoded Tailwind semantic colors inside page/component source
      // so storefront pages honor the tenant's theme via design tokens
      // (bg-primary / bg-destructive / bg-muted / text-foreground / etc.).
      // Templates under src/templates may intentionally use gray-950 / etc.
      // for their built-in aesthetic — see the overrides block below.
      'no-restricted-syntax': [
        'warn',
        {
          selector: 'Literal[value=/bg-(red|green|blue|yellow|orange|purple|pink|indigo)-[0-9]/]',
          message:
            "Use design tokens (bg-primary / bg-destructive / bg-success / etc.) instead of hardcoded Tailwind colors. Storefront pages must honor the tenant's theme.",
        },
        {
          selector: 'Literal[value=/text-(red|green|blue|yellow|orange|purple|pink|indigo)-[0-9]/]',
          message:
            'Use design tokens (text-primary / text-destructive / etc.) instead of hardcoded Tailwind colors.',
        },
        // Block inline <input>/<select>/<textarea> with text-sm or text-xs in
        // their className — iOS Safari force-zooms the viewport on focus
        // whenever a form input has computed font-size <16px and does not
        // auto-unzoom. Use the shared @ebda/ui components OR explicit
        // `text-base sm:text-sm` so mobile starts at 16px.
        // Documented in ~/.claude/projects/-Users-ahmadsharaf/memory/feedback-mobile-form-text-base.md.
        {
          selector:
            "JSXOpeningElement[name.name=/^(input|textarea|select)$/] JSXAttribute[name.name='className'] Literal[value=/(^|\\s)text-(xs|sm)(\\s|$)/]",
          message:
            'Inline <input>/<select>/<textarea> with text-sm or text-xs causes iOS Safari to auto-zoom on focus. Use the shared @ebda/ui Input/Select/Textarea components, OR explicit `text-base sm:text-sm` so mobile starts at 16px. See feedback-mobile-form-text-base in global memory.',
        },
      ],
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
  },
  {
    // Templates intentionally use bespoke colors to express their own aesthetic;
    // don't block hardcoded colors there.
    files: ['src/templates/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  ...slopRules,
];
