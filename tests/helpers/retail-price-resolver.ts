/**
 * A retail-only stand-in for `apps/api/src/services/price-resolver.service` in UNIT tests that mock Prisma (their mocked
 * client has no `productPriceTier` and no feature service). It runs the REAL pure `resolveUnitPrice` with no tiers and no
 * group, so a line prices at `variant.price ?? product.price` exactly as before B2B, and MOQ is reported.
 * Usage: vi.mock('@api/services/price-resolver.service', async () =>
 *          (await import('../helpers/retail-price-resolver')).retailPriceResolverModule());
 * Tests that exercise tiers / groups use the real module (tests/unit/price-resolver-service.test.ts and the integration suites).
 */
import { resolveUnitPrice, type Resolved } from '@ebda/shared';

interface Line {
  key: string;
  product: { id: string; price: number; moq?: number | null };
  variant?: { id: string; price?: number | null } | null;
  qty: number;
}

export function retailPriceResolverModule() {
  const priceCart = async (lines: readonly Line[]): Promise<Map<string, Resolved>> => {
    const productQty = new Map<string, number>();
    const variantQty = new Map<string, number>();
    for (const l of lines) {
      productQty.set(l.product.id, (productQty.get(l.product.id) ?? 0) + l.qty);
      if (l.variant) variantQty.set(l.variant.id, (variantQty.get(l.variant.id) ?? 0) + l.qty);
    }
    return new Map(
      lines.map(l => [
        l.key,
        resolveUnitPrice({
          baseMinor: l.variant?.price ?? l.product.price,
          productPriceMinor: l.product.price,
          qty: productQty.get(l.product.id)!,
          variantQty: l.variant ? variantQty.get(l.variant.id)! : undefined,
          variantId: l.variant?.id ?? null,
          buyerGroup: null,
          tiers: [],
          moq: l.product.moq ?? null,
        }),
      ])
    );
  };
  return {
    PriceResolver: {
      forBuyer: async () => ({
        groupName: null,
        priceCart,
        priceLine: async (product: Line['product'], variant: Line['variant'], qty: number) =>
          (await priceCart([{ key: 'line', product, variant, qty }])).get('line')!,
      }),
    },
    wholesaleEntitledUncached: async () => false,
    loadBuyerGroup: async () => null,
  };
}
