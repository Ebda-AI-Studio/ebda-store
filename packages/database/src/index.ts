// Database Package - Prisma Client Export
import { PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'node:async_hooks';

// Prevent multiple instances in development
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const basePrisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
    datasourceUrl: appendPoolParams(process.env.DATABASE_URL),
  });

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
      return Reflect.get(tx, prop, tx);
    }
    return Reflect.get(target, prop, receiver);
  },
}) as PrismaClient;

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
} from '@prisma/client';

export { prisma as db };

// Money-safe transaction wrapper (Neon pgbouncer P2028 guard). Use for every
// interactive $transaction call site. See ./with-money-tx.ts.
export { withMoneyTx } from './with-money-tx';

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
 * @example
 *   // In Express middleware:
 *   await runInTenantContext(storeId, async () => {
 *     // All prisma.product.findMany() etc. calls inside here
 *     // are scoped to this storeId via RLS
 *     await handler(req, res);
 *   });
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runInTenantContext<T>(storeId: string, fn: () => Promise<T>): Promise<T> {
  if (!UUID_RE.test(storeId)) {
    throw new Error('Invalid store ID format');
  }
  return basePrisma.$transaction(
    async tx => {
      await tx.$executeRawUnsafe(
        `SET LOCAL app.current_store_id = '${storeId.replace(/'/g, "''")}'`
      );
      return tenantStorage.run(tx, fn);
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
