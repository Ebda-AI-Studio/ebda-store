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
import { errorHandler } from './middleware/error-handler';
import { requestLogger } from './middleware/request-logger';
import {
  securityHeaders,
  requestId,
  sanitizeInput,
  csrfProtection,
  makeRateLimitStore,
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
import { sendAlert } from './services/alerts.service';
import { inngest } from './lib/inngest/client';
import { inngestFunctions } from './lib/inngest/functions';
import { serve as inngestServe } from 'inngest/express';
import { withLeaderLock } from './lib/leader-election';
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
// SET TRUST_PROXY_HOPS=2 ONLY ONCE api.force-ai.co IS PROXIED **AND** THE
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
import { corsDomainCache, CORS_CACHE_TTL_MS, isPlatformOrigin } from './lib/cors-cache';

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
        let hostname: string;
        try {
          // Normalize: lowercase + strip www (domains are stored normalized in DB)
          hostname = new URL(origin).hostname.toLowerCase().replace(/^www\./, '');
        } catch {
          return callback(new Error('Not allowed by CORS'));
        }

        // Return cached result if still fresh
        const cached = corsDomainCache.get(hostname);
        if (cached && cached.expiresAt > Date.now()) {
          return cached.allowed ? callback(null, true) : callback(new Error('Not allowed by CORS'));
        }

        // Async DB lookup — only allow if a store with this custom domain exists
        prisma.store
          .findFirst({ where: { domain: hostname }, select: { id: true } })
          .then(store => {
            const allowed = store !== null;
            corsDomainCache.set(hostname, { allowed, expiresAt: Date.now() + CORS_CACHE_TTL_MS });
            return allowed ? callback(null, true) : callback(new Error('Not allowed by CORS'));
          })
          .catch(() => callback(new Error('Not allowed by CORS')));
        return;
      }

      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    exposedHeaders: ['X-Request-Id', 'X-CSRF-Token'],
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
    store: makeRateLimitStore(redis.getClient(), 'global'),
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
    skip: req => {
      // Bypass 0: test environment. Integration test suites issue many
      // POST/PUT/DELETE mutations in a short window; the global mutation cap
      // would fire mid-suite and cascade all subsequent tests to 429. The
      // per-endpoint authLimiter already skips for test env — the global
      // limiter follows the same convention.
      if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') return true;
      // Bypass 1: load test
      const expected = process.env.LOAD_TEST_BYPASS_TOKEN;
      if (expected) {
        const provided = req.header('x-load-test-token');
        if (provided && provided === expected) return true;
      }
      // Bypass 2: safe-method reads. Legitimate clients (admin merchant
      // sessions, storefront customers) issue many GETs per page load;
      // 100+/15min is normal for normal use. Per-endpoint limiters
      // (publicLimiter etc.) still cover targeted hotspots. Mutations
      // (POST/PUT/PATCH/DELETE) below the bypass remain limited at 200/
      // 15min — that's the abuse-blocking surface.
      const method = req.method.toUpperCase();
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
        return true;
      }
      return false;
    },
  })
);

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

// CSRF protection
app.use(csrfProtection);

// Request logging
app.use(requestLogger);

// Simple health check (for load balancers)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
      const rows = await prisma.$queryRaw<Array<{ rolbypassrls: boolean }>>`
        SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user
      `;
      const bypassRls = rows[0]?.rolbypassrls === true;
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
  if (config.nodeEnv === 'production' && !config.inngestServeHost) {
    logger.warn(
      'INNGEST_SERVE_HOST is unset in production — Inngest will register the ' +
        'localhost origin and enqueued jobs will never run. Set it to the public ' +
        'API origin, e.g. https://store-api.forcemediakw.com'
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
