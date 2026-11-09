// The `z` namespace of ./zod-root.ts (Ruling BUNDLE-BUDGET-9): every export of `zod/v4`, with the three namespace-valued
// members that drag all 64 locales into the bundle shadowed (a local export wins over an `export *` of the same name).
// Nothing in apps/api reads `z.locales` / `z.core` from the package root; tests/unit/ops/zod-root-alias.test.ts keeps it so.
export * from 'zod/v4';
export const locales = undefined;
export const core = undefined;
export const z = undefined;
