/**
 * Merchant-managed reorder rules (M-107). `ReorderRule` had a reader (reorder-scan, low-stock analytics) and no
 * writer, so the reorder report had no data. This is the one writer. NO money effect: a rule only holds thresholds
 * (min qty, reorder qty, lead time, safety days, preferred supplier); nothing here posts to the books or moves stock.
 *
 * Uniqueness is (storeId, productId, variantId). `variant_id` is nullable and a NULL is distinct in a plain unique index, so
 * the database enforces it with `reorder_rules_one_per_item` on (store_id, product_id, COALESCE(variant_id, '')): Postgres
 * migration 20261111000100 and the StoreDO's cf-0005 (both dedupe existing rows, keeping the newest). The pre-check below
 * only gives the common case a cheap answer; the index decides a race, and the loser's unique violation (P2002 on either
 * backend) is answered as the same 409.
 *
 * Every id the body supplies (product, variant, supplier) is verified to belong to THIS store before it is written.
 */
import { storeDb, storeWriter } from '../../lib/repo-factory';
import { AppError } from '../../middleware/error-handler';
import { withSavepoint } from '../../lib/savepoint';
import { isP2002 } from '../../lib/prisma-errors';

export interface ReorderRuleInput {
  productId: string;
  variantId?: string | null;
  minQty: number;
  reorderQty: number;
  leadTimeDays?: number;
  safetyStockDays?: number;
  preferredSupplierId?: string | null;
  isActive?: boolean;
}

export type ReorderRulePatch = Partial<Omit<ReorderRuleInput, 'productId' | 'variantId'>>;

const RULE_INCLUDE = {
  product: { select: { id: true, name: true, nameAr: true, sku: true } },
  variant: { select: { id: true, title: true, titleAr: true, sku: true } },
  preferredSupplier: { select: { id: true, name: true } },
} as const;

async function assertOwnedRefs(
  storeId: string,
  refs: { productId?: string; variantId?: string | null; supplierId?: string | null }
): Promise<void> {
  const db = await storeDb(storeId);
  if (refs.productId) {
    const product = await db.product.findFirst({
      where: { id: refs.productId, storeId, deletedAt: null },
      select: { id: true },
    });
    if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found in this store.');
    if (refs.variantId) {
      const variant = await db.productVariant.findFirst({
        where: { id: refs.variantId, productId: refs.productId },
        select: { id: true },
      });
      if (!variant)
        throw new AppError(404, 'VARIANT_NOT_FOUND', 'Variant not found on this product.');
    }
  }
  if (refs.supplierId) {
    const supplier = await db.supplier.findFirst({
      where: { id: refs.supplierId, storeId, deletedAt: null },
      select: { id: true },
    });
    if (!supplier) throw new AppError(404, 'SUPPLIER_NOT_FOUND', 'Supplier not found.');
  }
}

export async function listReorderRules(storeId: string) {
  const db = await storeDb(storeId);
  return db.reorderRule.findMany({
    where: { storeId },
    include: RULE_INCLUDE,
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: 500,
  });
}

const exists = () =>
  new AppError(409, 'REORDER_RULE_EXISTS', 'A reorder rule already exists for this item.');

export async function createReorderRule(storeId: string, input: ReorderRuleInput) {
  const variantId = input.variantId ?? null;
  await assertOwnedRefs(storeId, {
    productId: input.productId,
    variantId,
    supplierId: input.preferredSupplierId,
  });
  const db = await storeDb(storeId);
  const dup = await db.reorderRule.findFirst({
    where: { storeId, productId: input.productId, variantId },
    select: { id: true },
  });
  if (dup) throw exists();
  const w = await storeWriter(storeId);
  let created: { id: string };
  try {
    // Savepoint: on Postgres a unique violation would otherwise abort the request's tenant transaction.
    created = await withSavepoint(() =>
      w.reorderRule.create({
        data: {
          storeId,
          productId: input.productId,
          variantId,
          minQty: input.minQty,
          reorderQty: input.reorderQty,
          leadTimeDays: input.leadTimeDays ?? 7,
          safetyStockDays: input.safetyStockDays ?? 7,
          preferredSupplierId: input.preferredSupplierId ?? null,
          isActive: input.isActive ?? true,
        },
      })
    );
  } catch (err) {
    if (isP2002(err)) throw exists();
    throw err;
  }
  return (await db.reorderRule.findFirst({
    where: { id: created.id, storeId },
    include: RULE_INCLUDE,
  }))!;
}

export async function updateReorderRule(storeId: string, id: string, patch: ReorderRulePatch) {
  const db = await storeDb(storeId);
  const owned = await db.reorderRule.findFirst({ where: { id, storeId }, select: { id: true } });
  if (!owned) throw new AppError(404, 'REORDER_RULE_NOT_FOUND', 'Reorder rule not found.');
  await assertOwnedRefs(storeId, { supplierId: patch.preferredSupplierId });
  const w = await storeWriter(storeId);
  await w.reorderRule.update({ where: { id, storeId }, data: { ...patch } });
  return (await db.reorderRule.findFirst({ where: { id, storeId }, include: RULE_INCLUDE }))!;
}

export async function deleteReorderRule(storeId: string, id: string): Promise<void> {
  const db = await storeDb(storeId);
  const owned = await db.reorderRule.findFirst({ where: { id, storeId }, select: { id: true } });
  if (!owned) throw new AppError(404, 'REORDER_RULE_NOT_FOUND', 'Reorder rule not found.');
  const w = await storeWriter(storeId);
  await w.reorderRule.delete({ where: { id, storeId } });
}
