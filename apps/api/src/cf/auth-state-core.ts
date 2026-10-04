/**
 * The command engine behind the AuthState Durable Object: the Redis subset the API uses, over a
 * SQLite database. It lives apart from the DO class (which needs `cloudflare:workers`) so the
 * semantics are unit-tested on Node with `node:sqlite`, and again inside workerd on the real DO.
 *
 * Expiry is absolute wall-clock ms; an expired row is invisible to every read and deleted when read.
 */

export type Op = [string, ...unknown[]];

export interface SetOptions {
  /** Time to live in ms; omitted = no expiry. */
  ttlMs?: number;
  nx?: boolean;
  xx?: boolean;
  /** Keep the existing TTL (Redis KEEPTTL). */
  keepTtl?: boolean;
}

/** The slice of Durable Object SQL storage the engine needs (also satisfied by a node:sqlite shim). */
export interface SqlLike {
  exec(
    query: string,
    ...bindings: unknown[]
  ): {
    toArray(): Array<Record<string, unknown>>;
    one(): Record<string, unknown>;
    rowsWritten: number;
  };
}

/** Commands that write expiring rows: the DO schedules its purge alarm after these. */
export const WRITE_COMMANDS = new Set(['set', 'incr', 'decr', 'hit', 'expire', 'reserveSlot']);

export class AuthStateStore {
  constructor(private readonly sql: SqlLike) {
    sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER)`);
    sql.exec(
      `CREATE TABLE IF NOT EXISTS lst (seq INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT NOT NULL, v TEXT NOT NULL)`
    );
    sql.exec(`CREATE INDEX IF NOT EXISTS lst_k ON lst (k, seq)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS kv_exp ON kv (exp)`);
  }

  /** Delete expired rows; true if any expiring rows remain (the caller reschedules its alarm). */
  purge(now: number): boolean {
    this.sql.exec(`DELETE FROM kv WHERE exp IS NOT NULL AND exp <= ?`, now);
    return (
      this.sql.exec(`SELECT 1 AS n FROM kv WHERE exp IS NOT NULL LIMIT 1`).toArray().length > 0
    );
  }

  private row(k: string, now: number): { v: string; exp: number | null } | null {
    const r = this.sql.exec(`SELECT v, exp FROM kv WHERE k = ?`, k).toArray()[0];
    if (!r) return null;
    const exp = r.exp as number | null;
    if (exp !== null && exp <= now) {
      this.sql.exec(`DELETE FROM kv WHERE k = ?`, k);
      return null;
    }
    return { v: r.v as string, exp };
  }

  private put(k: string, v: string, exp: number | null): void {
    this.sql.exec(
      `INSERT INTO kv (k, v, exp) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp`,
      k,
      v,
      exp
    );
  }

  run(op: Op, now: number): unknown {
    const sql = this.sql;
    const [cmd, ...a] = op;
    switch (cmd) {
      case 'get':
        return this.row(a[0] as string, now)?.v ?? null;
      case 'set': {
        const [k, v, o = {}] = a as [string, string, SetOptions?];
        const cur = this.row(k, now);
        if (o.nx && cur) return null;
        if (o.xx && !cur) return null;
        const exp = o.keepTtl && cur ? cur.exp : o.ttlMs !== undefined ? now + o.ttlMs : null;
        this.put(k, v, exp);
        return 'OK';
      }
      case 'del': {
        let n = 0;
        for (const k of a as string[]) {
          if (this.row(k, now)) n++;
          sql.exec(`DELETE FROM kv WHERE k = ?`, k);
          const l = sql.exec(`DELETE FROM lst WHERE k = ?`, k).rowsWritten;
          if (l > 0) n++;
        }
        return n;
      }
      case 'exists': {
        let n = 0;
        for (const k of a as string[]) {
          if (this.row(k, now) || this.listLen(k) > 0) n++;
        }
        return n;
      }
      case 'expire': {
        const [k, ttlMs] = a as [string, number];
        const cur = this.row(k, now);
        if (!cur) return 0;
        sql.exec(`UPDATE kv SET exp = ? WHERE k = ?`, now + ttlMs, k);
        return 1;
      }
      case 'pttl': {
        const cur = this.row(a[0] as string, now);
        if (!cur) return -2;
        return cur.exp === null ? -1 : cur.exp - now;
      }
      case 'incr':
      case 'decr': {
        const k = a[0] as string;
        const cur = this.row(k, now);
        const n = (cur ? Number(cur.v) : 0) + (cmd === 'incr' ? 1 : -1);
        if (!Number.isFinite(n)) throw new Error('ERR value is not an integer or out of range');
        this.put(k, String(n), cur ? cur.exp : null);
        return n;
      }
      case 'hit': {
        // Fixed-window counter for the rate-limit store: [count, resetAtMs].
        const [k, windowMs] = a as [string, number];
        const cur = this.row(k, now);
        if (!cur) {
          this.put(k, '1', now + windowMs);
          return [1, now + windowMs];
        }
        const n = Number(cur.v) + 1;
        this.put(k, String(n), cur.exp);
        return [n, cur.exp ?? now + windowMs];
      }
      case 'unhit': {
        const k = a[0] as string;
        const cur = this.row(k, now);
        if (cur) this.put(k, String(Math.max(0, Number(cur.v) - 1)), cur.exp);
        return null;
      }
      case 'scan': {
        // Keys starting with the prefix (live only), for deleteByPattern-style sweeps.
        const prefix = a[0] as string;
        const rows = sql
          .exec(
            `SELECT k FROM kv WHERE substr(k, 1, ?) = ? AND (exp IS NULL OR exp > ?) ORDER BY k LIMIT 1000`,
            prefix.length,
            prefix,
            now
          )
          .toArray();
        return rows.map(r => r.k as string);
      }
      case 'lpush': {
        const [k, ...vs] = a as string[];
        for (const v of vs) sql.exec(`INSERT INTO lst (k, v) VALUES (?, ?)`, k, v);
        return this.listLen(k);
      }
      case 'rpop': {
        const k = a[0] as string;
        const r = sql
          .exec(`SELECT seq, v FROM lst WHERE k = ? ORDER BY seq ASC LIMIT 1`, k)
          .toArray()[0];
        if (!r) return null;
        sql.exec(`DELETE FROM lst WHERE seq = ?`, r.seq);
        return r.v as string;
      }
      case 'llen':
        return this.listLen(a[0] as string);
      case 'lrange': {
        const [k, start, stop] = a as [string, number, number];
        const len = this.listLen(k);
        const s = start < 0 ? Math.max(0, len + start) : start;
        const e = stop < 0 ? len + stop : Math.min(stop, len - 1);
        if (e < s) return [];
        return sql
          .exec(`SELECT v FROM lst WHERE k = ? ORDER BY seq DESC LIMIT ? OFFSET ?`, k, e - s + 1, s)
          .toArray()
          .map(r => r.v as string);
      }
      case 'ltrim': {
        // Keep elements start..stop (head = newest), drop the rest.
        const [k, start, stop] = a as [string, number, number];
        const len = this.listLen(k);
        const s = start < 0 ? Math.max(0, len + start) : start;
        const e = stop < 0 ? len + stop : Math.min(stop, len - 1);
        if (e < s) {
          sql.exec(`DELETE FROM lst WHERE k = ?`, k);
          return 'OK';
        }
        sql.exec(
          `DELETE FROM lst WHERE k = ? AND seq NOT IN (SELECT seq FROM lst WHERE k = ? ORDER BY seq DESC LIMIT ? OFFSET ?)`,
          k,
          k,
          e - s + 1,
          s
        );
        return 'OK';
      }
      // Port of leader-election's compare-and-delete Lua.
      case 'delIfEquals': {
        const [k, v] = a as [string, string];
        const cur = this.row(k, now);
        if (cur && cur.v === v) {
          sql.exec(`DELETE FROM kv WHERE k = ?`, k);
          return 1;
        }
        return 0;
      }
      // Port of campaign-send-pacer's RESERVE_SLOT_LUA: [waitMs, reserved].
      case 'reserveSlot': {
        const [k, intervalMs, ttlMs, maxWaitMs] = a as [string, number, number, number];
        const cur = this.row(k, now);
        const slot = Math.max(now, cur ? Number(cur.v) : 0);
        if (maxWaitMs >= 0 && slot - now > maxWaitMs) return [slot - now, 0];
        this.put(k, String(slot + intervalMs), now + ttlMs);
        return [slot - now, 1];
      }
      default:
        throw new Error(`AuthState: unknown command ${String(cmd)}`);
    }
  }

  private listLen(k: string): number {
    return Number(this.sql.exec(`SELECT COUNT(*) AS n FROM lst WHERE k = ?`, k).one().n);
  }
}
