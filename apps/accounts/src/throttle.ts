/**
 * Attempt throttle on D1.
 *
 * COUNT-FIRST and ATOMIC: an attempt is admitted by a guarded INSERT (`... WHERE count < budget`) executed in one D1 batch
 * (one transaction) BEFORE the guarded work (bcrypt, a TOTP or code check) runs. A burst of N parallel requests is admitted
 * at most `budget` times and the rest are refused without being evaluated. Refused requests insert nothing, so a flood
 * cannot extend a lock or grow the table (and every count stays a bounded index scan).
 *
 * Every budget has its OWN namespace for both the subject key and the client IP, so a password login, a second factor and
 * an OTP guess never draw on one shared counter. A SUCCESS refunds the IP row and clears the subject's counter, so the IP
 * budget bounds failures and in-flight attempts only (a carrier-grade NAT with many honest users is not locked out by them).
 * The Store used an AuthState Durable Object for this; D1 is enough for identity volume (Ruling ID-7) and a Durable
 * Object is the drop-in upgrade.
 */
export const WINDOW_MS = 15 * 60_000;

export interface Budget {
  /** Namespace: separates this budget's counters from every other budget's. */
  name: string;
  /** Attempts allowed per subject key in the window. */
  perKey: number;
  /** Attempts allowed per client IP in the window (failures and in-flight only; successes are refunded). */
  perIp: number;
}

export const LOGIN: Budget = { name: 'login', perKey: 5, perIp: 60 };
export const SECOND_FACTOR: Budget = { name: 'mfa', perKey: 5, perIp: 60 };
export const CODE_GUESS: Budget = { name: 'code', perKey: 5, perIp: 60 };
/** Cheap unauthenticated writes (options, signup): per IP only. */
export const PER_IP_ONLY = (name: string, n: number): Budget => ({
  name,
  perKey: Number.MAX_SAFE_INTEGER,
  perIp: n,
});
/** One address cannot be mailed more than `n` times per window, whether or not it is registered. */
export const PER_EMAIL = (name: string, n: number): Budget => ({
  name,
  perKey: n,
  perIp: Number.MAX_SAFE_INTEGER,
});

export interface Attempt {
  ok: boolean;
  /** The guarded work succeeded: clear the subject's counter and give the IP row back. */
  succeeded(): Promise<void>;
}

export async function hit(
  db: D1Database,
  key: string,
  ip: string,
  budget: Budget
): Promise<Attempt> {
  const at = Date.now();
  const since = at - WINDOW_MS;
  const sKey = `s:${budget.name}:${key}`;
  const iKey = `i:${budget.name}:${ip}`;
  const guarded = `INSERT INTO login_attempts (key, at) SELECT ?1, ?2 WHERE (SELECT count(*) FROM login_attempts WHERE key = ?1 AND at > ?3) < ?4 RETURNING rowid AS id`;
  const res = await db.batch([
    db.prepare(guarded).bind(sKey, at, since, budget.perKey),
    db.prepare(guarded).bind(iKey, at, since, budget.perIp),
    // opportunistic cleanup keeps the table small
    db.prepare(`DELETE FROM login_attempts WHERE at < ?1`).bind(at - 2 * WINDOW_MS),
  ]);
  const sId = (res[0].results[0] as { id: number } | undefined)?.id;
  const iId = (res[1].results[0] as { id: number } | undefined)?.id;
  const ok = sId !== undefined && iId !== undefined;
  if (!ok) {
    // Admitted by one counter only: give that row back so a refused request leaves no trace.
    const strays = [sId, iId].filter((x): x is number => x !== undefined);
    for (const id of strays)
      await db.prepare(`DELETE FROM login_attempts WHERE rowid = ?1`).bind(id).run();
  }
  return {
    ok,
    async succeeded() {
      await db.batch([
        db.prepare(`DELETE FROM login_attempts WHERE key = ?1`).bind(sKey),
        ...(iId !== undefined
          ? [db.prepare(`DELETE FROM login_attempts WHERE rowid = ?1`).bind(iId)]
          : []),
      ]);
    },
  };
}
