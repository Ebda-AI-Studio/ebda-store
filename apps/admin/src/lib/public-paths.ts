/**
 * Pages reachable with no session. `/login` plus the self-serve funnel (`/signup`, `/verify-email`) and password
 * recovery (`/forgot-password`, `/reset-password`). Lives apart from auth.tsx so api.ts and session-ended.ts can use it
 * without an import cycle.
 */
export const PUBLIC_PATHS: readonly string[] = [
  '/login',
  '/signup',
  '/verify-email',
  '/forgot-password',
  '/reset-password',
];
