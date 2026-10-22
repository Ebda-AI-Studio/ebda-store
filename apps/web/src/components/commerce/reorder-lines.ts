/** One cart line to put back when a customer orders an old order again. */
export interface ReorderLine {
  productId: string;
  variantId?: string;
  note?: string;
  quantity: number;
}

interface OrderLike {
  productId: string;
  variantId?: string | null;
  quantity: number;
  personalisation?: string | null;
  bundleGroupId?: string | null;
}

/**
 * The lines "order again" re-adds from an old order (Ruling B4-8): the same product, the same
 * variant and the same note, at the same quantity. A bundle component is skipped (a box is not
 * rebuilt line by line from its allocated shares); two rows that are the same line add up.
 */
export function reorderLines(items: readonly OrderLike[]): ReorderLine[] {
  const out = new Map<string, ReorderLine>();
  for (const i of items) {
    if (i.bundleGroupId || i.quantity < 1) continue;
    const note = i.personalisation?.trim() || undefined;
    const key = `${i.productId}|${i.variantId ?? ''}|${note ?? ''}`;
    const have = out.get(key);
    if (have) have.quantity += i.quantity;
    else
      out.set(key, {
        productId: i.productId,
        ...(i.variantId ? { variantId: i.variantId } : {}),
        ...(note ? { note } : {}),
        quantity: i.quantity,
      });
  }
  return [...out.values()];
}
