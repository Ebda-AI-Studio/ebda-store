/**
 * AuthState: the strongly consistent state of the API, as a SQLite-backed Durable Object.
 *
 * R-EBDA-001 / design section 5: the token denylist (`jti`), per-user token versions
 * (`tv`), MFA and lockout counters, CSRF tokens and the auth rate limits must be
 * read-your-writes on EVERY isolate. KV's ~60 s staleness would let a revoked token
 * through, so these live here. One DO instance owns a SHARD of the key space (the
 * client hashes a key to a shard, see ioredis-cf.ts), and a DO is single-threaded, so
 * `apply([...ops])` is atomic: `INCR` then threshold cannot be raced by N parallel
 * guesses, and `SET NX` is a real mutex.
 *
 * The command set is the subset of Redis the API uses (get/set NX|XX|EX|PX/del/exists/
 * expire/incr/decr/pttl/scan, lists for the dead-letter pages, two named scripts) plus
 * `hit`, the fixed-window counter behind the rate-limit store. Expiry is absolute
 * wall-clock ms; expired rows are invisible to every read and purged by an alarm.
 */
import { DurableObject } from 'cloudflare:workers';

export type Op = [string, ...unknown[]];

export interface SetOptions {
  /** Time to live in ms; omitted = no expiry. */
  ttlMs?: number;
  nx?: boolean;
  xx?: boolean;
  /** Keep the existing TTL (Redis KEEPTTL). */
  keepTtl?: boolean;
}

const PURGE_EVERY_MS = 10 * 60 * 1000;

export class AuthState extends DurableObject {
  constructor(ctx: DurableObjectStateLike, env: unknown) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER)`);
    sql.exec(
      `CREATE TABLE IF NOT EXISTS lst (seq INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT NOT NULL, v TEXT NOT NULL)`
    );
    sql.exec(`CREATE INDEX IF NOT EXISTS lst_k ON lst (k, seq)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS kv_exp ON kv (exp)`);
  }

  /** Run `ops` atomically and in order; returns one result per op. */
  async apply(ops: Op[]): Promise<unknown[]> {
    const now = Date.now();
    const out = this.ctx.storage.transactionSync(() => ops.map(op => this.run(op, now)));
    if (ops.some(op => WRITES.has(op[0]))) await this.scheduleAlarm(now);
    return out;
  }

  async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    sql.exec(`DELETE FROM kv WHERE exp IS NOT NULL AND exp <= ?`, Date.now());
    const left = sql.exec(`SELECT 1 AS n FROM kv WHERE exp IS NOT NULL LIMIT 1`).toArray();
    if (left.length > 0) await this.ctx.storage.setAlarm(Date.now() + PURGE_EVERY_MS);
  }

  private async scheduleAlarm(now: number): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(now + PURGE_EVERY_MS);
    }
  }

  // ---------------------------------------------------------------- commands

  private row(k: string, now: number): { v: string; exp: number | null } | null {
    const r = this.ctx.storage.sql.exec(`SELECT v, exp FROM kv WHERE k = ?`, k).toArray()[0];
    if (!r) return null;
    const exp = r.exp as number | null;
    if (exp !== null && exp <= now) {
      this.ctx.storage.sql.exec(`DELETE FROM kv WHERE k = ?`, k);
      return null;
    }
    return { v: r.v as string, exp };
  }

  private put(k: string, v: string, exp: number | null): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO kv (k, v, exp) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp`,
      k,
      v,
      exp
    );
  }

  private run(op: Op, now: number): unknown {
    const sql = this.ctx.storage.sql;
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
    return Number(
      this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM lst WHERE k = ?`, k).one().n
    );
  }
}

const WRITES = new Set(['set', 'incr', 'decr', 'hit', 'expire', 'reserveSlot']);
