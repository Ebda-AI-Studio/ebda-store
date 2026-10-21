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
