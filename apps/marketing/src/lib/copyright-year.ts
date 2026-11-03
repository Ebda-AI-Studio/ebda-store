/**
 * The footer's copyright year, fixed at BUILD time (next.config.js inlines NEXT_PUBLIC_COPYRIGHT_YEAR into the static export), so
 * the server HTML and the hydrating client render the same year even on a page cached across New Year. Never a render-time
 * `new Date()` (tests/unit/no-render-time-nondeterminism.test.ts). The fallback only serves unit tests and `next dev`.
 */
export const COPYRIGHT_YEAR: number =
  Number(process.env.NEXT_PUBLIC_COPYRIGHT_YEAR) || new Date().getUTCFullYear();
