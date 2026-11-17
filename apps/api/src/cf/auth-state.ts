/**
 * AuthState: the strongly consistent state of the API, as a SQLite-backed Durable Object.
 *
 * R-EBDA-001 / design section 5: the token denylist (`jti`), per-user token versions
 * (`tv`), MFA and lockout counters, CSRF tokens and the auth rate limits must be
 * read-your-writes on EVERY isolate. KV's ~60 s staleness would let a revoked token
 * through, so these live here. One DO instance owns a SHARD of the key space (the
 * client hashes a key to a shard, see auth-state-client.ts), and a DO is single-threaded,
 * so `apply([...ops])` is atomic: `INCR` then threshold cannot be raced by N parallel
 * guesses, and `SET NX` is a real mutex. The command semantics are in auth-state-core.ts.
 */
import { DurableObject } from 'cloudflare:workers';
import { AuthStateStore, WRITE_COMMANDS, type Op } from './auth-state-core';

export type { Op, SetOptions } from './auth-state-core';

const PURGE_EVERY_MS = 10 * 60 * 1000;

export class AuthState extends DurableObject {
  private readonly store: AuthStateStore;

  constructor(ctx: DurableObjectStateLike, env: unknown) {
    super(ctx, env);
    this.store = new AuthStateStore(ctx.storage.sql);
  }

  /**
   * Run `ops` atomically and in order; returns one result per op. `nowMs` is a clock override for TESTS only
   * (Ruling FLAKE-LEASE-1); production callers (auth-state-client.ts) never pass it.
   */
  async apply(ops: Op[], nowMs?: number): Promise<unknown[]> {
    const now = nowMs ?? Date.now();
    const out = this.ctx.storage.transactionSync(() => ops.map(op => this.store.run(op, now)));
    if (ops.some(op => WRITE_COMMANDS.has(op[0]))) await this.scheduleAlarm(now);
    return out;
  }

  /**
   * Where THIS instance runs (Ruling PERF-AUTHSTATE-1, measurement only): the Cloudflare location code from the edge trace,
   * `null` when it cannot be read. Called only by the flag-gated super-admin echo route (DO_COLO_ECHO); no state is touched.
   */
  async colo(): Promise<string | null> {
    try {
      const r = await fetch('https://www.cloudflare.com/cdn-cgi/trace', {
        signal: AbortSignal.timeout(2_000),
      });
      return /^colo=([A-Z]{3})$/m.exec(await r.text())?.[1] ?? null;
    } catch {
      return null;
    }
  }

  async alarm(): Promise<void> {
    if (this.store.purge(Date.now())) {
      await this.ctx.storage.setAlarm(Date.now() + PURGE_EVERY_MS);
    }
  }

  private async scheduleAlarm(now: number): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(now + PURGE_EVERY_MS);
    }
  }
}
