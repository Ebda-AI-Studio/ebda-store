import type { Prisma } from '@prisma/client';

/**
 * Atomic inventory decrement helpers for order placement.
 *
 * Why raw atomic UPDATEs instead of `SELECT … FOR UPDATE` + a later
 * `update({ decrement })`: the conditional `UPDATE … WHERE inventory >= qty`
 * does the stock check AND the decrement in a single statement, so there is no
 * read-then-write window and no need to hold an explicit row lock across the
 * rest of the (multi-step) order transaction. Under a flash-sale storm on one
 * SKU this removes the N extra FOR-UPDATE round-trips to Neon and the
 * lock-acquired-early window — the row write-lock is taken at the decrement,
 * not at an upfront SELECT. Correctness (no oversell) is guaranteed by the
 * `inventory >= qty` guard: a losing concurrent writer sees 0 rows affected.
 *
 * There is deliberately NO unfloored product decrement here. One existed
 * until 2026-08-30 to mirror a variant sale onto the parent
 * `products.inventory` column; because a variant product's parent column
 * starts at 0, it only ever went down, and 24 live products had drifted as
 * far as -16 while their variants held four-figure stock. A line decrements
 * the variant row or the product row, never both — see
 * lib/effective-inventory.ts and
 * docs/superpowers/plans/2026-08-30-variant-stock-drift.md.
 */

export interface DecrementResult {
  /** true = decremented within available stock; false = would go below 0 (no mutation). */
  ok: boolean;
  /** Stock before this decrement (accurate, from RETURNING). */
  previousStock: number;
  /** Stock after this decrement (accurate, from RETURNING). */
  newStock: number;
}

/** Conditional decrement — only when enough stock exists. ok=false ⇒ no mutation. */
export async function decrementProductInventory(
  tx: Prisma.TransactionClient,
  productId: string,
  qty: number
): Promise<DecrementResult> {
  const rows = await tx.$queryRaw<Array<{ inventory: number }>>`
    UPDATE public.products
    SET inventory = inventory - ${qty}
    WHERE id = ${productId} AND inventory >= ${qty}
    RETURNING inventory
  `;
  if (rows.length === 1) {
    return { ok: true, previousStock: rows[0].inventory + qty, newStock: rows[0].inventory };
  }
  const [cur] = await tx.$queryRaw<Array<{ inventory: number }>>`
    SELECT inventory FROM public.products WHERE id = ${productId}
  `;
  const inv = cur?.inventory ?? 0;
  return { ok: false, previousStock: inv, newStock: inv };
}

/** Conditional variant decrement — only when enough variant stock exists. */
export async function decrementVariantInventory(
  tx: Prisma.TransactionClient,
  variantId: string,
  qty: number
): Promise<DecrementResult> {
  const rows = await tx.$queryRaw<Array<{ inventory: number }>>`
    UPDATE public.product_variants
    SET inventory = inventory - ${qty}
    WHERE id = ${variantId} AND inventory >= ${qty}
    RETURNING inventory
  `;
  if (rows.length === 1) {
    return { ok: true, previousStock: rows[0].inventory + qty, newStock: rows[0].inventory };
  }
  const [cur] = await tx.$queryRaw<Array<{ inventory: number }>>`
    SELECT inventory FROM public.product_variants WHERE id = ${variantId}
  `;
  const inv = cur?.inventory ?? 0;
  return { ok: false, previousStock: inv, newStock: inv };
}

/** Unconditional variant decrement (backorder path) — floored at 0 so variant
 *  inventory never stores a negative value. The order is still accepted (the
 *  acceptsBackorder flag gates that), but the column stays non-negative so the
 *  admin inventory grid never shows "-2" or similar. */
export async function forceDecrementVariantInventory(
  tx: Prisma.TransactionClient,
  variantId: string,
  qty: number
): Promise<DecrementResult> {
  // Read the real pre-decrement stock under the row lock (#2299). It used to
  // be reconstructed as `newStock + qty`, which is wrong exactly when the
  // floor bites (2 on hand, 5 ordered → 0 reported a previous stock of 5): the
  // sale's ledger row overstated the movement, and the backorder line could
  // not know that checkout took only 2.
  const [cur] = await tx.$queryRaw<Array<{ inventory: number }>>`
    SELECT inventory FROM public.product_variants WHERE id = ${variantId} FOR UPDATE
  `;
  const [row] = await tx.$queryRaw<Array<{ inventory: number }>>`
    UPDATE public.product_variants SET inventory = GREATEST(0, inventory - ${qty})
    WHERE id = ${variantId}
    RETURNING inventory
  `;
  const newStock = row?.inventory ?? 0;
  return { ok: true, previousStock: cur?.inventory ?? newStock + qty, newStock };
}

/**
 * Takes UP TO `qty` units (never below 0, never raising a negative backorder debt) in ONE atomic statement and reports what
 * was ACTUALLY taken (`previousStock - newStock`). The row is locked by the sub-select, so a concurrent sale cannot slip
 * between the read of the stock and the write: the phone-order override books its ledger row and `stock_not_taken` marker from it.
 */
export async function takeUpToInventory(
  tx: Prisma.TransactionClient,
  target: { productId: string; variantId?: string | null },
  qty: number
): Promise<{ previousStock: number; newStock: number }> {
  const rows = target.variantId
    ? await tx.$queryRaw<Array<{ previous: number; current: number }>>`
        UPDATE public.product_variants AS t
        SET inventory = t.inventory - LEAST(${qty}, GREATEST(t.inventory, 0))
        FROM (SELECT id, inventory FROM public.product_variants WHERE id = ${target.variantId} FOR UPDATE) AS o
        WHERE t.id = o.id
        RETURNING o.inventory AS previous, t.inventory AS current`
    : await tx.$queryRaw<Array<{ previous: number; current: number }>>`
        UPDATE public.products AS t
        SET inventory = t.inventory - LEAST(${qty}, GREATEST(t.inventory, 0))
        FROM (SELECT id, inventory FROM public.products WHERE id = ${target.productId} FOR UPDATE) AS o
        WHERE t.id = o.id
        RETURNING o.inventory AS previous, t.inventory AS current`;
  if (rows.length !== 1) throw new Error('takeUpToInventory: stock row not found');
  return { previousStock: rows[0].previous, newStock: rows[0].current };
}
