/**
 * Signup spam controls (SP5 task 4) layered in front of
 * `MerchantSignupService.signup`:
 *
 *   1. honeypot  - a hidden field no person fills; a filled one is a bot. The
 *                  answer is the SAME generic success (nothing is created), so
 *                  the bot learns nothing.
 *   2. form token - a server-signed timestamp + random nonce issued when the form loads
 *                  (`GET /auth/merchant/signup-token`). A submit faster than
 *                  `SIGNUP_MIN_FILL_MS`, with a missing / forged / expired /
 *                  already-used token is refused. The client cannot forge the
 *                  fill time because the server signs it.
 *   3. disposable domain - throwaway-mail blocklist (@ebda/shared), subdomains
 *                  included.
 *   4. per-domain daily cap - brute-force farming through one custom domain.
 *                  Large consumer providers are exempt (per-IP limits cover them).
 *
 * None of these reveal whether an ADDRESS already has an account: every refusal
 * depends only on the request, never on the user table.
 */
import crypto, { randomBytes } from 'crypto';
import { emailDomain, isDisposableEmail } from '@ebda/shared';
import { config } from '../config';
import logger from '../lib/logger';
import { abuseConfig } from '../lib/abuse-config';
import { maskEmail } from '../lib/pii-mask';
import { AppError } from '../middleware/error-handler';
import { redis } from './redis.service';

/** Consumer providers shared by millions of real people: never capped per domain. */
export const MAJOR_EMAIL_PROVIDERS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'ymail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'yandex.com',
  'mail.com',
  'zoho.com',
  'gmx.com',
]);

/** Name of the hidden honeypot input. Looks like something a form-filling bot wants to fill. */
export const SIGNUP_HONEYPOT_FIELD = 'company_site';

const TOKEN_KEY_PREFIX = 'signup:form-token:';

function sign(payload: string): string {
  return crypto
    .createHmac('sha256', `${config.jwtSecret}:merchant-signup-form`)
    .update(payload)
    .digest('base64url');
}

/**
 * Issue a form token: `<issuedAtMs>.<nonce>.<hmac(issuedAtMs.nonce)>`. Stateless; single use is
 * enforced at submit by claiming the signature. The nonce makes two tokens issued in the same
 * millisecond distinct: without it they were byte-identical and the second visitor's submit was
 * refused as already used (Ruling FU46-11). 9 random bytes from node `randomBytes` (nodejs_compat on Workers) = 12
 * base64url characters.
 */
export function issueSignupFormToken(now: number = Date.now()): string {
  const ts = String(now);
  const nonce = randomBytes(9).toString('base64url');
  return `${ts}.${nonce}.${sign(`${ts}.${nonce}`)}`;
}

export type FormTokenVerdict = 'ok' | 'invalid' | 'too_fast' | 'expired';

const NONCE_RE = /^[A-Za-z0-9_-]{12}$/;

export function verifySignupFormToken(
  token: unknown,
  now: number = Date.now()
): { verdict: FormTokenVerdict; sig?: string } {
  if (typeof token !== 'string') return { verdict: 'invalid' };
  const parts = token.split('.');
  // 3 parts since FU46-11; 2 parts = a token issued before it, accepted until it ages out.
  // TODO(remove after 2026-10-23): drop the legacy 2-part branch once every pre-FU46-11 token has expired.
  if (parts.length !== 2 && parts.length !== 3) return { verdict: 'invalid' };
  const ts = parts[0];
  const nonce = parts.length === 3 ? parts[1] : null;
  const sig = parts[parts.length - 1];
  if (!/^\d{10,15}$/.test(ts)) return { verdict: 'invalid' };
  if (nonce !== null && !NONCE_RE.test(nonce)) return { verdict: 'invalid' };
  const expected = sign(nonce === null ? ts : `${ts}.${nonce}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { verdict: 'invalid' };
  const age = now - Number(ts);
  if (age < 0) return { verdict: 'invalid' };
  if (age < abuseConfig.signupMinFillMs()) return { verdict: 'too_fast', sig };
  if (age > abuseConfig.signupFormMaxAgeMs()) return { verdict: 'expired', sig };
  return { verdict: 'ok', sig };
}

/** Claim a token for one use. Redis down -> allowed (fail open: availability over strictness). */
async function consumeToken(sig: string): Promise<boolean> {
  const client = redis.getClient();
  if (!client || !redis.isAvailable()) return true;
  try {
    const ttl = Math.ceil(abuseConfig.signupFormMaxAgeMs() / 1000) + 60;
    const res = await client.set(`${TOKEN_KEY_PREFIX}${sig}`, '1', 'EX', ttl, 'NX');
    return res === 'OK';
  } catch (err) {
    logger.warn({ err }, 'signup form token claim failed; allowing');
    return true;
  }
}

/** UTC day bucket for the per-domain counter. */
function dayBucket(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Count one signup attempt for `domain` today; true while within the cap.
 * Redis down -> allowed.
 */
async function withinDomainCap(domain: string, now: number): Promise<boolean> {
  const client = redis.getClient();
  if (!client || !redis.isAvailable()) return true;
  try {
    const key = `signup:domain:${domain}:${dayBucket(now)}`;
    const n = await client.incr(key);
    if (n === 1) await client.expire(key, 26 * 60 * 60);
    return n <= abuseConfig.signupEmailDomainDailyCap();
  } catch (err) {
    logger.warn({ err, domain }, 'signup domain cap check failed; allowing');
    return true;
  }
}

export type SignupGate = { allowed: true } | { allowed: false; silent: true };

/**
 * Run every pre-signup control. Returns `{ allowed: false, silent: true }` for
 * the honeypot (caller answers the generic success without creating anything)
 * and throws an `AppError` for the rest.
 */
export async function runSignupGate(
  input: { email: string; honeypot?: unknown; formToken?: unknown },
  now: number = Date.now()
): Promise<SignupGate> {
  if (typeof input.honeypot === 'string' && input.honeypot.trim() !== '') {
    logger.info({ email: maskEmail(input.email) }, 'signup honeypot tripped');
    return { allowed: false, silent: true };
  }

  const token = verifySignupFormToken(input.formToken, now);
  if (token.verdict === 'too_fast') {
    throw new AppError(400, 'SIGNUP_TOO_FAST', 'Please wait a moment and submit again');
  }
  if (token.verdict !== 'ok') {
    throw new AppError(400, 'SIGNUP_FORM_INVALID', 'This form has expired. Please submit again');
  }

  if (isDisposableEmail(input.email)) {
    logger.info({ email: maskEmail(input.email) }, 'signup refused: disposable email domain');
    throw new AppError(
      400,
      'EMAIL_DOMAIN_NOT_ALLOWED',
      'Please use a permanent email address, not a temporary one'
    );
  }

  const domain = emailDomain(input.email);
  if (domain && !MAJOR_EMAIL_PROVIDERS.has(domain) && !(await withinDomainCap(domain, now))) {
    logger.warn({ domain }, 'signup refused: per-email-domain daily cap');
    throw new AppError(
      429,
      'SIGNUP_DOMAIN_CAP',
      'Too many signups from this email provider today. Please try again tomorrow'
    );
  }

  // Last, so a request refused above does not burn the visitor's token.
  if (token.sig && !(await consumeToken(token.sig))) {
    throw new AppError(400, 'SIGNUP_FORM_INVALID', 'This form has expired. Please submit again');
  }
  return { allowed: true };
}
