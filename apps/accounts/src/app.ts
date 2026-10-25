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
  claimTotpStep,
  purgeCredentials,
  type UserRow,
} from './data';
import { ACCESS_TTL_SECONDS, mintAccessToken, verifyOwnAccessToken, type StoreClaim } from './jwt';
import { jwks } from './keys';
import { DUMMY_HASH, hashPassword, passwordPolicy, verifyPassword } from './password';
import { CODE_GUESS, hit, LOGIN, PER_EMAIL, PER_IP_ONLY, SECOND_FACTOR } from './throttle';
import { issueOtp, OTP_TTL_MINUTES, verifyOtp, type OtpType, type PendingSignup } from './otp';
import * as passkeys from './passkeys';
import { newSecret, seal, totpUri, unseal, verifyTotp } from './totp';
import { csv, iso, nowMs, randomCode, sha256Hex } from './util';

export const COOKIE = '__Host-ebda_rt';
type Env = Cloudflare.Env;
type C = Context<{ Bindings: Env }>;

class HttpError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 415 | 429 | 503,
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

/**
 * Bearer access token -> live user + session. Credential MANAGEMENT (MFA, passkeys, step-up) accepts only a `store` token:
 * a token minted for another product must not be able to change how the account signs in. Logout and revoke only
 * ever END sessions, so they accept any product's token (`anyAud`).
 */
async function bearerAuth(c: C, anyAud = false): Promise<{ user: UserRow; sid: string }> {
  const h = c.req.header('authorization') ?? '';
  const m = /^Bearer (.+)$/.exec(h);
  if (!m) throw err(401, 'UNAUTHORIZED');
  let verified: Awaited<ReturnType<typeof verifyOwnAccessToken>> | undefined;
  for (const aud of anyAud ? csv(c.env.PRODUCTS) : ['store']) {
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

/** Step-up for sensitive changes: the account password again, throttled like a login (a bearer token alone must not allow free guessing). */
async function requirePassword(c: C, user: UserRow, password: unknown): Promise<void> {
  const a = await hit(c.env.DB, user.id, clientIp(c), { ...LOGIN, name: 'pw' });
  if (!a.ok) throw err(429, 'TOO_MANY_ATTEMPTS');
  if (typeof password !== 'string' || !(await verifyPassword(password, user.password_hash)))
    throw err(403, 'STEP_UP_REQUIRED');
  await a.succeeded();
}

/**
 * EVERY endpoint that checks a TOTP code goes through here (or /login/mfa, which does the same): counted first against a
 * per-user budget, the matched time step is claimed single-use, a success clears the counter.
 */
async function checkTotp(c: C, user: UserRow, code: unknown): Promise<boolean> {
  const a = await hit(c.env.DB, user.id, clientIp(c), SECOND_FACTOR);
  if (!a.ok) throw err(429, 'TOO_MANY_ATTEMPTS');
  if (typeof code !== 'string' || !user.mfa_secret || !c.env.MFA_KEY) return false;
  const step = await verifyTotp(
    await unseal(c.env.MFA_KEY, user.mfa_secret),
    code,
    Date.now(),
    user.mfa_last_step
  );
  if (step === null || !(await claimTotpStep(c.env.DB, user.id, step))) return false;
  await a.succeeded();
  return true;
}

/** Second factor for a sensitive change when the account has one (a stolen token + password is not enough). */
async function requireSecondFactor(c: C, user: UserRow, code: unknown): Promise<void> {
  if (!user.mfa_enabled) return;
  if (!(await checkTotp(c, user, code))) throw err(403, 'MFA_REQUIRED');
}

/**
 * Issue a code (optionally carrying the signup data it activates) and mail it. Never touches an existing user row's credential.
 */
export async function issueAndMail(
  env: Env,
  user: UserRow,
  kind: 'email_verify' | 'password_reset',
  type: OtpType,
  pending?: PendingSignup
): Promise<void> {
  const code = await issueOtp(env.DB, user, type, pending);
  if (!code || !env.MAILER) return;
  try {
    await env.MAILER.sendCode({
      to: user.email,
      kind,
      code,
      language: (pending?.language ?? user.language) === 'ar' ? 'ar' : 'en',
      firstName: pending?.first_name ?? user.first_name,
      ttlMinutes: OTP_TTL_MINUTES[type],
    });
  } catch (e) {
    console.error(JSON.stringify({ msg: 'otp mail failed', kind, error: (e as Error).message }));
  }
}

/** Mail work runs after the response, so every branch of the caller answers in the same time (no registered-address oracle). */
function queueMail(c: C, job: Promise<unknown>): void {
  c.executionCtx.waitUntil(
    job.catch(e =>
      console.error(JSON.stringify({ msg: 'background job failed', error: (e as Error).message }))
    )
  );
}

/**
 * Register (or re-register) an UNVERIFIED merchant. The credential is bound to the verification CODE, not written to the
 * user row: verifying code X activates only the password submitted with the signup that produced X, and an unauthenticated
 * request never changes a stored credential. A verified account is never touched. Shared by POST /signup and the Store's
 * provisioning (Accounts.createUser).
 */
export async function registerPending(
  env: Env,
  input: {
    email: string;
    passwordHash: string;
    firstName: string;
    lastName: string;
    phone: string | null;
    language: 'en' | 'ar';
    id?: string;
  }
): Promise<{ id: string; created: boolean } | null> {
  const existing = await findUserByEmail(env.DB, input.email);
  if (existing?.email_verified) return null;
  let user = existing;
  let created = false;
  if (!user) {
    const id = input.id ?? crypto.randomUUID();
    try {
      // '!pending' is not a bcrypt hash: nobody can sign in with it until a code activates a credential.
      await env.DB.prepare(
        `INSERT INTO users (id, email, password_hash, first_name, last_name, phone, role, status, email_verified, language, created_at, updated_at)
         VALUES (?1,?2,'!pending',?3,?4,?5,'store_admin','active',0,?6,?7,?7)`
      )
        .bind(id, input.email, input.firstName, input.lastName, input.phone, input.language, iso())
        .run();
      created = true;
    } catch (e) {
      if (!/UNIQUE.*users\.email|users_email_lower/i.test((e as Error).message)) throw e; // lost a race: it exists now
    }
    user = await findUserByEmail(env.DB, input.email);
  }
  if (!user) return null;
  await issueAndMail(env, user, 'email_verify', 'email', {
    password_hash: input.passwordHash,
    first_name: input.firstName,
    last_name: input.lastName,
    phone: input.phone,
    language: input.language,
  });
  return { id: user.id, created };
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
    // Every state-changing request (login, MFA, passkey sign-in, refresh, logout, signup, ...) must come from an
    // allow-listed origin or a non-browser caller: a cross-site page cannot log a victim into an attacker's account.
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') originGuard(c);
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
    // A form post (text/plain, urlencoded) can be sent cross-site without a CORS preflight: refuse anything not JSON.
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json'))
      throw err(415, 'UNSUPPORTED_MEDIA_TYPE', 'application/json required');
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
    return c.json({ issuer: c.env.ISSUER, jwks_uri: `${c.env.ISSUER}/.well-known/jwks.json` });
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
    // Counted BEFORE the password is checked (see throttle.ts): a parallel burst cannot out-run the budget.
    const attempt = await hit(c.env.DB, body.email, ip, LOGIN);
    if (!attempt.ok) throw err(429, 'ACCOUNT_LOCKED', 'Too many attempts. Try again later.');
    const user = await findUserByEmail(c.env.DB, body.email);
    if (!user) {
      await bcrypt.compare(body.password, DUMMY_HASH); // same cost as a wrong password: no stopwatch oracle
      throw err(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }
    if (!(await verifyPassword(body.password, user.password_hash)))
      throw err(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    // Status is checked AFTER the password so "suspended" is not distinguishable from "wrong password" by shape.
    if (user.status !== 'active')
      throw err(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    // Only the holder of the mailbox may sign in: an account created by someone who merely typed the address is
    // unusable until the code mailed to that address is entered (pre-hijacking). Reached only with the right password.
    if (!user.email_verified) throw err(403, 'EMAIL_NOT_VERIFIED', 'Verify your email first');
    await attempt.succeeded();

    if (user.mfa_enabled && user.mfa_secret) {
      const challenge = randomCode() + crypto.randomUUID().replaceAll('-', '') + randomCode();
      await c.env.DB.batch([
        // ONE live challenge per user: a password holder cannot accumulate challenges to guess codes against in parallel.
        c.env.DB.prepare(`DELETE FROM challenges WHERE user_id = ?1 AND kind = 'mfa'`).bind(
          user.id
        ),
        c.env.DB.prepare(
          `INSERT INTO challenges (id, kind, user_id, data, expires_at) VALUES (?1,'mfa',?2,?3,?4)`
        ).bind(await sha256Hex(challenge), user.id, JSON.stringify({ aud }), nowMs() + 5 * 60_000),
      ]);
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
    const ip = clientIp(c);
    const id = await sha256Hex(body.challenge);
    // The attempt is COUNTED before anything is checked, in one guarded statement: parallel guesses cannot share a stale count.
    const row = await c.env.DB.prepare(
      `UPDATE challenges SET attempts = attempts + 1 WHERE id = ?1 AND kind = 'mfa' AND expires_at > ?2 AND attempts < 5
       RETURNING user_id, data`
    )
      .bind(id, nowMs())
      .first<{ user_id: string; data: string }>();
    if (!row) throw err(401, 'INVALID_CHALLENGE');
    const data = JSON.parse(row.data) as { aud: string };
    const user = await findUserById(c.env.DB, row.user_id);
    if (
      !user ||
      user.status !== 'active' ||
      !user.email_verified ||
      !user.mfa_secret ||
      !c.env.MFA_KEY
    )
      throw err(401, 'INVALID_CHALLENGE');
    // A per-USER budget a fresh challenge does not reset, counted before the code is checked.
    const attempt = await hit(c.env.DB, user.id, ip, SECOND_FACTOR);
    if (!attempt.ok) throw err(429, 'TOO_MANY_ATTEMPTS');
    let ok = false;
    let spentBackup: { old: string; next: string } | null = null;
    if (body.code) {
      const step = await verifyTotp(
        await unseal(c.env.MFA_KEY, user.mfa_secret),
        body.code,
        Date.now(),
        user.mfa_last_step
      );
      ok = step !== null && (await claimTotpStep(c.env.DB, user.id, step));
    } else if (body.backupCode) {
      const hashed = JSON.parse(user.mfa_backup_codes) as string[];
      for (let i = 0; i < hashed.length && !ok; i++) {
        if (await bcrypt.compare(body.backupCode, hashed[i])) {
          ok = true;
          spentBackup = {
            old: user.mfa_backup_codes,
            next: JSON.stringify(hashed.filter((_, j) => j !== i)),
          };
        }
      }
    }
    if (ok && spentBackup) {
      // Compare-and-set on the stored list: two parallel challenges cannot both spend the same backup code.
      const r = await c.env.DB.prepare(
        `UPDATE users SET mfa_backup_codes = ?3 WHERE id = ?1 AND mfa_backup_codes = ?2`
      )
        .bind(user.id, spentBackup.old, spentBackup.next)
        .run();
      ok = (r.meta.changes ?? 0) === 1;
    }
    if (!ok) throw err(401, 'INVALID_CODE');
    // Consume the challenge: one verification, one session.
    const del = await c.env.DB.prepare(`DELETE FROM challenges WHERE id = ?1`).bind(id).run();
    if ((del.meta.changes ?? 0) !== 1) throw err(401, 'INVALID_CHALLENGE');
    await attempt.succeeded();
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
    // Cookie session and/or bearer: revoke whichever session(s) the caller proves. Always clears the cookie.
    const r = cookieValue(c) ? await resolveRefresh(c.env.DB, cookieValue(c)) : null;
    if (r) await revokeSession(c.env.DB, r.session.sid, 'logout');
    try {
      const b = await bearerAuth(c, true);
      await revokeSession(c.env.DB, b.sid, 'logout');
    } catch {
      /* no/invalid bearer: the cookie path above is enough */
    }
    clearRefreshCookie(c);
    return c.json({ success: true, data: { loggedOut: true } });
  });

  app.post('/revoke', async c => {
    const b = await bearerAuth(c, true);
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
    const b = await bearerAuth(c, true);
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
    if (!(await hit(c.env.DB, 'all', clientIp(c), PER_IP_ONLY('signup', 10))).ok)
      throw err(429, 'TOO_MANY_ATTEMPTS');
    if (!(await hit(c.env.DB, body.email, 'n/a', PER_EMAIL('signup-email', 3))).ok)
      throw err(429, 'TOO_MANY_ATTEMPTS');
    const passwordHash = await hashPassword(body.password); // always paid, so every branch costs the same
    // Everything else runs after the response: "new", "pending" and "already verified" answer identically and in the same time.
    queueMail(
      c,
      registerPending(c.env, {
        email: body.email,
        passwordHash,
        firstName: body.firstName,
        lastName: body.lastName,
        phone: body.phone ?? null,
        language: body.language,
      })
    );
    return c.json({ success: true, data: { status: 'verification_sent' } }, 202);
  });

  // Verifying an address also needs the PASSWORD chosen at signup: a code mailed because someone else typed this address
  // cannot activate their password on the owner's behalf (the owner will not know it).
  const otpBody = z.object({
    email: emailSchema,
    code: z.string().regex(/^\d{6}$/),
    password: z.string().min(1).max(200),
  });

  app.post('/otp/verify', async c => {
    const body = await json(c, otpBody);
    const attempt = await hit(c.env.DB, body.email, clientIp(c), CODE_GUESS);
    if (!attempt.ok) throw err(429, 'TOO_MANY_ATTEMPTS');
    const user = await findUserByEmail(c.env.DB, body.email);
    const res = user
      ? await verifyOtp(c.env.DB, user, 'email', body.code, async pending => {
          const hash = pending ? pending.password_hash : user.password_hash;
          return verifyPassword(body.password, hash); // '!pending' / seed markers never match
        })
      : { ok: false, pending: null };
    if (!res.ok || !user) throw err(400, 'INVALID_CODE');
    const wasUnverified = !user.email_verified;
    if (res.pending && wasUnverified) {
      // Activate exactly the credential that was submitted with the signup that produced THIS code.
      await c.env.DB.prepare(
        `UPDATE users SET password_hash = ?2, first_name = ?3, last_name = ?4, phone = ?5, language = ?6, email_verified = 1, updated_at = ?7 WHERE id = ?1`
      )
        .bind(
          user.id,
          res.pending.password_hash,
          res.pending.first_name,
          res.pending.last_name,
          res.pending.phone,
          res.pending.language,
          iso()
        )
        .run();
    } else {
      await c.env.DB.prepare(`UPDATE users SET email_verified = 1, updated_at = ?2 WHERE id = ?1`)
        .bind(user.id, iso())
        .run();
    }
    // Anything attached to the account before its mailbox owner proved control is untrusted: drop it all and end sessions.
    if (wasUnverified) await purgeCredentials(c.env.DB, user.id, 'first-verification');
    await attempt.succeeded();
    return c.json({ success: true, data: { verified: true } });
  });

  app.post('/otp/resend', async c => {
    const body = await json(c, z.object({ email: emailSchema }));
    if (!(await hit(c.env.DB, 'all', clientIp(c), PER_IP_ONLY('resend', 10))).ok)
      throw err(429, 'TOO_MANY_ATTEMPTS');
    if (!(await hit(c.env.DB, body.email, 'n/a', PER_EMAIL('resend-email', 3))).ok)
      throw err(429, 'TOO_MANY_ATTEMPTS');
    queueMail(
      c,
      (async () => {
        const user = await findUserByEmail(c.env.DB, body.email);
        if (!user || user.status !== 'active' || user.email_verified) return;
        // Re-send carries the credential of the LATEST signup, so the new code activates the same password as before.
        const last = await c.env.DB.prepare(
          `SELECT pending FROM verification_tokens WHERE user_id = ?1 AND type = 'email' AND pending IS NOT NULL ORDER BY created_at DESC LIMIT 1`
        )
          .bind(user.id)
          .first<{ pending: string }>();
        await issueAndMail(
          c.env,
          user,
          'email_verify',
          'email',
          last ? (JSON.parse(last.pending) as PendingSignup) : undefined
        );
      })()
    );
    return c.json({ success: true, data: { status: 'sent_if_registered' } }, 202);
  });

  app.post('/password/forgot', async c => {
    const body = await json(c, z.object({ email: emailSchema }));
    if (!(await hit(c.env.DB, 'all', clientIp(c), PER_IP_ONLY('forgot', 10))).ok)
      throw err(429, 'TOO_MANY_ATTEMPTS');
    if (!(await hit(c.env.DB, body.email, 'n/a', PER_EMAIL('forgot-email', 3))).ok)
      throw err(429, 'TOO_MANY_ATTEMPTS');
    queueMail(
      c,
      (async () => {
        const user = await findUserByEmail(c.env.DB, body.email);
        if (user && user.status === 'active')
          await issueAndMail(c.env, user, 'password_reset', 'password_reset');
      })()
    );
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
    const attempt = await hit(c.env.DB, body.email, clientIp(c), CODE_GUESS);
    if (!attempt.ok) throw err(429, 'TOO_MANY_ATTEMPTS');
    const user = await findUserByEmail(c.env.DB, body.email);
    const res = user
      ? await verifyOtp(c.env.DB, user, 'password_reset', body.code)
      : { ok: false, pending: null };
    if (!res.ok || !user) throw err(400, 'INVALID_CODE');
    const wasUnverified = !user.email_verified;
    await c.env.DB.prepare(
      `UPDATE users SET password_hash = ?2, email_verified = 1, updated_at = ?3 WHERE id = ?1`
    )
      .bind(user.id, await hashPassword(body.newPassword), iso())
      .run();
    // Every session dies. Factors are removed only when the account had never been verified (pre-hijacking): a reset needs
    // only the mailbox, so stripping a verified owner's MFA/passkeys here would turn a mailbox compromise into an MFA bypass.
    if (wasUnverified) await purgeCredentials(c.env.DB, user.id, 'password-reset-unverified');
    else await revokeAllForUser(c.env.DB, user.id, 'password-reset');
    await attempt.succeeded();
    return c.json({ success: true, data: { reset: true } });
  });

  // ---- MFA (TOTP) management ----
  app.post('/mfa/enroll', async c => {
    const { user } = await bearerAuth(c);
    const body = await json(c, z.object({ password: z.string() }));
    await requirePassword(c, user, body.password);
    if (!user.email_verified) throw err(403, 'EMAIL_NOT_VERIFIED');
    if (user.mfa_enabled) throw err(409, 'MFA_ALREADY_ENABLED');
    if (!c.env.MFA_KEY) throw err(503, 'MFA_UNAVAILABLE');
    const secret = newSecret();
    await c.env.DB.prepare(`UPDATE users SET mfa_secret = ?2 WHERE id = ?1`)
      .bind(user.id, await seal(c.env.MFA_KEY, secret))
      .run();
    return c.json({
      success: true,
      data: { secret, otpauthUrl: totpUri(user.email, secret, 'Ebda AI Studio') },
    });
  });

  app.post('/mfa/enroll/verify', async c => {
    const { user } = await bearerAuth(c);
    const body = await json(c, z.object({ code: z.string() }));
    if (!user.mfa_secret || !c.env.MFA_KEY || user.mfa_enabled) throw err(409, 'MFA_NOT_PENDING');
    if (!(await checkTotp(c, user, body.code))) throw err(400, 'INVALID_CODE');
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
    await requirePassword(c, user, body.password);
    if (!user.mfa_secret || !c.env.MFA_KEY) throw err(409, 'MFA_NOT_ENABLED');
    if (!(await checkTotp(c, user, body.code))) throw err(400, 'INVALID_CODE');
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
    if (!(await hit(c.env.DB, 'all', clientIp(c), PER_IP_ONLY('pk-options', 60))).ok)
      throw err(429, 'TOO_MANY_ATTEMPTS');
    return c.json({
      success: true,
      data: await passkeys.beginAuthentication(c.env.DB, c.env, originHeader(c)),
    });
  });

  app.post('/passkey/login/verify', async c => {
    const body = await json(c, z.object({ response: z.any(), aud: z.string().optional() }));
    const aud = audOf(c.env, body.aud);
    const ip = clientIp(c);
    // per client: a global key would let anyone lock every passkey sign-in
    const attempt = await hit(c.env.DB, ip, ip, { ...LOGIN, name: 'passkey' });
    if (!attempt.ok) throw err(429, 'TOO_MANY_ATTEMPTS');
    const res = await passkeys.finishAuthentication(
      c.env.DB,
      c.env,
      originHeader(c),
      body.response
    );
    if ('fail' in res) {
      console.log(JSON.stringify({ msg: 'passkey auth failed', reason: res.fail }));
      throw err(401, 'PASSKEY_AUTH_FAILED', 'Passkey sign-in failed');
    }
    await attempt.succeeded();
    // A passkey (possession + user verification) satisfies MFA: no code step follows (Ruling PASSKEY-4).
    return c.json({ success: true, data: await sessionResponse(c, res.user, 'hwk', aud) });
  });

  app.post('/passkey/register/options', async c => {
    const { user } = await bearerAuth(c);
    const body = await json(c, z.object({ password: z.string(), code: z.string().optional() }));
    await requirePassword(c, user, body.password);
    // With MFA on, registering a passkey (which later signs in WITHOUT MFA) needs a fresh code: token + password is not enough.
    await requireSecondFactor(c, user, body.code);
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
    const body = await json(c, z.object({ password: z.string(), code: z.string().optional() }));
    await requirePassword(c, user, body.password);
    await requireSecondFactor(c, user, body.code);
    if (!(await passkeys.removePasskey(c.env.DB, user.id, c.req.param('id'))))
      throw err(404, 'NOT_FOUND');
    return c.json({ success: true, data: { deleted: true } });
  });

  return app;
}
