// Database Package - Prisma Client Export
import { PrismaClient } from '@prisma/client';

// Prevent multiple instances in development
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
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
      u.searchParams.set('pool_timeout', '10');
    }
    if (!u.searchParams.has('connection_limit')) {
      u.searchParams.set('connection_limit', '5');
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
  globalForPrisma.prisma = prisma;
}

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
} from '@prisma/client';

export { prisma as db };

/**
 * Execute a callback within a tenant-scoped transaction.
 * Sets `app.current_store_id` so that RLS policies restrict access
 * to only the specified store's data.
 *
 * Usage:
 *   const products = await withTenantContext(storeId, async (tx) => {
 *     return tx.product.findMany();
 *   });
 *
 * For super_admin operations that need cross-tenant access, call
 * prisma directly without this wrapper.
 */
export async function withTenantContext<T>(
  storeId: string,
  fn: (
    tx: Omit<
      PrismaClient,
      '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
    >
  ) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe(`SET LOCAL app.current_store_id = '${storeId.replace(/'/g, "''")}'`);
    return fn(tx);
  });
}
