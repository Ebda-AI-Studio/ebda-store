// Which PrismaClient the exported `prisma` talks to (R-EBDA-001, SP4 Stage 1a).
//
//   - A request-bound client, when `runWithRequestDb` is on the async stack.
//     Cloudflare Workers: one client per request, pool `max: 1`, disconnected
//     after the response through `ctx.waitUntil`. workerd cannot share a socket
//     between requests, so a module-global client is not an option there.
//   - Otherwise a lazily created PROCESS SINGLETON (Node: the Express API, the
//     Inngest functions, vitest, scripts). Same behaviour as before this file.
//
// This is deliberately separate from FWB's tenant-context AsyncLocalStorage in
// `index.ts` (`tenantStorage`, `storeScope`): that one carries an open
// TRANSACTION client for the request's RLS scope; this one carries the CLIENT
// the transaction is opened on. The two nest: the request transaction is begun
// on the request-bound client.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createPrismaClient, type AppPrismaClient } from './client';

interface RequestDb {
  client: AppPrismaClient;
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

/** The client the exported `prisma` resolves to right now. */
export function baseClient(): AppPrismaClient {
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
