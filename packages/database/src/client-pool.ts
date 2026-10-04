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
  async queryRaw(q: SqlQuery): Promise<SqlResultSet> {
    return (await this.current()).queryRaw(q);
  }
  async executeRaw(q: SqlQuery): Promise<number> {
    return (await this.current()).executeRaw(q);
  }
  async executeScript(script: string): Promise<void> {
    return (await this.current()).executeScript(script);
  }
  // The pg adapter's Transaction is bound to the scope's single connection for its whole life.
  async startTransaction(level?: IsolationLevel): Promise<Transaction> {
    return (await this.current()).startTransaction(level);
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

/** Thrown by `acquire` when no client freed up within `maxWaitMs`: shed load, do not queue forever. */
export class ClientPoolTimeout extends Error {
  constructor(ms: number) {
    super(`no database client available within ${ms} ms`);
    this.name = 'ClientPoolTimeout';
  }
}

interface Slot {
  client: AppPrismaClient;
  adapter: LeasedAdapter;
}

export interface ClientPoolOptions {
  connectionString: string;
  /**
   * Clients (engines, ~3.3 MB each) per isolate; concurrent requests beyond this wait. Default 4:
   * CPU-bound, an isolate gains nothing from more (measured: 4 and 8 drain a 200-request burst in
   * the same time), and each request can hold two server connections (below), so 4 clients need
   * 8 pooler connections at worst.
   */
  max?: number;
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
  /** How long a request waits for a client before `ClientPoolTimeout`. Default 20 000 ms. */
  maxWaitMs?: number;
  log?: CreatePrismaClientOptions['log'];
  onPoolError?: (err: Error) => void;
}

export class ClientPool {
  readonly max: number;
  readonly maxWaitMs: number;
  private readonly idle: Slot[] = [];
  private readonly waiters: Array<(slot: Slot) => void> = [];
  private created = 0;
  private leased = 0;
  private discarded = 0;

  constructor(private readonly opts: ClientPoolOptions) {
    this.max = Math.max(1, opts.max ?? 4);
    this.maxWaitMs = opts.maxWaitMs ?? 20_000;
  }

  /** Clients built so far (never exceeds `max`), leased now, and requests waiting. */
  stats(): {
    created: number;
    leased: number;
    idle: number;
    waiting: number;
    max: number;
    discarded: number;
  } {
    return {
      discarded: this.discarded,
      created: this.created,
      leased: this.leased,
      idle: this.idle.length,
      waiting: this.waiters.length,
      max: this.max,
    };
  }

  private build(): Slot {
    const adapter = new LeasedAdapter();
    const factory: SqlDriverAdapterFactory = {
      provider: 'postgres',
      adapterName: adapter.adapterName,
      connect: async () => adapter,
    };
    this.created++;
    return { adapter, client: createPrismaClientWithAdapter(factory, this.opts.log) };
  }

  async acquire(): Promise<ClientLease> {
    let slot = this.idle.pop();
    if (!slot && this.created < this.max) slot = this.build();
    if (!slot) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let waiter: ((s: Slot) => void) | undefined;
      try {
        slot = await new Promise<Slot>((resolve, reject) => {
          waiter = resolve;
          this.waiters.push(resolve);
          timer = setTimeout(() => reject(new ClientPoolTimeout(this.maxWaitMs)), this.maxWaitMs);
        });
      } catch (err) {
        const i = waiter ? this.waiters.indexOf(waiter) : -1;
        if (i >= 0) this.waiters.splice(i, 1);
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
    this.leased++;
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
        this.leased--;
        let back: Slot | undefined = held;
        if (hasStuckDispatch(held.client)) {
          // Never hand a client with a lost dispatch to the next request.
          this.discarded++;
          this.created--;
          void held.client.$disconnect().catch(() => undefined);
          back = this.waiters.length > 0 ? this.build() : undefined;
        }
        if (!back) return;
        const next = this.waiters.shift();
        if (next) next(back);
        else this.idle.push(back);
      },
    };
  }
}
