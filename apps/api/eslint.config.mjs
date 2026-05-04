import tseslint from "typescript-eslint";

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

export default [
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-console": "warn",
      "no-restricted-syntax": ["error", ...cacheTtlSelectors],
    },
  },
  ...(cacheTtlAllowlist.length > 0
    ? [
        {
          files: cacheTtlAllowlist,
          rules: {
            "no-restricted-syntax": "off",
          },
        },
      ]
    : []),
];
