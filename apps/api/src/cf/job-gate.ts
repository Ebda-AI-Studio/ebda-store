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

/**
 * Every method takes an optional trailing `nowMs`: a clock override for TESTS (Ruling FLAKE-LEASE-1). Production
 * callers never pass it, so the gate reads the real clock; a test passes a virtual one, so a lease TTL of a few
 * milliseconds is decided by arithmetic, not by how late a loaded runner fires `setTimeout`.
 */
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
  async acquire(limit: number, ttlMs: number, nowMs?: number): Promise<string | null> {
    this.init();
    const now = nowMs ?? Date.now();
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

  /**
   * Fencing: extend a live lease. False means the lease is gone (expired and purged, released, or
   * never held), and the run must stop before touching anything else. A lease that is merely past
   * its expiry but not yet purged is still ours (acquire purges before it counts), so it renews.
   */
  async renew(token: string, ttlMs: number, nowMs?: number): Promise<boolean> {
    this.init();
    const r = this.ctx.storage.sql.exec(
      `UPDATE leases SET expires_at = ? WHERE token = ?`,
      (nowMs ?? Date.now()) + ttlMs,
      token
    );
    return r.rowsWritten > 0;
  }

  async release(token: string): Promise<void> {
    this.init();
    this.ctx.storage.sql.exec(`DELETE FROM leases WHERE token = ?`, token);
  }

  /** Register an event as the newest; returns its token. */
  async touch(timeoutMs: number, nowMs?: number): Promise<string> {
    this.init();
    const now = nowMs ?? Date.now();
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
  async isLatest(token: string, timeoutMs: number, nowMs?: number): Promise<boolean> {
    this.init();
    const row = this.ctx.storage.sql
      .exec(`SELECT latest, first_at FROM debounce WHERE id = 1`)
      .toArray()[0];
    if (!row) return true;
    if (row.latest === token) return true;
    return (nowMs ?? Date.now()) - Number(row.first_at) > timeoutMs;
  }
}
