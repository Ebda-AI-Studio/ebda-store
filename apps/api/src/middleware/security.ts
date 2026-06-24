import { Request, Response, NextFunction } from 'express';
import rateLimit, { ipKeyGenerator, type Store } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { randomUUID } from 'node:crypto';
import { prisma } from '@force/database';
import { redis } from '../services/redis.service';
import { BoundedMap } from '../lib/bounded-map';
import { isPlatformOrigin, isAllowlistedMerchantOrigin } from '../lib/cors-cache';
import { config } from '../config';
import logger from '../lib/logger';

// ==========================================
// CSRF Protection with Redis + In-Memory Fallback
// ==========================================

// In-memory fallback when Redis is unavailable. BoundedMap caps the entry
// count so the process can never exhaust heap through CSRF token churn
// during a long Redis outage; old sessions are evicted and will re-mint.
const MAX_CSRF_TOKENS = 10000;
const csrfTokensMemory = new BoundedMap<string, { token: string; expiresAt: Date }>(
  MAX_CSRF_TOKENS
);

// Periodic cleanup of expired CSRF tokens
setInterval(
  () => {
    const now = new Date();
    for (const [key, value] of csrfTokensMemory) {
      if (value.expiresAt < now) csrfTokensMemory.delete(key);
    }
  },
  5 * 60 * 1000
); // Every 5 minutes

export async function generateCsrfToken(sessionId: string): Promise<string> {
  const token = randomUUID();
  const ttlSeconds = 3600; // 1 hour

  // Try Redis first
  if (redis.isAvailable()) {
    await redis.setCsrfToken(sessionId, token, ttlSeconds);
  } else {
    // Fallback to in-memory with size limit
    if (csrfTokensMemory.size >= MAX_CSRF_TOKENS) {
      // Evict oldest entries
      const iterator = csrfTokensMemory.keys();
      for (let i = 0; i < 1000; i++) {
        const key = iterator.next().value;
        if (key) csrfTokensMemory.delete(key);
      }
    }
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    csrfTokensMemory.set(sessionId, { token, expiresAt });
  }

  return token;
}

async function verifyCsrfToken(sessionId: string, token: string): Promise<boolean> {
  // Try Redis first
  if (redis.isAvailable()) {
    const storedToken = await redis.getCsrfToken(sessionId);
    return storedToken === token;
  }

  // Fallback to in-memory
  const stored = csrfTokensMemory.get(sessionId);
  if (!stored) return false;

  // Clean up expired tokens
  if (stored.expiresAt < new Date()) {
    csrfTokensMemory.delete(sessionId);
    return false;
  }

  return stored.token === token;
}

export function csrfProtection(req: Request, res: Response, next: NextFunction) {
  // Skip for safe methods
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  // Skip for webhook routes (they use HMAC signature verification instead)
  if (req.path.includes('/webhooks/')) {
    return next();
  }

  // Skip for all auth routes. Auth endpoints use JWT tokens (not session
  // cookies), so they are not vulnerable to CSRF. This covers login,
  // register, refresh, logout, password reset, verify-email, etc.
  if (req.path.includes('/auth/')) {
    return next();
  }

  // Skip for public routes. These are unauthenticated endpoints (affiliate
  // apply, contact form, cart operations, etc.) that don't use cookies or
  // sessions, so they are not vulnerable to CSRF. They have their own
  // rate limiting for abuse protection.
  if (req.path.includes('/public/')) {
    return next();
  }

  // Skip for Bearer token authenticated requests. CSRF attacks exploit
  // cookies that the browser attaches automatically. Bearer tokens in the
  // Authorization header are never sent automatically by the browser, so
  // these requests are inherently immune to CSRF.
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return next();
  }

  // OWASP "custom request header" defense — applies when the Origin is
  // a platform origin we control end-to-end.
  //
  // A simple HTML form attack can only forge POSTs with
  // `application/x-www-form-urlencoded` / `multipart/form-data` /
  // `text/plain`. JSON / XHR requests trigger a CORS preflight first,
  // and our CORS config rejects unknown origins — so JSON POSTs from
  // forcemediakw.com (admin / storefront) are inherently safe.
  //
  // CRITICAL: this skip MUST gate on the request's Origin being a
  // PLATFORM origin, not "any allowed origin". Custom merchant domains
  // are also CORS-allowlisted (via DB lookup at runtime), so without
  // the platform-origin gate a malicious merchant could configure
  // `attacker.com` as their store's domain, mount a JSON CSRF page
  // there, and ride the API host's cookie to call any other store's
  // endpoints. The CSRF-token verifier below catches that case.
  //
  // Guest checkout still works because the storefront is a platform
  // origin (store.forcemediakw.com) and is in the platform allowlist.
  const contentType = req.headers['content-type'] || '';
  const xRequestedWith = req.headers['x-requested-with'];
  const origin = req.headers.origin as string | undefined;
  const isJsonOrXhr = contentType.includes('application/json') || !!xRequestedWith;
  if (
    isJsonOrXhr &&
    (isPlatformOrigin(origin, {
      webUrl: config.webUrl,
      adminUrl: config.adminUrl,
      nodeEnv: config.nodeEnv,
    }) ||
      isAllowlistedMerchantOrigin(origin))
  ) {
    return next();
  }

  const sessionId = req.headers['x-session-id'] as string;
  const csrfToken = req.headers['x-csrf-token'] as string;

  // Require session ID for state-changing requests without Bearer auth.
  // This protects cookie-based or session-based endpoints from CSRF.
  if (!sessionId) {
    return res.status(403).json({
      success: false,
      error: {
        code: 'CSRF_MISSING_SESSION',
        message: 'Session ID required for state-changing requests',
      },
    });
  }

  // Always verify the CSRF token for state-changing requests (POST/PUT/PATCH/DELETE).
  // Previously this check was only applied when an Authorization header was present,
  // which left unauthenticated state-changing endpoints unprotected.
  verifyCsrfToken(sessionId, csrfToken)
    .then(valid => {
      if (!valid) {
        res.status(403).json({
          success: false,
          error: { code: 'CSRF_INVALID', message: 'Invalid CSRF token' },
        });
        return;
      }
      next();
    })
    .catch(() => {
      // Fail closed - reject the request when CSRF verification itself errors
      res.status(403).json({
        success: false,
        error: { code: 'CSRF_ERROR', message: 'CSRF validation failed' },
      });
    });
}

// ==========================================
// Rate Limiting (per-route)
// ==========================================

// ---------------------------------------------------------------------------
// Redis-backed rate-limit store (F8)
// ---------------------------------------------------------------------------

/**
 * Minimal ioredis shape rate-limit-redis needs: a raw `call(...)`.
 * `any[]` (not `unknown[]`) on purpose: ioredis's overloaded `call` has a
 * `string`-first signature that is contravariantly incompatible with an
 * `unknown[]` param, so the real client wouldn't be assignable. `any[]` makes
 * the param bivariant — the single SDK-shim seam for the redis store.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RedisCaller = { call: (...args: any[]) => unknown };

/**
 * Build a RedisStore for express-rate-limit so limits are shared across all API
 * replicas. The default in-memory MemoryStore counts per-process, letting a
 * client multiply its allowance by the replica count under horizontal scale
 * (F8). Returns `undefined` when Redis is unavailable so express-rate-limit
 * falls back to its in-memory store (dev / test only).
 */
export function makeRateLimitStore(
  redisClient: RedisCaller | null | undefined,
  prefix: string
): Store | undefined {
  if (!redisClient) return undefined;
  return new RedisStore({
    sendCommand: (...args: string[]) => redisClient.call(...args) as Promise<number | string>,
    prefix: `rl:${prefix}:`,
  });
}

// Strict limiter for auth endpoints.
//
// Two-layer brute-force defense: this 15-attempt window is the
// IP+email request budget, and the account-lockout service in
// auth.service.ts fires at 5 wrong-password attempts for the same
// email. The limiter exists to bound RAW request volume (helmet against
// credential-stuffing storms hammering the same login endpoint), not
// to be the primary brute-force gate — that's account-lockout.
//
// Previously hardcoded `max: 5`, which collided with the lockout-at-5
// boundary: the 6th request to verify the lock-out response was
// always RATE_LIMITED instead of ACCOUNT_LOCKED. 15 gives the test a
// margin and still drops a credential-stuffing attacker quickly.
//
// Tests skip the limiter entirely via `skip: () => isTestEnv` —
// integration / e2e suites need to fire many auth requests in
// sequence and rely on lockout behavior without the rate-limit
// trip-wire firing first.
const isTestEnv = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

// Shared skip predicate for load-test bypass. Active only when
// LOAD_TEST_BYPASS_TOKEN is set on the host AND the request carries
// a matching `x-load-test-token` header. Production traffic is
// rate-limited as usual whenever the env var is unset (default).
const skipForLoadTest = (req: Request): boolean => {
  const expected = process.env.LOAD_TEST_BYPASS_TOKEN;
  if (!expected) return false;
  return req.header('x-load-test-token') === expected;
};
const skipForLoadTestOrTests = (req: Request): boolean => isTestEnv || skipForLoadTest(req);
export const authLimiter = rateLimit({
  store: makeRateLimitStore(redis.getClient(), 'auth'),
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many login attempts, please try again later.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipForLoadTestOrTests,
  keyGenerator: req => {
    // Use IP + email for more granular limiting. ipKeyGenerator() normalizes
    // IPv6 to /64 prefix so an attacker can't rotate the lower 64 bits to
    // get a fresh bucket per request (ERR_ERL_KEY_GEN_IPV6).
    const email = req.body?.email || 'unknown';
    return `${ipKeyGenerator(req.ip ?? '')}-${email}`;
  },
});

// Limiter for API writes (orders, payments)
export const writeLimiter = rateLimit({
  store: makeRateLimitStore(redis.getClient(), 'write'),
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 writes per minute
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipForLoadTest,
});

// Stricter limiter for payment operations
export const paymentLimiter = rateLimit({
  store: makeRateLimitStore(redis.getClient(), 'payment'),
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 payment attempts per minute
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many payment attempts, please wait.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipForLoadTest,
});

// File upload limiter - more restrictive
export const uploadLimiter = rateLimit({
  store: makeRateLimitStore(redis.getClient(), 'upload'),
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 uploads per minute
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many upload requests, please slow down.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipForLoadTest,
  keyGenerator: req => {
    // Limit per user, not per IP. ipKeyGenerator() applied to the IP
    // fallback so anonymous IPv6 callers can't bypass via lower-64-bit
    // rotation (ERR_ERL_KEY_GEN_IPV6).
    return req.user?.userId || ipKeyGenerator(req.ip ?? '') || 'anonymous';
  },
});

// Daily upload limit per user
export const dailyUploadLimiter = rateLimit({
  store: makeRateLimitStore(redis.getClient(), 'upload-daily'),
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 500, // 500 uploads per day per user
  message: {
    success: false,
    error: { code: 'DAILY_LIMIT', message: 'Daily upload limit reached. Try again tomorrow.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipForLoadTest,
  keyGenerator: req => {
    // ipKeyGenerator() normalizes IPv6 to /64 prefix (ERR_ERL_KEY_GEN_IPV6).
    return req.user?.userId || ipKeyGenerator(req.ip ?? '') || 'anonymous';
  },
});

// Public API rate limiter - protect public endpoints from abuse
export const publicLimiter = rateLimit({
  store: makeRateLimitStore(redis.getClient(), 'public'),
  windowMs: 60 * 1000, // 1 minute
  // Storefront browsing burns through this fast on real mobile sessions:
  // home + Next.js App Router RSC prefetches on link hover/viewport entry +
  // product-list pagination + category filters easily clear 60 req/min on
  // a routine browse. Mobile audit on 2026-05-13 reproduced the "Too many
  // requests" banner during a normal customer flow. 300/min (~5/sec) is
  // generous for human use + RSC fanout while still tripping on bots
  // (typically >10/sec).
  max: 300,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipForLoadTest,
});

// Store resolver rate limiter - stricter for domain resolution
export const storeResolveLimiter = rateLimit({
  store: makeRateLimitStore(redis.getClient(), 'store-resolve'),
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many store resolution requests.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipForLoadTest,
});

// Cart rate limiter - prevent cart bombing
export const cartLimiter = rateLimit({
  store: makeRateLimitStore(redis.getClient(), 'cart'),
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 cart operations per minute
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many cart operations, please slow down.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipForLoadTest,
  keyGenerator: req => {
    // Use session ID if available, otherwise normalized IP (ipKeyGenerator
    // collapses IPv6 to /64 prefix — ERR_ERL_KEY_GEN_IPV6).
    const sessionId = req.headers['x-session-id'] as string;
    return sessionId || ipKeyGenerator(req.ip ?? '') || 'anonymous';
  },
});

// Newsletter signup limiter — stricter than the cart limiter because the
// signup form has no spam mitigations (no captcha, no email confirmation
// loop). 5 attempts per minute per IP+session is generous for a real human
// who fat-fingered their address but cuts off bot enumeration.
export const newsletterLimiter = rateLimit({
  store: makeRateLimitStore(redis.getClient(), 'newsletter'),
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many newsletter requests, please slow down.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipForLoadTest,
  keyGenerator: req => {
    // ipKeyGenerator() collapses IPv6 to /64 prefix — ERR_ERL_KEY_GEN_IPV6.
    const sessionId = req.headers['x-session-id'] as string;
    return `${sessionId || 'anon'}:${ipKeyGenerator(req.ip ?? '') || 'noip'}`;
  },
});

// Coupon validate limiter — public brute-force discovery protection.
// 20 attempts per minute per IP is enough for a legitimate checkout flow
// but prevents rapid enumeration of valid coupon codes.
// ipKeyGenerator() collapses IPv6 /128 → /64 (ERR_ERL_KEY_GEN_IPV6).
export const couponValidateLimiter = rateLimit({
  store: makeRateLimitStore(redis.getClient(), 'coupon-validate'),
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipForLoadTest,
  keyGenerator: req => ipKeyGenerator(req.ip ?? '') || 'noip',
});

// View ingest limiter — public PDP beacon, high-traffic, unauthenticated.
// 60 requests per minute per IP. The in-memory session debounce in
// view-ingest.service.ts provides a second layer: one DB increment per
// (sessionId, productId) per 10-minute window regardless of IP rotation.
// Key by normalized IP so IPv6 /128 bots can't bypass via address churn
// (ipKeyGenerator collapses to /64 prefix — ERR_ERL_KEY_GEN_IPV6).
export const viewIngestLimiter = rateLimit({
  store: makeRateLimitStore(redis.getClient(), 'view-ingest'),
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 view beacons per minute per IP (generous for real browsing)
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipForLoadTest,
  keyGenerator: req => ipKeyGenerator(req.ip ?? '') || 'noip',
});

// ==========================================
// Audit Logging
// ==========================================

export interface AuditLogEntry {
  action: string;
  userId?: string;
  resourceType: string;
  resourceId?: string;
  /**
   * Free-form JSON metadata. Accepts nested objects so callers can record
   * structured transitions like `{ role: { from: 'store_admin', to: 'super_admin' } }`.
   * The audit_logs table column is JSONB so anything serialisable fits.
   */
  details?: Record<string, unknown>;
  /**
   * Optional store scope — denormalised so per-store audit queries don't
   * need to join through resource → store. NULL for platform-wide events.
   */
  storeId?: string;
  ip?: string;
  userAgent?: string;
}

export async function auditLog(entry: AuditLogEntry) {
  try {
    // Log to structured logger in development
    if (process.env.NODE_ENV !== 'production') {
      logger.info({ audit: entry }, '[AUDIT]');
    }

    // Store in database
    await prisma.auditLog.create({
      data: {
        action: entry.action,
        userId: entry.userId,
        storeId: entry.storeId,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        details: entry.details ? JSON.parse(JSON.stringify(entry.details)) : {},
        ipAddress: entry.ip,
        userAgent: entry.userAgent,
      },
    });
  } catch (error) {
    // Don't fail the request if audit logging fails
    logger.error({ err: error }, '[AUDIT ERROR] Failed to write audit log');
  }
}

// ==========================================
// Input Sanitization
// ==========================================

export function sanitizeInput(req: Request, _res: Response, next: NextFunction) {
  // Recursively sanitize strings in body
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeObject(req.body);
  }

  // Sanitize query params
  if (req.query && typeof req.query === 'object') {
    req.query = sanitizeObject(req.query) as typeof req.query;
  }

  next();
}

// Maximum allowed length for any single input string before it is truncated.
const MAX_INPUT_STRING_LENGTH = 10_000;

// Fields that legitimately carry large payloads (bulk-import CSV text and
// base64-encoded XLSX uploads). These are exempt from the per-string length
// truncation \u2014 silently slicing them to 10k chars corrupts an import to ~21
// rows. They still get control-char / invisible-unicode stripping (which also
// protects the Postgres TEXT column from NUL bytes) and their own size limits
// come from express.json's 10mb body cap + route-level validation.
const LARGE_CONTENT_KEYS = new Set(['csvData', 'xlsxBase64']);

function sanitizeString(str: string, enforceMaxLength = true): string {
  // Strip null bytes and non-printable control characters (preserve newline \n, tab \t, carriage return \r)
  let cleaned = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Remove zero-width and invisible unicode characters that can be used to bypass filters
  cleaned = cleaned.replace(/[\u200B-\u200F\u2028-\u202F\uFEFF\uFFF9-\uFFFB]/g, '');

  // Enforce maximum length to prevent excessively large payloads slipping through body parsers
  if (enforceMaxLength && cleaned.length > MAX_INPUT_STRING_LENGTH) {
    cleaned = cleaned.slice(0, MAX_INPUT_STRING_LENGTH);
  }

  // NOTE: HTML encoding is intentionally NOT done here. Encoding at storage time corrupts
  // URLs, descriptions, and causes double-encoding issues. Output escaping must happen at
  // render time (template layer / invoice generation), not at input time.

  return cleaned.trim();
}

function sanitizeObject(obj: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      sanitized[key] = sanitizeString(value, !LARGE_CONTENT_KEYS.has(key));
    } else if (Array.isArray(value)) {
      sanitized[key] = value.map(item =>
        typeof item === 'object' && item !== null
          ? sanitizeObject(item as Record<string, unknown>)
          : typeof item === 'string'
            ? sanitizeString(item)
            : item
      );
    } else if (value && typeof value === 'object') {
      sanitized[key] = sanitizeObject(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

// ==========================================
// Security Headers Enhancement
// ==========================================

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  // HSTS - Strict Transport Security (1 year, include subdomains, preload ready)
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }

  // Additional security headers beyond helmet
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  // X-XSS-Protection is deprecated and harmful in modern browsers
  // (Chrome's XSS auditor caused side-channel info leaks before being
  // removed in Chrome 78). MDN recommends explicitly disabling it
  // rather than enabling — `0` tells legacy browsers not to engage
  // the auditor either. Modern XSS defense is CSP (set below) plus
  // the HTML escaping in transactional emails.
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Permissions-Policy: lock down every feature the API has no business
  // exposing. Was previously a 4-feature subset which left the door
  // open for accelerometer / fullscreen / autoplay etc. to be granted
  // to the platform origin if a future error page rendered HTML. The
  // exhaustive list is harder to drift on review; if a future feature
  // legitimately needs one, drop it from this list explicitly.
  res.setHeader(
    'Permissions-Policy',
    [
      'accelerometer=()',
      'ambient-light-sensor=()',
      'autoplay=()',
      'battery=()',
      'camera=()',
      'cross-origin-isolated=()',
      'display-capture=()',
      'document-domain=()',
      'encrypted-media=()',
      'execution-while-not-rendered=()',
      'execution-while-out-of-viewport=()',
      'fullscreen=()',
      'geolocation=()',
      'gyroscope=()',
      'keyboard-map=()',
      'magnetometer=()',
      'microphone=()',
      'midi=()',
      'navigation-override=()',
      'payment=()',
      'picture-in-picture=()',
      'publickey-credentials-get=()',
      'screen-wake-lock=()',
      'sync-xhr=()',
      'usb=()',
      'web-share=()',
      'xr-spatial-tracking=()',
    ].join(', ')
  );

  // Content Security Policy — API serves JSON, not HTML, so this is a
  // defense-in-depth measure in case an error page or redirect is rendered.
  res.setHeader(
    'Content-Security-Policy',
    ["default-src 'none'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'"].join(
      '; '
    )
  );

  // Remove server identification
  res.removeHeader('X-Powered-By');
  res.removeHeader('Server');

  // Prevent MIME type sniffing
  res.setHeader('X-Download-Options', 'noopen');

  // Cross-Origin policies
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  next();
}

// ==========================================
// Request ID for tracing
// ==========================================

export function requestId(req: Request, res: Response, next: NextFunction) {
  const clientId = req.headers['x-request-id'] as string;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const id = clientId && uuidRegex.test(clientId) ? clientId : randomUUID();
  req.headers['x-request-id'] = id;
  res.setHeader('X-Request-Id', id);
  next();
}
