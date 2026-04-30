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

  // Database
  databaseUrl: getRequiredSecret('DATABASE_URL', 'Database URL'),

  // Redis
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  // JWT - No fallback in production. Long lifetimes are intentional: the
  // admin PWA on a phone is expected to "stay logged in" between visits
  // so a store admin can tap a push notification about a new order and
  // land directly on the order page without re-authenticating. The
  // refresh token (1 year) is the practical re-login window.
  jwtSecret: getRequiredSecret('JWT_SECRET', 'JWT Secret'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '30d',
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
  whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',

  // Web Push (VAPID) - platform-wide keys for standards-based Web Push (RFC 8030)
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:contact@forcemediakw.com',

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

  // Email
  smtpHost: process.env.SMTP_HOST || 'localhost',
  smtpPort: parseInt(process.env.SMTP_PORT || '1025', 10),
  smtpUser: process.env.SMTP_USER || '',
  smtpPassword: process.env.SMTP_PASSWORD || '',
  smtpFromName: process.env.SMTP_FROM_NAME || 'Force Media',
  smtpFromEmail: process.env.SMTP_FROM_EMAIL || 'noreply@forcemedia.com',

  // Logging & Monitoring
  logLevel: process.env.LOG_LEVEL || 'debug',
  sentryDsn: process.env.SENTRY_DSN || '',
  sentryDebug: process.env.SENTRY_DEBUG === 'true',

  // Vercel (for custom domain provisioning)
  vercelApiToken: process.env.VERCEL_API_TOKEN || '',
  vercelProjectId: process.env.VERCEL_PROJECT_ID || '',
  vercelTeamId: process.env.VERCEL_TEAM_ID || '',

  // Backup
  backupEnabled: process.env.BACKUP_ENABLED === 'true',
  backupSchedule: process.env.BACKUP_SCHEDULE || '0 3 * * *', // Daily at 3 AM
  backupRetentionDays: parseInt(process.env.BACKUP_RETENTION_DAYS || '30', 10),
  backupS3Bucket: process.env.BACKUP_S3_BUCKET || '',

  // Shipping carrier webhook shared secrets. iCarry / Aramex push
  // shipment status updates to /webhooks/shipping/<carrier>. The
  // carriers don't sign their payloads, so we require a shared secret
  // configured on both sides as `Authorization: Bearer <secret>` on
  // the inbound POST. When unset the endpoint refuses every webhook
  // (fail-closed) — without this an attacker who knows the URL could
  // forge "delivered" status updates on any tracking number.
  icarryWebhookSecret: process.env.ICARRY_WEBHOOK_SECRET || '',
  aramexWebhookSecret: process.env.ARAMEX_WEBHOOK_SECRET || '',
} as const;

// Additional production validations (core secrets already validated above)
if (config.nodeEnv === 'production') {
  // Warn if no payment provider is configured
  if (
    !config.tapApiKey &&
    !config.myfatoorahApiKey &&
    !config.hesabeApiKey &&
    !config.upaymentsApiKey
  ) {
    // Logger cannot be used here (it depends on config) — write directly to stderr
    process.stderr.write('[CONFIG] Warning: No payment provider configured!\n');
  }

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
