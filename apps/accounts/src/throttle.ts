/**
 * Login throttle on D1. Failed attempts are counted per case-folded email AND per client IP in a sliding window.
 * (The Store uses an AuthState Durable Object for this; D1 is enough for the identity service's volume and keeps
 * the Worker free of a second storage system. A Durable Object is the upgrade path if volume ever demands it.)
 */
export const WINDOW_MS = 15 * 60_000;
export const MAX_PER_EMAIL = 5;
export const MAX_PER_IP = 30;

export async function isLocked(db: D1Database, email: string, ip: string): Promise<boolean> {
  const since = Date.now() - WINDOW_MS;
  const rows = await db
    .prepare(
      `SELECT key, count(*) AS n FROM login_attempts WHERE key IN (?1, ?2) AND at > ?3 GROUP BY key`
    )
    .bind(`e:${email}`, `i:${ip}`, since)
    .all<{ key: string; n: number }>();
  for (const r of rows.results) {
    if (r.key.startsWith('e:') && r.n >= MAX_PER_EMAIL) return true;
    if (r.key.startsWith('i:') && r.n >= MAX_PER_IP) return true;
  }
  return false;
}

export async function recordFailure(db: D1Database, email: string, ip: string): Promise<void> {
  const at = Date.now();
  await db.batch([
    db.prepare(`INSERT INTO login_attempts (key, at) VALUES (?1, ?2)`).bind(`e:${email}`, at),
    db.prepare(`INSERT INTO login_attempts (key, at) VALUES (?1, ?2)`).bind(`i:${ip}`, at),
    // opportunistic cleanup keeps the table small
    db.prepare(`DELETE FROM login_attempts WHERE at < ?1`).bind(at - 2 * WINDOW_MS),
  ]);
}

export async function clearEmail(db: D1Database, email: string): Promise<void> {
  await db.prepare(`DELETE FROM login_attempts WHERE key = ?1`).bind(`e:${email}`).run();
}
