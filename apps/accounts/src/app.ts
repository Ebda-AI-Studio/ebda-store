import { Hono, type Context } from 'hono';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import {
  createSession,
  findUserByEmail,
  findUserById,
  isSessionRevoked,
  resolveRefresh,
  revokeAllForUser,
  revokeSession,
  SESSION_TTL_MS,
  type Resolved,
  type UserRow,
} from './data';
import { ACCESS_TTL_SECONDS, mintAccessToken, verifyOwnAccessToken, type StoreClaim } from './jwt';
import { jwks } from './keys';
import { DUMMY_HASH, hashPassword, passwordPolicy, verifyPassword } from './password';
import { clearEmail, isLocked, recordFailure } from './throttle';
import { issueOtp, OTP_TTL_MINUTES, verifyOtp, type OtpType } from './otp';
import * as passkeys from './passkeys';
import { newSecret, seal, totpUri, unseal, verifyTotp } from './totp';
import { csv, iso, nowMs, randomCode, sha256Hex } from './util';

export const COOKIE = '__Host-ebda_rt';
type Env = Cloudflare.Env;
type C = Context<{ Bindings: Env }>;

class HttpError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503,
    public readonly code: string,
    message?: string
  ) {
    super(message ?? code);
  }
}

const err = (status: HttpError['status'], code: string, message?: string) =>
  new HttpError(status, code, message);

const emailSchema = z.string().trim().toLowerCase().email().max(254);

// ----------------------------------------------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------------------------------------------

const clientIp = (c: C) => c.req.header('cf-connecting-ip') ?? 'unknown';
const sessionCtx = (c: C) => ({ ip: clientIp(c), userAgent: c.req.header('user-agent') ?? '' });

function audOf(env: Env, raw: string | undefined | null): string {
  const aud = raw ?? 'store';
  if (!csv(env.PRODUCTS).includes(aud)) throw err(400, 'INVALID_AUDIENCE');
  return aud;
}

const cookieValue = (c: C): string => {
  const h = c.req.header('cookie') ?? '';
  for (const part of h.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return '';
};

const setRefreshCookie = (c: C, value: string) =>
  c.header(
    'Set-Cookie',
    `${COOKIE}=${value}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; Path=/; Secure; HttpOnly; SameSite=Lax`,
    { append: true }
  );
const clearRefreshCookie = (c: C) =>
  c.header('Set-Cookie', `${COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`, {
    append: true,
  });

/**
 * CSRF for cookie-authenticated requests. A request the browser marks cross-site is refused outright; one that
 * carries an Origin must be on the allow-list. (store.ebda.app -> accounts.ebda.app is same-site, so Lax cookies flow.)
 */
function originGuard(c: C): void {
  if (c.req.header('sec-fetch-site') === 'cross-site') throw err(403, 'CROSS_SITE');
  const origin = c.req.header('origin');
  if (origin && !csv(c.env.ALLOWED_ORIGINS).includes(origin)) throw err(403, 'ORIGIN_NOT_ALLOWED');
}

async function storesFor(env: Env, userId: string): Promise<StoreClaim[]> {
  if (!env.STORE_DIRECTORY) return [];
  try {
    return await env.STORE_DIRECTORY.storesForUser(userId);
  } catch {
    // A failed read is NOT "no stores": refuse, do not mint a token that silently loses access.
    throw err(503, 'DIRECTORY_UNAVAILABLE');
  }
}

async function mintFor(env: Env, user: UserRow, sid: string, aud: string) {
  const { token, expiresAt } = await mintAccessToken(env, {
    sub: user.id,
    sid,
    aud,
    stores: await storesFor(env, user.id),
    ...(user.role === 'super_admin' ? { pa: 'super_admin' as const } : {}),
    email: user.email,
    email_verified: !!user.email_verified,
  });
  return {
    access_token: token,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SECONDS,
    expires_at: expiresAt,
  };
}

const publicUser = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  firstName: u.first_name,
  lastName: u.last_name,
  role: u.role,
  emailVerified: !!u.email_verified,
  language: u.language,
  mfaEnabled: !!u.mfa_enabled,
});

async function sessionResponse(c: C, user: UserRow, amr: string, aud: string) {
  const s = await createSession(c.env.DB, user, amr, sessionCtx(c));
  setRefreshCookie(c, s.refreshToken);
  return { user: publicUser(user), ...(await mintFor(c.env, user, s.sid, aud)) };
}

/** Bearer access token (any product audience) -> live user + session. Used by management endpoints. */
async function bearerAuth(c: C): Promise<{ user: UserRow; sid: string }> {
  const h = c.req.header('authorization') ?? '';
  const m = /^Bearer (.+)$/.exec(h);
  if (!m) throw err(401, 'UNAUTHORIZED');
  let verified: Awaited<ReturnType<typeof verifyOwnAccessToken>> | undefined;
  for (const aud of csv(c.env.PRODUCTS)) {
    try {
      verified = await verifyOwnAccessToken(c.env, m[1], aud);
      break;
    } catch {
      /* try the next audience */
    }
  }
  if (!verified) throw err(401, 'UNAUTHORIZED');
  if (await isSessionRevoked(c.env.DB, verified.sid)) throw err(401, 'SESSION_REVOKED');
  const user = await findUserById(c.env.DB, verified.sub);
  if (!user || user.status !== 'active') throw err(401, 'UNAUTHORIZED');
  return { user, sid: verified.sid };
}

/** Step-up for sensitive changes: the account password again. */
async function requirePassword(user: UserRow, password: unknown): Promise<void> {
  if (typeof password !== 'string' || !(await verifyPassword(password, user.password_hash)))
    throw err(403, 'STEP_UP_REQUIRED');
}

async function mail(c: C, user: UserRow, kind: 'email_verify' | 'password_reset', type: OtpType) {
  const code = await issueOtp(c.env.DB, user, type);
  if (!code || !c.env.MAILER) return;
  try {
    await c.env.MAILER.sendCode({
      to: user.email,
      kind,
      code,
      language: user.language === 'ar' ? 'ar' : 'en',
      firstName: user.first_name,
      ttlMinutes: OTP_TTL_MINUTES[type],
    });
  } catch (e) {
    console.error(JSON.stringify({ msg: 'otp mail failed', kind, error: (e as Error).message }));
  }
}

// ----------------------------------------------------------------------------------------------------------------
// App
// ----------------------------------------------------------------------------------------------------------------

export function createApp() {
  const app = new Hono<{ Bindings: Env }>();

  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    const allowed = !!origin && csv(c.env.ALLOWED_ORIGINS).includes(origin);
    if (c.req.method === 'OPTIONS') {
      if (!allowed) return c.body(null, 403);
      return c.body(null, 204, {
        'Access-Control-Allow-Origin': origin!,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'content-type,authorization',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      });
    }
    await next();
    c.header('Vary', 'Origin', { append: true });
    if (allowed) {
      c.header('Access-Control-Allow-Origin', origin!);
      c.header('Access-Control-Allow-Credentials', 'true');
    }
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
    return undefined;
  });

  app.onError((e, c) => {
    if (e instanceof HttpError)
      return c.json({ success: false, error: { code: e.code, message: e.message } }, e.status);
    if (e instanceof z.ZodError)
      return c.json(
        {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request',
            details: e.flatten().fieldErrors,
          },
        },
        400
      );
    if (e instanceof passkeys.PasskeyError)
      return c.json({ success: false, error: { code: e.code, message: e.code } }, e.status as 400);
    console.error(JSON.stringify({ msg: 'unhandled', error: (e as Error).message }));
    return c.json({ success: false, error: { code: 'INTERNAL', message: 'Internal error' } }, 500);
  });

  const json = async <T extends z.ZodTypeAny>(c: C, schema: T): Promise<z.infer<T>> => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw err(400, 'VALIDATION_ERROR', 'JSON body required');
    }
    return schema.parse(body);
  };

  // ---- discovery ----
  app.get('/health', c => c.json({ status: 'ok', service: 'accounts' }));
  app.get('/.well-known/jwks.json', async c => {
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(await jwks(c.env));
  });
  app.get('/.well-known/openid-configuration', c => {
    c.header('Cache-Control', 'public, max-age=300');
    return c.json({
      issuer: c.env.ISSUER,
      jwks_uri: `${c.env.ISSUER}/.well-known/jwks.json`,
      token_endpoint: `${c.env.ISSUER}/token`,
      id_token_signing_alg_values_supported: ['ES256'],
      subject_types_supported: ['public'],
    });
  });

  // ---- password login ----
  const loginBody = z.object({
    email: emailSchema,
    password: z.string().min(1).max(200),
    aud: z.string().optional(),
  });

  app.post('/login', async c => {
    const body = await json(c, loginBody);
    const aud = audOf(c.env, body.aud);
    const ip = clientIp(c);
    if (await isLocked(c.env.DB, body.email, ip))
      throw err(429, 'ACCOUNT_LOCKED', 'Too many attempts. Try again later.');
    const user = await findUserByEmail(c.env.DB, body.email);
    if (!user) {
      await bcrypt.compare(body.password, DUMMY_HASH); // same cost as a wrong password: no stopwatch oracle
      await recordFailure(c.env.DB, body.email, ip);
      throw err(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }
    if (!(await verifyPassword(body.password, user.password_hash))) {
      await recordFailure(c.env.DB, body.email, ip);
      throw err(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }
    // Status is checked AFTER the password so "suspended" is not distinguishable from "wrong password" by shape.
    if (user.status !== 'active')
      throw err(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    await clearEmail(c.env.DB, body.email);

    if (user.mfa_enabled && user.mfa_secret) {
      const challenge = randomCode() + crypto.randomUUID().replaceAll('-', '') + randomCode();
      await c.env.DB.prepare(
        `INSERT INTO challenges (id, kind, user_id, data, expires_at) VALUES (?1,'mfa',?2,?3,?4)`
      )
        .bind(
          await sha256Hex(challenge),
          user.id,
          JSON.stringify({ aud, attempts: 0 }),
          nowMs() + 5 * 60_000
        )
        .run();
      return c.json({ success: true, data: { mfaRequired: true, challenge } });
    }
    return c.json({ success: true, data: await sessionResponse(c, user, 'pwd', aud) });
  });

  app.post('/login/mfa', async c => {
    const body = await json(
      c,
      z.object({
        challenge: z.string().min(10).max(200),
        code: z.string().max(20).optional(),
        backupCode: z.string().max(40).optional(),
      })
    );
    const id = await sha256Hex(body.challenge);
    const row = await c.env.DB.prepare(
      `SELECT * FROM challenges WHERE id = ?1 AND kind = 'mfa' AND expires_at > ?2`
    )
      .bind(id, nowMs())
      .first<{ user_id: string; data: string }>();
    if (!row) throw err(401, 'INVALID_CHALLENGE');
    const data = JSON.parse(row.data) as { aud: string; attempts: number };
    if (data.attempts >= 5) {
      await c.env.DB.prepare(`DELETE FROM challenges WHERE id = ?1`).bind(id).run();
      throw err(401, 'INVALID_CHALLENGE');
    }
    const user = await findUserById(c.env.DB, row.user_id);
    if (!user || user.status !== 'active' || !user.mfa_secret || !c.env.MFA_KEY)
      throw err(401, 'INVALID_CHALLENGE');
    let ok = false;
    let remaining: string[] | null = null;
    if (body.code) {
      ok = (await verifyTotp(await unseal(c.env.MFA_KEY, user.mfa_secret), body.code)) !== null;
    } else if (body.backupCode) {
      const hashed = JSON.parse(user.mfa_backup_codes) as string[];
      for (let i = 0; i < hashed.length && !ok; i++) {
        if (await bcrypt.compare(body.backupCode, hashed[i])) {
          ok = true;
          remaining = hashed.filter((_, j) => j !== i);
        }
      }
    }
    if (!ok) {
      data.attempts += 1;
      await c.env.DB.prepare(`UPDATE challenges SET data = ?2 WHERE id = ?1`)
        .bind(id, JSON.stringify(data))
        .run();
      throw err(401, 'INVALID_CODE');
    }
    // Consume the challenge: one verification, one session.
    const del = await c.env.DB.prepare(`DELETE FROM challenges WHERE id = ?1`).bind(id).run();
    if ((del.meta.changes ?? 0) !== 1) throw err(401, 'INVALID_CHALLENGE');
    if (remaining)
      await c.env.DB.prepare(`UPDATE users SET mfa_backup_codes = ?2 WHERE id = ?1`)
        .bind(user.id, JSON.stringify(remaining))
        .run();
    return c.json({ success: true, data: await sessionResponse(c, user, 'pwd,otp', data.aud) });
  });

  // ---- session endpoints (refresh cookie) ----
  async function cookieSession(c: C, force = false): Promise<Resolved> {
    originGuard(c);
    const r = await resolveRefresh(c.env.DB, cookieValue(c), force);
    if (!r) {
      clearRefreshCookie(c);
      throw err(401, 'NO_SESSION');
    }
    if (r.newRefreshToken) setRefreshCookie(c, r.newRefreshToken);
    return r;
  }

  app.get('/token', async c => {
    const aud = audOf(c.env, c.req.query('aud'));
    const r = await cookieSession(c);
    return c.json({ success: true, data: await mintFor(c.env, r.user, r.session.sid, aud) });
  });

  app.post('/refresh', async c => {
    const aud = audOf(c.env, c.req.query('aud'));
    const r = await cookieSession(c, true);
    return c.json({ success: true, data: await mintFor(c.env, r.user, r.session.sid, aud) });
  });

  app.post('/logout', async c => {
    originGuard(c);
    // Cookie session and/or bearer: revoke whichever session(s) the caller proves. Always clears the cookie.
    const r = cookieValue(c) ? await resolveRefresh(c.env.DB, cookieValue(c)) : null;
    if (r) await revokeSession(c.env.DB, r.session.sid, 'logout');
    try {
      const b = await bearerAuth(c);
      await revokeSession(c.env.DB, b.sid, 'logout');
    } catch {
      /* no/invalid bearer: the cookie path above is enough */
    }
    clearRefreshCookie(c);
    return c.json({ success: true, data: { loggedOut: true } });
  });

  app.post('/revoke', async c => {
    const b = await bearerAuth(c);
    const body = await json(
      c,
      z.object({ sid: z.string().uuid().optional(), all: z.boolean().optional() })
    );
    if (body.all) {
      await revokeAllForUser(c.env.DB, b.user.id, 'revoke-all');
      clearRefreshCookie(c);
      return c.json({ success: true, data: { revoked: 'all' } });
    }
    const target = body.sid ?? b.sid;
    const own = await c.env.DB.prepare(`SELECT sid FROM sessions WHERE sid = ?1 AND user_id = ?2`)
      .bind(target, b.user.id)
      .first();
    if (!own) throw err(404, 'SESSION_NOT_FOUND');
    await revokeSession(c.env.DB, target, 'revoke');
    return c.json({ success: true, data: { revoked: target } });
  });

  app.get('/sessions', async c => {
    const b = await bearerAuth(c);
    const rows = await c.env.DB.prepare(
      `SELECT sid, created_at, expires_at, ip, user_agent, amr FROM sessions WHERE user_id = ?1 AND revoked_at IS NULL AND expires_at > ?2 ORDER BY created_at DESC`
    )
      .bind(b.user.id, nowMs())
      .all();
    return c.json({ success: true, data: { current: b.sid, sessions: rows.results } });
  });

  app.get('/me', async c => {
    const b = await bearerAuth(c);
    return c.json({ success: true, data: { user: publicUser(b.user) } });
  });

  // ---- signup / OTP / password reset ----
  const signupBody = z.object({
    email: emailSchema,
    password: passwordPolicy,
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().max(100).default(''),
    phone: z.string().trim().max(40).optional(),
    language: z.enum(['en', 'ar']).default('en'),
  });

  app.post('/signup', async c => {
    const body = await json(c, signupBody);
    const hash = await hashPassword(body.password); // always paid, so "exists" and "new" take the same time
    if (!(await findUserByEmail(c.env.DB, body.email))) {
      const id = crypto.randomUUID();
      try {
        await c.env.DB.prepare(
          `INSERT INTO users (id, email, password_hash, first_name, last_name, phone, role, status, email_verified, language, created_at, updated_at)
           VALUES (?1,?2,?3,?4,?5,?6,'store_admin','active',0,?7,?8,?8)`
        )
          .bind(
            id,
            body.email,
            hash,
            body.firstName,
            body.lastName,
            body.phone ?? null,
            body.language,
            iso()
          )
          .run();
        const user = await findUserById(c.env.DB, id);
        if (user) await mail(c, user, 'email_verify', 'email');
      } catch (e) {
        if (!/UNIQUE/i.test((e as Error).message)) throw e; // lost a race: it exists now
      }
    }
    // Same answer whether or not the address was already registered.
    return c.json({ success: true, data: { status: 'verification_sent' } }, 202);
  });

  const otpBody = z.object({ email: emailSchema, code: z.string().regex(/^\d{6}$/) });

  app.post('/otp/verify', async c => {
    const body = await json(c, otpBody);
    const ip = clientIp(c);
    const key = `otp:${body.email}`;
    if (await isLocked(c.env.DB, key, ip)) throw err(429, 'TOO_MANY_ATTEMPTS');
    const user = await findUserByEmail(c.env.DB, body.email);
    const ok = user ? await verifyOtp(c.env.DB, user, 'email', body.code) : false;
    if (!ok || !user) {
      await recordFailure(c.env.DB, key, ip);
      throw err(400, 'INVALID_CODE');
    }
    await c.env.DB.prepare(`UPDATE users SET email_verified = 1, updated_at = ?2 WHERE id = ?1`)
      .bind(user.id, iso())
      .run();
    return c.json({ success: true, data: { verified: true } });
  });

  app.post('/otp/resend', async c => {
    const body = await json(c, z.object({ email: emailSchema }));
    const user = await findUserByEmail(c.env.DB, body.email);
    if (user && user.status === 'active' && !user.email_verified)
      await mail(c, user, 'email_verify', 'email');
    return c.json({ success: true, data: { status: 'sent_if_registered' } }, 202);
  });

  app.post('/password/forgot', async c => {
    const body = await json(c, z.object({ email: emailSchema }));
    const user = await findUserByEmail(c.env.DB, body.email);
    if (user && user.status === 'active') await mail(c, user, 'password_reset', 'password_reset');
    return c.json({ success: true, data: { status: 'sent_if_registered' } }, 202);
  });

  app.post('/password/reset', async c => {
    const body = await json(
      c,
      z.object({
        email: emailSchema,
        code: z.string().regex(/^\d{6}$/),
        newPassword: passwordPolicy,
      })
    );
    const ip = clientIp(c);
    const key = `otp:${body.email}`;
    if (await isLocked(c.env.DB, key, ip)) throw err(429, 'TOO_MANY_ATTEMPTS');
    const user = await findUserByEmail(c.env.DB, body.email);
    const ok = user ? await verifyOtp(c.env.DB, user, 'password_reset', body.code) : false;
    if (!ok || !user) {
      await recordFailure(c.env.DB, key, ip);
      throw err(400, 'INVALID_CODE');
    }
    await c.env.DB.prepare(
      `UPDATE users SET password_hash = ?2, email_verified = 1, updated_at = ?3 WHERE id = ?1`
    )
      .bind(user.id, await hashPassword(body.newPassword), iso())
      .run();
    await revokeAllForUser(c.env.DB, user.id, 'password-reset'); // every session of the account dies
    await clearEmail(c.env.DB, body.email);
    return c.json({ success: true, data: { reset: true } });
  });

  // ---- MFA (TOTP) management ----
  app.post('/mfa/enroll', async c => {
    const { user } = await bearerAuth(c);
    const body = await json(c, z.object({ password: z.string() }));
    await requirePassword(user, body.password);
    if (user.mfa_enabled) throw err(409, 'MFA_ALREADY_ENABLED');
    if (!c.env.MFA_KEY) throw err(503, 'MFA_UNAVAILABLE');
    const secret = newSecret();
    await c.env.DB.prepare(`UPDATE users SET mfa_secret = ?2 WHERE id = ?1`)
      .bind(user.id, await seal(c.env.MFA_KEY, secret))
      .run();
    return c.json({
      success: true,
      data: { secret, otpauthUrl: totpUri(user.email, secret, 'Ebda') },
    });
  });

  app.post('/mfa/enroll/verify', async c => {
    const { user } = await bearerAuth(c);
    const body = await json(c, z.object({ code: z.string() }));
    if (!user.mfa_secret || !c.env.MFA_KEY || user.mfa_enabled) throw err(409, 'MFA_NOT_PENDING');
    if ((await verifyTotp(await unseal(c.env.MFA_KEY, user.mfa_secret), body.code)) === null)
      throw err(400, 'INVALID_CODE');
    const plain = Array.from({ length: 10 }, () =>
      [...crypto.getRandomValues(new Uint8Array(5))]
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
    );
    const hashed = await Promise.all(plain.map(x => bcrypt.hash(x, 10)));
    await c.env.DB.prepare(
      `UPDATE users SET mfa_enabled = 1, mfa_enrolled_at = ?2, mfa_backup_codes = ?3 WHERE id = ?1`
    )
      .bind(user.id, iso(), JSON.stringify(hashed))
      .run();
    return c.json({ success: true, data: { enabled: true, backupCodes: plain } });
  });

  app.post('/mfa/disable', async c => {
    const { user } = await bearerAuth(c);
    const body = await json(c, z.object({ password: z.string(), code: z.string() }));
    await requirePassword(user, body.password);
    if (!user.mfa_secret || !c.env.MFA_KEY) throw err(409, 'MFA_NOT_ENABLED');
    if ((await verifyTotp(await unseal(c.env.MFA_KEY, user.mfa_secret), body.code)) === null)
      throw err(400, 'INVALID_CODE');
    await c.env.DB.prepare(
      `UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_backup_codes = '[]', mfa_enrolled_at = NULL WHERE id = ?1`
    )
      .bind(user.id)
      .run();
    return c.json({ success: true, data: { enabled: false } });
  });

  // ---- passkeys ----
  const originHeader = (c: C) => c.req.header('origin') ?? null;

  app.post('/passkey/login/options', async c => {
    return c.json({
      success: true,
      data: await passkeys.beginAuthentication(c.env.DB, c.env, originHeader(c)),
    });
  });

  app.post('/passkey/login/verify', async c => {
    const body = await json(c, z.object({ response: z.any(), aud: z.string().optional() }));
    const aud = audOf(c.env, body.aud);
    const ip = clientIp(c);
    const pkKey = `passkey:${ip}`; // per client: a global key would let anyone lock every passkey sign-in
    if (await isLocked(c.env.DB, pkKey, ip)) throw err(429, 'TOO_MANY_ATTEMPTS');
    const res = await passkeys.finishAuthentication(
      c.env.DB,
      c.env,
      originHeader(c),
      body.response
    );
    if ('fail' in res) {
      await recordFailure(c.env.DB, pkKey, ip);
      console.log(JSON.stringify({ msg: 'passkey auth failed', reason: res.fail }));
      throw err(401, 'PASSKEY_AUTH_FAILED', 'Passkey sign-in failed');
    }
    // A passkey (possession + user verification) satisfies MFA: no code step follows (Ruling PASSKEY-4).
    return c.json({ success: true, data: await sessionResponse(c, res.user, 'hwk', aud) });
  });

  app.post('/passkey/register/options', async c => {
    const { user } = await bearerAuth(c);
    const body = await json(c, z.object({ password: z.string() }));
    await requirePassword(user, body.password);
    return c.json({
      success: true,
      data: await passkeys.beginRegistration(c.env.DB, c.env, user, originHeader(c)),
    });
  });

  app.post('/passkey/register/verify', async c => {
    const { user } = await bearerAuth(c);
    const body = await json(c, z.object({ response: z.any(), name: z.string().optional() }));
    return c.json(
      {
        success: true,
        data: await passkeys.finishRegistration(c.env.DB, user, originHeader(c), body as never),
      },
      201
    );
  });

  app.get('/passkeys', async c => {
    const { user } = await bearerAuth(c);
    return c.json({
      success: true,
      data: { passkeys: await passkeys.listPasskeys(c.env.DB, user.id) },
    });
  });

  app.post('/passkeys/:id/delete', async c => {
    const { user } = await bearerAuth(c);
    const body = await json(c, z.object({ password: z.string() }));
    await requirePassword(user, body.password);
    if (!(await passkeys.removePasskey(c.env.DB, user.id, c.req.param('id'))))
      throw err(404, 'NOT_FOUND');
    return c.json({ success: true, data: { deleted: true } });
  });

  return app;
}
