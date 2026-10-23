// Leased Prisma clients for Cloudflare Workers (SP4 Stage 2).
//
// What is shared and what is not, with the evidence (docs/ebda/design/stage2-workers-db.md):
//   - The wasm query compiler INSTANCE is already one per isolate: Prisma caches it per provider
//     (`loadQueryCompiler`). What a PrismaClient adds is its engine: a QueryCompiler object holding
//     the parsed datamodel (~3.3 MB) and a request DataLoader.
//   - Stage 1 built that engine for EVERY request and threw it away. This pool builds it once per
//     client and REUSES it: a request leases a client, runs on it, returns it. At most `max` clients
//     exist per isolate; they are created lazily and kept.
//   - The pg connection stays per request (workerd forbids a socket crossing requests): each lease
//     gets a fresh `ConnectionScope` (a pg pool of one, opened on first query, ended at release).
//
// Why NOT one client for every concurrent request (tried first, measured): Prisma's DataLoader
// batches calls made in the same microtask turn and dispatches the batch from `process.nextTick`,
// which workerd implements with `queueMicrotask`. Two requests that call Prisma in the same turn
// therefore have the second one's query executed from the first one's async context. workerd
// rejects using request B's socket from request A's context ("Cannot call this AsyncLocalStorage
// bound function outside of the request in which it was created"), and for a pg socket it does so
// silently: the write is lost and the query never answers. 5 of 40 concurrent transactions hung
// (a pool of 8 server connections then starved). One client per concurrent request has no shared
// DataLoader, so it cannot happen; reuse across SEQUENTIAL requests is safe.
import type {
  ConnectionInfo,
  IsolationLevel,
  SqlDriverAdapter,
  SqlDriverAdapterFactory,
  SqlQuery,
  SqlResultSet,
  Transaction,
} from '@prisma/driver-adapter-utils';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { createPrismaClientWithAdapter, resolvePoolConfig, TextFallbackClient } from './client';
import type { AppPrismaClient, CreatePrismaClientOptions } from './client';

/** One request's connections: a small pg pool (see `connectionsPerRequest`), built on first use, ended at close. */
export class ConnectionScope {
  private adapter: Promise<SqlDriverAdapter> | undefined;
  private closed = false;
  /** 1 once this scope opened its pool, else 0 (a request that never queries opens nothing). */
  opened = 0;
  readonly id = ++scopeSeq;

  constructor(
    private readonly connectionString: string,
    private readonly onPoolError: (err: Error) => void,
    private readonly maxConnections: number
  ) {}

  get(): Promise<SqlDriverAdapter> {
    if (this.closed) {
      return Promise.reject(new Error('database connection scope is closed (request has ended)'));
    }
    this.adapter ??= (async () => {
      this.opened++;
      const pool = new pg.Pool({
        ...resolvePoolConfig(this.connectionString, this.maxConnections),
        Client: TextFallbackClient,
      });
      return new PrismaPg(pool, {
        disposeExternalPool: true,
        onPoolError: this.onPoolError,
      }).connect();
    })();
    return this.adapter;
  }

  /** End this request's pool. Safe to call twice, and when the pool was never opened. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const adapter = this.adapter;
    if (!adapter) return;
    try {
      await (await adapter).dispose();
    } catch {
      // A failing close must not fail the request's release path.
    }
  }
}

let scopeSeq = 0;

/**
 * The driver adapter a pooled client owns. It has no socket of its own: while a request holds the
 * lease, every call goes to that request's `ConnectionScope`. Outside a lease it refuses, so a
 * stray query (a module-load call, a timer) can never borrow another request's connection.
 */
class LeasedAdapter implements SqlDriverAdapter {
  readonly provider = 'postgres' as const;
  readonly adapterName = '@prisma/adapter-pg (leased)';
  scope: ConnectionScope | undefined;

  constructor(private readonly onError?: (err: Error, op: string) => void) {}

  /**
   * Prisma replaces an adapter's error with `PrismaClientUnknownRequestError(message)` and drops
   * the stack. A RangeError (`Invalid array buffer length`, incident 2026-10-22) is therefore
   * reported here, where the original stack still exists, then rethrown unchanged.
   */
  private async guard<T>(op: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof RangeError) {
        try {
          this.onError?.(err, op);
        } catch {
          // reporting must never change the query's outcome
        }
      }
      throw err;
    }
  }

  private current(): Promise<SqlDriverAdapter> {
    if (!this.scope) {
      return Promise.reject(
        new Error(
          'database query outside a request lease: on Workers every query must run inside ' +
            'IsolateDb.run() (a socket cannot outlive or cross requests)'
        )
      );
    }
    return this.scope.get();
  }
  /** Queries inside an interactive transaction go to the Transaction object, not to the adapter. */
  private guardTransaction(tx: Transaction): Transaction {
    return new Proxy(tx, {
      get: (target, prop, recv) => {
        const v = Reflect.get(target, prop, recv);
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => {
          const r = (v as (...a: unknown[]) => unknown).apply(target, args);
          return r instanceof Promise ? this.guard(`tx.${String(prop)}`, () => r) : r;
        };
      },
    });
  }
  queryRaw(q: SqlQuery): Promise<SqlResultSet> {
    return this.guard('queryRaw', async () => (await this.current()).queryRaw(q));
  }
  executeRaw(q: SqlQuery): Promise<number> {
    return this.guard('executeRaw', async () => (await this.current()).executeRaw(q));
  }
  executeScript(script: string): Promise<void> {
    return this.guard('executeScript', async () => (await this.current()).executeScript(script));
  }
  // The pg adapter's Transaction is bound to the scope's single connection for its whole life.
  startTransaction(level?: IsolationLevel): Promise<Transaction> {
    return this.guard('startTransaction', async () =>
      this.guardTransaction(await (await this.current()).startTransaction(level))
    );
  }
  getConnectionInfo(): ConnectionInfo {
    return { supportsRelationJoins: true };
  }
  async dispose(): Promise<void> {}
}

export interface ClientLease {
  readonly client: AppPrismaClient;
  readonly scope: ConnectionScope;
  /**
   * True until the lease is released. Code that outlives its request (a floating promise) must not
   * reach the pooled client any more: it would run on the NEXT request's connection.
   */
  readonly live: boolean;
  /** Return the client to the pool and end the request's connection. Idempotent. */
  release(): Promise<void>;
}

/**
 * Whether a client has no Prisma request half-dispatched. Prisma's request DataLoader schedules its
 * dispatch with `process.nextTick` (a microtask in workerd) and keeps `tickActive` true until it
 * runs. A Prisma call made after its request's context has ended (a floating promise) can lose
 * that microtask: `tickActive` then stays true for the life of the client and every later batched
 * query on it (all queries inside an interactive transaction) hangs forever. Seen on the buy-flow
 * parity run: `register` left one on its client, the next `login` hung. A client in that state is
 * dropped, not reused. Reads Prisma internals defensively: if they move, the client counts as
 * clean (the lease guard in `request-db.ts` is the primary defence, this is the backstop).
 */
export function hasStuckDispatch(client: unknown): boolean {
  try {
    const loader = (client as { _requestHandler?: { dataloader?: unknown } })._requestHandler
      ?.dataloader as { tickActive?: boolean; batches?: Record<string, unknown> } | undefined;
    if (!loader) return false;
    return loader.tickActive === true || Object.keys(loader.batches ?? {}).length > 0;
  } catch {
    return false;
  }
}

/** Thrown by `acquire` when no client freed up within `maxWaitMs` or the queue is full: shed load, do not queue forever. */
export class ClientPoolTimeout extends Error {
  constructor(ms: number) {
    super(
      ms > 0 ? `no database client available within ${ms} ms` : 'database client queue is full'
    );
    this.name = 'ClientPoolTimeout';
  }
}

interface Waiter {
  resolve: (slot: Slot) => void;
  since: number;
  /** Set when its request aborted: skipped, never handed a slot. */
  dead?: boolean;
}

interface Slot {
  client: AppPrismaClient;
  adapter: LeasedAdapter;
}

export interface ClientPoolOptions {
  connectionString: string;
  /**
   * Clients (engines, ~3.3 MB each) per isolate; concurrent requests beyond this wait. Default 6.
   * Locally (no network latency) 4 and 8 drain a burst in the same time because the isolate is CPU
   * bound; in production it is not: median CPU is 9 ms of a 720 ms request (measured 2026-10-22,
   * workersInvocationsAdaptive), so the pool, not the CPU, capped an isolate at ~5 requests/s. 6
   * clients cost ~6.6 MB of the 128 MB isolate and hold at most 18 pooler connections.
   */
  max?: number;
  /**
   * Requests that may wait for a client at once; the next is refused immediately (`ClientPoolTimeout`).
   * Default `5 * max`. Why: a client is held ~0.7 s per request (a request is ~9 ms of CPU, the
   * rest is waiting on Hyperdrive and Durable Objects), so the queue drains at ~`max` requests per
   * second per isolate and `5 * max` waiters is already a ~5 s wait. Beyond that the caller has
   * gone (incident 2026-10-22: 15% of requests were abandoned while waiting) and every waiter
   * keeps its request's memory alive in a 128 MB isolate.
   */
  maxQueue?: number;
  /**
   * pg connections one request may hold at once. Default 3. NOT 1: the API deliberately opens a
   * second, separate transaction while the request's tenant transaction is open (`withMoneyTx`
   * inside `runInTenantContext`, the nested-transaction registry in
   * tests/unit/nested-transaction-registry.test.ts). With one connection that deadlocks until
   * pg's connect timeout (Stage 2 parity run: the order-refunded fan-out failed with "timeout
   * exceeded when trying to connect"). The connections are sockets to the pooler, not server
   * connections: Hyperdrive / pgbouncer only assign one while a transaction is open.
   */
  connectionsPerRequest?: number;
  /** How long a request waits for a client before `ClientPoolTimeout`. Default 6 000 ms (was 20 000: p99 sat on exactly that). */
  maxWaitMs?: number;
  /**
   * A lease held longer than this is presumed to belong to a CANCELLED request and stops counting
   * against `max` when a client is needed. Default 30 000 ms (the request transaction's own limit; a reclaimed
   * but still-live request keeps its engine and sockets, so a shorter limit lets the real engine
   * count exceed `max`).
   */
  staleLeaseMs?: number;
  /** Clock, for tests. */
  now?: () => number;
  log?: CreatePrismaClientOptions['log'];
  onPoolError?: (err: Error) => void;
  /** A RangeError thrown under a lease, with the operation and the pool state (diagnostics). */
  onAdapterError?: (err: Error, op: string, stats: ReturnType<ClientPool['stats']>) => void;
}

export class ClientPool {
  readonly max: number;
  readonly maxWaitMs: number;
  readonly staleLeaseMs: number;
  readonly maxQueue: number;
  private readonly now: () => number;
  private readonly idle: Slot[] = [];
  private readonly waiters: Waiter[] = [];
  /** Every client handed out (to a lease or to a waiter), with when: what a stale check reads. */
  private readonly out = new Map<Slot, number>();
  private created = 0;
  private discarded = 0;
  private abandoned = 0;
  private shed = 0;

  constructor(private readonly opts: ClientPoolOptions) {
    this.max = Math.max(1, opts.max ?? 6);
    this.maxWaitMs = opts.maxWaitMs ?? 6_000;
    this.staleLeaseMs = opts.staleLeaseMs ?? 30_000;
    this.maxQueue = Math.max(0, opts.maxQueue ?? this.max * 5);
    this.now = opts.now ?? Date.now;
  }

  /**
   * Clients built so far and not abandoned (never exceeds `max`), held now, idle, requests waiting,
   * clients dropped for a lost dispatch, and leases abandoned as stale (cancelled requests).
   */
  stats(): {
    created: number;
    leased: number;
    idle: number;
    waiting: number;
    max: number;
    discarded: number;
    abandoned: number;
    shed: number;
  } {
    return {
      shed: this.shed,
      discarded: this.discarded,
      abandoned: this.abandoned,
      created: this.created,
      leased: this.out.size,
      idle: this.idle.length,
      waiting: this.waiters.length,
      max: this.max,
    };
  }

  private build(): Slot {
    const adapter = new LeasedAdapter((err, op) =>
      this.opts.onAdapterError?.(err, op, this.stats())
    );
    const factory: SqlDriverAdapterFactory = {
      provider: 'postgres',
      adapterName: adapter.adapterName,
      connect: async () => adapter,
    };
    this.created++;
    return { adapter, client: createPrismaClientWithAdapter(factory, this.opts.log) };
  }

  /** Stop counting leases older than `staleLeaseMs` (see the option). */
  private reclaimStale(): void {
    const cutoff = this.now() - this.staleLeaseMs;
    for (const [slot, since] of this.out) {
      if (since > cutoff) continue;
      this.out.delete(slot);
      this.created--;
      this.abandoned++;
    }
  }

  /** An idle client, a new one under `max`, or (at capacity) one freed by reclaiming stale leases. */
  private take(): Slot | undefined {
    let slot = this.idle.pop();
    if (!slot && this.created >= this.max) this.reclaimStale();
    if (!slot && this.created < this.max) slot = this.build();
    if (slot) this.out.set(slot, this.now());
    return slot;
  }

  /**
   * Give a client (or, with none, the capacity to build one) to the oldest LIVE waiter, else idle
   * it. A waiter older than `maxWaitMs` is dead: a live one has already timed out and left the
   * queue, so one still here belongs to a cancelled request whose timer will never fire.
   */
  private handBack(back: Slot | undefined): void {
    const cutoff = this.now() - this.maxWaitMs;
    while (this.waiters.length > 0) {
      const w = this.waiters[0];
      if (w.dead || w.since < cutoff) {
        this.waiters.shift();
        continue;
      }
      const slot = back ?? (this.created < this.max ? this.build() : undefined);
      if (!slot) return;
      this.waiters.shift();
      this.out.set(slot, this.now());
      w.resolve(slot);
      return;
    }
    if (back) this.idle.push(back);
  }

  /** Drop waiters that can no longer be served (aborted, or older than maxWaitMs: their timer never fired). */
  private pruneDeadWaiters(): void {
    const cutoff = this.now() - this.maxWaitMs;
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i];
      if (w.dead || w.since < cutoff) this.waiters.splice(i, 1);
    }
  }

  /** `signal`: the request's abort signal. An aborted waiter leaves the queue at once. */
  async acquire(signal?: AbortSignal): Promise<ClientLease> {
    let slot = this.take();
    if (!slot) {
      this.pruneDeadWaiters();
      if (signal?.aborted) throw new ClientPoolTimeout(0, true);
      if (this.waiters.length >= this.maxQueue) {
        this.shed++;
        throw new ClientPoolTimeout(0, true);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let waiter: Waiter | undefined;
      let onAbort: (() => void) | undefined;
      try {
        slot = await new Promise<Slot>((resolve, reject) => {
          waiter = { resolve, since: this.now() };
          this.waiters.push(waiter);
          if (signal) {
            onAbort = () => {
              if (waiter) waiter.dead = true;
              const i = waiter ? this.waiters.indexOf(waiter) : -1;
              if (i >= 0) this.waiters.splice(i, 1);
              reject(new ClientPoolTimeout(0, true));
            };
            signal.addEventListener('abort', onAbort, { once: true });
          }
          timer = setTimeout(() => {
            const i = waiter ? this.waiters.indexOf(waiter) : -1;
            if (i >= 0) this.waiters.splice(i, 1);
            // The lease we waited on may have gone stale meanwhile (a cancelled request).
            const late = this.take();
            if (late) resolve(late);
            else {
              this.shed++;
              reject(new ClientPoolTimeout(this.maxWaitMs));
            }
          }, this.maxWaitMs);
        });
      } finally {
        clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      }
    }
    const scope = new ConnectionScope(
      this.opts.connectionString,
      this.opts.onPoolError ?? (() => undefined),
      Math.max(1, this.opts.connectionsPerRequest ?? 3)
    );
    const held = slot;
    held.adapter.scope = scope;
    let released = false;
    return {
      client: held.client,
      scope,
      get live() {
        return !released;
      },
      release: async () => {
        if (released) return;
        released = true;
        // Unbind first: from here no query can reach the connection that is about to close.
        held.adapter.scope = undefined;
        await scope.close();
        if (!this.out.delete(held)) {
          // Abandoned as stale while this (slow, not dead) request still held it: the pool has
          // already replaced it, so it is not handed out again.
          void held.client.$disconnect().catch(() => undefined);
          return;
        }
        let back: Slot | undefined = held;
        if (hasStuckDispatch(held.client)) {
          // Never hand a client with a lost dispatch to the next request.
          this.discarded++;
          this.created--;
          void held.client.$disconnect().catch(() => undefined);
          back = undefined;
        }
        this.handBack(back);
      },
    };
  }
}
