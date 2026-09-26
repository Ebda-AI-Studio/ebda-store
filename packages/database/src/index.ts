// Database Package - Prisma Client Export
import { PrismaClient, Prisma } from '@prisma/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import { applyGucs, gucStatements, type TenantGucs } from './tenant-gucs';

// Options are extracted so the client's TYPE can be derived from them. A global
// `omit` narrows PrismaClient's generic, so a plain `PrismaClient` annotation on
// the dev-mode cache below no longer matches what `new PrismaClient(...)`
// returns. Deriving keeps them in lockstep instead of casting the mismatch away.
const prismaOptions = {
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  datasourceUrl: appendPoolParams(process.env.DATABASE_URL),
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

// Prevent multiple instances in development
const globalForPrisma = globalThis as unknown as {
  prisma: AppPrismaClient | undefined;
};

const basePrisma: AppPrismaClient = globalForPrisma.prisma ?? new PrismaClient(prismaOptions);

/**
 * Append connection parameters for Neon serverless Postgres.
 * Neon suspends idle connections which causes Prisma to hang on stale
 * pooled connections. These params ensure:
 * - connect_timeout: new connections fail fast instead of hanging
 * - pool_timeout: pooled connection acquisition times out
 * - connection_limit: keep pool small to reduce stale connections
 * - pgbouncer: required when using Neon's connection pooler
 */
function appendPoolParams(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (!u.searchParams.has('connect_timeout')) {
      u.searchParams.set('connect_timeout', '10');
    }
    if (!u.searchParams.has('pool_timeout')) {
      u.searchParams.set('pool_timeout', process.env.DB_POOL_TIMEOUT || '20');
    }
    if (!u.searchParams.has('connection_limit')) {
      // A limit of 5 starved the pool under real concurrency (storefront + admin
      // + Inngest async writers share one process) -> ~220x/day "Timed out
      // fetching a new connection from the pool" in Sentry. Neon's pooled
      // endpoint runs pgbouncer in transaction mode, so a higher per-instance
      // client limit multiplexes safely onto fewer server connections.
      // Default 15; override via DB_CONNECTION_LIMIT in Railway without a deploy.
      u.searchParams.set('connection_limit', process.env.DB_CONNECTION_LIMIT || '15');
    }
    // Enable pgbouncer mode for Neon pooler URLs
    if (u.hostname.includes('neon.tech') && !u.searchParams.has('pgbouncer')) {
      u.searchParams.set('pgbouncer', 'true');
    }
    return u.toString();
  } catch {
    return url;
  }
}

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = basePrisma;
}

// ---------------------------------------------------------------------------
// Tenant-scoped RLS via AsyncLocalStorage
// ---------------------------------------------------------------------------

type TenantTx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/** Stores the active tenant transaction for the current async context. */
const tenantStorage = new AsyncLocalStorage<TenantTx>();

/**
 * The RLS settings each tenant transaction was opened with, so a SECOND
 * transaction started from inside it can carry the same ones (see
 * `$transaction` in the proxy below).
 */
const txGucs = new WeakMap<object, TenantGucs>();

/**
 * A store scope WITHOUT a long-lived transaction — see `runInStoreScope`.
 */
const storeScope = new AsyncLocalStorage<{ storeId: string }>();

/** The RLS settings in force on this async context, if any. */
function ambientGucs(): TenantGucs | undefined {
  const tx = tenantStorage.getStore();
  if (tx) return txGucs.get(tx as object);
  const scope = storeScope.getStore();
  return scope ? { storeId: scope.storeId } : undefined;
}

/**
 * A deferred query issued inside `runInStoreScope`. Lazy like a PrismaPromise:
 * nothing runs until it is awaited, and then it runs in its own short
 * `runInTenantContext`. Inside a batch `prisma.$transaction([...])` the whole
 * batch instead runs in ONE tenant transaction via `exec` (see
 * `transactionWithGucs`), so batch atomicity is kept.
 */
const SCOPED_OP = Symbol('forceScopedOp');
interface ScopedOp extends PromiseLike<unknown> {
  [SCOPED_OP]: true;
  exec: () => Promise<unknown>;
}

function isScopedOp(v: unknown): v is ScopedOp {
  return Boolean(v && typeof v === 'object' && (v as Record<symbol, unknown>)[SCOPED_OP]);
}

function scopedOp(storeId: string, exec: () => Promise<unknown>): ScopedOp & Promise<unknown> {
  let started: Promise<unknown> | undefined;
  const run = () => (started ??= runInTenantContext(storeId, exec));
  const op = {
    [SCOPED_OP]: true as const,
    exec,
    then: (a?: (v: unknown) => unknown, b?: (e: unknown) => unknown) => run().then(a, b),
    catch: (b?: (e: unknown) => unknown) => run().catch(b),
    finally: (f?: () => void) => run().finally(f),
    [Symbol.toStringTag]: 'ScopedPrismaPromise',
  };
  return op as unknown as ScopedOp & Promise<unknown>;
}

/**
 * `prisma.$transaction` when RLS settings are in force on this context.
 *
 * `$transaction` is never routed to the ambient tenant transaction (see
 * `hasTenantContext`), so it opens a NEW transaction on another connection —
 * and that connection used to carry none of the settings. Every table with a
 * STRICT policy (store_id = app.current_store_id, no contextless allowance)
 * then read as empty and rejected writes, while allow-contextless tables
 * silently lost their tenant scoping. Measured on 2026-09-25 under a real
 * `force_app` login: inside `runInTenantContext`, a direct count of
 * `ai_recommendation` returned 2 rows, the same count through `withMoneyTx`
 * or a batch `$transaction([...])` returned 0.
 *
 * The new transaction still opens separately (nesting is impossible in
 * Prisma and callers rely on their own isolation/timeout options); it now
 * starts with the same `SET LOCAL`s. Inert on a BYPASSRLS role.
 */
function transactionWithGucs(gucs: TenantGucs) {
  const base = basePrisma.$transaction.bind(basePrisma) as (...a: unknown[]) => Promise<unknown>;
  return (arg: unknown, opts?: unknown): Promise<unknown> => {
    if (typeof arg === 'function') {
      const fn = arg as (tx: TenantTx) => Promise<unknown>;
      return base(async (tx: TenantTx) => {
        await applyGucs(tx, gucs);
        return fn(tx);
      }, opts);
    }
    if (Array.isArray(arg)) {
      if (arg.length > 0 && arg.every(isScopedOp)) {
        return runInTenantContext(gucs.storeId, async () => {
          const out: unknown[] = [];
          for (const op of arg) out.push(await op.exec());
          return out;
        });
      }
      const sets = gucStatements(gucs).map(sql => basePrisma.$executeRawUnsafe(sql));
      return base([...sets, ...arg], opts).then(r => (r as unknown[]).slice(sets.length));
    }
    return base(arg, opts);
  };
}

function isModelDelegate(prop: string, value: unknown): value is object {
  return (
    prop[0] !== '$' &&
    prop[0] !== '_' &&
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as { findMany?: unknown }).findMany === 'function'
  );
}

/**
 * Tenant transactions whose `runInTenantContext` callback has already
 * returned — i.e. Prisma is committing (or has committed) them.
 *
 * Why this exists: the API holds ONE interactive transaction per request in
 * `tenantStorage` and commits it on `res.on('finish')` (see
 * apps/api/src/middleware/tenant-context.ts). A fire-and-forget promise
 * started inside the handler INHERITS this AsyncLocalStorage context, so any
 * Prisma call it makes after the response flushes lands on a committed
 * transaction and throws P2028 ("Transaction already closed"). Every such
 * call site wraps itself in a logging `.catch`, so the work silently never
 * happened — return-confirmation emails never sent, affiliate audit events
 * never written, orphaned R2 objects never reclaimed.
 *
 * The transaction object itself is the only stable identity we have for
 * "this request's tx", hence a WeakSet (entries are collected with the tx).
 *
 * This is DETECTION ONLY. The proxy still routes the call to the closed
 * transaction exactly as before — the P2028 still throws, byte-identical
 * behaviour — but a registered reporter gets told, with the property name
 * and a stack, so the failure is loud instead of silent. Routing the call to
 * the base client instead would drop the `app.current_store_id` GUC that
 * `runInTenantContext` set, trading a transaction bug for a tenancy bug.
 */
const closedTenantTxs = new WeakSet<object>();

/** What a closed-tenant-tx access reports to the host application. */
export interface ClosedTenantTxAccess {
  /** The Prisma property that was read (model accessor or raw helper). */
  property: string;
  /** Capture stack of the offending access, so the call site is nameable. */
  stack?: string;
}

let closedTenantTxReporter: ((info: ClosedTenantTxAccess) => void) | null = null;

/**
 * Register a handler invoked whenever code touches the ambient tenant
 * transaction AFTER its `runInTenantContext` callback returned.
 *
 * The API registers one at boot that logs at error level and fires the
 * standard Telegram alert (see apps/api/src/lib/after-tenant-commit.ts).
 * Registering is optional — with no reporter this is a no-op, which is what
 * scripts, migrations and tests get.
 */
export function onClosedTenantTxAccess(
  handler: ((info: ClosedTenantTxAccess) => void) | null
): void {
  closedTenantTxReporter = handler;
}

function reportClosedTenantTxAccess(property: string): void {
  const reporter = closedTenantTxReporter;
  if (!reporter) return;
  try {
    reporter({ property, stack: new Error('Prisma call on a committed tenant transaction').stack });
  } catch {
    // A broken reporter must never change the behaviour of the query path.
  }
}

/**
 * Model-level property names on PrismaClient (e.g. `user`, `product`, `store`).
 * When a tenant transaction is active, reads of these properties are proxied
 * to the transaction client so every query runs inside the SET LOCAL scope.
 *
 * We also proxy `$queryRaw`, `$executeRaw`, and `$queryRawUnsafe` /
 * `$executeRawUnsafe` so raw queries respect the tenant context too.
 */
const PROXIED_PRISMA_METHODS = new Set([
  // Raw query helpers
  '$queryRaw',
  '$queryRawUnsafe',
  '$executeRaw',
  '$executeRawUnsafe',
]);

function isProxiedProp(prop: string | symbol): boolean {
  if (typeof prop !== 'string') return false;
  // Proxy model accessors (lowercase, no $ prefix) and raw query helpers
  if (PROXIED_PRISMA_METHODS.has(prop)) return true;
  // Model accessors: lowercase first letter, no $ prefix (e.g. 'user', 'product')
  return prop.length > 0 && prop[0] !== '$' && prop[0] === prop[0].toLowerCase();
}

/**
 * Whether an ambient tenant transaction (from `runInTenantContext`) is active
 * on this async context.
 *
 * Exists because `$transaction` is NOT proxied to the tenant transaction: the
 * proxy above only forwards model accessors and raw helpers (`isProxiedProp`
 * rejects anything starting with `$`). So `prisma.$transaction(...)` inside a
 * request opens a SEPARATE transaction on a different connection, which cannot
 * see rows the request has already written in the outer tenant transaction —
 * that transaction does not commit until the response finishes.
 *
 * That is not hypothetical: `CartService.addItem` created the cart via the
 * proxy (outer tx, uncommitted) and then inserted the cart item inside a nested
 * `$transaction`, so the FK on `cart_items.cart_id` pointed at a row the nested
 * transaction could not see → P2003, a 500 on the first add-to-cart of a
 * session. Call sites that write-then-read within one request must use this to
 * stay on the ambient transaction.
 *
 * The call sites that do, as of 2026-09-13 — keep this list current, because
 * the next omission looks exactly like the last three:
 *   - `CartService.addItem`    (cart_items unique + FK)
 *   - `CartService.addBundle`  (cart_bundles unique + FK)
 *   - `CartService.addItems`   (bulk /cart/sync — same shape, and it kept the
 *                               defect through THREE separate audit reports
 *                               because the first-party storefront calls the
 *                               sibling public route, which is mounted outside
 *                               `tenantContext` and so always took the safe
 *                               branch)
 *   - `AuthService.eraseAccount` (2026-09-23 — a DIFFERENT shape from the cart
 *                               three: no write-then-read, so it would not have
 *                               failed loudly. The `withMoneyTx` simply committed
 *                               the irreversible PII anonymization on a second,
 *                               GUC-less connection, independently of the request
 *                               transaction — so an abort after it destroyed the
 *                               data while rolling back its own audit row. Latent
 *                               until the merchant-initiated
 *                               `POST /stores/:storeId/customers/:customerId/erase`
 *                               route made it reachable under `tenantContext`;
 *                               `/auth/me/erase` and the retention cron are both
 *                               context-less.)
 *
 * The shape to look for: a service that calls `getOrCreate`-then-`$transaction`
 * and is reachable from a router mounted under `tenantContext`. Note the
 * eraseAccount case widens that: ANY `$transaction` reachable under
 * `tenantContext` is already wrong on RLS scoping and commit atomicity, even
 * when it never reads back what it wrote and so never throws.
 *
 * Prisma does not support nested interactive transactions in any case.
 *
 * Since 2026-09-25 that separate transaction at least starts with the SAME RLS
 * settings (`transactionWithGucs` below), so it no longer reads a STRICT-policy
 * table as empty. It is still a different connection with its own commit —
 * everything above about write-then-read and commit atomicity still holds.
 */
export function hasTenantContext(): boolean {
  return tenantStorage.getStore() !== undefined;
}

/**
 * Proxy-wrapped Prisma client.
 *
 * When called inside `runInTenantContext`, model accessors and raw query
 * helpers transparently delegate to the tenant-scoped transaction that
 * already has `SET LOCAL app.current_store_id` applied.
 *
 * Outside a tenant context the proxy passes through to the base client,
 * so cross-tenant operations (super_admin, migrations, crons) work unchanged.
 */
export const prisma = new Proxy(basePrisma, {
  get(target, prop, receiver) {
    const tx = tenantStorage.getStore();
    if (tx && isProxiedProp(prop)) {
      // Detection only — see `closedTenantTxs`. Routing is unchanged.
      if (closedTenantTxs.has(tx as object)) {
        reportClosedTenantTxAccess(String(prop));
      }
      return Reflect.get(tx, prop, tx);
    }
    if (prop === '$transaction') {
      const gucs = ambientGucs();
      if (gucs && (gucs.storeId || gucs.userId)) return transactionWithGucs(gucs);
    }
    // `runInStoreScope`: no transaction is open, so each model call and raw
    // query runs in its own short tenant transaction instead.
    const scope = tx ? undefined : storeScope.getStore();
    if (scope && typeof prop === 'string') {
      const self = prisma as unknown as Record<string, unknown>;
      if (PROXIED_PRISMA_METHODS.has(prop)) {
        return (...args: unknown[]) =>
          scopedOp(scope.storeId, () =>
            (self[prop] as (...a: unknown[]) => Promise<unknown>)(...args)
          );
      }
      const value = Reflect.get(target, prop, receiver);
      if (isModelDelegate(prop, value)) {
        return new Proxy(value, {
          get(delegate, method, r) {
            const v = Reflect.get(delegate, method, r);
            if (typeof v !== 'function' || typeof method !== 'string') return v;
            return (...args: unknown[]) =>
              scopedOp(scope.storeId, () => {
                const d = self[prop] as Record<string, (...a: unknown[]) => Promise<unknown>>;
                return d[method](...args);
              });
          },
        });
      }
      return value;
    }
    return Reflect.get(target, prop, receiver);
  },
  // Cast to the OMIT-NARROWED type, not bare PrismaClient. With bare
  // PrismaClient the types would still advertise `passwordHash` while the
  // runtime omits it — code reading it would compile and silently get
  // undefined. Narrowing makes a missing per-query opt-in a COMPILE error.
}) as AppPrismaClient;

// Re-export everything from Prisma client (types, enums, Prisma namespace)
export * from '@prisma/client';
export { Prisma } from '@prisma/client';

// Explicit enum re-exports for environments where barrel re-exports may not resolve
export {
  UserRole,
  UserStatus,
  StoreStatus,
  StorePlan,
  StoreTemplate,
  ProductStatus,
  InventoryChangeType,
  PaymentStatus,
  OrderStatus,
  OrderPaymentStatus,
  ReturnType,
  ReturnStatus,
  PaymentProvider,
  ProviderHealthStatus,
  CouponType,
  VerificationTokenType,
  LoyaltyTransactionType,
  AccountType,
  JournalEntrySource,
  JournalEntryStatus,
  SupplierPaymentTerms,
  PurchaseOrderStatus,
  StockAdjustmentType,
  StockAdjustmentStatus,
  ExpenseStatus,
  ReorderSuggestionStatus,
  DeadStockFlagStatus,
  AnomalyScope,
  AnomalyMetric,
  AnomalySeverity,
  RfmSegment,
  CampaignStatus,
  CampaignRecipientStatus,
} from '@prisma/client';

export { prisma as db };

// Money-safe transaction wrapper (Neon pgbouncer P2028 guard). Use for every
// interactive $transaction call site. See ./with-money-tx.ts.
export { withMoneyTx } from './with-money-tx';

// Set RLS settings on a caller-opened transaction. See ./tenant-gucs.ts.
export { setTenantGucs, type TenantGucs } from './tenant-gucs';

/**
 * Run a callback inside a Prisma interactive transaction with
 * `app.current_store_id` set via SET LOCAL. All Prisma queries executed
 * through the `prisma` export (the proxy) within the callback
 * automatically use this transaction — no code changes needed in services.
 *
 * The tenant context is stored in AsyncLocalStorage, so it flows through
 * any async operations within the callback.
 *
 * If the callback throws, the transaction rolls back automatically.
 *
 * @param storeId RLS cutover Phase 1c (user-scoped routers, see
 *   apps/api/src/middleware/tenant-context.ts `userContext`): may be
 *   `undefined` for routers that have no store in scope at all (e.g.
 *   `address.routes.ts` — addresses are user-scoped, FK `user_id`, no
 *   `store_id` column exists). When `undefined`, `app.current_store_id` is
 *   simply never SET LOCAL'd — `current_store_id()` returns NULL and every
 *   store-scoped hybrid policy allow-contextless, IDENTICAL to calling this
 *   function today with no context at all. A *defined* storeId still MUST
 *   be a valid UUID (throws otherwise, same as before) — this only relaxes
 *   the "must pass something" requirement, it does not relax validation of
 *   a value that IS passed.
 * @param userId Optional — additionally sets `app.current_user_id` via SET
 *   LOCAL, for the user-scoped RLS policies added in the RLS cutover Phase
 *   1b (e.g. `addresses`, see 20260702170000_rls_close_denyall_tables).
 *   Additive: defaults to `undefined`, in which case the GUC is left unset,
 *   `current_user_id()` returns NULL, and the hybrid user-scoped policies
 *   allow-contextless — IDENTICAL to today's behavior. Only callers that
 *   explicitly pass a userId (tenant-context.ts, from `req.user?.userId`)
 *   opt into the per-user backstop.
 *
 * @example
 *   // In Express middleware:
 *   await runInTenantContext(storeId, async () => {
 *     // All prisma.product.findMany() etc. calls inside here
 *     // are scoped to this storeId via RLS
 *     await handler(req, res);
 *   }, req.user?.userId);
 *
 * @example
 *   // User-scoped router with no store in scope (address.routes.ts):
 *   await runInTenantContext(undefined, async () => {
 *     // app.current_store_id stays unset; app.current_user_id is set.
 *     await handler(req, res);
 *   }, req.user!.userId);
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runInTenantContext<T>(
  storeId: string | undefined,
  fn: () => Promise<T>,
  userId?: string
): Promise<T> {
  if (storeId !== undefined && !UUID_RE.test(storeId)) {
    throw new Error('Invalid store ID format');
  }
  return basePrisma.$transaction(
    async tx => {
      await applyGucs(tx, { storeId, userId });
      txGucs.set(tx as object, { storeId, userId });
      try {
        return await tenantStorage.run(tx, fn);
      } finally {
        // The callback has returned, so Prisma is about to COMMIT: from here
        // on, any query that reaches this tx throws P2028. Mark it so the
        // proxy can name the offender instead of leaving a swallowed
        // rejection. Behaviour is otherwise unchanged.
        closedTenantTxs.add(tx as object);
      }
    },
    // maxWait raised from Prisma's 2s default — admin dashboards fire 4-6
    // parallel /stores/:id/* requests, each opening an interactive tx for
    // RLS. Neon pgbouncer slot contention under that burst was firing P2028
    // at ~2050ms. 10s gives headroom without masking real saturation.
    { maxWait: 10000, timeout: 30000 }
  );
}

/**
 * Execute a callback within a tenant-scoped transaction (explicit tx version).
 * Prefer `runInTenantContext` for automatic proxy-based scoping.
 * This version passes the transaction client directly for cases where
 * you need explicit control.
 */
export async function withTenantContext<T>(
  storeId: string,
  fn: (tx: TenantTx) => Promise<T>
): Promise<T> {
  if (!UUID_RE.test(storeId)) {
    throw new Error('Invalid store ID format');
  }
  return basePrisma.$transaction(
    async tx => {
      await tx.$executeRawUnsafe(
        `SET LOCAL app.current_store_id = '${storeId.replace(/'/g, "''")}'`
      );
      return fn(tx);
    },
    { maxWait: 10000, timeout: 30000 }
  );
}

/**
 * Scope every Prisma call in `fn` to `storeId` under RLS WITHOUT holding one
 * transaction open for the whole of `fn`.
 *
 * For long-running per-store work — the bulk-AI Inngest jobs, which interleave
 * Gemini calls and multi-second throttles between queries. Those jobs were
 * once wrapped in `runInTenantContext`; its 30s interactive transaction
 * expired mid-sweep (#461), so the wrapper was removed on the belief that the
 * jobs touch no RLS-protected table. They do: `bulk_ai_jobs`, `ai_usage`,
 * `ai_recommendation`, `store_faqs` and `store_howtos` all carry STRICT
 * policies, so under `force_app` every one of those jobs would read nothing
 * and fail its first `bulkAiJob.update` (P2025).
 *
 * Inside the scope, each model call / raw query runs in its own short
 * `runInTenantContext(storeId, …)`; `$transaction` / `withMoneyTx` start with
 * the store's `SET LOCAL`; an explicit `runInTenantContext` / `withRlsBypass`
 * inside the scope behaves exactly as it does anywhere else. Results are
 * identical on the owner role — the only cost is one short transaction per
 * query, negligible next to an AI call.
 */
export function runInStoreScope<T>(storeId: string, fn: () => Promise<T>): Promise<T> {
  if (!UUID_RE.test(storeId)) {
    throw new Error('Invalid store ID format');
  }
  return storeScope.run({ storeId }, fn);
}

/**
 * Execute a callback within a transaction that BYPASSES Row-Level Security.
 *
 * Use this for super-admin, cron, Inngest, and other cross-tenant operations
 * that need to touch RLS-protected tables (journal_entries, accounts,
 * orders, products, etc.) without being filtered to the current tenant.
 *
 * RLS policies on FWB are written with an explicit bypass clause:
 *   USING (
 *     store_id::text = current_setting('app.current_store_id', true)
 *     OR current_setting('app.bypass_rls', true) = 'true'
 *   )
 *
 * Setting the bypass GUC via SET LOCAL means the override dies on
 * commit/rollback (transaction-scoped, no leak to other connections).
 *
 * Trap this helper protects against: opening a fresh prisma.$transaction
 * for cross-tenant work, then watching DELETEs / UPDATEs silently match
 * zero rows because RLS filtered them out. See
 * feedback-postgres-rls-silent-filter-trap.md for the FWB incident
 * 2026-05-21.
 *
 * @example
 *   // Inngest job archiving cross-tenant audit logs
 *   await withRlsBypass(async tx => {
 *     await tx.$executeRaw`DELETE FROM public.audit_logs WHERE created_at < ${cutoff}`;
 *   });
 */
export async function withRlsBypass<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return basePrisma.$transaction(
    async tx => {
      // 1. app.bypass_rls = 'true': honoured by new-style RLS policies
      //    (accounting tables + tables updated in 20260602000000_fix_ai_usage_rls_bypass).
      await tx.$executeRaw`SET LOCAL app.bypass_rls = 'true'`;
      // 2. app.current_store_id = '': resets any stale session-level GUC.
      //    current_store_id() returns NULLIF('', '') = NULL so old-style
      //    policies (`current_store_id() IS NULL`) also allow all rows.
      //    Defense-in-depth: a reused pgbouncer connection may carry a
      //    previous request's store ID at session scope even after SET LOCAL
      //    reverts on commit — this explicit reset guarantees the bypass
      //    path works for both policy generations.
      await tx.$executeRaw`SET LOCAL app.current_store_id = ''`;
      return fn(tx);
    },
    { maxWait: 10000, timeout: 30000 }
  );
}
