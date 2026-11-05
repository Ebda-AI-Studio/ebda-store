// The ONE place a PrismaClient is built (R-EBDA-001).
//
// Prisma 6.19.3 with `engineType = "client"` (see schema.prisma) has no native
// engine: the query compiler is wasm, and the database is reached through a
// driver adapter. This factory is the single construction path for every
// runtime:
//   - Node (Express API, vitest, scripts): a process-wide singleton, see
//     `request-db.ts`;
//   - Cloudflare Workers (workerd): a small pool of clients per isolate, each leased to one
//     request at a time and reused, over a leased driver adapter; the pg connection is per
//     request, see `client-pool.ts` and `createIsolateDb`.
// workerd forbids reusing an I/O object (socket, stream) created in one request
// from another, and a pg Pool caches sockets, so the CONNECTION cannot be shared; the client can. Hyperdrive / the pooler holds the real server connections, which
// is what makes a client-per-request cheap (spikes/workers-api/README.md).
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import type { SqlDriverAdapterFactory } from '@prisma/driver-adapter-utils';
import { tenantGuardExtension } from './tenant-guard';
import { guardOrphanTransactionsFactory } from './orphan-tx-guard';

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
  // Store credentials (agentApiKey) joined the
  // omit on 2026-09-25. The earlier worry was that guards like
  // `if (!store.credentials.agentApiKey) return;` would turn into SILENT no-ops. They can't:
  // the generated types follow the global omit, so reading an omitted field
  // off a query that didn't select it is a TYPE ERROR, and every reader now
  // names the field in its `select`. PaymentConfig.{apiKey,secretKey,
  // webhookSecret} still needs the same pass.
  //
  // 2026-10-07 (R-EBDA-005): the store credentials moved out of `stores`
  // into `store_credentials` (strict store RLS); the omit moved with them, so a
  // reader still names each one in a `select`.
  omit: {
    user: {
      passwordHash: true,
      mfaSecret: true,
      mfaBackupCodes: true,
      // Ebda's own ads attribution (ip, user agent, Meta ids): never in a full-row
      // read; only the CAPI job and the super-admin store page name it in a select.
      acquisition: true,
    },
    storeCredential: {
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
  /**
   * Called when an IDLE pooled client errors (a socket the pooler or Neon dropped). Default:
   * `console.error`. A Worker passes a quieter sink: its per-request client ends its single
   * connection at the end of every request, and workerd reports that as a cancelled stream.
   */
  onPoolError?: (err: Error) => void;
  /**
   * Prisma log levels. Default: query + error + warn in development, error otherwise. A Worker
   * passes ['error', 'warn']: a console line per query is CPU, log volume and heap there.
   */
  log?: Array<'query' | 'info' | 'warn' | 'error'>;
  /**
   * 'app' (default): the client every runtime uses. It carries the code-level tenant
   * guard (`tenant-guard.ts`, R-EBDA-003): a query on a tenant model must be scoped to
   * the ambient store or it is refused before it is sent.
   *
   * 'owner': migrations, seeds, ops scripts and integration-test FIXTURES only. No
   * tenant guard, and it REFUSES to run unless its connection role bypasses RLS by
   * itself (superuser / BYPASSRLS): on `ebda_app` its first query throws. It is the
   * client form of `withOwnerTx` (hatch 'owner-role-tx'), and
   * `tests/unit/no-rls-bypass-in-runtime.test.ts` keeps it out of `apps/api/src`.
   */
  role?: 'app' | 'owner';
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
 * Column types the driver adapter can map (Postgres type OIDs, from
 * `@prisma/adapter-pg` 6.19: scalar and array types). Anything ELSE with a
 * built-in (< 16384) OID makes the adapter throw `UnsupportedNativeDataType` for
 * the whole `$queryRaw`: `name` (`current_user`, `pg_class.relname`,
 * `pg_indexes.indexname`, every `information_schema` identifier), `"char"`,
 * `regclass`, `interval`, `xid`, ... The Rust engine tolerated them, ~160 raw SQL
 * call sites and the catalog queries in tests/ops scripts rely on that, and
 * spikes/workers-api/README.md recorded the quirk.
 */
const ADAPTER_SUPPORTED_OIDS = new Set([
  // scalars
  16, 17, 20, 21, 23, 25, 26, 114, 142, 650, 700, 701, 790, 869, 1042, 1043, 1082, 1083, 1114, 1184,
  1266, 1560, 1562, 1700, 2950, 3802,
  // arrays
  199, 143, 651, 791, 1000, 1001, 1002, 1005, 1007, 1009, 1014, 1015, 1016, 1021, 1022, 1028, 1041,
  1115, 1182, 1183, 1185, 1231, 1561, 1563, 2951, 3807,
]);
const FIRST_NORMAL_OBJECT_ID = 16384;
const TEXT_OID = 25;

/**
 * A pg Client that reports unsupported built-in column types as `text`. pg's
 * default parser already returns such values as strings, so only the type tag the
 * adapter reads from `result.fields` needs to change. Nothing else is touched.
 */
function retypeUnsupportedFields(r: pg.QueryResult | undefined): void {
  for (const f of r?.fields ?? []) {
    if (f.dataTypeID < FIRST_NORMAL_OBJECT_ID && !ADAPTER_SUPPORTED_OIDS.has(f.dataTypeID)) {
      f.dataTypeID = TEXT_OID;
    }
  }
}

export class TextFallbackClient extends pg.Client {
  constructor(config?: string | pg.ClientConfig) {
    super(config);
    // A late socket error (the read loop of a closing socket: workerd's "Network connection
    // lost") reaches the Client AFTER pg-pool has detached its own 'error' listener. An EventEmitter
    // 'error' with no listener THROWS, inside pg-cloudflare's promise chain, which workerd reports
    // as an uncaught rejection (and `wrangler dev` treats as fatal). Errors on a LIVE query still
    // reject that query; this only absorbs the orphaned ones. The pool's idle listener still logs
    // idle-client errors through `onPoolError`.
    this.on('error', () => undefined);
  }

  // pg-pool calls `client.query(text, values, callback)` for `pool.query`, while a
  // pooled client's `query` (interactive transactions) returns a promise: both
  // shapes are covered.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override query(...args: any[]): any {
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      args[args.length - 1] = (err: Error | null, res: pg.QueryResult | undefined) => {
        retypeUnsupportedFields(res);
        last(err, res);
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (super.query as any)(...args);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (super.query as any)(...args);
    if (typeof result?.then !== 'function') return result; // a submittable (cursor, ...)
    return result.then((r: pg.QueryResult | undefined) => {
      retypeUnsupportedFields(r);
      return r;
    });
  }
}

/**
 * Build the app's Prisma client over `@prisma/adapter-pg`.
 *
 * Works unchanged under Node and workerd: it only needs `pg` (which workerd
 * serves through `nodejs_compat`) and the wasm query compiler that
 * `@prisma/client` resolves per runtime.
 */
export function createPrismaClient(opts: CreatePrismaClientOptions): AppPrismaClient {
  const poolConfig = resolvePoolConfig(opts.connectionString, opts.max);
  const pool = new pg.Pool({ ...poolConfig, Client: TextFallbackClient });
  const adapter = new PrismaPg(pool, {
    // `$disconnect()` ends the pool (a request-bound client must not leak sockets).
    disposeExternalPool: true,
    // The adapter attaches an 'error' listener to idle pool clients; without a
    // sink here a dropped idle socket would be swallowed with no trace.
    onPoolError:
      opts.onPoolError ??
      (err => {
        console.error(`[database] idle pool client error: ${err.message}`);
      }),
  });
  // Node path: a transaction Prisma starts but never closes (a `$disconnect()` racing a start) is rolled back and
  // released instead of stranding `BEGIN` and hanging `pool.end()`. See orphan-tx-guard.ts.
  const guarded = guardOrphanTransactionsFactory(adapter);
  if (opts.role === 'owner') return createOwnerClient(guarded, opts.log);
  return createPrismaClientWithAdapter(guarded, opts.log);
}

/**
 * The same client over any driver adapter factory (or an adapter). The Worker shell passes the
 * leased factory from `client-pool.ts`, once per pooled client.
 */
export function createPrismaClientWithAdapter(
  adapter: PrismaPg | SqlDriverAdapterFactory,
  log?: CreatePrismaClientOptions['log']
): AppPrismaClient {
  // The tenant guard is a QUERY extension: it changes no types, so the client keeps
  // the omit-narrowed `AppPrismaClient` shape. Interactive transactions opened on it
  // carry the extension too.
  return new PrismaClient({
    ...prismaOptions,
    ...(log ? { log } : {}),
    adapter,
  }).$extends(tenantGuardExtension) as unknown as AppPrismaClient;
}

/**
 * The owner-role client (`role: 'owner'`): no tenant guard, and every operation first
 * proves (once per client) that the connection's role bypasses RLS by itself. On the
 * strict-RLS app role it throws instead of silently reading zero rows.
 */
function createOwnerClient(
  adapter: PrismaPg | SqlDriverAdapterFactory,
  log?: CreatePrismaClientOptions['log']
): AppPrismaClient {
  const base = new PrismaClient({ ...prismaOptions, ...(log ? { log } : {}), adapter });
  let verified: Promise<void> | undefined;
  const verify = (): Promise<void> =>
    (verified ??= base
      .$queryRawUnsafe<Array<{ ok: boolean; who: string }>>(
        'SELECT (rolsuper OR rolbypassrls) AS ok, current_user::text AS who FROM pg_roles WHERE rolname = current_user'
      )
      .then(rows => {
        if (rows[0]?.ok !== true) {
          throw new Error(
            `owner-role client: connection role ${rows[0]?.who ?? '?'} does not bypass RLS. ` +
              'It is for migrations, scripts and test fixtures on an owner connection only.'
          );
        }
      })
      .catch(err => {
        verified = undefined;
        throw err;
      }));
  return base.$extends({
    name: 'ebda-owner-role-check',
    query: {
      $allOperations: async ({ args, query }) => {
        await verify();
        return query(args);
      },
    },
  }) as unknown as AppPrismaClient;
}
