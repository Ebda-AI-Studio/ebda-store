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
 *
 * ACCOUNT-GUESS BUDGETS (`brake: true`: password sign-in and emailed-code guesses, the two keyed by an email ANYONE can type) DO NOT LOCK THE ACCOUNT (M-066, Ruling M066-1).
 * The old per-subject lock let anyone type 5 wrong passwords against a victim's email and lock the victim out. Now:
 *   - the hard refusal is per (account, client IP) pair: an attacker locks only their own address out of that account;
 *   - the per-IP budget still bounds one address across all accounts;
 *   - the account as a whole is never refused. Instead every attempt on an account that has seen more than
 *     BRAKE_FREE attempts in the window waits a progressive delay (250 ms doubling, capped) BEFORE the guarded work
 *     runs, which caps how fast a distributed guesser can learn anything while the victim's own sign-in only gets slower.
 * The Store used an AuthState Durable Object for this; D1 is enough for identity volume (Ruling ID-7) and a Durable
 * Object is the drop-in upgrade.
 */
export const WINDOW_MS = 15 * 60_000;
/** The longest window any budget uses: the opportunistic cleanup keeps rows for twice this, so a long-window budget is never trimmed by a short one. */
export const MAX_WINDOW_MS = 60 * 60_000;

export interface Budget {
  /** Namespace: separates this budget's counters from every other budget's. */
  name: string;
  /** Attempts allowed per subject key in the window. */
  perKey: number;
  /** Attempts allowed per client IP in the window (failures and in-flight only; successes are refunded). */
  perIp: number;
  /** Window for this budget (default 15 min, at most MAX_WINDOW_MS). */
  windowMs?: number;
  /** Account-guess budget: lock per (key, IP) pair, never per key, plus a progressive delay on the whole account. */
  brake?: boolean;
}

/** Attempts on one account in the window that run at full speed before the progressive delay starts. */
export const BRAKE_FREE = 5;
/** First delay step and its cap, ms. Tests shrink both (setBrakeBaseMs) so a burst finishes quickly. */
let brakeBaseMs = 250;
const BRAKE_CAP_FACTOR = 80; // 250 ms * 80 = 20 s
export function setBrakeBaseMs(ms: number): void {
  brakeBaseMs = ms;
}
/** Delay for the n-th attempt on an account in the window: 0 up to BRAKE_FREE, then base * 2^(n - BRAKE_FREE - 1), capped. */
export function brakeDelayMs(n: number, base: number = brakeBaseMs): number {
  if (n <= BRAKE_FREE) return 0;
  return Math.min(base * BRAKE_CAP_FACTOR, base * 2 ** (n - BRAKE_FREE - 1));
}

export const LOGIN: Budget = { name: 'login', perKey: 5, perIp: 60, brake: true };
export const SECOND_FACTOR: Budget = { name: 'mfa', perKey: 5, perIp: 60 };
export const CODE_GUESS: Budget = { name: 'code', perKey: 5, perIp: 60, brake: true };
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
  const since = at - Math.min(budget.windowMs ?? WINDOW_MS, MAX_WINDOW_MS);
  // A brake budget locks per (key, ip) pair; every other budget keeps its per-key counter.
  const sKey = budget.brake ? `s:${budget.name}:${key}|${ip}` : `s:${budget.name}:${key}`;
  const aKey = `a:${budget.name}:${key}`;
  const iKey = `i:${budget.name}:${ip}`;
  const guarded = `INSERT INTO login_attempts (key, at) SELECT ?1, ?2 WHERE (SELECT count(*) FROM login_attempts WHERE key = ?1 AND at > ?3) < ?4 RETURNING rowid AS id`;
  // A counter with no limit (MAX) is not kept at all: it would only grow into one hot global key under a flood.
  const skipKey = budget.perKey === Number.MAX_SAFE_INTEGER;
  const skipIp = budget.perIp === Number.MAX_SAFE_INTEGER;
  const res = await db.batch([
    db
      .prepare(skipKey ? `SELECT NULL AS id WHERE 0` : guarded)
      .bind(...(skipKey ? [] : [sKey, at, since, budget.perKey])),
    db
      .prepare(skipIp ? `SELECT NULL AS id WHERE 0` : guarded)
      .bind(...(skipIp ? [] : [iKey, at, since, budget.perIp])),
    // opportunistic cleanup keeps the table small
    db.prepare(`DELETE FROM login_attempts WHERE at < ?1`).bind(at - 2 * MAX_WINDOW_MS),
  ]);
  const sId = (res[0].results[0] as { id: number } | undefined)?.id;
  const iId = (res[1].results[0] as { id: number } | undefined)?.id;
  const ok = (skipKey || sId !== undefined) && (skipIp || iId !== undefined);
  if (!ok) {
    // Admitted by one counter only: give that row back so a refused request leaves no trace.
    const strays = [sId, iId].filter((x): x is number => x !== undefined);
    for (const id of strays)
      await db.prepare(`DELETE FROM login_attempts WHERE rowid = ?1`).bind(id).run();
  }
  if (ok && budget.brake) {
    // The account-wide tally: counted, never a refusal. A busy account is only slowed, not locked.
    await db.prepare(`INSERT INTO login_attempts (key, at) VALUES (?1, ?2)`).bind(aKey, at).run();
    const c = await db
      .prepare(`SELECT count(*) AS n FROM login_attempts WHERE key = ?1 AND at > ?2`)
      .bind(aKey, since)
      .first<{ n: number }>();
    const delay = brakeDelayMs(c?.n ?? 0);
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
  }
  return {
    ok,
    async succeeded() {
      await db.batch([
        db.prepare(`DELETE FROM login_attempts WHERE key = ?1`).bind(sKey),
        ...(budget.brake
          ? [db.prepare(`DELETE FROM login_attempts WHERE key = ?1`).bind(aKey)]
          : []),
        ...(iId !== undefined
          ? [db.prepare(`DELETE FROM login_attempts WHERE rowid = ?1`).bind(iId)]
          : []),
      ]);
    },
  };
}

/** Seconds until the oldest counted attempt of `key` (a budget's subject key) leaves its window; at least 1. */
export async function retryAfterSeconds(
  db: D1Database,
  budget: Budget,
  key: string
): Promise<number> {
  const windowMs = Math.min(budget.windowMs ?? WINDOW_MS, MAX_WINDOW_MS);
  const row = await db
    .prepare(`SELECT min(at) AS oldest FROM login_attempts WHERE key = ?1 AND at > ?2`)
    .bind(`s:${budget.name}:${key}`, Date.now() - windowMs)
    .first<{ oldest: number | null }>();
  if (!row?.oldest) return 60;
  return Math.max(1, Math.ceil((row.oldest + windowMs - Date.now()) / 1000));
}
