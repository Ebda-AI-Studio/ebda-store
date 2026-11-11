// Slop rules (foundation os/standard/pr-quality.md). Spread LAST in a workspace config so it wins over looser local settings:
//   import { slopRules } from '../../eslint.slop.mjs';  export default [ ...existing, ...slopRules ];
// Existing violations are recorded per workspace in eslint-suppressions.json (`eslint --suppress-all`); a suppression can only
// be removed (`eslint --prune-suppressions`), and eslint fails on an unused one, so the baseline only shrinks.

// ESLint's own no-warning-comments has no issue-link exception, so a TODO/FIXME/XXX/HACK is checked here instead:
// allowed only when the same comment holds `#123` or `/issues/123`.
const todoNeedsIssue = {
  meta: { type: 'problem', schema: [], messages: { bare: '{{term}} comment without an issue link (#123 or .../issues/123).' } },
  create(context) {
    return {
      Program() {
        for (const c of context.sourceCode.getAllComments()) {
          const m = /\b(TODO|FIXME|XXX|HACK)\b/.exec(c.value);
          if (m && !/#\d+|\/issues\/\d+/.test(c.value)) context.report({ loc: c.loc, messageId: 'bare', data: { term: m[1] } });
        }
      },
    };
  },
};

export const slopRules = [
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs}'],
    ignores: ['**/*.{test,spec}.*', '**/test/**', '**/tests/**', '**/__tests__/**', '**/e2e/**', '**/scripts/**'],
    plugins: { slop: { rules: { 'todo-needs-issue': todoNeedsIssue } } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'error',
      'slop/todo-needs-issue': 'error',
    },
  },
];
