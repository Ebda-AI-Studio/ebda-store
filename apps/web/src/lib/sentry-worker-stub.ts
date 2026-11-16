/**
 * Ruling WEB-COLD-3: the SERVER-side stand-in for `@sentry/nextjs` in the Cloudflare (OpenNext) build only.
 *
 * Why: three modules import `@sentry/nextjs` (PostHogProvider, SectionErrorBoundary, store-resolve-cache). On the Worker the
 * Next-server Sentry SDK is never initialised (cf-build.sh moves instrumentation.ts aside; SSR errors are captured by
 * `@sentry/cloudflare` in sentry-worker-entry.ts), so every call below was already a no-op there, yet the import pulled
 * 3.7 MB of SDK + OpenTelemetry into the 22.8 MB Worker script that every cold isolate must fetch and compile.
 * The browser keeps the real SDK (turbopack alias condition `browser`, next.config.js); Vercel/Node builds are untouched
 * (alias only when IS_CLOUDFLARE). Only the functions the app calls on a server render path are stubbed;
 * apps/web/src/lib/sentry-worker-stub.test.ts fails when app code starts using another `Sentry.*` export.
 */
export const captureException = (): string => '';
export const captureMessage = (): string => '';
export const setTag = (): void => {};
export const setContext = (): void => {};
