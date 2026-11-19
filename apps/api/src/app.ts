// The Express application, with NO side effects beyond constructing it: no
// listen(), no timers, no signal handlers, no Redis connect. Two shells use it:
//   - `index.ts`  : the Node server (Railway/Docker/dev): http server, socket.io,
//                   background loops, graceful shutdown.
//   - `worker.ts` : the Cloudflare Worker (`httpServerHandler`), R-EBDA-001.
import { requestShapeGuard } from './middleware/request-shape-guard';
import { installWaWriteObservers } from './lib/wa/observers';
import express, { Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { isWorkers } from './lib/runtime';
import { config } from './config';
import { errorHandler, AppError } from './middleware/error-handler';
import { requestLogger } from './middleware/request-logger';
import {
  securityHeaders,
  requestId,
  sanitizeInput,
  csrfProtection,
  restrictPlatformOnlyOrigins,
  plannedRateLimit,
  sanitizedBody,
} from './middleware/security';
import { prefetchRequestLimits, raiseHeldBodyError } from './middleware/request-limit-prefetch';
import { writeFreeze } from './middleware/write-freeze';
import { authenticate } from './middleware/auth';
import { requireRole } from './middleware/rbac';
import routes from './routes';
import webhookRoutes from './routes/webhook.routes';
import billingWebhookRoutes from './routes/billing-webhook.routes';
import internalInstapayRoutes from './routes/internal-instapay.routes';
import { assertBillingConfigAtBoot, billingProviderUnsetWarning } from './services/billing';
import alertWebhookRoutes from './routes/alert-webhooks.routes';
import { setupSwagger } from './docs/swagger';
import { prisma, setCommitHookErrorReporter, setDbHopObserver } from '@ebda/database';
import { lookupStore } from './lib/definer';
import './services/platform/router';
import './lib/store-scope-resolver';
import { redis } from './services/redis.service';
import { erasureFlagState } from './services/account-closure.wiring';
import { circuitBreaker } from './services/circuit-breaker.service';
import { emailQueue } from './services/email-queue.service';
import { SentryService } from './services/sentry.service';
import { sendAlert } from './services/alerts.service';
// Side effect: registers every background job (lib/inngest/functions) for the Worker's runners.
import './lib/inngest/functions';
import { installClosedTenantTxAlerting } from './lib/after-tenant-commit';
import logger from './lib/logger';

// Initialize Sentry before anything else
SentryService.init();

// SP5 task 3: refuse BILLING_PROVIDER=stub in production before serving anything.
import {
  corsDomainCache,
  corsStoreOriginWhere,
  corsEntryAfterFailure,
  corsEntryAfterLookup,
  decideAfterFailedLookup,
  decideCorsCache,
  isPlatformOrigin,
} from './lib/cors-cache';
import { healthPayload } from './lib/health-payload';
import { storageBackendCounts } from './lib/store-backend';
import { cfBindings } from './cf/bindings';
import { hopTiming, markHop, recordHop } from './lib/hop-timing';
import { serverTiming } from './lib/request-timing';
import { localizeRateLimited } from './lib/localized-error';
import { skipGlobalRateLimit } from './middleware/global-rate-limit-skip';
import { repoScope } from './lib/repo-factory';
import { NO_CLIENT_ADDRESS_HEADER } from './cf/ssr-client-ip';
assertBillingConfigAtBoot();
{
  // M-032: an UNSET provider in production is loud (P1 + error log) but does not stop an InstaPay-only API.
  const unset = billingProviderUnsetWarning();
  if (unset) {
    logger.error(unset);
    void sendAlert({
      level: 'p1',
      title: 'Billing: BILLING_PROVIDER is not set',
      body: unset,
    }).catch(() => undefined);
  }
}

// Every plan / subscription / catalog write anywhere tells Ebda Chat (lib/wa/observers.ts).
installWaWriteObservers();

const app = express();

// Railway terminates TLS at its proxy and forwards X-Forwarded-For. Without
// this setting, `req.ip` resolves to the proxy's address — which means every
// IP-keyed rate limiter (authLimiter, paymentLimiter, writeLimiter, etc.) is
// effectively a single global counter, and brute-force protection is off.
//
// The value is a HOP COUNT, and it must equal the number of proxies actually
// in front of this process — no more, no less.
//
//   Railway only:            client -> Railway -> here            = 1
//   Cloudflare + Railway:    client -> Cloudflare -> Railway -> here = 2
//
// Too LOW and `req.ip` becomes the nearest proxy's address (all anonymous
// traffic collapses into one rate-limit bucket, and audit logs record the
// proxy instead of the client). Too HIGH — or `true` — and a client can spoof
// X-Forwarded-For to forge its own address and bypass every IP-keyed limiter
// outright, which is strictly worse than having none.
//
// Configurable because the correct value depends on deployment topology, not
// on code: a preview/staging deploy that is NOT behind Cloudflare still needs
// 1 while production needs 2. Defaults to 1 so any environment that has not
// been told otherwise keeps today's (safe, non-spoofable) behaviour.
//
// SET TRUST_PROXY_HOPS=2 ONLY ONCE api.ebda.app IS PROXIED **AND** THE
// RAILWAY ORIGIN NO LONGER ACCEPTS DIRECT PUBLIC TRAFFIC. Raising it while the
// naked *.up.railway.app hostname is still reachable is the spoofing hole
// described above. See docs/ENVIRONMENT.md.
const TRUST_PROXY_HOPS = (() => {
  const raw = process.env.TRUST_PROXY_HOPS;
  if (!raw) return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 5) {
    // Fail SAFE, not open: an unparseable value must not become `true`.
    logger.warn({ raw }, '[startup] TRUST_PROXY_HOPS is not an integer 0-5 — falling back to 1');
    return 1;
  }
  return n;
})();
app.set('trust proxy', TRUST_PROXY_HOPS);
logger.info({ trustProxyHops: TRUST_PROXY_HOPS }, '[startup] trust proxy hop count');

// Ruling RL-SSR-IP-6: a request with no client address (worker.ts, cf/ssr-client-ip.ts) has an EMPTY req.ip, so the
// per-address limiters skip it instead of pooling it on the fallback address. Only the Worker sets the marker (it
// strips any inbound copy first); on Node it is removed and ignored.
app.use((req, _res, next) => {
  if (req.headers[NO_CLIENT_ADDRESS_HEADER] !== undefined) {
    delete req.headers[NO_CLIENT_ADDRESS_HEADER];
    if (isWorkers) Object.defineProperty(req, 'ip', { value: undefined, configurable: true });
  }
  next();
});

/** Flipped by the Node shell's graceful shutdown (index.ts); a Worker never sets it. */
export const lifecycle = { isShuttingDown: false };

// Make "Prisma query on an already-committed tenant transaction" loud.
// Detection only — the query still fails with P2028 exactly as before — but
// it now reaches the error log and the Telegram alert channel instead of
// dying inside a caller's `.catch`. That silence is why every return
// confirmation email failed to send for months without a single signal.
// See lib/after-tenant-commit.ts.
installClosedTenantTxAlerting();
setDbHopObserver(recordHop);
// An after-commit hook that throws is REPORTED through the app logger, never swallowed (Ruling NZ-D19). A partial `@ebda/database`
// mock (unit tests) has no setter; the real package always does.
try {
  setCommitHookErrorReporter(err =>
    logger.error(
      { err },
      '[tx-hooks] an after-commit hook failed (the transaction already committed)'
    )
  );
} catch {
  /* test double */
}

// The backend of a store is server-side state only (Ruling CF-BACKEND-1): a client `x-ebda-backend` never reaches a handler.
app.use((req, _res, next) => {
  delete req.headers['x-ebda-backend'];
  next();
});
// Request ID for tracing
app.use(requestId);
// Cutover read-only window (WRITES_FROZEN=1, docs/runbooks/cutover-cf.md): 503 to every write, reads stay open.
app.use(writeFreeze);
// Operator-only per-hop timing LOG (x-hop-timing must equal the HOP_TIMING_TOKEN secret; never a
// response header), see lib/hop-timing.ts.
app.use(hopTiming);
// Server-Timing: auth / identity / db-wait / handler (BE:E-1) next to request-tx.
app.use(serverTiming);
// RATE_LIMITED bodies from every limiter carry details.messageAr/messageEn (BE:E-3).
app.use(localizeRateLimited);
// Per-request repo scope (lib/repo-factory.ts, Ruling CF-REPO-1): lets a service ask for its store's backend by store id.
app.use(repoScope);

// Graceful shutdown middleware
app.use((_req, res, next) => {
  if (lifecycle.isShuttingDown) {
    res.setHeader('Connection', 'close');
    res.status(503).json({
      success: false,
      error: {
        code: 'SERVER_SHUTTING_DOWN',
        message: 'Server is shutting down. Please retry.',
      },
    });
    return;
  }
  next();
});

// Security middleware
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        scriptSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);
app.use(securityHeaders);

// Compression middleware for better performance
// Not on Workers: the edge compresses, and node:zlib streams under
// httpServerHandler lose the body (experiment B7).
if (!isWorkers) {
  app.use(
    compression({
      filter: (req, res) => {
        if (req.headers['x-no-compression']) {
          return false;
        }
        return compression.filter(req, res);
      },
      level: 6,
    })
  );
}

// CORS domain cache shared via module so store.routes.ts can bust it on domain changes

/**
 * A cross-origin request from an origin we don't recognise is a CLIENT
 * condition, not a server fault — the same category as "auth required" or
 * "validation failed".
 *
 * It used to be reported as `new Error('Not allowed by CORS')`, which misses
 * every branch of `errorHandler` and lands in the final "Unhandled error (5xx)"
 * case: HTTP 500, `logger.error`, and therefore Sentry. By 2026-08-11 that had
 * produced the single noisiest signal in the whole platform — three separate
 * Sentry issues (84 + 35 + 8 events), the #1 and #2 entries in the alert
 * digest, all of them expected rejections of traffic we never wanted to serve.
 *
 * The volume was the smaller problem. The real cost is that a merchant whose
 * custom domain is genuinely misconfigured produces exactly the same event as a
 * bot probing with a spoofed Origin, so the one that matters is unfindable.
 *
 * `AppError` 4xx is the existing, documented idiom for this (see the log-level
 * discipline comment in error-handler.ts). Behaviour is unchanged — the request
 * is still rejected before it reaches any route handler; only the status code
 * (403, not 500) and the log level (debug, not error) change.
 */
// Takes `string | undefined` deliberately: `origin` is a function PARAMETER, so
// the `if (!origin)` narrowing above is discarded inside the `.then()` closure
// (TypeScript cannot prove a mutable binding is unchanged across a callback).
// Widening here beats a non-null assertion at three call sites.
function corsRejection(origin: string | undefined): AppError {
  return new AppError(
    403,
    'CORS_ORIGIN_NOT_ALLOWED',
    `Origin ${origin ?? 'unknown'} is not allowed`
  );
}

app.use(
  cors({
    origin: (origin, callback) => {
      // Requests without an Origin header are rejected by CORS.
      // Same-origin requests, server-to-server calls, mobile apps, and dev
      // tools (curl, Postman) are unaffected because CORS is only enforced by
      // browsers.  Returning false means no Access-Control-Allow-Origin header
      // is set, which does not block non-browser clients.
      if (!origin) return callback(null, false);

      // Platform origins (storefront / admin / Cloudflare Workers previews / localhost) —
      // single source of truth shared with the CSRF middleware so the two
      // can never drift. Custom merchant domains fall through to the DB
      // lookup below; they're CORS-allowed but the CSRF token check
      // still applies to them (see security.ts comment).
      if (
        isPlatformOrigin(origin, {
          webUrl: config.webUrl,
          adminUrl: config.adminUrl,
          nodeEnv: config.nodeEnv,
        })
      ) {
        return callback(null, true);
      }

      // For other HTTPS origins, check if they match a store's custom domain in the DB.
      // We cache results briefly to avoid a DB hit on every request.
      if (origin.startsWith('https://')) {
        // Host routing: `<slug>.ebda.app` is a store origin (matched by slug),
        // any other well-formed host a custom-domain candidate; reserved labels,
        // platform hosts, IPs and malformed values can never be a store origin
        // and are rejected here WITHOUT a database lookup.
        let storeOriginWhere: ReturnType<typeof corsStoreOriginWhere>;
        try {
          storeOriginWhere = corsStoreOriginWhere(new URL(origin).hostname);
        } catch {
          return callback(corsRejection(origin));
        }
        if (!storeOriginWhere) return callback(corsRejection(origin));
        const hostname = storeOriginWhere.cacheKey;

        // Return cached result if still fresh
        const decision = decideCorsCache(corsDomainCache.get(hostname), Date.now());
        if (decision === 'allow') return callback(null, true);
        if (decision === 'reject') return callback(corsRejection(origin));
        if (decision === 'unavailable') {
          return callback(
            new AppError(503, 'CORS_LOOKUP_UNAVAILABLE', 'Unable to verify origin at this time')
          );
        }
        // decision === 'miss' — fall through to the DB lookup below.

        // Async DB lookup — only allow if a LIVE store (active/suspended, not
        // deleted) owns this host (slug subdomain or custom domain). See corsStoreOriginWhere (#1214).
        // `stores` is under RLS (R-EBDA-005): the host resolves through the lookup definer.
        lookupStore(storeOriginWhere.match, storeOriginWhere.statuses)
          .then(store => {
            const allowed = store !== null;
            corsDomainCache.set(hostname, corsEntryAfterLookup(allowed, Date.now()));
            return allowed ? callback(null, true) : callback(corsRejection(origin));
          })
          // A FAILED LOOKUP IS NOT A REJECTED ORIGIN. If Neon is down or the
          // pool is starved, every merchant custom domain stops passing CORS —
          // that is an outage, and collapsing it into the same 403 the bots get
          // would hide it behind the noise we are removing here. 503 + AppError
          // 5xx keeps it at `error` level and therefore still in Sentry.
          .catch(err => {
            // Yes, this logs and then errorHandler logs the AppError again.
            // The duplication is intentional and the two lines are NOT
            // interchangeable: this one carries the ORIGINAL rejection (the
            // Prisma/connection error, plus the origin that triggered it),
            // whereas errorHandler only ever sees the AppError we construct
            // below and would report "CORS_LOOKUP_UNAVAILABLE" with no cause.
            // AppError has no `cause` slot to thread it through. Deleting this
            // line as redundant would throw away the only record of WHY the
            // lookup failed, which is the entire diagnostic value of a 503.
            // It also records WHICH answer the request got (`served`), so a
            // stale-allow window is observable rather than silent.
            // #1074: a failed lookup used to populate NOTHING, so every
            // request for this hostname re-hit the already-degraded database
            // for the whole outage. A short negative cache (5s, far shorter
            // than the 2min success TTL) bounds that to one query per 5s per
            // hostname once failures REPEAT (issue 2109: a single blip lets
            // the next request re-query), never silently upgrades a hostname
            // that was never verified to `allowed`, and self-heals fast once
            // Neon recovers. Issue 2169: the last RESOLVED answer is carried
            // forward (the expired entry is still in the map), so a merchant
            // domain verified in the last 15 minutes keeps passing CORS
            // through the outage instead of 503ing its checkout.
            const now = Date.now();
            const entry = corsEntryAfterFailure(corsDomainCache.get(hostname), now);
            corsDomainCache.set(hostname, entry);
            const fallback = decideAfterFailedLookup(entry, now);
            logger.error(
              { err, origin, failures: entry.failures, served: fallback },
              'CORS custom-domain lookup failed'
            );
            if (fallback === 'allow') return callback(null, true);
            if (fallback === 'reject') return callback(corsRejection(origin));
            callback(
              new AppError(503, 'CORS_LOOKUP_UNAVAILABLE', 'Unable to verify origin at this time')
            );
          });
        return;
      }

      callback(corsRejection(origin));
    },
    credentials: true,
    // Content-Disposition: the admin names a downloaded export after the
    // server's filename (it carries the applied date range).
    exposedHeaders: ['X-Request-Id', 'X-CSRF-Token', 'Content-Disposition'],
  })
);

// The JSON body parser (one instance: the request-level limiter prefetch may parse the body early, PERF-BATCH-1,
// middleware/request-limit-prefetch.ts) and the cookie parser the prefetch prepares its key-prediction copy with.
const jsonBody = express.json({ limit: '10mb' });
const parseCookies = cookieParser();

// Global rate limiting, behind the request-level prefetch that sends every limiter hit of the request in one round trip per
// AuthState shard (PERF-BATCH-1).
const globalLimiter = plannedRateLimit('global', {
  windowMs: 15 * 60 * 1000, // 15 minutes
  // 2026-05-21 redesign — global limiter now ONLY counts mutations
  // (POST/PUT/PATCH/DELETE), not safe-method reads (GET/HEAD/OPTIONS).
  // Reason: legit clients (merchants on admin, customers browsing
  // storefront) easily issue 100+ GET requests per 15min via normal
  // page navigation. The previous 100-cap-per-IP false-positived on
  // every busy session. Mutations are the abuse vector — scraping,
  // brute-force, mass-create attacks — keep those rate-limited.
  //
  // Reads still have per-endpoint targeted limits where appropriate
  // (publicLimiter, etc.) plus auth chains that gate sensitive data.
  // 200 mutations per IP per 15min is comfortable for normal use
  // and still blocks scripted abuse.
  max: 200,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Fail-OPEN on a Redis store error — see the posture comment on the
  // limiters in middleware/security.ts (deliberate availability-over-
  // strictness tradeoff, adversarial audit P2).
  passOnStoreError: true,
  // Skip the limiter for two cases:
  //
  // 1. Load test bypass token. We only check when LOAD_TEST_BYPASS_TOKEN
  //    is set on Railway — unset means "no bypass possible", so
  //    production traffic is always rate limited regardless of header
  //    values. Use a long random value so the header isn't guessable.
  //
  // 2. Admin bulk-AI job-status polling (GET /api/v1/stores/.../ai/bulk
  //    and /api/v1/stores/.../ai/bulk/<jobId>). These are read-only
  //    one-row DB lookups that the admin UI polls every 4s while a
  //    sweep is running. The downstream `authenticate` + `authorize`
  //    middleware still enforce auth; this just lifts the global IP
  //    rate cap so a logged-in merchant watching their job progress
  //    doesn't 429 after ~3 minutes. Safe because:
  //      - method is GET only (no writes)
  //      - the auth chain still requires a valid store_admin/super_admin
  //        JWT cookie, so unauthenticated traffic still hits the limiter
  //        via the auth middleware's `authLimiter` 5-attempts-per-15min
  //      - polling endpoints don't trigger expensive work (Gemini calls
  //        happen inside Inngest, not in the GET handler)
  skip: skipGlobalRateLimit,
});
app.use(
  prefetchRequestLimits({
    global: globalLimiter,
    router: routes,
    mount: '/api/v1',
    jsonBody,
    prepare: copy => {
      if (copy.body && typeof copy.body === 'object') copy.body = sanitizedBody(copy.body);
      parseCookies(copy, {} as Response, () => undefined);
    },
  })
);

// Subscription-billing webhooks (SP5 task 3): raw body for HMAC, mounted BEFORE
// the generic payment webhooks and the JSON parser.
app.use(
  '/api/v1/webhooks/billing',
  express.raw({ type: () => true, limit: '1mb' }),
  billingWebhookRoutes
);

// InstaPay auto-confirm: the brain's signed one-tap "not received" (INSTAPAY-AUTO-1). Raw body for the HMAC, before the JSON parser.
app.use(
  '/internal/instapay',
  express.raw({ type: () => true, limit: '16kb' }),
  internalInstapayRoutes
);

// Webhook routes need raw body parsing (must be before json middleware)
app.use('/api/v1/webhooks', express.raw({ type: 'application/json' }), webhookRoutes);

// Body parsing
// 10mb = API_JSON_BODY_LIMIT_BYTES, the byte cap the guard below also enforces (tests/unit/zod-huge-array-bounds).
app.use(raiseHeldBodyError, jsonBody);
app.use(express.urlencoded({ extended: true }));
// Size and shape caps before any route or schema parses the body (Ruling ITEST-11).
app.use(requestShapeGuard);

// External-service-to-Telegram alert bridge. Sentry / BetterStack /
// PostHog all POST to /api/v1/alerts/webhooks/<source> and we fan
// out to the same Telegram chat via the internal alerts.service.
// Protected by ALERTS_WEBHOOK_TOKEN env var (querystring or header).
app.use('/api/v1/alerts/webhooks', alertWebhookRoutes);

// Cookie parsing (for HTTP-only auth cookie support)
app.use(cookieParser());

// Input sanitization
app.use(sanitizeInput);

// Origin gate for the platform-admin surface. Runs BEFORE csrfProtection
// because it must cover reads too, not just state-changing methods.
app.use(restrictPlatformOnlyOrigins);

// CSRF protection
app.use(csrfProtection);

// Request logging
app.use(requestLogger);

// Simple health check (for load balancers).
//
// Carries the build's identity as well as its liveness. A 200 alone cannot
// answer "did the merged code reach production" — the container serving the
// PREVIOUS release returns exactly the same 200 — so the deploy verification
// and any manual check had nothing to compare against. Unknown values are
// reported as null rather than omitted or guessed, so a caller can tell
// "this build is X" apart from "this build will not say".
app.get('/health', async (_req, res) => {
  res.json(await healthPayload());
});

// Comprehensive health check with dependency status (requires auth)
app.get(
  '/api/v1/health',
  authenticate,
  requireRole(['super_admin']),
  async (_req: Request, res: Response) => {
    const checks: Record<string, { status: string; latency?: number }> = {};

    // Check database
    // NEON-ZERO N-17 (Ruling NZ-D23): the Worker has no Postgres; it is reported as removed, never probed (a probe throws
    // POSTGRES_REMOVED and would page a P1 every call). Node (tests, local dev) still probes.
    const dbStart = Date.now();
    if (isWorkers) {
      checks.database = { status: 'removed' };
    } else {
      try {
        await prisma.$queryRaw`SELECT 1`;
        checks.database = { status: 'connected', latency: Date.now() - dbStart };
      } catch {
        checks.database = { status: 'disconnected' };
      }
    }

    // Check Redis
    const redisStart = Date.now();
    try {
      if (redis.isAvailable()) {
        await redis.getClient()?.ping();
        checks.redis = { status: 'connected', latency: Date.now() - redisStart };
      } else {
        checks.redis = { status: 'unavailable' };
      }
    } catch {
      checks.redis = { status: 'disconnected' };
    }

    // S3: surface the PDPL erasure flag. Informational (does not flip overall health): off = merchant/staff account
    // closure answers 503 ERASURE_NOT_ENABLED and records the request. Enabling it is an operator decision.
    checks.pdplErasure = { status: erasureFlagState() };

    // Get circuit breaker states
    const circuits = circuitBreaker.getAllStates();

    // Get email queue stats
    const emailStats = await emailQueue.getStats();

    // Determine overall status. Database disconnect is treated as the
    // load-bearing failure (we can't serve anything without it). Redis
    // being unavailable degrades caching but the API still works.
    const isHealthy =
      checks.database.status === 'connected' || checks.database.status === 'removed';
    const status = isHealthy ? 'healthy' : 'degraded';

    // P1 alert when the deep health check reports degraded. Throttled
    // via alerts.service so a flapping DB won't fire-storm Telegram —
    // first alert lands, subsequent ones within 5min get suppressed.
    if (!isHealthy) {
      void sendAlert({
        level: 'p1',
        scope: 'platform',
        source: 'api.health.deep_check',
        title: 'health check degraded',
        body: `Deep health check returned status=${status}. Investigate Neon / Railway / circuit breakers.`,
        context: { checks, circuits, emailQueue: emailStats },
      }).catch(() => undefined);
    }

    res.status(isHealthy ? 200 : 503).json({
      success: true,
      data: {
        status,
        timestamp: new Date().toISOString(),
        version: config.appVersion,
        environment: config.nodeEnv,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        checks,
        circuits: Object.entries(circuits).reduce(
          (acc, [name, state]) => {
            acc[name] = state.state;
            return acc;
          },
          {} as Record<string, string>
        ),
        emailQueue: emailStats,
        // Per-backend store counts (runbook cutover-cf s4 row 1); super_admin only, they disclose the store count.
        storage_backend: await storageBackendCounts(cfBindings()?.PLATFORM_DB),
      },
    });
  }
);

// API Documentation (Swagger)
setupSwagger(app);

// API Routes
app.use('/api/v1', (_req, _res, next) => {
  markHop('routes');
  next();
});
app.use('/api/v1', routes);

// JSON 404 catch-all (2026-09-22 security audit, info finding). Mounted
// AFTER every router above, so it only runs when nothing matched — an
// unknown route previously fell through to Express's own default handler,
// which returns HTML ("Cannot GET /x") and fingerprints the framework. This
// is a plain (req, res) middleware, not an error handler, so it never
// shadows a route that matched and threw — those still reach
// SentryService.errorHandler() / errorHandler below via next(err).
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: `Cannot ${req.method} ${req.originalUrl}` },
  });
});

// Sentry error handler (must be before errorHandler)
app.use(SentryService.errorHandler());

// Error handling
app.use(errorHandler);

export default app;
