/** One-time email codes: verification and password reset. 6 digits, hashed at rest, 5 tries, single use. */
import type { UserRow } from './data';
import { iso, nowMs, randomCode, safeEqual, sha256Hex } from './util';

export type OtpType = 'email' | 'password_reset' | 'two_factor';
export const OTP_TTL_MINUTES: Record<OtpType, number> = {
  email: 30,
  password_reset: 15,
  two_factor: 10,
};
const MAX_ATTEMPTS = 5;
export const MAX_SENDS_PER_15_MIN = 3;

/** Signup data carried by ONE code (see migration). */
export interface PendingSignup {
  password_hash: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  language: string;
}

const hashCode = (userId: string, type: OtpType, code: string) =>
  sha256Hex(`otp:${type}:${userId}:${code}`);

/**
 * Issue a code. Returns the plain code to mail, or null when the user is over the send cap.
 *
 * Cap-first, atomically: the new code is inserted INACTIVE (`sent = 0`, already `used`), becomes active only if the number
 * of codes sent in the window is still under the cap, and only then are the user's older codes invalidated. All of it is
 * one D1 batch (one transaction). So (a) a burst cannot slip past the cap, and (b) an attacker spamming "resend" beyond
 * the cap cannot kill the valid code the owner is holding.
 */
export async function issueOtp(
  db: D1Database,
  user: Pick<UserRow, 'id'>,
  type: OtpType,
  pending?: PendingSignup,
  /** Override the code lifetime (an invitation outlives a password-reset code). */
  ttlMinutes: number = OTP_TTL_MINUTES[type]
): Promise<string | null> {
  const code = randomCode();
  const now = nowMs();
  const id = crypto.randomUUID();
  const res = await db.batch([
    db
      .prepare(
        `INSERT INTO verification_tokens (id, token, user_id, type, expires_at, used_at, created_at, sent, pending)
         VALUES (?1,?2,?3,?4,?5,?6,?6,0,?7)`
      )
      .bind(
        id,
        await hashCode(user.id, type, code),
        user.id,
        type,
        iso(now + ttlMinutes * 60_000),
        iso(now),
        pending ? JSON.stringify(pending) : null
      ),
    db
      .prepare(
        `UPDATE verification_tokens SET sent = 1, used_at = NULL
         WHERE id = ?1 AND (SELECT count(*) FROM verification_tokens WHERE user_id = ?2 AND type = ?3 AND sent = 1 AND created_at > ?4) < ?5`
      )
      .bind(id, user.id, type, iso(now - 15 * 60_000), MAX_SENDS_PER_15_MIN),
    db
      .prepare(
        `UPDATE verification_tokens SET used_at = ?4
         WHERE user_id = ?1 AND type = ?2 AND used_at IS NULL AND id != ?3
           AND (SELECT sent FROM verification_tokens WHERE id = ?3) = 1`
      )
      .bind(user.id, type, id, iso(now)),
    db.prepare(`DELETE FROM verification_tokens WHERE id = ?1 AND sent = 0`).bind(id),
  ]);
  return (res[1].meta.changes ?? 0) === 1 ? code : null;
}

export interface OtpResult {
  ok: boolean;
  pending: PendingSignup | null;
}

/** Consumes the code on success. Wrong guesses count against the newest code; the 5th kills it. */
export async function verifyOtp(
  db: D1Database,
  user: Pick<UserRow, 'id'>,
  type: OtpType,
  code: string,
  /**
   * Extra proof required AFTER the code matches and BEFORE it is consumed (signup: the password submitted with the signup
   * that produced this code). A refusal counts as a wrong guess and leaves the code usable.
   */
  accept?: (pending: PendingSignup | null) => Promise<boolean>
): Promise<OtpResult> {
  const fail: OtpResult = { ok: false, pending: null };
  if (!/^\d{6}$/.test(code ?? '')) return fail;
  const live = await db
    .prepare(
      `SELECT id FROM verification_tokens
       WHERE user_id = ?1 AND type = ?2 AND used_at IS NULL AND sent = 1 AND expires_at > ?3 ORDER BY created_at DESC LIMIT 1`
    )
    .bind(user.id, type, iso())
    .first<{ id: string }>();
  if (!live) return fail;
  // The attempt is CLAIMED atomically BEFORE the code is compared (Issue 618): one guarded UPDATE ... RETURNING, so K parallel
  // guesses against one code get at most MAX_ATTEMPTS comparisons in total; the rest find no claim and are refused unevaluated.
  const row = await db
    .prepare(
      `UPDATE verification_tokens SET attempts = attempts + 1
       WHERE id = ?1 AND used_at IS NULL AND attempts < ?2 RETURNING token, attempts, pending`
    )
    .bind(live.id, MAX_ATTEMPTS)
    .first<{ token: string; attempts: number; pending: string | null }>();
  if (!row) return fail;
  const pending = row.pending ? (JSON.parse(row.pending) as PendingSignup) : null;
  const codeMatches = safeEqual(row.token, await hashCode(user.id, type, code));
  if (!codeMatches || (accept && !(await accept(pending)))) {
    // the last claimed attempt burns the code
    if (row.attempts >= MAX_ATTEMPTS)
      await db
        .prepare(`UPDATE verification_tokens SET used_at = ?2 WHERE id = ?1 AND used_at IS NULL`)
        .bind(live.id, iso())
        .run();
    return fail;
  }
  const res = await db
    .prepare(`UPDATE verification_tokens SET used_at = ?2 WHERE id = ?1 AND used_at IS NULL`)
    .bind(live.id, iso())
    .run();
  if ((res.meta.changes ?? 0) !== 1) return fail;
  return { ok: true, pending };
}
