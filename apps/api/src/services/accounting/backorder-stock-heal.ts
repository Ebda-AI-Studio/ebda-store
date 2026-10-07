import type { Prisma } from '@force/database';

/**
 * Heal a NON-variant product's backorder stock debt, up to 0 and never above
 * (owner decision 2026-10-01, #2277, ruling AP-5c; extended to PO receipts by
 * #2299, ruling AP-5d).
 *
 * A NON-variant backordered sale force-decrements `products.inventory`
 * unfloored (`OrderService.create`), so the product carries the shortfall as a
 * negative debt. When a backorder line's units leave the backlog — cancelled
 * (`cancelBackorder`) or fulfilled by a PO receipt (`receivePurchaseOrder`) —
 * this heals `min(units, −inventory)` of it: the negative part comes back, the
 * row never goes above 0, and a product that is not negative gets nothing — a
 * line that left no debt cannot add phantom units.
 *
 * A VARIANT line heals nothing. Checkout floors variant rows at 0
 * (`forceDecrementVariantInventory`), so a variant backorder never drives
 * stock negative and there is no debt of the line's to heal. An untracked
 * product is skipped too — checkout never decremented it.
 *
 * Writes the `return_stock` InventoryHistory row the same way every other
 * stock writer does. `reference` must NOT be the orderId: the whole-order
 * restore reads an orderId-referenced `return_stock` row as "this order was
 * already restored". The caller busts the product caches after its write.
 * Returns the units healed.
 */
export async function healBackorderStockDebt(
  tx: Prisma.TransactionClient,
  args: {
    storeId: string;
    productId: string;
    variantId: string | null;
    quantity: number;
    reference: string;
    reason: string;
    userId?: string | null;
  }
): Promise<number> {
  const { storeId, productId, variantId, quantity, reference, reason, userId } = args;
  if (variantId || quantity <= 0) return 0;

  const [row] = await tx.$queryRaw<Array<{ inventory: number; track_inventory: boolean }>>`
    SELECT inventory, track_inventory FROM public.products
    WHERE id = ${productId} AND store_id = ${storeId}
    FOR UPDATE
  `;
  if (!row || !row.track_inventory || row.inventory >= 0) return 0;

  const healed = Math.min(quantity, -row.inventory);
  await tx.product.update({
    where: { id: productId, storeId },
    data: { inventory: { increment: healed } },
  });
  await tx.inventoryHistory.create({
    data: {
      productId,
      storeId,
      type: 'return_stock',
      quantity: healed,
      previousStock: row.inventory,
      newStock: row.inventory + healed,
      reason,
      reference,
      createdBy: userId ?? null,
    },
  });
  return healed;
}
