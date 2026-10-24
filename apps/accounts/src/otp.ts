/** One-time email codes: verification and password reset. 6 digits, hashed at rest, 5 tries, single use. */
import type { UserRow } from './data';
import { iso, nowMs, randomCode, safeEqual, sha256Hex } from './util';

export type OtpType = 'email' | 'password_reset';
export const OTP_TTL_MINUTES: Record<OtpType, number> = { email: 30, password_reset: 15 };
const MAX_ATTEMPTS = 5;
const MAX_SENDS_PER_15_MIN = 3;

const hashCode = (userId: string, type: OtpType, code: string) =>
  sha256Hex(`otp:${type}:${userId}:${code}`);

/** Returns the plain code to mail, or null when the user asked for too many in the window (caller still answers generically). */
export async function issueOtp(
  db: D1Database,
  user: Pick<UserRow, 'id'>,
  type: OtpType
): Promise<string | null> {
  const code = randomCode();
  const now = nowMs();
  const id = crypto.randomUUID();
  // Insert FIRST, then count in the same batch: a burst of requests cannot all pass a check-then-act cap.
  const res = await db.batch([
    db
      .prepare(
        `UPDATE verification_tokens SET used_at = ?3 WHERE user_id = ?1 AND type = ?2 AND used_at IS NULL`
      )
      .bind(user.id, type, iso(now)),
    db
      .prepare(
        `INSERT INTO verification_tokens (id, token, user_id, type, expires_at, created_at) VALUES (?1,?2,?3,?4,?5,?6)`
      )
      .bind(
        id,
        await hashCode(user.id, type, code),
        user.id,
        type,
        iso(now + OTP_TTL_MINUTES[type] * 60_000),
        iso(now)
      ),
    db
      .prepare(
        `SELECT count(*) AS n FROM verification_tokens WHERE user_id = ?1 AND type = ?2 AND created_at > ?3`
      )
      .bind(user.id, type, iso(now - 15 * 60_000)),
  ]);
  if (((res[2].results[0] as { n: number }).n ?? 0) > MAX_SENDS_PER_15_MIN) {
    // Over the cap: this code is never mailed, so it must not be valid either.
    await db
      .prepare(`UPDATE verification_tokens SET used_at = ?2 WHERE id = ?1`)
      .bind(id, iso(now))
      .run();
    return null;
  }
  return code;
}

/** Consumes the code on success. Wrong guesses count against the newest code; the 5th kills it. */
export async function verifyOtp(
  db: D1Database,
  user: Pick<UserRow, 'id'>,
  type: OtpType,
  code: string
): Promise<boolean> {
  if (!/^\d{6}$/.test(code ?? '')) return false;
  const row = await db
    .prepare(
      `SELECT id, token, attempts FROM verification_tokens
       WHERE user_id = ?1 AND type = ?2 AND used_at IS NULL AND expires_at > ?3 ORDER BY created_at DESC LIMIT 1`
    )
    .bind(user.id, type, iso())
    .first<{ id: string; token: string; attempts: number }>();
  if (!row) return false;
  if (!safeEqual(row.token, await hashCode(user.id, type, code))) {
    await db
      .prepare(
        `UPDATE verification_tokens SET attempts = attempts + 1, used_at = CASE WHEN attempts + 1 >= ?2 THEN ?3 ELSE used_at END WHERE id = ?1`
      )
      .bind(row.id, MAX_ATTEMPTS, iso())
      .run();
    return false;
  }
  const res = await db
    .prepare(`UPDATE verification_tokens SET used_at = ?2 WHERE id = ?1 AND used_at IS NULL`)
    .bind(row.id, iso())
    .run();
  return (res.meta.changes ?? 0) === 1;
}
