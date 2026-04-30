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
import { securityHeaders, requestId, sanitizeInput, csrfProtection } from './middleware/security';
import { authenticate } from './middleware/auth';
import { requireRole } from './middleware/rbac';
import routes from './routes';
import webhookRoutes from './routes/webhook.routes';
import { socketService } from './services/socket.service';
import { setupSwagger } from './docs/swagger';
import { prisma } from '@force/database';
import { redis } from './services/redis.service';
import { circuitBreaker } from './services/circuit-breaker.service';
import { emailQueue } from './services/email-queue.service';
import { whatsappQueue } from './services/whatsapp-queue.service';
import { smsQueue } from './services/sms-queue.service';
import { abandonedCartService } from './services/abandoned-cart.service';
import { recommendationService } from './services/recommendation.service';
import { shippingCarrierService } from './services/shipping-carrier.service';
import { loyaltyAutomationService } from './services/loyalty-automation.service';
import { AuthService } from './services/auth.service';
import { SentryService } from './services/sentry.service';
import logger from './lib/logger';

// Initialize Sentry before anything else
SentryService.init();

const app = express();

// Railway terminates TLS at its proxy and forwards X-Forwarded-For. Without
// this setting, `req.ip` resolves to the proxy's address — which means every
// IP-keyed rate limiter (authLimiter, paymentLimiter, writeLimiter, etc.) is
// effectively a single global counter, and brute-force protection is off.
// `1` = trust the immediate hop only; do NOT raise to `true` (allows clients
// to spoof X-Forwarded-For). Same value used in production by Vercel /
// Cloudflare reference docs for single-proxy hops.
app.set('trust proxy', 1);

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
  whatsappQueue.startProcessing(2000);
  smsQueue.startProcessing(2000);
  abandonedCartService.startProcessing(900000); // 15 minutes
  recommendationService.startFBTCron(86400000, []); // daily; storeIds populated per-trigger
  shippingCarrierService.startTrackingCron(1800000); // every 30 minutes
  loyaltyAutomationService.startCron(86400000); // daily: birthday bonuses + point expiration

  // Refresh-token cleanup. Reuse detection requires keeping revoked
  // rows for ~30 days; without periodic deletion the table grows
  // unbounded. Run once at startup, then every 12 hours.
  AuthService.cleanupRefreshTokens().catch(err =>
    logger.error({ err }, 'Refresh-token cleanup failed at startup')
  );
  setInterval(
    () => {
      AuthService.cleanupRefreshTokens().catch(err =>
        logger.error({ err }, 'Refresh-token cleanup failed')
      );
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

      // Platform origins (storefront / admin / vercel previews / localhost) —
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
    max: 100, // limit each IP to 100 requests per windowMs
    message: {
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later.' },
    },
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Webhook routes need raw body parsing (must be before json middleware)
app.use('/api/v1/webhooks', express.raw({ type: 'application/json' }), webhookRoutes);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

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

    // Determine overall status
    const isHealthy = checks.database.status === 'connected';
    const status = isHealthy ? 'healthy' : 'degraded';

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
      whatsappQueue.stopProcessing();
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
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', reason => {
  logger.error({ err: reason }, 'Unhandled rejection');
  if (reason instanceof Error) {
    SentryService.captureException(reason, { tags: { type: 'unhandledRejection' } });
  }
});

export default app;
