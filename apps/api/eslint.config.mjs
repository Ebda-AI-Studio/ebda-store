import tseslint from 'typescript-eslint';
import { slopRules } from '../../eslint.slop.mjs';

// Block sub-120s Redis cache TTLs outside an allow-list. Short TTLs
// have repeatedly caused Vercel/Neon cost spikes — see the
// `feedback-cache-cost-tradeoff` rule in project memory. The default
// floor is 120s (2 min). Files that genuinely need fresher data
// (inventory levels, in-flight orders, payment status) are listed in
// the `cacheTtlAllowlist` override below.
const CACHE_TTL_FLOOR = 120;
const cacheTtlAllowlist = [
  // Add files here only when fresher than 2-minute caching is
  // genuinely required (e.g. inventory levels feeding stock decisions).
  // Pattern is glob-relative-to-eslint-config root.
];

const cacheTtlSelectors = [
  // redis.set(key, value, <number < FLOOR>)
  {
    selector: `CallExpression[callee.object.name='redis'][callee.property.name=/^set(Ex)?$/] > Literal:nth-child(3)[value<${CACHE_TTL_FLOOR}]`,
    message: `Redis cache TTL < ${CACHE_TTL_FLOOR}s — see feedback-cache-cost-tradeoff. Default floor is 2 minutes; add this file to cacheTtlAllowlist if genuine.`,
  },
  // getCached(key, <number < FLOOR>, fn)
  {
    selector: `CallExpression[callee.name='getCached'] > Literal:nth-child(2)[value<${CACHE_TTL_FLOOR}]`,
    message: `getCached() TTL < ${CACHE_TTL_FLOOR}s — see feedback-cache-cost-tradeoff.`,
  },
  // getCachedAnalytics(key, <number < FLOOR>, fn)
  {
    selector: `CallExpression[callee.name='getCachedAnalytics'] > Literal:nth-child(2)[value<${CACHE_TTL_FLOOR}]`,
    message: `getCachedAnalytics() TTL < ${CACHE_TTL_FLOOR}s — see feedback-cache-cost-tradeoff.`,
  },
];

// Block a server-side fetch() of a NON-LITERAL url in REQUEST-HANDLING code.
//
// lib/safe-fetch.ts blocks RFC1918 / CGNAT / loopback / link-local — including
// 169.254.169.254, the cloud metadata address — but a guard nothing enforces
// only protects the call sites that remembered it. Audited 2026-08-31
// (docs/audits/2026-08-31-reel-derived-lenses.md, lens L11): the guard existed
// with TWO call sites while ~43 other fetch() calls did not use it. None were
// vulnerable — every one composes a provider endpoint from config — but nothing
// stopped the next fetch(userSuppliedUrl) from bypassing it, and that failure
// would be silent.
//
// Scoped to `routes/**` on purpose. That is where request data lives, so it is
// where a user-supplied URL can first reach fetch(). Applying this to every
// service would flag ~14 provider clients whose URLs come from process.env, and
// a rule that needs a 14-entry allowlist is one people learn to silence.
// Services that later accept a URL from a route must use safeFetch* regardless
// — that is a review point, documented in the audit above.
const ssrfSelectors = [
  {
    // Flags a non-literal URL, EXCEPT a template rooted at `config.*` or
    // `process.env.*` — those are deployment configuration and cannot be
    // attacker-controlled. This exclusion keeps the rule at zero false positives while still catching
    // `fetch(req.body.url)` / `fetch(userUrl)`.
    selector:
      "CallExpression[callee.name='fetch'] > :first-child:matches(Identifier, TemplateLiteral, MemberExpression):not(TemplateLiteral[expressions.0.object.name='config']):not(TemplateLiteral[expressions.0.object.object.name='process'])",
    message:
      'fetch() with a non-literal URL inside a route handler. If the URL can come from request input, route it through safeFetchImage/safe-fetch (SSRF — cloud metadata at 169.254.169.254). If it is provider config, move the call into its service client.',
  },
];

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'src/cf/modules/exceljs.cjs',
      'src/cf/modules/*.mjs',
    ], // generated minified library builds (BUNDLE-BUDGET-6, -7)
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': 'warn',
      'no-restricted-syntax': ['error', ...cacheTtlSelectors],
    },
  },
  ...(cacheTtlAllowlist.length > 0
    ? [
        {
          files: cacheTtlAllowlist,
          rules: {
            'no-restricted-syntax': 'off',
          },
        },
      ]
    : []),
  // Request-handling code: cache-TTL rules PLUS the SSRF guard.
  {
    files: ['**/routes/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...cacheTtlSelectors, ...ssrfSelectors],
    },
  },
  ...slopRules,
];
