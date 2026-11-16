import nextPlugin from '@next/eslint-plugin-next';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
import { slopRules } from '../../eslint.slop.mjs';

export default [
  { ignores: ['.next/**', 'out/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,jsx,ts,tsx,mjs}'],
    plugins: { react: reactPlugin, 'react-hooks': reactHooksPlugin, '@next/next': nextPlugin },
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      'react/react-in-jsx-scope': 'off',
      'react/no-unescaped-entities': 'off',
      '@next/next/no-img-element': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      // Every same-site link goes through components/PageLink: next/link sends a FILE path (security.txt, sitemap.xml)
      // through the client router, which with trailingSlash rewrote /.well-known/security.txt to a 404.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'next/link',
              message: 'Use PageLink from components/PageLink (file paths must be plain anchors).',
            },
          ],
        },
      ],
    },
    settings: { react: { version: 'detect' } },
  },
  { files: ['src/components/PageLink.tsx'], rules: { 'no-restricted-imports': 'off' } },
  ...slopRules,
];
