/**
 * Pure helpers for the B2B minimum order quantity on the storefront (Review Focus 7). The SERVER decides (the cart response
 * carries `belowMoq` / `moqRequired` per line; the order is refused with 422 BELOW_MOQ); these only turn that into UI state.
 */
export interface MoqLine {
  productId: string;
  name: string;
  nameAr?: string;
  quantity: number;
  belowMoq?: boolean;
  moqRequired?: number;
  unavailable?: boolean;
}

/** One entry per PRODUCT below its MOQ (variant lines of one product are one problem), with the product total. */
export function moqShortfalls(
  lines: readonly MoqLine[]
): Array<{ productId: string; name: string; nameAr?: string; required: number; current: number }> {
  const byProduct = new Map<
    string,
    { productId: string; name: string; nameAr?: string; required: number; current: number }
  >();
  for (const l of lines) {
    if (l.unavailable || !l.belowMoq || !l.moqRequired) continue;
    const cur = byProduct.get(l.productId);
    if (cur) cur.current += l.quantity;
    else
      byProduct.set(l.productId, {
        productId: l.productId,
        name: l.name,
        nameAr: l.nameAr,
        required: l.moqRequired,
        current: l.quantity,
      });
  }
  return [...byProduct.values()];
}

/** The cart message naming every product below its MOQ. Latin digits (NUMERALS-1). */
export function moqCartMessage(
  shortfalls: ReturnType<typeof moqShortfalls>,
  lang: 'en' | 'ar'
): string | undefined {
  if (shortfalls.length === 0) return undefined;
  const list = shortfalls
    .map(s => `${lang === 'ar' ? s.nameAr || s.name : s.name} (${s.current}/${s.required})`)
    .join(lang === 'ar' ? '، ' : ', ');
  return lang === 'ar'
    ? `بعض المنتجات أقل من الحد الأدنى للكمية: ${list}. زد الكمية لإتمام الطلب.`
    : `Some items are below their minimum order quantity: ${list}. Increase the quantity to check out.`;
}

/** The API accepts up to 1000 per line (cart.routes quantity max). */
export const SERVER_MAX_QTY = 1000;

/**
 * The most a PDP stepper lets the shopper pick (review M7). Retail stays at its usual cap (`base`), but a product with a
 * minimum order or a price break above that cap must be reachable, or the MOQ / the tier table promise a quantity the page
 * cannot select.
 */
export function pdpMaxQty(
  base: number,
  moq: number | null | undefined,
  tiers: ReadonlyArray<{ minQty: number }> | null | undefined
): number {
  const top = Math.max(base, moq ?? 0, ...(tiers ?? []).map(t => t.minQty));
  return Math.min(top, SERVER_MAX_QTY);
}

/** Cart stepper cap: a line with a MOQ, or already on a tier / group price, is a trade quantity and may exceed the retail cap. */
export function cartMaxQty(line: {
  moqRequired?: number | null;
  priceSource?: 'base' | 'tier' | 'group';
}): number {
  return line.moqRequired || (line.priceSource && line.priceSource !== 'base')
    ? SERVER_MAX_QTY
    : 10;
}

/**
 * The quantity increase that clears a MOQ shortfall for one product, as the quantity to set on its first cart line
 * ("Set to N" action in the cart, review M7). `lines` are that product's lines.
 */
export function moqFix(
  shortfall: { productId: string; required: number; current: number },
  lines: ReadonlyArray<{ id: string; productId: string; quantity: number }>
): { lineId: string; quantity: number } | null {
  const first = lines.find(l => l.productId === shortfall.productId);
  if (!first) return null;
  return { lineId: first.id, quantity: first.quantity + (shortfall.required - shortfall.current) };
}
