/** D1 access. Every statement is parameterised; there is no string-built SQL with user input anywhere in this file. */
import { iso, nowMs, randomToken, sha256Hex } from './util';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  role: 'customer' | 'store_admin' | 'super_admin' | 'staff';
  status: 'active' | 'inactive' | 'suspended';
  email_verified: number;
  language: string;
  mfa_enabled: number;
  mfa_secret: string | null;
  mfa_backup_codes: string;
  mfa_last_step: number | null;
  token_version: number;
}

export interface SessionRow {
  sid: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  amr: string;
}

export const SESSION_TTL_MS = 30 * 24 * 3600_000;
/** A session never outlives this, however often it is rotated (sliding window is capped). */
export const SESSION_MAX_MS = 180 * 24 * 3600_000;
/** The refresh cookie rotates at most this often; a rotated token still answers for GRACE_MS (parallel tabs). */
export const ROTATE_AFTER_MS = 24 * 3600_000;
export const GRACE_MS = 60_000;

export const findUserByEmail = (db: D1Database, email: string) =>
  db
    .prepare(`SELECT * FROM users WHERE lower(email) = lower(?1) AND deleted_at IS NULL`)
    .bind(email)
    .first<UserRow>();

export const findUserById = (db: D1Database, id: string) =>
  db.prepare(`SELECT * FROM users WHERE id = ?1 AND deleted_at IS NULL`).bind(id).first<UserRow>();

export interface SessionContext {
  ip: string;
  userAgent: string;
}

/** New login: a session plus its first refresh token. Returns the RAW refresh token (shown once, stored hashed). */
export async function createSession(
  db: D1Database,
  user: Pick<UserRow, 'id'>,
  amr: string,
  ctx: SessionContext
): Promise<{ sid: string; refreshToken: string; expiresAt: number }> {
  const sid = crypto.randomUUID();
  const refreshToken = randomToken();
  const now = nowMs();
  const expiresAt = now + SESSION_TTL_MS;
  await db.batch([
    db
      .prepare(
        `INSERT INTO sessions (sid, user_id, created_at, expires_at, ip, user_agent, amr) VALUES (?1,?2,?3,?4,?5,?6,?7)`
      )
      .bind(sid, user.id, now, expiresAt, ctx.ip.slice(0, 64), ctx.userAgent.slice(0, 200), amr),
    db
      .prepare(
        `INSERT INTO refresh_tokens (id, token, user_id, sid, expires_at, created_at) VALUES (?1,?2,?3,?4,?5,?6)`
      )
      .bind(
        crypto.randomUUID(),
        await sha256Hex(refreshToken),
        user.id,
        sid,
        iso(expiresAt),
        iso(now)
      ),
    db.prepare(`UPDATE users SET last_login_at = ?2 WHERE id = ?1`).bind(user.id, iso(now)),
  ]);
  return { sid, refreshToken, expiresAt };
}

export interface Resolved {
  user: UserRow;
  session: SessionRow;
  /** Set when the cookie was rotated: the browser must store this value. */
  newRefreshToken?: string;
}

/**
 * Resolve a refresh cookie to a live session.
 *  - unknown token                                  -> null
 *  - a token that was rotated away (reuse)          -> the whole session is revoked, null
 *    (except inside the 60 s grace window, which parallel tabs legitimately hit)
 *  - expired / revoked session / inactive user      -> null
 *  - token older than 24 h                          -> rotated (old row revoked with reason 'rotated')
 */
export async function resolveRefresh(
  db: D1Database,
  raw: string,
  force = false
): Promise<Resolved | null> {
  if (!raw || raw.length > 200) return null;
  const hash = await sha256Hex(raw);
  const rt = await db.prepare(`SELECT * FROM refresh_tokens WHERE token = ?1`).bind(hash).first<{
    id: string;
    user_id: string;
    sid: string | null;
    expires_at: string;
    created_at: string;
    revoked_at: string | null;
    revoked_reason: string | null;
  }>();
  if (!rt || !rt.sid) return null;
  const now = nowMs();

  if (rt.revoked_at) {
    const rotatedRecently =
      rt.revoked_reason === 'rotated' && now - Date.parse(rt.revoked_at) <= GRACE_MS;
    if (!rotatedRecently) await revokeSession(db, rt.sid, 'refresh-reuse');
    else {
      const ok = await liveSession(db, rt.sid, rt.user_id);
      return ok ? { ...ok } : null;
    }
    return null;
  }
  if (Date.parse(rt.expires_at) <= now) return null;
  const ok = await liveSession(db, rt.sid, rt.user_id);
  if (!ok) return null;

  if (!force && now - Date.parse(rt.created_at) < ROTATE_AFTER_MS) return ok;

  const next = randomToken();
  const nextId = crypto.randomUUID();
  const expiresAt = now + SESSION_TTL_MS;
  const res = await db.batch([
    // Compare-and-set: only one of two racing rotations wins; the loser keeps the (now rotated) old token + grace.
    db
      .prepare(
        `UPDATE refresh_tokens SET revoked_at = ?2, revoked_reason = 'rotated', replaced_by_id = ?3 WHERE id = ?1 AND revoked_at IS NULL`
      )
      .bind(rt.id, iso(now), nextId),
    db
      .prepare(
        `INSERT INTO refresh_tokens (id, token, user_id, sid, expires_at, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE changes() = 1`
      )
      .bind(nextId, await sha256Hex(next), rt.user_id, rt.sid, iso(expiresAt), iso(now)),
    db
      .prepare(`UPDATE sessions SET expires_at = ?2 WHERE sid = ?1 AND changes() = 1`)
      .bind(rt.sid, expiresAt),
  ]);
  const won = (res[0].meta.changes ?? 0) === 1;
  return won ? { ...ok, newRefreshToken: next } : ok;
}

async function liveSession(
  db: D1Database,
  sid: string,
  userId: string
): Promise<{ user: UserRow; session: SessionRow } | null> {
  const session = await db
    .prepare(`SELECT * FROM sessions WHERE sid = ?1`)
    .bind(sid)
    .first<SessionRow>();
  if (
    !session ||
    session.revoked_at ||
    session.expires_at <= nowMs() ||
    session.created_at + SESSION_MAX_MS <= nowMs() ||
    session.user_id !== userId
  )
    return null;
  const user = await findUserById(db, userId);
  if (!user || user.status !== 'active') return null;
  return { user, session };
}

export async function revokeSession(db: D1Database, sid: string, reason: string): Promise<void> {
  const now = nowMs();
  await db.batch([
    db
      .prepare(
        `UPDATE sessions SET revoked_at = ?2, revoked_reason = ?3 WHERE sid = ?1 AND revoked_at IS NULL`
      )
      .bind(sid, now, reason),
    db
      .prepare(
        `UPDATE refresh_tokens SET revoked_at = ?2, revoked_reason = COALESCE(revoked_reason, ?3) WHERE sid = ?1 AND revoked_at IS NULL`
      )
      .bind(sid, iso(now), reason),
  ]);
}

export async function revokeAllForUser(
  db: D1Database,
  userId: string,
  reason: string
): Promise<void> {
  const now = nowMs();
  await db.batch([
    db
      .prepare(
        `UPDATE sessions SET revoked_at = ?2, revoked_reason = ?3 WHERE user_id = ?1 AND revoked_at IS NULL`
      )
      .bind(userId, now, reason),
    db
      .prepare(
        `UPDATE refresh_tokens SET revoked_at = ?2, revoked_reason = COALESCE(revoked_reason, ?3) WHERE user_id = ?1 AND revoked_at IS NULL`
      )
      .bind(userId, iso(now), reason),
  ]);
}

/** Sign out every session of the user EXCEPT `keepSid` (the one that just made a security change), refresh tokens included. */
export async function revokeOtherSessions(
  db: D1Database,
  userId: string,
  keepSid: string,
  reason: string
): Promise<void> {
  const now = nowMs();
  await db.batch([
    db
      .prepare(
        `UPDATE sessions SET revoked_at = ?3, revoked_reason = ?4 WHERE user_id = ?1 AND sid != ?2 AND revoked_at IS NULL`
      )
      .bind(userId, keepSid, now, reason),
    db
      .prepare(
        `UPDATE refresh_tokens SET revoked_at = ?3, revoked_reason = COALESCE(revoked_reason, ?4) WHERE user_id = ?1 AND sid != ?2 AND revoked_at IS NULL`
      )
      .bind(userId, keepSid, iso(now), reason),
  ]);
}

/** True when the session must be refused: unknown, revoked, expired, or its user is no longer active. */
export async function isSessionRevoked(db: D1Database, sid: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT s.revoked_at, s.expires_at, s.created_at, u.status, u.deleted_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.sid = ?1`
    )
    .bind(sid)
    .first<{
      revoked_at: number | null;
      expires_at: number;
      created_at: number;
      status: string;
      deleted_at: string | null;
    }>();
  if (!row) return true;
  const now = nowMs();
  return (
    !!row.revoked_at ||
    row.expires_at <= now ||
    row.created_at + SESSION_MAX_MS <= now ||
    row.status !== 'active' ||
    !!row.deleted_at
  );
}

/**
 * Strip every second factor and credential an attacker could have planted before the mailbox owner proved control of
 * the address (pre-hijacking), and end every session. Run on the first email verification of a previously unverified
 * account, on a password reset of such an account, and when a new signup overwrites it.
 */
export async function purgeCredentials(
  db: D1Database,
  userId: string,
  reason: string
): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM passkey_credentials WHERE user_id = ?1`).bind(userId),
    db
      .prepare(
        `UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_backup_codes = '[]', mfa_enrolled_at = NULL, mfa_last_step = NULL WHERE id = ?1`
      )
      .bind(userId),
    db.prepare(`DELETE FROM challenges WHERE user_id = ?1`).bind(userId),
  ]);
  await revokeAllForUser(db, userId, reason);
}

/** Single-use TOTP step: true only for the first acceptance of a step newer than the last one accepted. */
export async function claimTotpStep(
  db: D1Database,
  userId: string,
  step: number
): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE users SET mfa_last_step = ?2 WHERE id = ?1 AND (mfa_last_step IS NULL OR mfa_last_step < ?2)`
    )
    .bind(userId, step)
    .run();
  return (r.meta.changes ?? 0) === 1;
}

const USER_TABLES = [
  'sessions',
  'refresh_tokens',
  'verification_tokens',
  'passkey_credentials',
] as const;

async function remainingFor(db: D1Database, userId: string, email: string | null): Promise<number> {
  let n = 0;
  for (const t of ['users', ...USER_TABLES]) {
    const col = t === 'users' ? 'id' : 'user_id';
    const r = await db
      .prepare(`SELECT count(*) AS n FROM ${t} WHERE ${col} = ?1`)
      .bind(userId)
      .first<{ n: number }>();
    n += r?.n ?? 0;
  }
  const c = await db
    .prepare(`SELECT count(*) AS n FROM challenges WHERE user_id = ?1`)
    .bind(userId)
    .first<{ n: number }>();
  n += c?.n ?? 0;
  if (email) {
    const a = await db
      .prepare(`SELECT count(*) AS n FROM login_attempts WHERE key = ?1`)
      .bind(`e:${email.toLowerCase()}`)
      .first<{ n: number }>();
    n += a?.n ?? 0;
  }
  return n;
}

/**
 * PDPL erasure (G10): deletes the user, every session, refresh token, verification token and passkey (FK cascade), the MFA
 * secret and backup codes (they live on the user row), open challenges and the login-throttle rows keyed by the address.
 * Deleting the sessions revokes every sid: isSessionRevoked treats an unknown sid as revoked. Idempotent: a repeat finds
 * nothing and reports erased=false. `remaining` is re-counted AFTER the delete and must be 0.
 */
export async function eraseIdentity(
  db: D1Database,
  userId: string,
  requestId?: string
): Promise<{ erased: boolean; remaining: number }> {
  const user = await db
    .prepare(`SELECT email FROM users WHERE id = ?1`)
    .bind(userId)
    .first<{ email: string }>();
  const email = user?.email ?? null;
  const statements = [
    db.prepare(`DELETE FROM challenges WHERE user_id = ?1`).bind(userId),
    db.prepare(`DELETE FROM users WHERE id = ?1`).bind(userId),
  ];
  if (email)
    statements.push(
      db.prepare(`DELETE FROM login_attempts WHERE key = ?1`).bind(`e:${email.toLowerCase()}`)
    );
  await db.batch(statements);
  const remaining = await remainingFor(db, userId, email);
  // Audit line without personal data: the request id and counts only.
  console.log(
    JSON.stringify({
      msg: 'identity erased',
      requestId: requestId ?? null,
      erased: !!user,
      remaining,
    })
  );
  return { erased: !!user, remaining };
}

/** PDPL export (G10): the user's identity data, secrets and credential material excluded. */
export async function exportIdentity(
  db: D1Database,
  userId: string
): Promise<Record<string, unknown[]>> {
  const all = async (sql: string) =>
    (await db.prepare(sql).bind(userId).all()).results as unknown[];
  return {
    users: await all(
      `SELECT id, email, first_name, last_name, phone, role, status, email_verified, avatar, language, last_login_at,
              created_at, updated_at, deleted_at, mfa_enabled, mfa_enrolled_at FROM users WHERE id = ?1`
    ),
    sessions: await all(
      `SELECT sid, created_at, expires_at, revoked_at, revoked_reason, ip, user_agent, amr FROM sessions WHERE user_id = ?1 ORDER BY created_at`
    ),
    refresh_tokens: await all(
      `SELECT id, sid, expires_at, created_at, revoked_at, revoked_reason FROM refresh_tokens WHERE user_id = ?1 ORDER BY created_at`
    ),
    verification_tokens: await all(
      `SELECT id, type, expires_at, used_at, created_at FROM verification_tokens WHERE user_id = ?1 ORDER BY created_at`
    ),
    passkey_credentials: await all(
      `SELECT id, credential_id, transports, device_type, backed_up, rp_id, name, created_at, last_used_at FROM passkey_credentials WHERE user_id = ?1 ORDER BY created_at`
    ),
  };
}
