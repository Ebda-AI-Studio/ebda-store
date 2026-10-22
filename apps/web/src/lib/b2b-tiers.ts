/**
 * Pure helpers for the PDP price-break table (B2B Task 6). The PUBLIC payload carries only public tiers; the signed-in buyer's
 * own prices come from POST /public/pricing/resolve and are painted client-side, so the cached / SSR HTML stays anonymous.
 */
export interface PublicTier {
  variantId: string | null;
  minQty: number;
  priceMinor: number;
}

/** Rows for the selected variant: variant-level breaks when that variant has any, else the product-level ones; ascending, one per minQty. */
export function tierRows(
  tiers: readonly PublicTier[],
  variantId: string | null | undefined
): PublicTier[] {
  const forVariant = variantId ? tiers.filter(t => t.variantId === variantId) : [];
  const source = forVariant.length > 0 ? forVariant : tiers.filter(t => t.variantId === null);
  const byQty = new Map<number, PublicTier>();
  for (const t of [...source].sort((a, b) => a.minQty - b.minQty || a.priceMinor - b.priceMinor)) {
    if (!byQty.has(t.minQty)) byQty.set(t.minQty, t); // lowest price wins a duplicate qty, as the resolver does
  }
  return [...byQty.values()];
}

/** The quantities to ask the server to price for the signed-in buyer: 1 plus every break (max 11 = under the endpoint's 50 cap). */
export function resolveQuantities(rows: readonly PublicTier[]): number[] {
  return [...new Set([1, ...rows.map(r => r.minQty)])].slice(0, 11);
}

export interface ResolvedPrice {
  productId: string;
  variantId: string | null;
  qty: number;
  unitPrice: number;
  listPrice: number;
  priceSource: 'base' | 'tier' | 'group';
}

/** qty -> the buyer's unit price, only where it is BELOW the retail list (otherwise there is nothing buyer-specific to show). */
export function buyerPricesByQty(prices: readonly ResolvedPrice[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const p of prices) if (p.unitPrice < p.listPrice) out.set(p.qty, p.unitPrice);
  return out;
}
