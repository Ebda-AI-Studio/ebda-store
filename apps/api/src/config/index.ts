import dotenv from 'dotenv';
import crypto from 'crypto';

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
  // detail page (orders.forcemediakw.com/orders/:id?store=:storeId). Dev
  // default matches the orders app's dev port (next dev -p 3002).
  ordersUrl: process.env.ORDERS_URL || 'http://localhost:3002',

  // Database
  databaseUrl: getRequiredSecret('DATABASE_URL', 'Database URL'),
  // DIRECT_URL is the non-pooled Neon connection used for migrations
  // (prisma migrate deploy / interactive transactions). Without it, the
  // Railway preDeployCommand silently runs the pooled URL which doesn't
  // support DDL on Neon serverless — migrations vanish. Surfaced by the
  // 2026-05-22 audit (P1-6).
  directUrl: getRequiredSecret('DIRECT_URL', 'Direct (non-pooled) Database URL'),

  // Redis
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  // Optional keyspace prefix applied to EVERY Redis command via the
  // ioredis `keyPrefix` constructor option. Prod leaves this unset so
  // existing cache/session/csrf keys keep their bare shape (no migration).
  // Staging sets REDIS_KEY_PREFIX=fwb-staging: so its keys live under
  // `fwb-staging:cache:*`, `fwb-staging:csrf:*` etc., fully isolated
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
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '30m',
  refreshTokenExpiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || '365d',

  // Encryption
  encryptionKey: getRequiredSecret('ENCRYPTION_KEY', 'Encryption Key'),

  // ==========================================
  // Kuwait Payment Providers
  // Stripe doesn't work in Kuwait!
  // ==========================================

  // Payment Settings
  paymentTestMode: process.env.PAYMENT_TEST_MODE === 'true',
  defaultPaymentProvider: process.env.DEFAULT_PAYMENT_PROVIDER || 'tap',
  defaultCurrency: process.env.DEFAULT_CURRENCY || 'KWD',

  // Tap Payments (https://tap.company)
  tapApiKey: process.env.TAP_API_KEY || '',
  tapSecretKey: process.env.TAP_SECRET_KEY || '',
  tapWebhookSecret: process.env.TAP_WEBHOOK_SECRET || '',

  // MyFatoorah (https://myfatoorah.com)
  myfatoorahApiKey: process.env.MYFATOORAH_API_KEY || '',
  myfatoorahTestMode: process.env.MYFATOORAH_TEST_MODE === 'true',
  myfatoorahCountryCode: process.env.MYFATOORAH_COUNTRY_CODE || 'KWT',
  myfatoorahWebhookSecret: process.env.MYFATOORAH_WEBHOOK_SECRET || '',

  // Hesabe (https://hesabe.com)
  hesabeApiKey: process.env.HESABE_API_KEY || '',
  hesabeSecretKey: process.env.HESABE_SECRET_KEY || '', // Format: "ivKey:encryptionKey"
  hesabeMerchantId: process.env.HESABE_MERCHANT_ID || '',
  hesabeWebhookSecret: process.env.HESABE_WEBHOOK_SECRET || '',

  // UPayments (https://upayments.com)
  upaymentsApiKey: process.env.UPAYMENTS_API_KEY || '',
  upaymentsSecretKey: process.env.UPAYMENTS_SECRET_KEY || '',
  upaymentsMerchantId: process.env.UPAYMENTS_MERCHANT_ID || '',
  upaymentsWebhookSecret: process.env.UPAYMENTS_WEBHOOK_SECRET || '',

  // Storage (S3-compatible)
  storageEndpoint: process.env.STORAGE_ENDPOINT || '',
  storageAccessKey: process.env.STORAGE_ACCESS_KEY || '',
  storageSecretKey: process.env.STORAGE_SECRET_KEY || '',
  storageBucket: process.env.STORAGE_BUCKET || 'uploads',
  storagePublicUrl: process.env.STORAGE_PUBLIC_URL || '',

  // Web Push (VAPID) - platform-wide keys for standards-based Web Push (RFC 8030)
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:contact@force-ai.co',

  // OneSignal — admin-side push notifications. Tags are scoped per-user with
  // (role, store_id) so notifyAdminsOfOrder() can filter to the order's store
  // admins plus all super_admins, never bleeding to other tenants' admins.
  // Storefront OneSignal app — push notifications to shoppers. The app's
  // `chrome_web_origin` is locked to https://store.forcemediakw.com and
  // OneSignal does not allow multiple origins per app, so the admin uses
  // a SEPARATE app (variables below) when configured. When the admin
  // variables are unset we fall back to the storefront app id so legacy
  // single-app setups keep working — they just won't subscribe new admin
  // devices because the origin won't match.
  onesignalAppId: process.env.ONESIGNAL_APP_ID || '',
  onesignalRestApiKey: process.env.ONESIGNAL_REST_API_KEY || '',
  // Admin OneSignal app — push notifications to store admins about new
  // orders, etc. Origin must match https://app.forcemediakw.com. When
  // unset, falls back to the storefront app (admin pushes won't actually
  // deliver because the origin won't match — operator should create a
  // dedicated admin OneSignal app and set these).
  onesignalAdminAppId: process.env.ONESIGNAL_ADMIN_APP_ID || process.env.ONESIGNAL_APP_ID || '',
  onesignalAdminRestApiKey:
    process.env.ONESIGNAL_ADMIN_REST_API_KEY || process.env.ONESIGNAL_REST_API_KEY || '',
  // Orders PWA OneSignal app — push notifications to store staff about new
  // orders on the Orders PWA (origin orders.forcemediakw.com). OneSignal locks
  // each app to a single chrome_web_origin, so the Orders app needs its OWN
  // OneSignal app distinct from the admin one (app.forcemediakw.com). No
  // fallback to the admin app id — an origin mismatch would silently fail to
  // subscribe Orders devices, so we leave it empty and skip sends when unset.
  onesignalOrdersAppId: process.env.ONESIGNAL_ORDERS_APP_ID || '',
  onesignalOrdersRestApiKey: process.env.ONESIGNAL_ORDERS_REST_API_KEY || '',

  // Email
  smtpHost: process.env.SMTP_HOST || 'localhost',
  smtpPort: parseInt(process.env.SMTP_PORT || '1025', 10),
  smtpUser: process.env.SMTP_USER || '',
  smtpPassword: process.env.SMTP_PASSWORD || '',
  smtpFromName: process.env.SMTP_FROM_NAME || 'Force Media',
  smtpFromEmail: process.env.SMTP_FROM_EMAIL || 'noreply@force-ai.co',

  // Resend SDK key (single platform-wide account; all merchant domains live
  // under it). Falls back to SMTP_PASSWORD because the pre-existing setup
  // (nodemailer-via-Resend-SMTP) stored the same `re_xxx` key there —
  // Resend keys are valid as both SMTP password AND SDK auth, so the
  // fallback bridges the migration without forcing an env-var rename
  // on Railway. When neither is set, ResendService gracefully degrades to
  // no-op + logs a warning so dev environments don't crash on every send.
  resendApiKey: process.env.RESEND_API_KEY || process.env.SMTP_PASSWORD || '',

  // Public origin Inngest Cloud must call to reach our serve endpoint
  // (scheme+host only, e.g. https://store-api.forcemediakw.com — servePath
  // is added separately). CRITICAL: without this the SDK infers its public
  // URL from the Host header of whatever request triggers registration. Our
  // post-boot self-register PUT hits 127.0.0.1, so the SDK registered
  // `https://localhost:4000/api/v1/inngest` — unreachable from Inngest Cloud,
  // leaving every enqueued job queued forever (verified 2026-06-27: the
  // force-api app was stuck on localhost; description_balance jobs never ran).
  // Setting serveHost makes registration advertise the real domain no matter
  // who triggers it. Unset → fall back to the old (broken-on-Railway)
  // host-introspection behaviour, so prod MUST set this.
  inngestServeHost: process.env.INNGEST_SERVE_HOST || '',

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

  // Vercel (for custom domain provisioning)
  vercelApiToken: process.env.VERCEL_API_TOKEN || '',
  vercelProjectId: process.env.VERCEL_PROJECT_ID || '',
  vercelTeamId: process.env.VERCEL_TEAM_ID || '',

  // Frontend custom-domain provider. 'vercel' (default, live) or 'cloudflare'
  // (Cloudflare-for-SaaS). Per-store `Store.domainProvider` overrides this.
  domainProvider: (process.env.DOMAIN_PROVIDER as 'vercel' | 'cloudflare') || 'vercel',
  // Cloudflare-for-SaaS Custom Hostnames. Unset → CloudflareDomainService
  // reports not-configured and the resolver no-ops the CF path (like Vercel today).
  cfApiToken: process.env.CF_API_TOKEN || '',
  cfZoneId: process.env.CF_ZONE_ID || '',
  // The CNAME target a merchant points their hostname at (a hostname in our CF
  // zone that fronts the Worker / fallback origin), e.g. 'cf.forcemediakw.com'.
  cfFallbackOrigin: process.env.CF_FALLBACK_ORIGIN || '',

  // AI features — Force AI Store AI assistant uses Google Gemini 2.0 Flash
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

  // Inngest — durable async job queue for fan-out work that doesn't
  // need to block the request (post-order push/email, bulk imports,
  // PDF generation). When `INNGEST_EVENT_KEY` is unset the client
  // runs in dev mode and routes events to the local Inngest dev
  // server (npx inngest-cli dev). `INNGEST_SIGNING_KEY` is required
  // for the production /api/v1/inngest endpoint to verify Inngest
  // platform request signatures — without it the endpoint fail-
  // closes and Inngest can't invoke our functions.
  inngestEventKey: process.env.INNGEST_EVENT_KEY || '',
  inngestSigningKey: process.env.INNGEST_SIGNING_KEY || '',

  // Shipping carrier webhook shared secrets. iCarry / Aramex push
  // shipment status updates to /webhooks/shipping/<carrier>. The
  // carriers don't sign their payloads, so we require a shared secret
  // configured on both sides as `Authorization: Bearer <secret>` on
  // the inbound POST. When unset the endpoint refuses every webhook
  // (fail-closed) — without this an attacker who knows the URL could
  // forge "delivered" status updates on any tracking number.
  icarryWebhookSecret: process.env.ICARRY_WEBHOOK_SECRET || '',
  aramexWebhookSecret: process.env.ARAMEX_WEBHOOK_SECRET || '',

  // Force AI WhatsApp Business Platform bridge
  // Base URL of the WBS backend. In production: https://backend.forcemediakw.com
  // Leave unset in dev — the bridge will skip sends gracefully when store.wbsEnabled=false.
  wbsBaseUrl: process.env.WBS_BASE_URL || 'https://whatsapp-api.force-ai.co',
} as const;

// Additional production validations (core secrets already validated above)
if (config.nodeEnv === 'production') {
  // Payment-provider warning removed 2026-05-20 — FWB uses per-store
  // PaymentConfig table rows (encrypted via ENCRYPTION_KEY) for every real
  // checkout. The TAP_* / MYFATOORAH_* / HESABE_* / UPAYMENTS_* env vars
  // only feed the legacy platform-level fallback path, which is never hit
  // in production (no super-admin payment without a store context). The
  // boot-time warning was misleading — it shouted about an unused code path
  // and looked like a P0 in railway logs every cold start.

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
