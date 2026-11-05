// Which PrismaClient the exported `prisma` talks to (R-EBDA-001, SP4 Stage 1a).
//
//   - A request-bound client, when `runWithRequestDb` is on the async stack.
//     Cloudflare Workers: one client per request, pool `max: 1`, disconnected
//     after the response through `ctx.waitUntil`. workerd cannot share a socket
//     between requests, so a module-global client is not an option there.
//   - Otherwise a lazily created PROCESS SINGLETON (Node: the Express API, the
//     Inngest functions, vitest, scripts). Same behaviour as before this file.
//
// This is deliberately separate from Ebda's tenant-context AsyncLocalStorage in
// `index.ts` (`tenantStorage`, `storeScope`): that one carries an open
// TRANSACTION client for the request's RLS scope; this one carries the CLIENT
// the transaction is opened on. The two nest: the request transaction is begun
// on the request-bound client.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createPrismaClient, type AppPrismaClient } from './client';
import { ClientPool, type ClientLease, type ClientPoolOptions } from './client-pool';

interface RequestDb {
  /** A pooled client's getter refuses once its lease is released (see `createIsolateDb`). */
  readonly client: AppPrismaClient;
}

const requestDb = new AsyncLocalStorage<RequestDb>();

/**
 * The process singleton is kept on `globalThis.prisma`: the integration setup
 * (`tests/setup-e2e.ts`) disconnects and clears it so a suite re-initialises
 * against the DATABASE_URL it resolved, and a dev server reload must not leak
 * a pool per reload.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: AppPrismaClient | undefined;
};

/** The Node process-wide client, created on first use (never at import time). */
export function getProcessClient(): AppPrismaClient {
  const existing = globalForPrisma.prisma;
  if (existing) return existing;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set: the process Prisma client cannot be created. ' +
        'A Worker binds one per request with runWithRequestDb().'
    );
  }
  const client = createPrismaClient({ connectionString: url });
  globalForPrisma.prisma = client;
  return client;
}

// Test/diagnostic only (the Worker enables it under DEV_STATS=1, never in a deployed Worker): every access to the Postgres
// client is counted with the first frames of its stack, so a dead-Postgres sweep can assert that NOTHING reached it.
let trackReaches = false;
const reachLabel = new AsyncLocalStorage<string>();
/** Name the work running in `fn` (a cron job) in the reach log. */
export function withReachLabel<T>(label: string, fn: () => T): T {
  return reachLabel.run(label, fn);
}
const reaches: Array<{ at: number; label: string; stack: string }> = [];
export function trackPostgresReaches(on: boolean): void {
  trackReaches = on;
}
export function postgresReaches(
  reset = false
): Array<{ at: number; label: string; stack: string }> {
  const out = reaches.slice();
  if (reset) reaches.length = 0;
  return out;
}

/** The client the exported `prisma` resolves to right now. */
export function baseClient(): AppPrismaClient {
  if (trackReaches && reaches.length < 500)
    reaches.push({
      at: Date.now(),
      label: reachLabel.getStore() ?? '(unlabelled)',
      stack: (new Error().stack ?? '').split('\n').slice(2, 9).join('\n'),
    });
  return requestDb.getStore()?.client ?? getProcessClient();
}

/** Whether a request-bound client is in force on this async context. */
export function hasRequestDb(): boolean {
  return requestDb.getStore() !== undefined;
}

export interface RunWithRequestDbOptions {
  /**
   * Cloudflare's `ctx.waitUntil`. When given, the client is disconnected
   * through it, off the response's latency path. Without it the disconnect is
   * awaited before `runWithRequestDb` resolves (tests, scripts).
   */
  waitUntil?: (p: Promise<unknown>) => void;
  /** The request's abort signal: a request still queued for a client leaves the queue when it aborts. */
  signal?: AbortSignal;
  /**
   * Awaited before the disconnect, inside the same promise. The Worker shell
   * passes the deferred-work drain here: post-commit tasks
   * (`deferAfterTenantCommit`) run on this client and must finish before its
   * pool is closed.
   */
  beforeDisconnect?: () => Promise<unknown>;
}

/**
 * Run `fn` with a request-bound Prisma client. `clientFactory` is called once
 * per request; the Worker shell passes
 * `() => createPrismaClient({ connectionString: env.HYPERDRIVE.connectionString, max: 1 })`.
 *
 * Everything `fn` does through the exported `prisma` (and `runInTenantContext`,
 * `runInStoreScope`, `withStore`, ...) uses that client. Nothing outside `fn`
 * is affected, so two concurrent requests never share a pool or a socket.
 */
export async function runWithRequestDb<T>(
  clientFactory: () => AppPrismaClient,
  fn: () => Promise<T>,
  opts: RunWithRequestDbOptions = {}
): Promise<T> {
  const client = clientFactory();
  try {
    return await requestDb.run({ client }, fn);
  } finally {
    const release = (async () => {
      try {
        await opts.beforeDisconnect?.();
      } catch {
        // A failing drain must not leak the pool.
      }
      await client.$disconnect().catch(() => undefined);
    })();
    if (opts.waitUntil) opts.waitUntil(release);
    else await release;
  }
}

export interface IsolateDbOptions extends ClientPoolOptions {}

export interface IsolateDb {
  /** Like `runWithRequestDb`, but on a pooled, reused client with a per-request connection. */
  run<T>(fn: () => Promise<T>, opts?: RunWithRequestDbOptions): Promise<T>;
  /** The lease of the current async context (tests, diagnostics). */
  currentLease(): ClientLease | undefined;
  stats(): ReturnType<ClientPool['stats']>;
}

/**
 * Cloudflare Workers: build ONCE per isolate. A request leases one of at most `max` Prisma clients
 * (engines are built lazily and reused, not rebuilt per request), runs on it with its own lazily
 * opened pg connection, and returns it after its deferred work has drained. Transactions begin on,
 * and stay pinned to, that connection. See `client-pool.ts` for why clients are not shared by
 * concurrent requests.
 */
export function createIsolateDb(opts: IsolateDbOptions): IsolateDb {
  const pool = new ClientPool(opts);
  const leases = new AsyncLocalStorage<ClientLease>();
  return {
    stats: () => pool.stats(),
    currentLease: () => leases.getStore(),
    run: async (fn, runOpts = {}) => {
      const lease = await pool.acquire(runOpts.signal);
      try {
        // The exported `prisma` resolves its client through this store on EVERY call. Once the lease
        // is released the client belongs to the next request, so a floating promise of this one that
        // reaches for `prisma` late must fail here, not run on someone else's connection.
        const bound: RequestDb = {
          get client() {
            if (!lease.live) {
              throw new Error(
                'database used after its request ended: a promise outlived the response ' +
                  '(await it, or register it with ctx.waitUntil / deferAfterTenantCommit)'
              );
            }
            return lease.client;
          },
        };
        return await leases.run(lease, () => requestDb.run(bound, fn));
      } finally {
        const release = (async () => {
          try {
            await runOpts.beforeDisconnect?.();
          } catch {
            // A failing drain must not leak the connection or the client.
          }
          await lease.release();
        })();
        if (runOpts.waitUntil) runOpts.waitUntil(release);
        else await release;
      }
    },
  };
}
