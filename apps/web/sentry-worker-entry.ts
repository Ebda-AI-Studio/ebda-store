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
 * OPENNEXT_CACHE=true (live since 2026-07-12): the generated worker also
 * exports `DOQueueHandler` / `DOShardedTagCache` (Durable Objects for the R2
 * cache + tag cache). Those are re-exported by the GENERATED wrapper entry
 * `cache-worker-entry.ts` (emitted by scripts/cf-setup-local.sh, which then
 * points wrangler `main` at the wrapper instead of this file) — this file
 * stays DO-free so the cache-off configuration keeps working unchanged.
 */

// @ts-expect-error — `.open-next/worker.js` is generated at build time by
// `scripts/cf-build.sh` (@opennextjs/cloudflare); it doesn't exist in the
// repo or in a plain `tsc` typecheck, only inside an actual CF build.
import { default as nextHandler } from './.open-next/worker.js';
import * as Sentry from '@sentry/cloudflare';
import { companyHostRoute } from './company-host-route';

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

/**
 * Ebda COMPANY-page carve-out (2026-07-09).
 *
 * `ebda.app` / `ebda.app` are the Ebda *company* umbrella page —
 * a separate static site hosted on Cloudflare Pages (`force-ai-landing-preview`).
 * But this storefront Worker owns the WHOLE `ebda.app` zone via the SaaS
 * wildcard catch-all route (needed for `ebda.app` + every merchant
 * custom hostname), and Worker routes take priority over Pages custom domains —
 * so the apex would otherwise render the storefront platform landing.
 *
 * Fix: intercept the company hosts here, BEFORE the Next handler. The `www`
 * variant 301-redirects to the bare apex so there is a single canonical host
 * (no duplicate-content across `ebda.app` + `ebda.app`); the apex
 * reverse-proxies to the Pages company site (URL stays `ebda.app`; content
 * comes from Pages, including its `/api/demo-request` Function). Everything else —
 * `ebda.app`, merchant domains, `/<slug>` — falls through to Next
 * completely unchanged. The Pages origin is a different zone, so the proxied
 * subrequest never re-enters this Worker (no loop).
 */
const baseHandler = {
  async fetch(request: Request, env: WorkerEnv, ctx: unknown): Promise<Response> {
    const { hostname, pathname, search } = new URL(request.url);
    const route = companyHostRoute(hostname, pathname, search);
    if (route.kind === 'redirect') {
      return Response.redirect(route.location, route.status);
    }
    if (route.kind === 'proxy') {
      // `new Request(url, request)` copies method/headers/body; the outbound
      // Host is derived from the proxy origin so Pages serves the company site.
      return fetch(new Request(route.origin + pathname + search, request));
    }
    // route.kind === 'next' — all merchant domains + platform subdomains,
    // routed to the Next storefront exactly as before this carve-out.
    return nextHandler.fetch(request, env, ctx);
  },
};

export default Sentry.withSentry(
  (env: WorkerEnv) => ({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: env.SENTRY_DSN ? 0.1 : 0,
    environment: env.CF_ENV_NAME || 'production',
  }),
  baseHandler
);
