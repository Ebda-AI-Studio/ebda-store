// `@sentry/node` on Workers is `@sentry/cloudflare`. SentryService calls the same
// capture/scope functions; `init` is a no-op here because the Worker entry wraps
// the handler with `Sentry.withSentry` (client options come from `env`, per request).
export * from '@sentry/cloudflare';
export function init(): void {
  // See worker.ts: initialisation happens in withSentry.
}
