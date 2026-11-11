import dotenv from 'dotenv';
import crypto from 'crypto';
import { BRAND } from '@ebda/shared';
import { isWorkers } from '../lib/runtime';

import { REGION } from '@ebda/shared';
dotenv.config();

// Generate a random secret for development only - this is NOT secure for production
const generateDevSecret = () => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set in production environment');
  }
  // Logger is not yet ready at this point in startup — write directly to stderr
  process.stderr.write(
    '[CONFIG] WARNING: Using auto-generated JWT secret. Set JWT_SECRET in .env for persistence.\n'
  );
  return crypto.randomBytes(32).toString('hex');
};

// Validate required secrets
const getRequiredSecret = (envVar: string, name: string): string => {
  const value = process.env[envVar];
  if (!value) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(`${name} (${envVar}) is required in production`);
    }
    if (envVar === 'JWT_SECRET') {
      return generateDevSecret();
    }
    // Logger is not yet ready at this point in startup — write directly to stderr
    process.stderr.write(`[CONFIG] WARNING: ${name} is not set. Some features may not work.\n`);
    return '';
  }
  return value;
};

export const config = {
  // Server
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || process.env.API_PORT || '4000', 10),
  host: process.env.API_HOST || '0.0.0.0',
  appVersion: process.env.APP_VERSION || '1.0.0',

  // URLs
  webUrl: process.env.WEB_URL || 'http://localhost:3000',
  adminUrl: process.env.ADMIN_URL || 'http://localhost:3001',
  apiUrl: process.env.API_URL || 'http://localhost:4000',
  // Orders PWA base URL — used to build OneSignal deep-links to the order
  // detail page (orders.ebda.app/orders/:id?store=:storeId). Dev
  // default matches the orders app's dev port (next dev -p 3002).
  ordersUrl: process.env.ORDERS_URL || 'http://localhost:3002',

  // Database
  // On Workers there is NO database (NEON-ZERO N-17: worker.ts runs on a client that throws
  // POSTGRES_REMOVED); no connection string in the environment.
  databaseUrl: isWorkers ? '' : getRequiredSecret('DATABASE_URL', 'Database URL'),
  // DIRECT_URL is the non-pooled Neon connection used for migrations
  // (prisma migrate deploy / interactive transactions). Without it, the
  // Railway preDeployCommand silently runs the pooled URL which doesn't
  // support DDL on Neon serverless — migrations vanish. Surfaced by the
  // 2026-05-22 audit (P1-6).
  directUrl: isWorkers ? '' : getRequiredSecret('DIRECT_URL', 'Direct (non-pooled) Database URL'),

  // Redis
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  // Optional keyspace prefix applied to EVERY Redis command via the
  // ioredis `keyPrefix` constructor option. Prod leaves this unset so
  // existing cache/session/csrf keys keep their bare shape (no migration).
  // Staging sets REDIS_KEY_PREFIX=ebda-staging: so its keys live under
  // `ebda-staging:cache:*`, `ebda-staging:csrf:*` etc., fully isolated
  // from prod traffic on the shared Railway Redis instance.
  redisKeyPrefix: process.env.REDIS_KEY_PREFIX || '',

  // JWT - No fallback in production.
  //
  // Access token is SHORT-LIVED (30 min). With refresh-token rotation in
  // place, a short access token is what gives rotation its security value:
  // a leaked access token is useless within half an hour, and a leaked
  // refresh token is single-use (rotated on every refresh, reuse self-
  // revokes the whole family). The 30-min access token silently refreshes
  // in the background (the web/admin clients retry on 401 via /auth/refresh)
  // so the user never sees it expire.
  //
  // The user-facing "always signed in" UX is governed by the REFRESH token
  // lifetime, NOT the access token: the admin PWA on a phone stays logged in
  // for the full refresh window (1 year) so a store admin can tap a push
  // notification about a new order weeks later and land directly on the
  // order page without re-authenticating. Shortening the access token does
  // NOT shorten the session — it only forces a transparent token swap.
  jwtSecret: getRequiredSecret('JWT_SECRET', 'JWT Secret'),
  /** Optional HMAC key for the email-barcode R2 object names; unset = derived from ENCRYPTION_KEY. */
  barcodeKeySecret: process.env.BARCODE_KEY_SECRET || '',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '30m',
  refreshTokenExpiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || '365d',

  // Encryption
  encryptionKey: getRequiredSecret('ENCRYPTION_KEY', 'Encryption Key'),

  // ==========================================
  // Egypt Payment Providers
  // Stripe doesn't work in Egypt!
  // ==========================================

  // Payment Settings
  paymentTestMode: process.env.PAYMENT_TEST_MODE === 'true',
  defaultPaymentProvider: process.env.DEFAULT_PAYMENT_PROVIDER || 'paymob',
  defaultCurrency: process.env.DEFAULT_CURRENCY || REGION.currency,

  // Storage (S3-compatible)
  storageEndpoint: process.env.STORAGE_ENDPOINT || '',
  storageAccessKey: process.env.STORAGE_ACCESS_KEY || '',
  storageSecretKey: process.env.STORAGE_SECRET_KEY || '',
  storageBucket: process.env.STORAGE_BUCKET || 'uploads',
  storagePublicUrl: process.env.STORAGE_PUBLIC_URL || '',
  // PRIVATE bucket for PII evidence (merchant tax cards / VAT certificates,
  // ruling TAX-4). Same S3 credentials; NO public access. Explicitly set to ''
  // to disable: uploads that need it are then refused (fail closed).
  storagePrivateBucket: process.env.STORAGE_PRIVATE_BUCKET ?? 'ebda-private',

  // Web Push (VAPID) - platform-wide keys for standards-based Web Push (RFC 8030)
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
  vapidSubject: process.env.VAPID_SUBJECT || `mailto:${BRAND.supportEmail}`,

  // OneSignal — admin-side push notifications. Tags are scoped per-user with
  // (role, store_id) so notifyAdminsOfOrder() can filter to the order's store
  // admins plus all super_admins, never bleeding to other tenants' admins.
  // Storefront OneSignal app — push notifications to shoppers. The app's
  // `chrome_web_origin` is locked to https://ebda.app and
  // OneSignal does not allow multiple origins per app, so the admin uses
  // a SEPARATE app (variables below) when configured. When the admin
  // variables are unset we fall back to the storefront app id so legacy
  // single-app setups keep working — they just won't subscribe new admin
  // devices because the origin won't match.
  onesignalAppId: process.env.ONESIGNAL_APP_ID || '',
  onesignalRestApiKey: process.env.ONESIGNAL_REST_API_KEY || '',
  // Admin OneSignal app — push notifications to store admins about new
  // orders, etc. Origin must match https://store.ebda.app. When
  // unset, falls back to the storefront app (admin pushes won't actually
  // deliver because the origin won't match — operator should create a
  // dedicated admin OneSignal app and set these).
  onesignalAdminAppId: process.env.ONESIGNAL_ADMIN_APP_ID || process.env.ONESIGNAL_APP_ID || '',
  onesignalAdminRestApiKey:
    process.env.ONESIGNAL_ADMIN_REST_API_KEY || process.env.ONESIGNAL_REST_API_KEY || '',
  // Orders PWA OneSignal app — push notifications to store staff about new
  // orders on the Orders PWA (origin orders.ebda.app). OneSignal locks
  // each app to a single chrome_web_origin, so the Orders app needs its OWN
  // OneSignal app distinct from the admin one (store.ebda.app). No
  // fallback to the admin app id — an origin mismatch would silently fail to
  // subscribe Orders devices, so we leave it empty and skip sends when unset.
  onesignalOrdersAppId: process.env.ONESIGNAL_ORDERS_APP_ID || '',
  onesignalOrdersRestApiKey: process.env.ONESIGNAL_ORDERS_REST_API_KEY || '',

  // PostHog — server-side Right-to-Erasure propagation only (GDPR Art. 17
  // and applicable GCC data-protection law — see
  // docs/privacy/data-map.md). Distinct from the storefront's
  // NEXT_PUBLIC_POSTHOG_KEY (public project key, baked into the browser
  // bundle) — deleting a person requires a PERSONAL API key with
  // person-level write scope, which must never reach the browser. Unset
  // by default; when unset, `deletePostHogPerson` (privacy-propagation
  // service) logs a WARN and no-ops, because nothing calls
  // `posthog.identify(userId)` so no person is keyed by our userId. Set
  // `POSTHOG_ERASURE_REQUIRED=true` once identify() is wired to make the
  // unconfigured case fail loud again. See docs/privacy/data-map.md.
  posthogPersonalApiKey: process.env.POSTHOG_PERSONAL_API_KEY || '',
  posthogProjectId: process.env.POSTHOG_PROJECT_ID || '',
  posthogHost: process.env.POSTHOG_HOST || 'https://eu.posthog.com',
  // Declares that PostHog HOLDS erasable per-subject data, so a missing
  // credential is a real compliance failure rather than a no-op. Off by
  // default because nothing in this repo calls `posthog.identify(userId)`
  // (verified 2026-09-23: every occurrence is a comment), so PostHog knows
  // visitors only by an anonymous distinct_id the server never learns —
  // there is no person keyed by our userId to delete. Set this to `true` the
  // moment identify() is wired, and the unconfigured case fails loud again.
  posthogErasureRequired: process.env.POSTHOG_ERASURE_REQUIRED === 'true',

  // Email
  smtpHost: process.env.SMTP_HOST || 'localhost',
  smtpPort: parseInt(process.env.SMTP_PORT || '1025', 10),
  smtpUser: process.env.SMTP_USER || '',
  smtpPassword: process.env.SMTP_PASSWORD || '',
  smtpFromName: process.env.SMTP_FROM_NAME || BRAND.product.nameEn,
  smtpFromEmail: process.env.SMTP_FROM_EMAIL || BRAND.noReplyEmail,

  // Logging & Monitoring
  logLevel: process.env.LOG_LEVEL || 'debug',
  sentryDsn: process.env.SENTRY_DSN || '',
  sentryDebug: process.env.SENTRY_DEBUG === 'true',

  // Out-of-band alerts (Telegram bot). Both empty = sendAlert() is a
  // no-op + a single warn line at boot. Sentry catches errors but
  // can't surface them when the process is dying (uncaughtException)
  // or when the alert needs a real mobile push for 3am incidents.
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramAlertChatId: process.env.TELEGRAM_ALERT_CHAT_ID || '',

  // The AI OS brain mirrors every alert (Ruling ESC-AIOS-1 / AIOS-8): a Telegram bot cannot read its own outgoing messages, so the
  // brain is the only place an operator or controller can read them back. Token empty = no mirror (Telegram is unaffected).
  osBrainUrl: process.env.EBDA_OS_BRAIN_URL || 'https://os.ebda.app',
  osIngestToken: process.env.EBDA_OS_INGEST_TOKEN || '',

  // Cloudflare-for-SaaS Custom Hostnames — the only custom-domain provider
  // (Vercel cancelled 2026-07, removed). Unset → CloudflareDomainService
  // reports not-configured and the resolver no-ops the domain-provisioning path.
  cfApiToken: process.env.CF_API_TOKEN || '',
  cfZoneId: process.env.CF_ZONE_ID || '',
  // The CNAME target a merchant points their hostname at (a hostname in our CF
  // zone that fronts the Worker / fallback origin), e.g. 'cf.ebda.app'.
  cfFallbackOrigin: process.env.CF_FALLBACK_ORIGIN || '',

  // AI features — Ebda AI assistant uses Google Gemini 2.0 Flash
  // for translation, SEO meta generation, and category suggestions.
  // Free tier covers 15 req/min and ~1500 req/day per project, which
  // is well above what a single store will use. `AI_FEATURES_ENABLED`
  // is a kill switch in case the free tier rate-limits us during a
  // launch and we need to disable cleanly without redeploying.
  // `AI_DAILY_TOKEN_BUDGET_PER_STORE` caps a single tenant's usage so
  // a runaway script can't burn the shared free quota.
  // Accept GEMINI_API_KEY as a fallback so a prod deploy that set the shorter
  // var name still works without a reconfig (trap: silent 503 if neither is set).
  googleAiKey: process.env.GOOGLE_GENERATIVE_AI_KEY ?? process.env.GEMINI_API_KEY ?? '',
  aiFeaturesEnabled: process.env.AI_FEATURES_ENABLED !== 'false',
  aiDailyTokenBudgetPerStore: parseInt(process.env.AI_DAILY_TOKEN_BUDGET_PER_STORE || '200000', 10),
} as const;

// Additional production validations (core secrets already validated above)
if (config.nodeEnv === 'production') {
  // Payment-provider warning removed 2026-05-20 — Ebda uses per-store
  // PaymentConfig table rows (encrypted via ENCRYPTION_KEY) for every real
  // checkout. There are no platform-level gateway env vars at all (SP6b):
  // Paymob, Kashier and Fawry keys exist only as encrypted per-store rows.

  // Validate JWT secret strength
  if (config.jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters for production');
  }

  // Reject well-known placeholder values that developers might accidentally leave in production
  const jwtSecretLower = config.jwtSecret.toLowerCase();
  if (
    jwtSecretLower.includes('change-in-production') ||
    jwtSecretLower.includes('your-super-secret') ||
    jwtSecretLower.includes('changeme') ||
    jwtSecretLower.includes('placeholder')
  ) {
    throw new Error(
      'JWT_SECRET contains a placeholder value and must be replaced with a cryptographically random secret before running in production'
    );
  }

  // Validate encryption key strength
  if (config.encryptionKey.length < 32) {
    throw new Error('ENCRYPTION_KEY must be at least 32 characters for production');
  }
}
