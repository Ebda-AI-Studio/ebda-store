/**
 * Tunables for the self-serve abuse controls (SP5 task 4). Read from the
 * environment on every call (not frozen at import) so a test or an operator
 * hot-fix can change a threshold without a rebuild; each has a conservative
 * default. Catalogued in docs/ENVIRONMENT.md.
 */
function intEnv(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function floatEnv(name: string, fallback: number, min = 0, max = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

export const abuseConfig = {
  // ── Signup ────────────────────────────────────────────────────────────
  /** Signups per IP per hour (POST /auth/merchant/signup). */
  signupIpPerHour: () => intEnv('SIGNUP_IP_PER_HOUR', 5, 1),
  /** Signups per IPv4 /24 (IPv6 /64) per hour. */
  signupSubnetPerHour: () => intEnv('SIGNUP_SUBNET_PER_HOUR', 20, 1),
  /** New signups per non-major email domain per UTC day. */
  signupEmailDomainDailyCap: () => intEnv('SIGNUP_EMAIL_DOMAIN_DAILY_CAP', 25, 1),
  /** Faster than this since the form loaded = a script, not a person. */
  signupMinFillMs: () => intEnv('SIGNUP_MIN_FILL_MS', 3000, 0),
  /** A form token older than this must be re-fetched. */
  signupFormMaxAgeMs: () => intEnv('SIGNUP_FORM_MAX_AGE_MS', 6 * 60 * 60 * 1000, 1000),

  // ── Stores ────────────────────────────────────────────────────────────
  /** Stores one account may create per rolling 24h (soft-deleted ones count). */
  storesPerAccountPerDay: () => intEnv('STORES_PER_ACCOUNT_PER_DAY', 2, 1),

  // ── Custom domains ────────────────────────────────────────────────────
  /** A pending/failed domain claim older than this is released. */
  domainClaimTtlHours: () => intEnv('DOMAIN_CLAIM_TTL_HOURS', 72, 1),

  // ── Card testing (storefront payments) ────────────────────────────────
  /** Online-payment attempts per store per 10 minutes. */
  paymentAttemptsPerStore10m: () => intEnv('PAYMENT_ATTEMPTS_PER_STORE_10M', 120, 1),
  /** Online-payment attempts per client IP per 10 minutes. */
  paymentAttemptsPerIp10m: () => intEnv('PAYMENT_ATTEMPTS_PER_IP_10M', 10, 1),
  /** Declines per checkout session before it is blocked (for 1 hour). */
  paymentSessionMaxDeclines: () => intEnv('PAYMENT_SESSION_MAX_DECLINES', 5, 1),
  /** Declines per client IP per hour before it is blocked. */
  paymentIpMaxDeclines: () => intEnv('PAYMENT_IP_MAX_DECLINES', 10, 1),
  /** Decline-rate alert: minimum attempts in the window before a rate means anything. */
  paymentAlertMinAttempts: () => intEnv('PAYMENT_ALERT_MIN_ATTEMPTS', 20, 1),
  /** Decline-rate alert: declines / attempts at or above this raises the alert. */
  paymentAlertDeclineRatio: () => floatEnv('PAYMENT_ALERT_DECLINE_RATIO', 0.6, 0, 1),
};
