/**
 * Cloudflare Workers entry point — wraps the OpenNext-generated Next.js
 * fetch handler with `@sentry/cloudflare` so SSR / RSC errors are captured
 * on the Workers target.
 *
 * WHY THIS FILE EXISTS: the standard `@sentry/nextjs` server SDK (used on
 * Vercel via instrumentation.ts + sentry.server.config.ts) can't run on
 * Workers, and `scripts/cf-build.sh` moves `instrumentation.ts` aside for
 * every Cloudflare build anyway (see that script + docs/migration/
 * cloudflare-preview-workers.md — an unrelated upstream @opennextjs/cloudflare
 * tracing bug, independent of Sentry). So SSR Sentry on the CF target has to
 * be wired at the Worker layer instead, using the Workers-native SDK.
 *
 * PATTERN SOURCE (verified 2026-07-02, not guessed from memory):
 * - Sentry's official Cloudflare Workers setup — `Sentry.withSentry(optionsFn,
 *   handler)` — https://docs.sentry.io/platforms/javascript/guides/cloudflare/
 * - OpenNext's "Custom Worker" howto for re-using the generated fetch handler
 *   — https://opennext.js.org/cloudflare/howtos/custom-worker
 * - Sentry's Next.js-on-Cloudflare deploy notes (nodejs_compat + compatibility
 *   date >= 2025-08-16 for `https.request`) —
 *   https://docs.sentry.io/platforms/javascript/guides/cloudflare/frameworks/nextjs/
 *
 * NO-OP WHEN UNCONFIGURED: `env.SENTRY_DSN` is read INSIDE the options
 * callback (per-request Workers env — never module-scope `process.env`, see
 * feedback-workers-no-module-env-secrets.md), and the Sentry SDK itself
 * no-ops cleanly whenever `dsn` is falsy (same contract every other Sentry
 * config in this repo relies on). A preview/unconfigured deploy with no
 * SENTRY_DSN var still builds and serves traffic normally.
 *
 * FOLLOW-UP if `OPENNEXT_CACHE=true` is ever enabled for this app: the
 * generated worker also exports `DOQueueHandler` / `DOShardedTagCache`
 * (Durable Object bindings for the R2 cache + tag cache) which this custom
 * entry must re-export — see the OpenNext howto above. Not needed today
 * (OPENNEXT_CACHE is off by default — see cf-deploy.yml).
 */

// @ts-expect-error — `.open-next/worker.js` is generated at build time by
// `scripts/cf-build.sh` (@opennextjs/cloudflare); it doesn't exist in the
// repo or in a plain `tsc` typecheck, only inside an actual CF build.
import { default as nextHandler } from './.open-next/worker.js';
import * as Sentry from '@sentry/cloudflare';

interface WorkerEnv {
  /** Server-side Sentry DSN for this Worker. Set via `wrangler deploy --var
   * SENTRY_DSN:<value>` in .github/workflows/cf-deploy.yml, sourced from the
   * SAME `NEXT_PUBLIC_SENTRY_DSN_WEB` GitHub repo variable already used for
   * client Sentry (the DSN isn't a secret — it's already shipped in the
   * browser bundle). Absent entirely on unconfigured/preview deploys. */
  SENTRY_DSN?: string;
  CF_ENV_NAME?: string;
  [key: string]: unknown;
}

const baseHandler = {
  fetch: nextHandler.fetch,
};

export default Sentry.withSentry(
  (env: WorkerEnv) => ({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: env.SENTRY_DSN ? 0.1 : 0,
    environment: env.CF_ENV_NAME || 'production',
  }),
  baseHandler
);
