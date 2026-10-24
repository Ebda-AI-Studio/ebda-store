/**
 * Attempt throttle on D1. COUNT-FIRST: the attempt row is inserted and the window is counted in ONE batch (one D1
 * transaction), BEFORE the guarded work (bcrypt, a TOTP check, an OTP check) runs. A burst of N parallel requests therefore
 * sees counts 1..N and everything past the budget is refused without being evaluated; a check-then-act design lets all N
 * pass the check together. The Store used an AuthState Durable Object for this; D1 is enough for identity volume
 * (Ruling ID-7) and a Durable Object is the drop-in upgrade.
 *
 * Keys are free-form strings. Each call counts against `key` (per subject: an email, a user id) AND against the client IP.
 */
export const WINDOW_MS = 15 * 60_000;

export interface Budget {
  /** Attempts allowed per subject key in the window. */
  perKey: number;
  /** Attempts allowed per client IP in the window (across all subjects). */
  perIp: number;
}

export const LOGIN: Budget = { perKey: 5, perIp: 30 };
export const SECOND_FACTOR: Budget = { perKey: 5, perIp: 30 };
export const CODE_GUESS: Budget = { perKey: 5, perIp: 30 };
/** Cheap unauthenticated writes (options, signup): per IP only. */
export const PER_IP_ONLY = (n: number): Budget => ({ perKey: Number.MAX_SAFE_INTEGER, perIp: n });

/** Records the attempt and returns whether it is within budget (true = go ahead). */
export async function hit(
  db: D1Database,
  key: string,
  ip: string,
  budget: Budget
): Promise<boolean> {
  const at = Date.now();
  const since = at - WINDOW_MS;
  const res = await db.batch([
    db.prepare(`INSERT INTO login_attempts (key, at) VALUES (?1, ?2)`).bind(`s:${key}`, at),
    db.prepare(`INSERT INTO login_attempts (key, at) VALUES (?1, ?2)`).bind(`i:${ip}`, at),
    db
      .prepare(`SELECT count(*) AS n FROM login_attempts WHERE key = ?1 AND at > ?2`)
      .bind(`s:${key}`, since),
    db
      .prepare(`SELECT count(*) AS n FROM login_attempts WHERE key = ?1 AND at > ?2`)
      .bind(`i:${ip}`, since),
    // opportunistic cleanup keeps the table small
    db.prepare(`DELETE FROM login_attempts WHERE at < ?1`).bind(at - 2 * WINDOW_MS),
  ]);
  const nKey = (res[2].results[0] as { n: number }).n;
  const nIp = (res[3].results[0] as { n: number }).n;
  return nKey <= budget.perKey && nIp <= budget.perIp;
}

/** A success clears the subject's counter (the IP counter stays: it bounds a sprayer, not a user). */
export async function clear(db: D1Database, key: string): Promise<void> {
  await db.prepare(`DELETE FROM login_attempts WHERE key = ?1`).bind(`s:${key}`).run();
}
