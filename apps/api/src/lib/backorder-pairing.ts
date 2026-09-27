/**
 * Pair each backordered decrement with exactly ONE order line.
 *
 * `OrderService.create` records one backordered entry per line it had to
 * force-decrement, then tags order lines with a BackorderLine. The match used
 * to be a non-consuming `find` on (productId, variantId), which was 1:1 only
 * while an order held at most one line per SKU. Bundles break that: N boxes of
 * a bundle holding the same product write N order lines with the same
 * (productId, variantId), and every one of them matched the single backordered
 * entry — recording N units of backorder debt for one short unit (#1552).
 * Downstream that inflated the reorder backlog, and purchase-order receiving
 * then "cleared" the phantom lines before replenishing on-hand stock, so real
 * units were lost from sellable inventory.
 *
 * Consuming: each entry is used once. Among same-SKU candidates, an entry with
 * the line's own quantity is preferred so a line is paired with the decrement
 * it actually caused.
 */
export interface BackorderedEntry {
  productId: string;
  variantId?: string | null;
  quantity: number;
}

export interface OrderLineRef {
  id: string;
  productId: string;
  variantId?: string | null;
  quantity: number;
}

export function pairBackorderedLines<L extends OrderLineRef>(
  lines: readonly L[],
  backordered: readonly BackorderedEntry[]
): Array<{ line: L; quantity: number }> {
  const unpaired = [...lines];
  const pairs: Array<{ line: L; quantity: number }> = [];
  for (const entry of backordered) {
    const sameSku = (l: L) =>
      l.productId === entry.productId && (l.variantId ?? null) === (entry.variantId ?? null);
    let idx = unpaired.findIndex(l => sameSku(l) && l.quantity === entry.quantity);
    if (idx === -1) idx = unpaired.findIndex(sameSku);
    if (idx === -1) continue;
    const [line] = unpaired.splice(idx, 1);
    pairs.push({ line, quantity: entry.quantity });
  }
  return pairs;
}
