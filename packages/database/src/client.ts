// The ONE place a PrismaClient is built (R-EBDA-001).
//
// Prisma 6.19.3 with `engineType = "client"` (see schema.prisma) has no native
// engine: the query compiler is wasm, and the database is reached through a
// driver adapter. This factory is the single construction path for every
// runtime:
//   - Node (Express API, vitest, scripts): a process-wide singleton, see
//     `request-db.ts`;
//   - Cloudflare Workers (workerd): one client PER REQUEST with `max: 1`,
//     disconnected through `ctx.waitUntil`, see `runWithRequestDb`.
// workerd forbids reusing an I/O object (socket, stream) created in one request
// from another, and a pg Pool caches sockets, so a module-global client cannot
// work there. Hyperdrive / the pooler holds the real server connections, which
// is what makes a client-per-request cheap (spikes/workers-api/README.md).
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// Options are extracted so the client's TYPE can be derived from them. A global
// `omit` narrows PrismaClient's generic, so a plain `PrismaClient` annotation
// no longer matches what `new PrismaClient(...)` returns. Deriving keeps them in
// lockstep instead of casting the mismatch away.
const prismaOptions = {
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  // Never let User secrets leave the DB layer unless a caller asks by name.
  //
  // Before this, ~46 reads on secret-bearing models ran without an explicit
  // `select`, and the ONLY thing stopping a leak was each response path
  // remembering to project its output. That is fail-OPEN: every new endpoint
  // touching `user` has to independently remember. A global omit fails CLOSED
  // — a forgotten projection returns nothing instead of a password hash.
  //
  // Callers that legitimately need one opt back in per query with
  // `omit: { passwordHash: false }`, which makes every legitimate use explicit
  // and greppable. A query-level `select` also still returns the field (naming
  // it IS asking for it); `select` and `omit` cannot be combined in one query.
  //
  // Store credentials (wbsApiKey, metaAccessToken, agentApiKey) joined the
  // omit on 2026-09-25. The earlier worry was that guards like
  // `if (!store.wbsApiKey) return;` would turn into SILENT no-ops. They can't:
  // the generated types follow the global omit, so reading an omitted field
  // off a query that didn't select it is a TYPE ERROR, and every reader now
  // names the field in its `select`. PaymentConfig.{apiKey,secretKey,
  // webhookSecret} still needs the same pass.
  omit: {
    user: {
      passwordHash: true,
      mfaSecret: true,
      mfaBackupCodes: true,
    },
    store: {
      wbsApiKey: true,
      metaAccessToken: true,
      agentApiKey: true,
    },
  },
} satisfies Prisma.PrismaClientOptions;

export type AppPrismaClient = PrismaClient<typeof prismaOptions>;

/**
 * Accepts either the app client or an interactive-transaction client.
 *
 * `Prisma.TransactionClient` is generated from the UN-narrowed PrismaClient, so
 * once a global `omit` narrows our client the two are no longer assignable.
 * Helpers that take "a client, tx or not" should type that parameter as
 * `DbClient` rather than casting the mismatch away at each call site.
 */
export type DbClient = AppPrismaClient | Prisma.TransactionClient;

export interface CreatePrismaClientOptions {
  /** A `postgresql://` URL. Prisma-engine pool params in it are translated, see below. */
  connectionString: string;
  /**
   * Maximum connections in this client's pg pool. A Worker passes 1 (one request,
   * one transaction). Default for a Node process: `DB_CONNECTION_LIMIT` or 15.
   */
  max?: number;
}

/**
 * Query params the Prisma ENGINE understood (`connection_limit`, `pool_timeout`,
 * `connect_timeout`, `pgbouncer`, `schema`). node-postgres does not, so they are
 * translated to pool settings and removed from the URL it parses. The
 * `DATABASE_URL`s already in `.env` files and CI keep working unchanged.
 */
const ENGINE_ONLY_PARAMS = [
  'connection_limit',
  'pool_timeout',
  'connect_timeout',
  'socket_timeout',
  'pgbouncer',
  'schema',
] as const;

/** Pure: split a connection string into the URL pg parses and the pool settings. */
export function resolvePoolConfig(
  connectionString: string,
  max?: number
): {
  connectionString: string;
  max: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
} {
  let url = connectionString;
  let limitFromUrl: number | undefined;
  let connectTimeoutS: number | undefined;
  try {
    const u = new URL(connectionString);
    const num = (k: string): number | undefined => {
      const v = Number(u.searchParams.get(k));
      return Number.isFinite(v) && v > 0 ? v : undefined;
    };
    limitFromUrl = num('connection_limit');
    connectTimeoutS = num('connect_timeout');
    for (const p of ENGINE_ONLY_PARAMS) u.searchParams.delete(p);
    url = u.toString();
  } catch {
    // Not a parseable URL (a unix-socket DSN, say): hand it to pg untouched.
  }
  const envLimit = Number(process.env.DB_CONNECTION_LIMIT);
  return {
    connectionString: url,
    max: max ?? limitFromUrl ?? (Number.isFinite(envLimit) && envLimit > 0 ? envLimit : 15),
    // Neon suspends idle compute: a new connection must fail fast instead of
    // hanging (this was `connect_timeout=10` on the engine URL).
    connectionTimeoutMillis: (connectTimeoutS ?? 10) * 1000,
    // Drop idle sockets before a pooler/Neon does, so a stale one is never handed out.
    idleTimeoutMillis: 30_000,
  };
}

/**
 * Build the app's Prisma client over `@prisma/adapter-pg`.
 *
 * Works unchanged under Node and workerd: it only needs `pg` (which workerd
 * serves through `nodejs_compat`) and the wasm query compiler that
 * `@prisma/client` resolves per runtime.
 */
export function createPrismaClient(opts: CreatePrismaClientOptions): AppPrismaClient {
  const pool = resolvePoolConfig(opts.connectionString, opts.max);
  const adapter = new PrismaPg(pool, {
    // The adapter attaches an 'error' listener to idle pool clients; without a
    // sink here a dropped idle socket would be swallowed with no trace.
    onPoolError: err => {
      console.error(`[database] idle pool client error: ${err.message}`);
    },
  });
  return new PrismaClient({ ...prismaOptions, adapter }) as unknown as AppPrismaClient;
}
