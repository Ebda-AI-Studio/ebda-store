// MUST be first: OTel auto-instrumentation patches http/express/pg at
// require-time, so the tracing SDK has to start before those modules load.
import './tracing';
import express, { Request, Response } from 'express';
import { createServer } from 'http';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { config } from './config';
import { errorHandler, AppError } from './middleware/error-handler';
import { requestLogger } from './middleware/request-logger';
import {
  securityHeaders,
  requestId,
  sanitizeInput,
  csrfProtection,
  restrictPlatformOnlyOrigins,
  makeRateLimitStore,
  rateLimitRedisClient,
  inngestLimiter,
} from './middleware/security';
import { authenticate } from './middleware/auth';
import { requireRole } from './middleware/rbac';
import routes from './routes';
import webhookRoutes from './routes/webhook.routes';
import alertWebhookRoutes from './routes/alert-webhooks.routes';
import waBridgeRoutes from './routes/wa-bridge.routes';
import { socketService } from './services/socket.service';
import { setupSwagger } from './docs/swagger';
import { prisma } from '@force/database';
import { redis } from './services/redis.service';
import { circuitBreaker } from './services/circuit-breaker.service';
import { emailQueue } from './services/email-queue.service';
import { smsQueue } from './services/sms-queue.service';
import { abandonedCartService } from './services/abandoned-cart.service';
import { recommendationService } from './services/recommendation.service';
import { shippingCarrierService } from './services/shipping-carrier.service';
import { loyaltyAutomationService } from './services/loyalty-automation.service';
import { AuthService } from './services/auth.service';
import { SentryService } from './services/sentry.service';
import { sendAlert, awaitInFlightAlerts, ALERT_SEND_DEADLINE_MS } from './services/alerts.service';
import { inngest } from './lib/inngest/client';
import { inngestFunctions } from './lib/inngest/functions';
import { serve as inngestServe } from 'inngest/express';
import { withLeaderLock } from './lib/leader-election';
import { installClosedTenantTxAlerting, awaitDeferredWork } from './lib/after-tenant-commit';
import logger from './lib/logger';

// Initialize Sentry before anything else
SentryService.init();

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

const httpServer = createServer(app);

// Track server state for graceful shutdown
let isShuttingDown = false;

// Initialize Socket.io
socketService.initialize(httpServer);

// Make "Prisma query on an already-committed tenant transaction" loud.
// Detection only — the query still fails with P2028 exactly as before — but
// it now reaches the error log and the Telegram alert channel instead of
// dying inside a caller's `.catch`. That silence is why every return
// confirmation email failed to send for months without a single signal.
// See lib/after-tenant-commit.ts.
installClosedTenantTxAlerting();

// Connect Redis before starting queue processors
(async () => {
  await redis.connect();

  // Start email queue processor
  emailQueue.startProcessing();
  smsQueue.startProcessing(2000);
  abandonedCartService.startProcessing(900000); // 15 minutes
  recommendationService.startFBTCron(86400000, []); // daily; storeIds populated per-trigger
  shippingCarrierService.startTrackingCron(1800000); // every 30 minutes
  loyaltyAutomationService.startCron(86400000); // daily: birthday bonuses + point expiration

  // Refresh-token cleanup. Reuse detection requires keeping revoked
  // rows for ~30 days; without periodic deletion the table grows
  // unbounded. Run once at startup, then every 12 hours.
  // Leader-gated so only one Railway replica runs the deleteMany per tick.
  withLeaderLock('auth-refresh-token-cleanup', 12 * 60 * 60 * 1000, () =>
    AuthService.cleanupRefreshTokens().then(() => undefined)
  ).catch(err => logger.error({ err }, 'Refresh-token cleanup failed at startup'));
  setInterval(
    () => {
      withLeaderLock('auth-refresh-token-cleanup', 12 * 60 * 60 * 1000, () =>
        AuthService.cleanupRefreshTokens().then(() => undefined)
      ).catch(err => logger.error({ err }, 'Refresh-token cleanup failed'));
    },
    12 * 60 * 60 * 1000
  );
})();

// Request ID for tracing
app.use(requestId);

// Graceful shutdown middleware
app.use((_req, res, next) => {
  if (isShuttingDown) {
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

// CORS domain cache shared via module so store.routes.ts can bust it on domain changes
import {
  corsDomainCache,
  corsStoreOriginWhere,
  corsEntryAfterFailure,
  corsEntryAfterLookup,
  decideAfterFailedLookup,
  decideCorsCache,
  isPlatformOrigin,
} from './lib/cors-cache';
import { buildIdentity } from './lib/build-identity';
import { skipGlobalRateLimit } from './middleware/global-rate-limit-skip';

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
        prisma.store
          .findFirst({ where: storeOriginWhere.where, select: { id: true } })
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

// Global rate limiting
app.use(
  rateLimit({
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
    store: makeRateLimitStore(rateLimitRedisClient, 'global'),
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
  })
);

// issue 2063: the Inngest serve path's own bucket — counts only caller-fault
// answers (4xx except 429: forged/unsigned/malformed calls; never a failing
// step's 5xx, issue 2314), and sits BEFORE the body parser so a
// capped caller is refused before its body is read. See inngestLimiter.
app.use('/api/v1/inngest', inngestLimiter);

// Webhook routes need raw body parsing (must be before json middleware)
app.use('/api/v1/webhooks', express.raw({ type: 'application/json' }), webhookRoutes);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// External-service-to-Telegram alert bridge. Sentry / BetterStack /
// PostHog all POST to /api/v1/alerts/webhooks/<source> and we fan
// out to the same Telegram chat via the internal alerts.service.
// Protected by ALERTS_WEBHOOK_TOKEN env var (querystring or header).
app.use('/api/v1/alerts/webhooks', alertWebhookRoutes);

// Phase 6 (Option C) — WBS WhatsApp customer-DM ordering bridge inbound.
// Mounted BEFORE CSRF because the caller is WBS (a server, not a
// browser), authenticated via X-WBS-API-KEY header against the store's
// encrypted wbsApiKey. See apps/api/src/middleware/wa-bridge-auth.ts.
app.use('/api/v1/wa-bridge', express.json({ limit: '256kb' }), waBridgeRoutes);

// Inngest serve handler. Mounted before auth/CSRF because Inngest's
// platform calls this endpoint with its own request signature
// (verified inside the SDK using INNGEST_SIGNING_KEY) — it must not
// be subject to our cookie-based CSRF gate. The handler responds to
// PUT (function registration) and POST (function invocation).
app.use(
  '/api/v1/inngest',
  inngestServe({
    client: inngest,
    functions: inngestFunctions,
    // Advertise the real public origin to Inngest Cloud. Without this the SDK
    // guesses from the Host header of the registering request — and our
    // post-boot self-PUT hits 127.0.0.1, registering an unreachable
    // localhost URL (see config.inngestServeHost). Only pass it when set so
    // local dev keeps the SDK's default host-introspection.
    ...(config.inngestServeHost
      ? { serveHost: config.inngestServeHost, servePath: '/api/v1/inngest' }
      : {}),
  })
);

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
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), ...buildIdentity() });
});

// Comprehensive health check with dependency status (requires auth)
app.get(
  '/api/v1/health',
  authenticate,
  requireRole(['super_admin']),
  async (_req: Request, res: Response) => {
    const checks: Record<string, { status: string; latency?: number }> = {};

    // Check database
    const dbStart = Date.now();
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = { status: 'connected', latency: Date.now() - dbStart };
    } catch {
      checks.database = { status: 'disconnected' };
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

    // Get circuit breaker states
    const circuits = circuitBreaker.getAllStates();

    // Get email queue stats
    const emailStats = await emailQueue.getStats();

    // Determine overall status. Database disconnect is treated as the
    // load-bearing failure (we can't serve anything without it). Redis
    // being unavailable degrades caching but the API still works.
    const isHealthy = checks.database.status === 'connected';
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
      },
    });
  }
);

// API Documentation (Swagger)
setupSwagger(app);

// API Routes
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

// Start server
const server = httpServer.listen(config.port, () => {
  logger.info({ host: config.host, port: config.port, env: config.nodeEnv }, 'API server started');
  logger.info(
    { docs: `http://${config.host}:${config.port}/docs` },
    'WebSocket enabled, API docs available'
  );

  // Finding #5 (MED): BYPASSRLS guard.
  // If DATABASE_URL ever connects as a BYPASSRLS role (e.g. neondb_owner),
  // all RLS tenant isolation is silently off — every store can read every
  // other store's data. Refuse to serve traffic in production; warn in dev.
  // Wrapped in try/catch so a transient query failure doesn't kill the boot.
  (async () => {
    try {
      const rows = await prisma.$queryRaw<Array<{ currentUser: string; rolbypassrls: boolean }>>`
        SELECT current_user AS "currentUser", rolbypassrls FROM pg_roles WHERE rolname = current_user
      `;
      const bypassRls = rows[0]?.rolbypassrls === true;
      // Positive, always-on record of the role the API actually connected as
      // (#1940). CI greps this exact line after /health is up and fails the
      // integration job unless it reads `current_user=force_app
      // rolbypassrls=false` — a liveness probe alone passes identically as a
      // superuser, so a silent relapse to a bypass role would stay green.
      // Values are in the message (not only the object) so the grep works
      // under pino-pretty too. A role name is not a secret.
      logger.info(
        { currentUser: rows[0]?.currentUser, rolbypassrls: bypassRls },
        `[SECURITY] DB role check: current_user=${rows[0]?.currentUser ?? 'unknown'} rolbypassrls=${bypassRls}`
      );
      if (bypassRls) {
        // Explicit escape hatch. Production currently connects as `neondb_owner`
        // (a BYPASSRLS role); cutting DATABASE_URL over to the non-owner
        // `force_app` role is a tracked RLS-cutover follow-up, NOT a P0 change.
        // Until then, ALLOW_BYPASSRLS_ROLE=true keeps the API serving (loud
        // warning, not exit) so a routine redeploy can't take the whole platform
        // down. Verified 2026-06-27: this guard `process.exit(1)` crash-looped
        // prod the moment a redeploy first built it. Remove the env once
        // force_app is live and DATABASE_URL no longer uses a bypass role.
        const allowBypassRls = process.env.ALLOW_BYPASSRLS_ROLE === 'true';
        if (config.nodeEnv === 'production' && !allowBypassRls) {
          logger.fatal(
            { currentUser: 'see pg_roles', rolbypassrls: true },
            '[SECURITY FATAL] DATABASE_URL connects as a BYPASSRLS role — ' +
              'all RLS tenant isolation is disabled. ' +
              'Switch DATABASE_URL to the non-owner role (force_app) and redeploy, ' +
              'or set ALLOW_BYPASSRLS_ROLE=true to explicitly accept this.'
          );
          process.exit(1);
        } else {
          logger.warn(
            { rolbypassrls: true },
            '[SECURITY WARN] DB role has BYPASSRLS — RLS is not enforced in this environment. ' +
              'Use the force_app role in production.'
          );
        }
      }
    } catch (err) {
      // Query failure must not crash boot — log and continue.
      logger.warn({ err }, '[SECURITY] BYPASSRLS guard query failed — skipping check');
    }
  })();

  // Surface auth-token TTLs at boot. A stale `JWT_EXPIRES_IN="3h"` env
  // var on Railway once silently broke the iOS PWA — the cookie's
  // `maxAge` was 30 days but the JWT inside it expired every 3 hours,
  // logging merchants out mid-day. Logging the resolved values means a
  // future short override is obvious in deployment logs instead of
  // buried under support reports.
  logger.info(
    {
      jwtExpiresIn: config.jwtExpiresIn,
      refreshTokenExpiresIn: config.refreshTokenExpiresIn,
    },
    'Auth token lifetimes resolved'
  );
  if (
    typeof config.jwtExpiresIn === 'string' &&
    /^\d+\s*[hms]$/i.test(config.jwtExpiresIn.trim())
  ) {
    logger.warn(
      { jwtExpiresIn: config.jwtExpiresIn },
      'Short JWT_EXPIRES_IN detected — iOS admin PWA will log out at this interval. ' +
        'Defaults are 30d access + 1y refresh; unset the env var to restore.'
    );
  }

  // Guard: in production the self-PUT below registers whatever origin the
  // SDK advertises. With serveHost unset it advertises 127.0.0.1 (the PUT's
  // own Host), which Inngest Cloud can't reach — jobs then sit queued
  // forever. Warn loudly so this is caught at boot, not via a 7-hour
  // queue-depth alert.
  // issue 2064: the global-limiter bypass for Inngest step calls and the
  // endpoint's own safety both rest on the SDK verifying signatures, which it
  // only does in cloud mode with a key. With no key in production the bypass
  // turns itself off (inngestSignatureIsEnforced), but say so loudly.
  if (config.nodeEnv === 'production' && !config.inngestSigningKey) {
    logger.error(
      'INNGEST_SIGNING_KEY is unset in production — the Inngest serve endpoint cannot ' +
        'verify callers; the global rate-limit bypass for it is disabled'
    );
    void sendAlert({
      level: 'p1',
      scope: 'platform',
      source: 'boot.inngest_signing_key_missing',
      title: 'INNGEST_SIGNING_KEY unset in production',
      body: 'The Inngest serve endpoint cannot verify request signatures. Set INNGEST_SIGNING_KEY on the API service.',
    }).catch(() => undefined);
  }

  if (config.nodeEnv === 'production' && !config.inngestServeHost) {
    logger.warn(
      'INNGEST_SERVE_HOST is unset in production — Inngest will register the ' +
        'localhost origin and enqueued jobs will never run. Set it to the public ' +
        'API origin, e.g. https://api.ebda.app'
    );
  }

  // Self-PUT the Inngest serve endpoint after boot so the new container
  // registers its functions with Inngest cloud. Without this, after a
  // Railway redeploy the new container's function definitions stay
  // unregistered until Inngest cloud happens to ping us — which can take
  // 30+ min. Verified 2026-05-27: 3 bulk-ai jobs queued for 30 min on
  // Wady Aljuz after a redeploy because functions hadn't synced.
  // With serveHost set (config.inngestServeHost), this PUT still registers
  // the correct public origin even though it originates from 127.0.0.1.
  //
  // Fire-and-forget. If Inngest cloud is unreachable or the SDK rejects,
  // log + move on — health check still passes, jobs will retry later.
  setTimeout(() => {
    fetch(`http://127.0.0.1:${config.port}/api/v1/inngest`, { method: 'PUT' })
      .then(async res => {
        const body = await res.text().catch(() => '');
        if (res.ok) {
          logger.info({ status: res.status, body: body.slice(0, 200) }, 'Inngest self-register OK');
        } else {
          logger.warn(
            { status: res.status, body: body.slice(0, 200) },
            'Inngest self-register non-2xx'
          );
        }
      })
      .catch(err => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Inngest self-register failed'
        );
      });
  }, 3000);
});

// Graceful shutdown handler
async function gracefulShutdown(signal: string) {
  logger.info({ signal }, 'Starting graceful shutdown');
  isShuttingDown = true;

  // Stop accepting new connections
  server.close(async () => {
    logger.info('HTTP server closed');

    try {
      emailQueue.stopProcessing();
      smsQueue.stopProcessing();
      abandonedCartService.stopProcessing();
      recommendationService.stopFBTCron();
      shippingCarrierService.stopTrackingCron();
      loyaltyAutomationService.stopCron();
      socketService.close();
      // #1601: no new requests can start after server.close()'s callback
      // fires, so every deferred-work drain still running belongs to a
      // request whose response already went out. Wait for them (bounded —
      // see the 30s force-close timer below) BEFORE disconnecting Prisma;
      // otherwise a Railway redeploy silently drops in-flight return-
      // confirmation emails / R2 cleanup / audit rows mid-drain.
      await awaitDeferredWork(10000);
      // Issue 2387: detached alert sends (`void sendAlert(...)`, the
      // orphaned-invoice page) — including any a drain above just fired —
      // finish before Redis is disconnected and the process exits. Bounded:
      // every tracked send settles within ALERT_SEND_DEADLINE_MS of its start
      // (a hard deadline over lock + POST + body read, issue 2393), so this
      // drain never waits on a send that can no longer finish.
      await awaitInFlightAlerts(ALERT_SEND_DEADLINE_MS);
      await prisma.$disconnect();
      await redis.disconnect();
      await SentryService.close();

      logger.info('Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'Error during shutdown');
      process.exit(1);
    }
  });

  // Force close after 30 seconds
  setTimeout(() => {
    logger.fatal('Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
}

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', error => {
  logger.fatal({ err: error }, 'Uncaught exception');
  SentryService.captureException(error, { tags: { type: 'uncaughtException' } });
  // Out-of-band Telegram alert — Sentry needs the process alive to phone
  // home but uncaughtException is the path where it most often isn't.
  // sendAlert is already try/catch-internal; the .catch is belt-and-
  // suspenders so a rejected Promise warning can't race the shutdown.
  void sendAlert({
    level: 'p0',
    scope: 'platform',
    source: 'process.uncaughtException',
    title: 'uncaughtException',
    body: error.message,
    context: { stack: error.stack?.slice(0, 1500), name: error.name },
  }).catch(() => undefined);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', reason => {
  logger.error({ err: reason }, 'Unhandled rejection');
  if (reason instanceof Error) {
    SentryService.captureException(reason, { tags: { type: 'unhandledRejection' } });
  }
});

export default app;
