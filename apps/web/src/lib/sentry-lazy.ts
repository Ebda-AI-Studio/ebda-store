/**
 * Lazy handle on the browser Sentry SDK (docs/RULINGS.md PERF-STORE-2).
 *
 * `@sentry/nextjs` is ~55 KB gzip of the storefront's first-load JS and a
 * visitor needs none of it to see or use the page, so nothing in the
 * first-load graph may import it statically: `instrumentation-client.ts`
 * initialises it after the page is idle (or on the first error / first
 * interaction, whichever comes first) and every other caller goes through
 * this module. Resolves to `null` when no DSN is configured, so callers stay a
 * no-op in dev / preview without downloading the SDK.
 */
type SentryModule = typeof import('@sentry/nextjs');

let pending: Promise<SentryModule | null> | null = null;

export function loadSentry(): Promise<SentryModule | null> {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN_WEB) return Promise.resolve(null);
  pending ??= import('@sentry/nextjs').catch(() => null);
  return pending;
}

/** Fire-and-forget `Sentry.captureException`; a no-op without a DSN. */
export function reportError(
  error: unknown,
  hint?: Parameters<SentryModule['captureException']>[1]
) {
  void loadSentry().then(Sentry => Sentry?.captureException(error, hint));
}
