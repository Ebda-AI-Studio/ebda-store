import dotenv from 'dotenv';

dotenv.config();

export const config = {
  // Server
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.API_PORT || '4000', 10),
  host: process.env.API_HOST || 'localhost',
  appVersion: process.env.APP_VERSION || '1.0.0',

  // URLs
  webUrl: process.env.WEB_URL || 'http://localhost:3000',
  adminUrl: process.env.ADMIN_URL || 'http://localhost:3001',
  apiUrl: process.env.API_URL || 'http://localhost:4000',

  // Database
  databaseUrl: process.env.DATABASE_URL || '',

  // Redis
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  // JWT
  jwtSecret: process.env.JWT_SECRET || 'development-secret-change-in-production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  refreshTokenExpiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || '30d',

  // Encryption
  encryptionKey: process.env.ENCRYPTION_KEY || '',

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
  storageCdnUrl: process.env.STORAGE_CDN_URL || '',

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

  // AI (Force AI)
  aiApiKey: process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || '',
  aiApiEndpoint: process.env.AI_API_ENDPOINT || 'https://api.anthropic.com/v1/messages',

  // Backup
  backupEnabled: process.env.BACKUP_ENABLED === 'true',
  backupSchedule: process.env.BACKUP_SCHEDULE || '0 3 * * *', // Daily at 3 AM
  backupRetentionDays: parseInt(process.env.BACKUP_RETENTION_DAYS || '30', 10),
  backupS3Bucket: process.env.BACKUP_S3_BUCKET || '',
} as const;

// Validate required config in production
if (config.nodeEnv === 'production') {
  const required = ['databaseUrl', 'jwtSecret', 'encryptionKey'] as const;
  for (const key of required) {
    if (!config[key]) {
      throw new Error(`Missing required config: ${key}`);
    }
  }

  // Warn if no payment provider is configured
  if (!config.tapApiKey && !config.myfatoorahApiKey && !config.hesabeApiKey && !config.upaymentsApiKey) {
    console.warn('[CONFIG] Warning: No payment provider configured!');
  }
}
