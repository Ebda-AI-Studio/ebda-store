import { prisma, hasTenantContext, runInTenantContext } from '@ebda/database';
import {
  customerRow,
  customerRows,
  isLiveCustomer,
  pickSelected,
} from '../../lib/customer-directory';
import type { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/error-handler';
import { storeRepo } from '../../lib/repo-factory';

/**
 * Assert that every id supplied in a request body belongs to the calling store.
 *
 * WHY THIS EXISTS
 *
 * The accounting services accept product / variant / supplier / account ids
 * straight from the request body and then write rows keyed on those bare ids.
 * Their route middleware (`authenticate -> authorize -> requireStoreAccess ->
 * requireFeature`) only proves the caller owns the store named in the URL — it
 * says nothing about ids in the payload. So a store_admin could harvest a
 * competitor's productId/variantId from the public storefront, post them as
 * line items on their OWN store's stock adjustment or purchase order, and
 * write another tenant's inventory, weighted-average cost, backorders and
 * order items.
 *
 * Production connects as a BYPASSRLS role, so there is no database backstop
 * for this today. App-layer scoping is the only boundary.
 *
 * SHAPE OF THE GUARD
 *
 * Batched (one query per entity type, not one per id) and fails with 404 —
 * never 403. A 403 would confirm that the foreign id exists, which is itself a
 * cross-tenant read. The error names no id for the same reason.
 *
 * Variants are checked through their parent product's storeId because
 * ProductVariant has no storeId column of its own.
 */
export interface StoreOwnedIds {
  productIds?: (string | null | undefined)[];
  variantIds?: (string | null | undefined)[];
  supplierIds?: (string | null | undefined)[];
  accountIds?: (string | null | undefined)[];
  customerIds?: (string | null | undefined)[];
  categoryIds?: (string | null | undefined)[];
}

/** Drop null/undefined and de-duplicate. */
function clean(ids: (string | null | undefined)[] | undefined): string[] {
  if (!ids?.length) return [];
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

function notFound(): never {
  // Deliberately generic: naming the offending id would confirm it exists.
  throw new AppError(404, 'NOT_FOUND', 'One or more referenced records were not found');
}

/**
 * Throws `AppError(404)` unless every supplied id resolves inside `storeId`.
 *
 * Pass the transaction client when calling from inside a transaction so the
 * check sees the same snapshot as the writes it is guarding.
 */
export async function assertStoreOwns(
  storeId: string,
  ids: StoreOwnedIds,
  client: Prisma.TransactionClient | typeof prisma = prisma
): Promise<void> {
  const productIds = clean(ids.productIds);
  const variantIds = clean(ids.variantIds);
  const supplierIds = clean(ids.supplierIds);
  const accountIds = clean(ids.accountIds);
  const customerIds = clean(ids.customerIds);
  const categoryIds = clean(ids.categoryIds);

  const [products, variants, suppliers, accounts, customers, categories] = await Promise.all([
    productIds.length
      ? client.product.findMany({
          where: { id: { in: productIds }, storeId },
          select: { id: true },
        })
      : [],
    variantIds.length
      ? client.productVariant.findMany({
          // ProductVariant carries no storeId; ownership is via its parent.
          where: { id: { in: variantIds }, product: { storeId } },
          select: { id: true },
        })
      : [],
    supplierIds.length
      ? client.supplier.findMany({
          where: { id: { in: supplierIds }, storeId },
          select: { id: true },
        })
      : [],
    accountIds.length
      ? client.account.findMany({
          where: { id: { in: accountIds }, storeId },
          select: { id: true },
        })
      : [],
    customerIds.length
      ? ((await customerRows(storeId, customerIds)) ??
        client.user.findMany({ where: { id: { in: customerIds }, storeId }, select: { id: true } }))
      : [],
    categoryIds.length
      ? client.category.findMany({
          where: { id: { in: categoryIds }, storeId },
          select: { id: true },
        })
      : [],
  ]);

  if (products.length !== productIds.length) notFound();
  if (variants.length !== variantIds.length) notFound();
  if (suppliers.length !== supplierIds.length) notFound();
  if (accounts.length !== accountIds.length) notFound();
  if (customers.length !== customerIds.length) notFound();
  if (categories.length !== categoryIds.length) notFound();
}

/**
 * Run the ownership guard in the same RLS posture as the writes it protects,
 * WITHOUT opening a second transaction when one is already ambient (issue
 * 2057).
 *
 * - Ambient tenant context (the HTTP routes wrap the service call in
 *   `runInTenantContext(req.params.storeId, …)`; barcode reconcile does the
 *   same): the `prisma` proxy already routes onto that transaction with the
 *   store GUC set, so the guard runs there. Opening a nested
 *   `runInTenantContext` would take a SECOND pool connection while the outer
 *   one is held (the double-nest `routes/index.ts` warns about) and read a
 *   different snapshot from the writes it guards.
 * - No ambient context: open a tenant-scoped transaction for the GUARD ALONE,
 *   so a GUC-less read under RLS cannot 404 every legitimately-owned id.
 *   This does NOT scope the caller's writes (issue 2291) — a service that can
 *   be reached with no ambient context must scope its whole body itself
 *   (`createExpense` wraps itself in `runInTenantContext`; the purchase-order
 *   and stock-adjustment writers are only reached through routes that wrap
 *   the call).
 */
export async function assertStoreOwnsInTenantScope(
  storeId: string,
  ids: StoreOwnedIds
): Promise<void> {
  // A store on its Durable Object owns its rows there (Ruling CF-R7-1): the same checks, against the DO read client.
  const repo = await storeRepo(storeId);
  if (repo.backend === 'do') {
    await assertStoreOwns(storeId, ids, repo.db as unknown as typeof prisma);
    return;
  }
  if (hasTenantContext()) {
    await assertStoreOwns(storeId, ids);
    return;
  }
  await runInTenantContext(storeId, () => assertStoreOwns(storeId, ids));
}
