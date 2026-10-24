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
  if (!session || session.revoked_at || session.expires_at <= nowMs() || session.user_id !== userId)
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
    db.prepare(`UPDATE users SET token_version = token_version + 1 WHERE id = ?1`).bind(userId),
  ]);
}

/** True when the session must be refused: unknown, revoked, expired, or its user is no longer active. */
export async function isSessionRevoked(db: D1Database, sid: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT s.revoked_at, s.expires_at, u.status, u.deleted_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.sid = ?1`
    )
    .bind(sid)
    .first<{
      revoked_at: number | null;
      expires_at: number;
      status: string;
      deleted_at: string | null;
    }>();
  if (!row) return true;
  return (
    !!row.revoked_at || row.expires_at <= nowMs() || row.status !== 'active' || !!row.deleted_at
  );
}
