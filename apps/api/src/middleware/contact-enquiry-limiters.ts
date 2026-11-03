import type { Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { normalizeEmail } from '@ebda/shared/contact-enquiry';
import { makeRateLimitStore, rateLimitRedisClient } from './security';

/**
 * Rate limits for the public studio enquiry form (Ruling CONTACT-FORM-1). Two independent budgets, each
 * 5 per hour: one per client IP (IPv6 normalised to its /64) and one per submitted email, so rotating the
 * address does not reset the IP budget and rotating IPs does not reset the email budget. Both are
 * skipped under vitest and by the load-test token like every limiter here (Ruling ITEST-8: a test that
 * needs a 429 builds the limiter with `skip: () => false`). Redis failure fails OPEN (the form's honeypot
 * and the studio inbox are the backstop), the same posture as the other public limiters.
 */
const MAX_PER_HOUR = 5;

const skipDefault = (req: Request): boolean => {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') return true;
  const expected = process.env.LOAD_TEST_BYPASS_TOKEN;
  return Boolean(expected) && req.header('x-load-test-token') === expected;
};

export function contactIpKey(req: Request): string {
  return ipKeyGenerator(req.ip ?? '') || 'noip';
}

/** The normalised email, else a fixed bucket for "no usable email" (those requests fail validation anyway). */
export function contactEmailKey(req: Request): string {
  const raw = (req.body as { email?: unknown } | undefined)?.email;
  return (typeof raw === 'string' && normalizeEmail(raw)) || 'no-email';
}

function make(
  prefix: string,
  keyGenerator: (req: Request) => string,
  skip?: (req: Request) => boolean
) {
  return rateLimit({
    store: makeRateLimitStore(rateLimitRedisClient, prefix),
    windowMs: 60 * 60 * 1000,
    max: MAX_PER_HOUR,
    message: {
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many messages from you, please try again later or use WhatsApp or email.',
      },
    },
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
    skip: skip ?? skipDefault,
    keyGenerator,
  });
}

export function createContactEnquiryLimiters(opts?: {
  skip?: (req: Request) => boolean;
  prefix?: string;
}) {
  const p = opts?.prefix ?? 'contact-enquiry';
  return {
    ip: make(`${p}-ip`, contactIpKey, opts?.skip),
    email: make(`${p}-email`, contactEmailKey, opts?.skip),
  };
}

export const contactEnquiryLimiters = createContactEnquiryLimiters();
