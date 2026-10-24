/**
 * JobGate: the two things Inngest gave a function that Workflows / Queues do not (G5).
 *
 *  - Concurrency: `acquire(limit, ttlMs)` hands out at most `limit` live leases per gate (one gate
 *    per function + key, e.g. `bulk-ai-seo|<storeId>`). A lease that is never released (the
 *    instance died) expires after its TTL, so a crash cannot wedge a store forever.
 *  - Debounce: `touch()` records "this is the latest event"; after the quiet period the run asks
 *    `isLatest(token)` and only the newest event proceeds (a stream longer than `timeoutMs`
 *    still gets one run).
 * One DO instance per gate id; a DO is single-threaded, so both are race-free.
 */
import { DurableObject } from 'cloudflare:workers';

export class JobGate extends DurableObject {
  private init(): void {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS leases (token TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)`
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS debounce (id INTEGER PRIMARY KEY CHECK (id = 1), latest TEXT NOT NULL, first_at INTEGER NOT NULL)`
    );
  }

  /** A lease token, or null when `limit` leases are already live. */
  async acquire(limit: number, ttlMs: number): Promise<string | null> {
    this.init();
    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec(`DELETE FROM leases WHERE expires_at <= ?`, now);
      const live = Number(sql.exec(`SELECT COUNT(*) AS n FROM leases`).one().n);
      if (live >= limit) return null;
      const token = crypto.randomUUID();
      sql.exec(`INSERT INTO leases (token, expires_at) VALUES (?, ?)`, token, now + ttlMs);
      return token;
    });
  }

  async release(token: string): Promise<void> {
    this.init();
    this.ctx.storage.sql.exec(`DELETE FROM leases WHERE token = ?`, token);
  }

  /** Register an event as the newest; returns its token. */
  async touch(timeoutMs: number): Promise<string> {
    this.init();
    const now = Date.now();
    const token = crypto.randomUUID();
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const row = sql.exec(`SELECT first_at FROM debounce WHERE id = 1`).toArray()[0];
      // A new burst starts when the previous one is older than the debounce timeout.
      const firstAt = row && now - Number(row.first_at) <= timeoutMs ? Number(row.first_at) : now;
      sql.exec(
        `INSERT INTO debounce (id, latest, first_at) VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET latest = excluded.latest, first_at = excluded.first_at`,
        token,
        firstAt
      );
    });
    return token;
  }

  /** True for the newest token, or for any token once the burst has run past `timeoutMs`. */
  async isLatest(token: string, timeoutMs: number): Promise<boolean> {
    this.init();
    const row = this.ctx.storage.sql
      .exec(`SELECT latest, first_at FROM debounce WHERE id = 1`)
      .toArray()[0];
    if (!row) return true;
    if (row.latest === token) return true;
    return Date.now() - Number(row.first_at) > timeoutMs;
  }
}
