// MUST be first: OTel auto-instrumentation patches http/express/pg at
// require-time, so the tracing SDK has to start before those modules load.
import './tracing';
import { createServer } from 'http';
import app, { lifecycle } from './app';
import { config } from './config';
import { prisma } from '@force/database';
import { redis } from './services/redis.service';
import { socketService } from './services/socket.service';
import { emailQueue } from './services/email-queue.service';
import { smsQueue } from './services/sms-queue.service';
import { abandonedCartService } from './services/abandoned-cart.service';
import { recommendationService } from './services/recommendation.service';
import { shippingCarrierService } from './services/shipping-carrier.service';
import { loyaltyAutomationService } from './services/loyalty-automation.service';
import { AuthService } from './services/auth.service';
import { SentryService } from './services/sentry.service';
import { sendAlert, awaitInFlightAlerts, ALERT_SEND_DEADLINE_MS } from './services/alerts.service';
import { withLeaderLock } from './lib/leader-election';
import { awaitDeferredWork } from './lib/after-tenant-commit';
import logger from './lib/logger';
import { listenAfterDatabaseRoleGuard, type DatabaseRoleRow } from './lib/database-role-guard';
import { retryTransientRead } from './lib/db-retry';

// The Node server shell (Railway, Docker, `npm run dev`). The Express app itself
// lives in app.ts and is shared with the Cloudflare Worker shell (worker.ts);
// everything here is process-lifetime state a Worker does not have: the listening
// socket, socket.io, in-process loops, signal handlers.

const httpServer = createServer(app);

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

// Start server — only AFTER the DB role guard has run (FIX-003). The guard used
// to be a fire-and-forget IIFE inside this callback, so the API was already
// serving when it ran, and a failed role query was logged and skipped (fail
// open). Now it is awaited first; in production an unsafe OR unverifiable role
// exits non-zero before a single request is accepted. ALLOW_BYPASSRLS_ROLE=true
// is still honoured (loudly). See lib/database-role-guard.ts; the Workers shell
// has its own guard (cf/database-role-guard.ts).
const server = httpServer;
void listenAfterDatabaseRoleGuard(
  {
    queryRole: () =>
      retryTransientRead(
        () => prisma.$queryRaw<DatabaseRoleRow[]>`
          SELECT current_user::text AS "currentUser", rolbypassrls, rolsuper
          FROM pg_roles WHERE rolname = current_user
        `,
        { label: 'database-role-guard' }
      ),
    nodeEnv: config.nodeEnv,
    allowBypassRls: process.env.ALLOW_BYPASSRLS_ROLE === 'true',
    log: logger,
    exit: code => process.exit(code),
  },
  () => server.listen(config.port, onListening)
);

function onListening(): void {
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
}

// Graceful shutdown handler
async function gracefulShutdown(signal: string) {
  logger.info({ signal }, 'Starting graceful shutdown');
  lifecycle.isShuttingDown = true;

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
