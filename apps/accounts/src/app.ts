import { Hono, type Context } from 'hono';
import { z } from 'zod/v3';
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
import { AUDIENCE_SCOPES } from './client-scopes';
import {
  accessTtlFor,
  mintAccessToken,
  mintClientToken,
  verifyOwnAccessToken,
  type StoreClaim,
} from './jwt';
import {
  auditAuthFailure,
  audit,
  authenticateClient,
  CLIENT_TOKEN_TTL_SECONDS,
  createClient,
  DEFAULT_OVERLAP_HOURS,
  getStoreClient,
  ipPrefix,
  listClients,
  MAX_OVERLAP_HOURS,
  PepperMissing,
  revokeClient,
  rotateClient,
} from './clients';
import { jwks } from './keys';
import { DUMMY_HASH, hashPassword, passwordPolicy, verifyPassword } from './password';
import {
  CODE_GUESS,
  hit,
  LOGIN,
  PER_EMAIL,
  PER_IP_ONLY,
  CHAT_INVITE_MAIL,
  retryAfterSeconds,
  SECOND_FACTOR,
  type Budget,
} from './throttle';
import { sendCodeOverWhatsApp } from './whatsapp-otp';
import { issueOtp, OTP_TTL_MINUTES, verifyOtp, type OtpType, type PendingSignup } from './otp';
import * as passkeys from './passkeys';
import { newSecret, sealCurrent, totpUri, unsealAny, verifyTotp } from './totp';
import { csv, iso, nowMs, randomCode, sha256Hex } from './util';
import {
  pickStudioLang,
  renderStudioPage,
  HSTS_VALUE,
  STUDIO_PAGE_HEADERS,
} from '../../../packages/shared/src/studio-pages/index';
import {
  renderSignInPage,
  signInProduct,
  signInReturn,
  SIGN_IN_CSS,
  SIGN_IN_JS,
  SIGN_IN_PAGE_HEADERS,
} from './sign-in-page';

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

/**
 * A browser origin may only request tokens for the product it belongs to (ORIGIN_PRODUCTS). Requests with no Origin header
 * (server-side) are not browser-bound and keep the cookie/CSRF rules unchanged.
 */
function originAudience(c: C, aud: string): void {
  const origin = c.req.header('origin');
  if (!origin) return;
  const mapped = csv(c.env.ORIGIN_PRODUCTS)
    .map(p => p.split('='))
    .find(([o]) => o === origin)?.[1];
  if (!mapped || mapped !== aud) throw err(403, 'ORIGIN_AUDIENCE_MISMATCH');
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

/** A platform admin must have logged in within this window for `pa` to be minted or honoured (Ruling ID-15). */
export const SUPER_ADMIN_MAX_AUTH_AGE_MS = 12 * 3600_000;

/** A second factor was used to create the session: TOTP (`otp`) or a passkey (`hwk`). */
const hasSecondFactor = (amr: string) => /(^|,)(otp|hwk)(,|$)/.test(amr);

/**
 * `pa: super_admin` is minted only for a session that (a) was created by a login that used a SECOND FACTOR (TOTP or passkey),
 * and (b) is at most 12 h old. A platform admin whose session is older must sign in again (401 REAUTH_REQUIRED); one that has
 * no second factor yet gets an ordinary token without `pa` and is told to enrol (see /login).
 */
async function mintFor(
  env: Env,
  user: UserRow,
  sid: string,
  aud: string,
  session: { created_at: number; amr: string }
) {
  const admin = user.role === 'super_admin';
  if (admin && nowMs() - session.created_at > SUPER_ADMIN_MAX_AUTH_AGE_MS)
    throw err(401, 'REAUTH_REQUIRED', 'Sign in again to continue as a platform administrator');
  const { token, expiresAt } = await mintAccessToken(env, {
    sub: user.id,
    sid,
    aud,
    stores: await storesFor(env, user.id),
    ...(admin && hasSecondFactor(session.amr) ? { pa: 'super_admin' as const } : {}),
    auth_time: Math.floor(session.created_at / 1000),
    email: user.email,
    email_verified: !!user.email_verified,
  });
  return {
    access_token: token,
    token_type: 'Bearer',
    expires_in: accessTtlFor(aud),
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
  phone: u.phone,
  mfaEnabled: !!u.mfa_enabled,
});

async function hasAnyFactor(db: D1Database, user: UserRow): Promise<boolean> {
  if (user.mfa_enabled && user.mfa_secret) return true;
  const p = await db
    .prepare(`SELECT count(*) AS n FROM passkey_credentials WHERE user_id = ?1`)
    .bind(user.id)
    .first<{ n: number }>();
  return (p?.n ?? 0) > 0;
}

/**
 * First-factor bootstrap for a platform administrator (Ruling ID-15). A password-only session must not be able to bind the
 * FIRST factor to a super_admin (a phished or leaked password would hand over the account). So, in addition to the password
 * and the session, it needs (1) the one-time enrolment token the operator's script printed to their terminal, and (2) a
 * one-time code mailed to the account's mailbox. Both are single use; the token is hashed at rest and expires.
 */
type EnrolMode = 'bootstrap' | 'step-up' | 'password';
type EnrolTicket = { mode: EnrolMode; sid: string; via?: 'session' | 'totp' };
const FRESH_FACTOR_MS = 10 * 60_000;

/** The CURRENT session was created by a login that used a second factor, at most 10 minutes ago. */
async function sessionFactorFresh(c: C, sid: string): Promise<boolean> {
  const s = await c.env.DB.prepare(
    `SELECT created_at, amr FROM sessions WHERE sid = ?1 AND revoked_at IS NULL`
  )
    .bind(sid)
    .first<{ created_at: number; amr: string }>();
  return !!s && hasSecondFactor(s.amr) && nowMs() - s.created_at <= FRESH_FACTOR_MS;
}

/**
 * Policy for adding ANY sign-in factor (TOTP or passkey), decided when the enrolment BEGINS and stored on a ticket that the
 * completion step must find (Ruling ID-15):
 *  - a platform admin with no factor yet: `bootstrap` - the operator's token + an e-mailed code at completion;
 *  - an account that already has a factor: `step-up` - a password plus a stolen token is not enough; the session must come
 *    from a login that used a second factor in the last 10 minutes, or (TOTP holders) a valid TOTP code sent now;
 *  - anyone else (first factor of a merchant): the password step-up that was always required.
 * Completion re-checks the CURRENT state, so a factor enrolled between begin and finish only ever makes it stricter.
 */
async function startEnrolment(
  c: C,
  user: UserRow,
  sid: string,
  totpCode?: string
): Promise<EnrolMode> {
  const factor = await hasAnyFactor(c.env.DB, user);
  let ticket: EnrolTicket;
  if (user.role === 'super_admin' && !factor) ticket = { mode: 'bootstrap', sid };
  else if (factor) {
    if (await sessionFactorFresh(c, sid)) ticket = { mode: 'step-up', sid, via: 'session' };
    else if (user.mfa_enabled && totpCode && (await checkTotp(c, user, totpCode)))
      ticket = { mode: 'step-up', sid, via: 'totp' };
    else throw err(403, user.mfa_enabled ? 'MFA_REQUIRED' : 'STEP_UP_REQUIRED');
  } else ticket = { mode: 'password', sid };
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM challenges WHERE user_id = ?1 AND kind = 'factor-enrol'`).bind(
      user.id
    ),
    c.env.DB.prepare(
      `INSERT INTO challenges (id, kind, user_id, data, expires_at) VALUES (?1,'factor-enrol',?2,?3,?4)`
    ).bind(crypto.randomUUID(), user.id, JSON.stringify(ticket), nowMs() + 10 * 60_000),
  ]);
  return ticket.mode;
}

/** Completion gate: the ticket must exist (bound to this session) and its policy - or a stricter current one - must hold. */
async function authorizeEnrolment(
  c: C,
  user: UserRow,
  sid: string,
  proof: { enrolmentToken?: string; emailCode?: string }
): Promise<EnrolMode> {
  const row = await c.env.DB.prepare(
    `SELECT data FROM challenges WHERE user_id = ?1 AND kind = 'factor-enrol' AND expires_at > ?2`
  )
    .bind(user.id, nowMs())
    .first<{ data: string }>();
  const t = row ? (JSON.parse(row.data) as EnrolTicket) : null;
  if (!t || t.sid !== sid) throw err(409, 'ENROL_NOT_STARTED');
  if (t.mode === 'bootstrap') {
    await requireBootstrapProof(c, user, proof); // required whatever the account looks like NOW
    return 'bootstrap';
  }
  const factorNow = await hasAnyFactor(c.env.DB, user);
  if (!factorNow && user.role !== 'super_admin') {
    await requireEmailCode(c, user, proof.emailCode);
    return 'password';
  }
  if (factorNow) {
    if (t.via !== 'totp' && !(await sessionFactorFresh(c, sid))) throw err(403, 'STEP_UP_REQUIRED');
    return 'step-up';
  }
  if (user.role === 'super_admin') {
    await requireBootstrapProof(c, user, proof);
    return 'bootstrap';
  }
  return t.mode;
}

/** After a factor is bound: drop every pending enrolment of the account; after a bootstrap also end EVERY session. */
async function finishEnrolment(
  c: C,
  user: UserRow,
  mode: EnrolMode,
  factor: 'totp' | 'passkey'
): Promise<boolean> {
  const db = c.env.DB;
  const stmts = [
    db
      .prepare(
        `DELETE FROM challenges WHERE user_id = ?1 AND kind IN ('factor-enrol','passkey-register')`
      )
      .bind(user.id),
  ];
  if (mode === 'bootstrap') {
    const now = nowMs();
    stmts.push(
      db
        .prepare(
          `UPDATE sessions SET revoked_at = ?2, revoked_reason = 'first-factor-enrolled' WHERE user_id = ?1 AND revoked_at IS NULL`
        )
        .bind(user.id, now),
      db
        .prepare(
          `UPDATE refresh_tokens SET revoked_at = ?2, revoked_reason = COALESCE(revoked_reason, 'first-factor-enrolled') WHERE user_id = ?1 AND revoked_at IS NULL`
        )
        .bind(user.id, iso()),
      // an unfinished TOTP secret must not outlive the factor that won
      db
        .prepare(`UPDATE users SET mfa_secret = NULL WHERE id = ?1 AND mfa_enabled = 0`)
        .bind(user.id)
    );
  }
  await db.batch(stmts);
  // A sign-in method was added: tell the mailbox owner (best effort; the change already happened).
  queueMail(
    c,
    c.env.MAILER?.sendNotice({
      to: user.email,
      kind: 'factor_added',
      factor,
      language: user.language === 'ar' ? 'ar' : 'en',
      firstName: user.first_name,
    }) ?? Promise.resolve()
  );
  // A platform admin's FIRST factor ends EVERY session, the enrolling one included: it was a password-only session, and the
  // person signs in again with the new factor (which is what carries admin power).
  return mode === 'bootstrap';
}

async function requireBootstrapProof(
  c: C,
  user: UserRow,
  proof: { enrolmentToken?: string; emailCode?: string }
): Promise<void> {
  const a = await hit(c.env.DB, user.id, clientIp(c), SECOND_FACTOR);
  if (!a.ok) throw err(429, 'TOO_MANY_ATTEMPTS');
  if (!proof.enrolmentToken || !proof.emailCode) throw err(403, 'ENROLMENT_PROOF_REQUIRED');
  const hash = await sha256Hex(proof.enrolmentToken);
  const row = await c.env.DB.prepare(
    `SELECT id FROM enrolment_tokens WHERE user_id = ?1 AND token_hash = ?2 AND used_at IS NULL AND expires_at > ?3`
  )
    .bind(user.id, hash, nowMs())
    .first<{ id: string }>();
  if (!row) throw err(403, 'ENROLMENT_PROOF_INVALID');
  if (!(await verifyOtp(c.env.DB, user, 'two_factor', proof.emailCode)).ok)
    throw err(403, 'ENROLMENT_PROOF_INVALID');
  const used = await c.env.DB.prepare(
    `UPDATE enrolment_tokens SET used_at = ?2 WHERE id = ?1 AND used_at IS NULL AND expires_at > ?2`
  )
    .bind(row.id, nowMs())
    .run();
  if ((used.meta.changes ?? 0) !== 1) throw err(403, 'ENROLMENT_PROOF_INVALID');
  await a.succeeded();
}

/**
 * A merchant's (or staff member's) FIRST factor: the password step-up is not enough, because a phished password would let an
 * attacker bind their own factor, and a password reset (which keeps a verified account's factors, Ruling ID-8) would never
 * remove it. So it needs the same proof a reset needs: a one-time code mailed to the account's address.
 */
async function requireEmailCode(c: C, user: UserRow, emailCode?: string): Promise<void> {
  const a = await hit(c.env.DB, user.id, clientIp(c), SECOND_FACTOR);
  if (!a.ok) throw err(429, 'TOO_MANY_ATTEMPTS');
  if (!emailCode) throw err(403, 'EMAIL_CODE_REQUIRED');
  if (!(await verifyOtp(c.env.DB, user, 'two_factor', emailCode)).ok)
    throw err(403, 'EMAIL_CODE_INVALID');
  await a.succeeded();
}

async function sessionResponse(c: C, user: UserRow, amr: string, aud: string) {
  const s = await createSession(c.env.DB, user, amr, sessionCtx(c));
  setRefreshCookie(c, s.refreshToken);
  return {
    user: publicUser(user),
    ...(await mintFor(c.env, user, s.sid, aud, { created_at: nowMs(), amr })),
    // A platform admin without a second factor gets no admin power: the client must send them to enrol one.
    // (A super admin WITH a factor never reaches this point on a password: /login answers secondFactorRequired and creates NO session.)
    ...(user.role === 'super_admin' && !hasSecondFactor(amr)
      ? { mfaEnrollmentRequired: true }
      : {}),
  };
}

/**
 * Bearer access token -> live user + session. Credential MANAGEMENT (MFA, passkeys, step-up) accepts only a `store` token:
 * a token minted for another product must not be able to change how the account signs in. Logout and revoke only
 * ever END sessions, so they accept any product's token (`anyAud`).
 */
async function bearerAuth(
  c: C,
  anyAud = false
): Promise<{ user: UserRow; sid: string; aud: string }> {
  const h = c.req.header('authorization') ?? '';
  const m = /^Bearer (.+)$/.exec(h);
  if (!m) throw err(401, 'UNAUTHORIZED');
  let verified: Awaited<ReturnType<typeof verifyOwnAccessToken>> | undefined;
  let verifiedAud = 'store';
  for (const aud of anyAud ? csv(c.env.PRODUCTS) : ['store']) {
    try {
      verified = await verifyOwnAccessToken(c.env, m[1], aud);
      verifiedAud = aud;
      break;
    } catch {
      /* try the next audience */
    }
  }
  if (!verified) throw err(401, 'UNAUTHORIZED');
  // An integrator client token (v1.3) is a machine token: it can never manage a person's credentials or an owner's clients.
  if (verified.payload.client !== undefined) throw err(401, 'UNAUTHORIZED');
  if (await isSessionRevoked(c.env.DB, verified.sid)) throw err(401, 'SESSION_REVOKED');
  const user = await findUserById(c.env.DB, verified.sub);
  if (!user || user.status !== 'active') throw err(401, 'UNAUTHORIZED');
  return { user, sid: verified.sid, aud: verifiedAud };
}

/** Step-up for sensitive changes: the account password again, throttled like a login (a bearer token alone must not allow free guessing). */
async function requirePassword(c: C, user: UserRow, password: unknown): Promise<void> {
  const a = await hit(c.env.DB, user.id, clientIp(c), { ...LOGIN, name: 'pw', brake: false });
  if (!a.ok) throw err(429, 'TOO_MANY_ATTEMPTS');
  if (typeof password !== 'string' || !(await verifyPassword(password, user.password_hash)))
    throw err(403, 'STEP_UP_REQUIRED');
  await a.succeeded();
}

/** Open a sealed TOTP secret with the keyring; a key that is not in it is an operator problem (503), never a 500 or a pass. */
async function openTotpSecret(c: C, sealed: string, userId: string): Promise<string> {
  try {
    return await unsealAny(c.env, sealed, userId);
  } catch {
    throw err(503, 'MFA_UNAVAILABLE');
  }
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
    await openTotpSecret(c, user.mfa_secret, user.id),
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
  kind: 'email_verify' | 'password_reset' | 'staff_invite' | 'factor_enrol',
  type: OtpType,
  pending?: PendingSignup,
  opts: { ttlMinutes?: number; storeName?: string } = {}
): Promise<void> {
  const code = await issueOtp(env.DB, user, type, pending, opts.ttlMinutes);
  if (!code) return;
  // The WhatsApp channel (ID-WA-OTP-1) is only for a password-reset code going to a VERIFIED, non-platform-admin account's own phone. Signup verification and
  // invitations stay email-only (the phone is not yet proven to belong to the mailbox owner); factor enrolment stays email-only (Ruling ID-15 makes the e-mailed code
  // the proof of mailbox control); a platform admin's recovery stays email-only.
  const whatsapp =
    kind === 'password_reset' && user.role !== 'super_admin'
      ? sendCodeOverWhatsApp(env, user, code)
      : Promise.resolve('skipped' as const);
  const mail = (async () => {
    if (!env.MAILER) return;
    try {
      await env.MAILER.sendCode({
        to: user.email,
        kind,
        code,
        language: (pending?.language ?? user.language) === 'ar' ? 'ar' : 'en',
        firstName: pending?.first_name ?? user.first_name,
        ttlMinutes: opts.ttlMinutes ?? OTP_TTL_MINUTES[type],
        ...(opts.storeName ? { storeName: opts.storeName } : {}),
      });
    } catch (e) {
      console.error(JSON.stringify({ msg: 'otp mail failed', kind, error: (e as Error).message }));
    }
  })();
  // Neither channel waits for or can fail the other; sendCodeOverWhatsApp never rejects.
  await Promise.all([mail, whatsapp]);
}

/** Mail work runs after the response, so every branch of the caller answers in the same time (no registered-address oracle). */
function queueMail(c: C, job: Promise<unknown>): void {
  c.executionCtx.waitUntil(
    job.catch(e =>
      console.error(JSON.stringify({ msg: 'background job failed', error: (e as Error).message }))
    )
  );
}

/** Mail a password-reset code to an existing active account (generic: silent for an unknown address). */
export async function forgotPasswordFor(env: Env, email: string): Promise<void> {
  const user = await findUserByEmail(env.DB, email);
  if (user && user.status === 'active')
    await issueAndMail(env, user, 'password_reset', 'password_reset');
}

export type InviteResult =
  | { id: string; created: true }
  | { id: string; created: false; emailVerified: boolean; role: UserRow['role'] };

/**
 * Invite a merchant or staff member: creates an UNVERIFIED identity with no credential and mails a one-time code that
 * lets the invitee set their own password (the reset flow; it also verifies the address).
 *
 * An invitation may only ever bind to a row IT created. If ANY identity already exists for the address it is reported back
 * (`created: false`, with its real id, role and verified flag) and nothing is mailed or changed: the caller must use the
 * explicit accept flow. The one exception is a retry of the same invitation (same id, same role, still unverified), which
 * re-mails the code. This closes the cross-tenant takeover where an invite attached a store to someone else's row.
 */
export async function inviteFor(
  env: Env,
  input: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: 'store_admin' | 'staff';
    language: 'en' | 'ar';
    storeName?: string;
  }
): Promise<InviteResult> {
  let user = await findUserByEmail(env.DB, input.email);
  if (!user) {
    try {
      await env.DB.prepare(
        `INSERT INTO users (id, email, password_hash, first_name, last_name, role, status, email_verified, language, created_at, updated_at)
         VALUES (?1,?2,'!pending',?3,?4,?5,'active',0,?6,?7,?7)`
      )
        .bind(
          input.id,
          input.email,
          input.firstName,
          input.lastName,
          input.role,
          input.language,
          iso()
        )
        .run();
    } catch (e) {
      if (!/UNIQUE.*users\.email|users_email_lower/i.test((e as Error).message)) throw e;
    }
    user = await findUserByEmail(env.DB, input.email);
  }
  if (!user) throw new Error('invite: identity row missing after insert');
  const retry = user.id === input.id && user.role === input.role && !user.email_verified;
  if (!retry) {
    return { id: user.id, created: false, emailVerified: !!user.email_verified, role: user.role };
  }
  await issueAndMail(
    env,
    user,
    input.storeName ? 'staff_invite' : 'password_reset',
    'password_reset',
    undefined,
    {
      ttlMinutes: 24 * 60,
      storeName: input.storeName,
    }
  );
  return { id: user.id, created: true };
}

/** Why a Chat invite was refused. Chat shows one generic message for it; the cause is never revealed to the inviter. */
export class InviteRefused extends Error {
  constructor() {
    super('INVITE_REFUSED');
    this.name = 'InviteRefused';
  }
}

/**
 * Invite a person to a standalone Ebda Chat workspace by email (Ruling CHAT-SA-6). Returns ONLY `{ userId }`, identical
 * whether the address already had an identity, so the inviter learns nothing about who is registered.
 *  - no identity: an unverified, credential-less `staff` identity (role is irrelevant to Chat; membership lives in Chat's D1)
 *    and the one-time set-password code (24 h, single use: the existing reset flow) mailed as the invitation;
 *  - ACTIVE verified identity: its id, plus an "added to <workspace>" notice (no code, no credential touched);
 *  - ACTIVE but never verified (a signup nobody completed): bound to its own id only; the set-password code is mailed
 *    to the mailbox, so only that mailbox's owner can ever activate it (first verification purges anything attached earlier);
 *  - inactive, suspended or erased identity: throws InviteRefused.
 * Mail is capped at 5 per address per hour (the limiter window is at most 1 h); past it the call still resolves the same id, mail is skipped.
 */
export async function inviteChatMemberFor(
  env: Env,
  input: { email: string; firstName: string; language: 'en' | 'ar'; workspaceName: string }
): Promise<{ userId: string }> {
  const mailAllowed = (await hit(env.DB, input.email, 'n/a', CHAT_INVITE_MAIL)).ok;
  const user = await findUserByEmail(env.DB, input.email);
  if (user && user.status !== 'active') throw new InviteRefused();
  // A soft-deleted (erased) identity still owns its address: never re-invite onto it.
  if (
    !user &&
    (await env.DB.prepare(
      `SELECT 1 AS x FROM users WHERE lower(email) = lower(?1) AND deleted_at IS NOT NULL`
    )
      .bind(input.email)
      .first())
  )
    throw new InviteRefused();
  let userId: string;
  if (!user) {
    // Unreachable in practice: 5 calls in an hour for an address that never got an identity. Refuse rather than mail past the cap.
    if (!mailAllowed) throw new InviteRefused();
    const r = await inviteFor(env, {
      id: crypto.randomUUID(),
      email: input.email,
      firstName: input.firstName,
      lastName: '',
      role: 'staff',
      language: input.language,
      storeName: input.workspaceName,
    });
    userId = r.id;
  } else {
    userId = user.id;
    if (mailAllowed && user.email_verified) {
      try {
        await env.MAILER?.sendNotice({
          to: user.email,
          kind: 'chat_member_added',
          language: user.language === 'ar' ? 'ar' : input.language,
          firstName: user.first_name,
          workspaceName: input.workspaceName,
        });
      } catch (e) {
        console.error(
          JSON.stringify({ msg: 'chat invite notice failed', error: (e as Error).message })
        );
      }
    } else if (mailAllowed) {
      await issueAndMail(env, user, 'staff_invite', 'password_reset', undefined, {
        ttlMinutes: 24 * 60,
        storeName: input.workspaceName,
      });
    }
  }
  // Audit trail (structured log; the durable `member.added` row is Chat's). No address, no code.
  console.log(
    JSON.stringify({ msg: 'audit', event: 'chat_member_invited', userId, mailed: mailAllowed })
  );
  return { userId };
}

/** Mail a fresh code to an existing UNVERIFIED account; carries the credential of the latest signup (see verify). */
export async function resendVerificationFor(env: Env, email: string): Promise<void> {
  const user = await findUserByEmail(env.DB, email);
  if (!user || user.status !== 'active' || user.email_verified) return;
  const last = await env.DB.prepare(
    `SELECT pending FROM verification_tokens WHERE user_id = ?1 AND type = 'email' AND pending IS NOT NULL ORDER BY created_at DESC LIMIT 1`
  )
    .bind(user.id)
    .first<{ pending: string }>();
  await issueAndMail(
    env,
    user,
    'email_verify',
    'email',
    last ? (JSON.parse(last.pending) as PendingSignup) : undefined
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

const STORE_SIGN_IN_URL = 'https://store.ebda.app/login';

/** The Store sign-in URL carrying the caller's `product` (chat | store) and a bounded https `return`. */
export function signInEntryUrl(product: string | undefined, ret: string | undefined): string {
  const url = new URL(STORE_SIGN_IN_URL);
  if (product === 'chat' || product === 'store') url.searchParams.set('product', product);
  if (ret && ret.length <= 2048 && /^https:\/\//i.test(ret)) url.searchParams.set('return', ret);
  return url.toString();
}

export function createApp() {
  const app = new Hono<{ Bindings: Env }>();

  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    // /oauth/token is for servers: no CORS, ever (browsers must not hold a client secret).
    let allowed =
      !!origin && c.req.path !== '/oauth/token' && csv(c.env.ALLOWED_ORIGINS).includes(origin);
    // Client management is for the integration product's own origin only (no CORS for the other products' pages).
    if (allowed && /^\/stores\/[^/]+\/clients(\/|$)/.test(c.req.path)) {
      const product = csv(c.env.ORIGIN_PRODUCTS)
        .map(p => p.split('='))
        .find(([o]) => o === origin)?.[1];
      allowed = !!product && Object.hasOwn(AUDIENCE_SCOPES, product);
    }
    if (c.req.method === 'OPTIONS') {
      if (!allowed) return c.body(null, 403);
      return c.body(null, 204, {
        'Access-Control-Allow-Origin': origin!,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
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
    c.header('Strict-Transport-Security', HSTS_VALUE);
    c.header('Referrer-Policy', 'no-referrer');
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
    return undefined;
  });

  // A person who opened a wrong accounts URL gets the studio's calm 404 (search + a map); API callers keep JSON.
  app.notFound(c => {
    const wantsHtml = (c.req.header('accept') ?? '').includes('text/html');
    if (wantsHtml && (c.req.method === 'GET' || c.req.method === 'HEAD')) {
      const lang = pickStudioLang(
        c.req.header('accept-language'),
        new URL(c.req.url).searchParams.get('lang')
      );
      return new Response(
        c.req.method === 'HEAD' ? null : renderStudioPage({ lang, kind: 'not-found' }),
        {
          status: 404,
          headers: STUDIO_PAGE_HEADERS,
        }
      );
    }
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
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
    if (e instanceof PepperMissing)
      return c.json(
        {
          success: false,
          error: { code: 'CLIENTS_UNAVAILABLE', message: 'Integrator clients are unavailable' },
        },
        503
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

  // ---- human entry points ----
  // The Store app's /login posts to this service too (Ruling ID-1). `/sign-in` sends a person there instead of a 404
  // (Ruling ACCOUNTS-ENTRY-1).
  // On that hop only `product` (known set) and `return` (bounded https URL) travel; the Store page re-validates `return`
  // against its host allowlist (Ruling SIGNIN-RETURN-1). Ebda Chat arrives at /login?product=chat&return=<https url>.
  // `/login` is now this host's own Ebda AI Studio sign-in page and `/` lands on it
  // (Ruling ACCOUNTS-PAGE-1): it calls the same POST /login and /login/mfa as the Store page; the Store page is unchanged.
  app.get('/sign-in', c =>
    c.redirect(signInEntryUrl(c.req.query('product'), c.req.query('return')), 302)
  );
  app.get('/', c => {
    const q = new URLSearchParams();
    for (const k of ['product', 'return', 'return_to', 'lang']) {
      const v = c.req.query(k);
      if (v !== undefined && v.length <= 2048) q.set(k, v);
    }
    const s = q.toString();
    return c.redirect(s ? `/login?${s}` : '/login', 302);
  });
  app.get('/login', c => {
    const lang = pickStudioLang(c.req.header('accept-language'), c.req.query('lang'));
    const product = signInProduct(c.req.query('product'));
    // `return` is Ebda Chat's parameter; `return_to` is accepted as an alias. Validated here, by the Store's allowlist.
    const returnTo = signInReturn(c.req.query('return') ?? c.req.query('return_to'));
    return new Response(
      c.req.method === 'HEAD' ? null : renderSignInPage({ lang, product, returnTo }),
      { status: 200, headers: SIGN_IN_PAGE_HEADERS }
    );
  });
  app.get('/sign-in.js', c =>
    c.body(SIGN_IN_JS, 200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
    })
  );
  app.get('/sign-in.css', c =>
    c.body(SIGN_IN_CSS, 200, {
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': 'no-cache',
    })
  );

  // ---- discovery ----
  app.get('/health', c =>
    c.json({
      status: 'ok',
      service: 'accounts',
      commit: c.env.BUILD_COMMIT_SHA || null,
      deploymentId: c.env.CF_VERSION_METADATA?.id ?? null,
    })
  );
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
    originAudience(c, aud);
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
    // A platform admin who has a passkey but no TOTP cannot be signed in by the password alone: no session, no cookie, no token
    // (a half-signed-in session could otherwise be used to remove the passkey, i.e. to lock the only admin out).
    if (user.role === 'super_admin' && (await hasAnyFactor(c.env.DB, user)))
      return c.json({ success: true, data: { secondFactorRequired: true } });
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
    originAudience(c, data.aud);
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
        await openTotpSecret(c, user.mfa_secret, user.id),
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
    originAudience(c, aud);
    const r = await cookieSession(c);
    return c.json({
      success: true,
      data: await mintFor(c.env, r.user, r.session.sid, aud, r.session),
    });
  });

  app.post('/refresh', async c => {
    const aud = audOf(c.env, c.req.query('aud'));
    originAudience(c, aud);
    const r = await cookieSession(c, true);
    return c.json({
      success: true,
      data: await mintFor(c.env, r.user, r.session.sid, aud, r.session),
    });
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
    queueMail(c, resendVerificationFor(c.env, body.email));
    return c.json({ success: true, data: { status: 'sent_if_registered' } }, 202);
  });

  app.post('/password/forgot', async c => {
    const body = await json(c, z.object({ email: emailSchema }));
    if (!(await hit(c.env.DB, 'all', clientIp(c), PER_IP_ONLY('forgot', 10))).ok)
      throw err(429, 'TOO_MANY_ATTEMPTS');
    if (!(await hit(c.env.DB, body.email, 'n/a', PER_EMAIL('forgot-email', 3))).ok)
      throw err(429, 'TOO_MANY_ATTEMPTS');
    queueMail(c, forgotPasswordFor(c.env, body.email));
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
    const { user, sid } = await bearerAuth(c);
    const body = await json(c, z.object({ password: z.string(), code: z.string().optional() }));
    await requirePassword(c, user, body.password);
    if (!user.email_verified) throw err(403, 'EMAIL_NOT_VERIFIED');
    if (user.mfa_enabled) throw err(409, 'MFA_ALREADY_ENABLED');
    if (!c.env.MFA_KEY) throw err(503, 'MFA_UNAVAILABLE');
    await startEnrolment(c, user, sid, body.code);
    const secret = newSecret();
    await c.env.DB.prepare(`UPDATE users SET mfa_secret = ?2 WHERE id = ?1`)
      .bind(user.id, await sealCurrent(c.env, secret, user.id))
      .run();
    return c.json({
      success: true,
      data: { secret, otpauthUrl: totpUri(user.email, secret, 'Ebda AI Studio') },
    });
  });

  // Mails the one-time code every account needs to enrol its FIRST factor (a platform admin also needs the operator's token).
  app.post('/mfa/bootstrap/code', async c => {
    const { user } = await bearerAuth(c);
    const body = await json(c, z.object({ password: z.string() }));
    await requirePassword(c, user, body.password);
    if (await hasAnyFactor(c.env.DB, user)) throw err(409, 'NOT_REQUIRED');
    if (!(await hit(c.env.DB, user.id, 'n/a', PER_EMAIL('bootstrap-code', 3))).ok)
      throw err(429, 'TOO_MANY_ATTEMPTS');
    await issueAndMail(c.env, user, 'factor_enrol', 'two_factor');
    return c.json({ success: true, data: { sent: true } }, 202);
  });

  app.post('/mfa/enroll/verify', async c => {
    const { user, sid } = await bearerAuth(c);
    const body = await json(
      c,
      z.object({
        code: z.string(),
        enrolmentToken: z.string().max(200).optional(),
        emailCode: z.string().max(10).optional(),
      })
    );
    if (!user.mfa_secret || !c.env.MFA_KEY || user.mfa_enabled) throw err(409, 'MFA_NOT_PENDING');
    if (!(await checkTotp(c, user, body.code))) throw err(400, 'INVALID_CODE');
    const mode = await authorizeEnrolment(c, user, sid, body);
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
    const requiresSignIn = await finishEnrolment(c, user, mode, 'totp');
    return c.json({ success: true, data: { enabled: true, backupCodes: plain, requiresSignIn } });
  });

  app.post('/mfa/disable', async c => {
    const { user } = await bearerAuth(c);
    const body = await json(c, z.object({ password: z.string(), code: z.string() }));
    await requirePassword(c, user, body.password);
    if (!user.mfa_secret || !c.env.MFA_KEY) throw err(409, 'MFA_NOT_ENABLED');
    if (!(await checkTotp(c, user, body.code))) throw err(400, 'INVALID_CODE');
    if (user.role === 'super_admin') {
      const n = await c.env.DB.prepare(
        `SELECT count(*) AS n FROM passkey_credentials WHERE user_id = ?1`
      )
        .bind(user.id)
        .first<{ n: number }>();
      if ((n?.n ?? 0) === 0) throw err(409, 'LAST_FACTOR'); // the TOTP is their only factor
    }
    await c.env.DB.prepare(
      `UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_backup_codes = '[]', mfa_enrolled_at = NULL WHERE id = ?1`
    )
      .bind(user.id)
      .run();
    return c.json({ success: true, data: { enabled: false } });
  });

  // ---- account phone (Ruling PHONE-CHANGE-1) ----
  // The phone is the WhatsApp reset-code destination (ID-WA-OTP-1), so changing it is a recovery-channel change: a stolen
  // access token alone must not be enough. Same step-up as /mfa/disable: the current password, plus a TOTP code when the
  // account has a second factor, and a per-user throttle. Interim: the new number is NOT proven by a code sent to it (the
  // WhatsApp channel is flag-off); the re-authentication is the proof. Send the code to the new number here when it is on.
  app.post('/phone', async c => {
    const { user } = await bearerAuth(c);
    const body = await json(
      c,
      z.object({
        phone: z
          .string()
          .trim()
          .regex(/^\+?[0-9][0-9 ()-]{6,19}$/)
          .transform(v => v.replace(/[ ()-]/g, '')),
        password: z.string(),
        code: z.string().optional(),
      })
    );
    if (!(await hit(c.env.DB, user.id, 'n/a', PER_EMAIL('phone-change', 5))).ok)
      throw err(429, 'TOO_MANY_ATTEMPTS');
    await requirePassword(c, user, body.password);
    await requireSecondFactor(c, user, body.code);
    await c.env.DB.prepare(`UPDATE users SET phone = ?2, updated_at = ?3 WHERE id = ?1`)
      .bind(user.id, body.phone, iso())
      .run();
    return c.json({ success: true, data: { phone: body.phone } });
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
    originAudience(c, aud);
    const ip = clientIp(c);
    // per client: a global key would let anyone lock every passkey sign-in
    const attempt = await hit(c.env.DB, ip, ip, { ...LOGIN, name: 'passkey', brake: false });
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
    const { user, sid } = await bearerAuth(c);
    const body = await json(c, z.object({ password: z.string(), code: z.string().optional() }));
    await requirePassword(c, user, body.password);
    // Registering a passkey (which later signs in WITHOUT a second factor) never rests on a token + password alone:
    // see startEnrolment for the policy this call records on the enrolment ticket.
    await startEnrolment(c, user, sid, body.code);
    return c.json({
      success: true,
      data: await passkeys.beginRegistration(c.env.DB, c.env, user, originHeader(c)),
    });
  });

  app.post('/passkey/register/verify', async c => {
    const { user, sid } = await bearerAuth(c);
    const body = await json(
      c,
      z.object({
        response: z.any(),
        name: z.string().optional(),
        enrolmentToken: z.string().max(200).optional(),
        emailCode: z.string().max(10).optional(),
      })
    );
    const mode = await authorizeEnrolment(c, user, sid, body);
    const data = await passkeys.finishRegistration(c.env.DB, user, originHeader(c), body as never);
    const requiresSignIn = await finishEnrolment(c, user, mode, 'passkey');
    return c.json({ success: true, data: { ...data, requiresSignIn } }, 201);
  });

  app.get('/passkeys', async c => {
    const { user } = await bearerAuth(c);
    return c.json({
      success: true,
      data: { passkeys: await passkeys.listPasskeys(c.env.DB, user.id) },
    });
  });

  app.post('/passkeys/:id/rename', async c => {
    const { user } = await bearerAuth(c);
    const body = await json(c, z.object({ name: z.string().min(1).max(100) }));
    if (!(await passkeys.renamePasskey(c.env.DB, user.id, c.req.param('id'), body.name)))
      throw err(404, 'NOT_FOUND');
    return c.json({ success: true, data: { renamed: true } });
  });

  app.post('/passkeys/:id/delete', async c => {
    const { user, sid } = await bearerAuth(c);
    const body = await json(c, z.object({ password: z.string(), code: z.string().optional() }));
    await requirePassword(c, user, body.password);
    await requireSecondFactor(c, user, body.code);
    // Removing a platform admin's factor needs the same fresh second-factor session as adding one (a phished password must not
    // be able to strip the only admin's passkey).
    if (user.role === 'super_admin') {
      if (!(await sessionFactorFresh(c, sid))) throw err(403, 'STEP_UP_REQUIRED');
      // never let the only platform admin strip their LAST factor (recovery would need the operator script)
      const n = await c.env.DB.prepare(
        `SELECT count(*) AS n FROM passkey_credentials WHERE user_id = ?1`
      )
        .bind(user.id)
        .first<{ n: number }>();
      if ((n?.n ?? 0) <= 1 && !user.mfa_enabled) throw err(409, 'LAST_FACTOR');
    }
    if (!(await passkeys.removePasskey(c.env.DB, user.id, c.req.param('id'))))
      throw err(404, 'NOT_FOUND');
    return c.json({ success: true, data: { deleted: true } });
  });

  // ---- integrator clients (identity contract v1.3) ----
  const STORE_ID = /^[A-Za-z0-9_-]{1,64}$/;
  const CLIENT_ID = /^cli_[A-Za-z0-9_-]{1,60}$/;

  /**
   * The store owner, decided NOW from the Store directory (never from the bearer's `stores` claim, which can be 15 min stale).
   * Returns the audience of the person token that was presented: client management is bound to it (a token issued to one
   * product cannot manage another product's clients), and a browser Origin must belong to that same product.
   */
  async function storeOwner(c: C, storeId: string, needFreshFactor: boolean) {
    if (!STORE_ID.test(storeId)) throw err(404, 'NOT_FOUND');
    const { user, sid, aud } = await bearerAuth(c, true);
    originAudience(c, aud);
    const stores = await storesFor(c.env, user.id);
    if (!stores.some(s => s.id === storeId && s.role === 'owner')) throw err(403, 'FORBIDDEN');
    if (needFreshFactor && !(await sessionFactorFresh(c, sid)))
      throw err(
        403,
        'FACTOR_REQUIRED',
        'Sign in again with your second factor to manage integrator clients'
      );
    return { user, aud };
  }
  /** Create, rotate and list act on ONE audience's clients and need a token issued to exactly that audience. */
  const sameAudience = (tokenAud: string, clientAud: string) => {
    if (tokenAud !== clientAud)
      throw err(403, 'AUDIENCE_MISMATCH', 'Use a token issued to the integration product');
  };

  app.get('/stores/:storeId/clients', async c => {
    const storeId = c.req.param('storeId');
    const { aud } = await storeOwner(c, storeId, false);
    if (!Object.hasOwn(AUDIENCE_SCOPES, aud))
      throw err(403, 'AUDIENCE_MISMATCH', 'This product has no integrator clients');
    return c.json({ success: true, data: await listClients(c.env.DB, storeId, aud) });
  });

  const createSchema = z.object({
    name: z.string().trim().min(1).max(80),
    audience: z.string().trim().min(1).max(32),
    scopes: z.array(z.string().max(64)).max(32),
  });
  app.post('/stores/:storeId/clients', async c => {
    const storeId = c.req.param('storeId');
    const { user, aud } = await storeOwner(c, storeId, true);
    const body = await json(c, createSchema);
    sameAudience(aud, body.audience);
    const r = await createClient(c.env.DB, c.env, {
      storeId,
      audience: body.audience,
      name: body.name,
      scopes: body.scopes,
      actor: user.id,
    });
    if (!r.ok) throw err(400, r.reason);
    c.header('Cache-Control', 'no-store');
    return c.json(
      {
        success: true,
        data: {
          client_id: r.clientId,
          client_secret: r.secret,
          name: body.name,
          audience: body.audience,
          scopes: r.scopes,
        },
      },
      201
    );
  });

  const rotateSchema = z.object({
    overlapHours: z.number().int().min(0).max(MAX_OVERLAP_HOURS).default(DEFAULT_OVERLAP_HOURS),
  });
  app.post('/stores/:storeId/clients/:id/rotate', async c => {
    const storeId = c.req.param('storeId');
    const id = c.req.param('id');
    const { user, aud } = await storeOwner(c, storeId, true);
    if (!CLIENT_ID.test(id)) throw err(404, 'NOT_FOUND');
    const existing = await getStoreClient(c.env.DB, storeId, id);
    if (!existing) throw err(404, 'NOT_FOUND');
    sameAudience(aud, existing.audience);
    const body = (c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')
      ? await json(c, rotateSchema)
      : rotateSchema.parse({});
    const r = await rotateClient(c.env.DB, c.env, storeId, id, user.id, body.overlapHours);
    if (!r.ok) {
      if (r.reason === 'NOT_FOUND') throw err(404, 'NOT_FOUND');
      throw err(409, r.reason === 'REVOKED' ? 'CLIENT_REVOKED' : 'ROTATION_IN_PROGRESS');
    }
    c.header('Cache-Control', 'no-store');
    return c.json({
      success: true,
      data: {
        client_id: id,
        client_secret: r.secret,
        secret_slot: r.slot,
        previous_secret_expires_at: r.oldExpiresAt,
      },
    });
  });

  app.delete('/stores/:storeId/clients/:id', async c => {
    const storeId = c.req.param('storeId');
    const id = c.req.param('id');
    // Revoking only ever REDUCES access: any audience of the owner may do it.
    const { user } = await storeOwner(c, storeId, true);
    if (!CLIENT_ID.test(id)) throw err(404, 'NOT_FOUND');
    if ((await revokeClient(c.env.DB, storeId, id, user.id)) === 'not_found')
      throw err(404, 'NOT_FOUND');
    return c.json({ success: true, data: { revoked: true } });
  });

  // OAuth 2.0 client_credentials (RFC 6749 s4.4). The ONLY mint of a client token (Ruling ID-12: no RPC mints one).
  const OAUTH_FAIL: Budget = { name: 'oauthfail', perKey: 10, perIp: 200 };
  const OAUTH_ISSUE: Budget = {
    name: 'oauthissue',
    perKey: 60,
    perIp: Number.MAX_SAFE_INTEGER,
    windowMs: 3600_000,
  };
  app.post('/oauth/token', async c => {
    const oauth = (
      status: 400 | 401 | 429 | 503,
      error: string,
      extra: Record<string, string> = {}
    ) => {
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      if (status === 401)
        c.header('WWW-Authenticate', 'Basic realm="ebda-accounts", charset="UTF-8"');
      return c.json({ error, ...extra }, status);
    };
    // Servers only: a browser (any Origin) never holds a client secret.
    if (c.req.header('origin')) return oauth(400, 'invalid_request');
    if (
      !(c.req.header('content-type') ?? '')
        .toLowerCase()
        .startsWith('application/x-www-form-urlencoded')
    )
      return oauth(400, 'invalid_request');
    const raw = new TextDecoder().decode(await c.req.arrayBuffer());
    if (raw.length > 4096) return oauth(400, 'invalid_request');
    const params = new URLSearchParams(raw);
    if (params.has('client_secret')) return oauth(400, 'invalid_request');
    if (params.get('grant_type') !== 'client_credentials')
      return oauth(400, 'unsupported_grant_type');

    const m = /^Basic\s+([A-Za-z0-9+/=_-]+)$/i.exec(c.req.header('authorization') ?? '');
    let id = '';
    let secret = '';
    if (m) {
      try {
        const dec = atob(m[1].replace(/-/g, '+').replace(/_/g, '/'));
        const i = dec.indexOf(':');
        if (i > 0) {
          id = dec.slice(0, i);
          secret = dec.slice(i + 1);
        }
      } catch {
        /* malformed */
      }
    }
    if (!id || !secret || id.length > 64 || secret.length > 128)
      return oauth(401, 'invalid_client');

    const ip = clientIp(c);
    const key = `${(await sha256Hex(id)).slice(0, 24)}:${ipPrefix(ip)}`;
    try {
      const attempt = await hit(c.env.DB, key, ip, OAUTH_FAIL);
      if (!attempt.ok) {
        c.header('Retry-After', String(await retryAfterSeconds(c.env.DB, OAUTH_FAIL, key)));
        return oauth(429, 'slow_down');
      }
      const auth = await authenticateClient(c.env.DB, c.env, id, secret);
      if (!auth.client) {
        // Only a KNOWN client gets a trail row (random ids cannot grow the table); the answer is the same either way.
        // After the response: the trail write must not make a known client's failure slower than an unknown one's.
        if (auth.known) {
          const known = auth.known;
          const write = auditAuthFailure(c.env.DB, known, ip).catch(() => undefined);
          try {
            c.executionCtx.waitUntil(write);
          } catch {
            await write;
          }
        }
        return oauth(401, 'invalid_client');
      }
      await attempt.succeeded();
      const client = auth.client;
      // A deleted store ends its clients at once, whatever the cleanup has done yet. A directory error fails CLOSED (503).
      if (!c.env.STORE_DIRECTORY) return oauth(503, 'temporarily_unavailable');
      let live: boolean;
      try {
        live = await c.env.STORE_DIRECTORY.storeActive(client.store_id);
      } catch {
        return oauth(503, 'temporarily_unavailable');
      }
      if (!live) return oauth(401, 'invalid_client');
      const audience = params.get('audience') ?? client.audience;
      if (audience !== client.audience) return oauth(400, 'unauthorized_client');
      const held = client.scopes.split(' ');
      const asked = params.get('scope');
      const granted = asked === null ? held : asked.split(' ').filter(Boolean);
      if (
        !granted.length ||
        granted.some(s => !held.includes(s)) ||
        new Set(granted).size !== granted.length
      )
        return oauth(400, 'invalid_scope');
      const issue = await hit(c.env.DB, client.id, ip, OAUTH_ISSUE);
      if (!issue.ok) {
        c.header('Retry-After', String(await retryAfterSeconds(c.env.DB, OAUTH_ISSUE, client.id)));
        return oauth(429, 'slow_down');
      }
      const scope = granted.join(' ');
      const t = await mintClientToken(
        c.env,
        { clientId: client.id, storeId: client.store_id, aud: client.audience, scope },
        CLIENT_TOKEN_TTL_SECONDS
      );
      await audit(c.env.DB, {
        clientId: client.id,
        storeId: client.store_id,
        event: 'issued',
        jti: t.jti,
        slot: auth.slot,
        ip,
        scope,
      }).run();
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json({
        access_token: t.token,
        token_type: 'Bearer',
        expires_in: CLIENT_TOKEN_TTL_SECONDS,
        scope,
      });
    } catch (e) {
      if (e instanceof PepperMissing) return oauth(503, 'temporarily_unavailable');
      throw e;
    }
  });

  return app;
}
