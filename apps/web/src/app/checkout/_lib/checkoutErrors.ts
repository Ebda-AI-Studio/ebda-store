/** The order's locale from the storefront language: Arabic only when the shopper is on Arabic. */
export function orderLocale(language: string): 'en' | 'ar' {
  return language === 'ar' ? 'ar' : 'en';
}

/**
 * Shopper-facing copy for order-creation failures that need their own message.
 * Pure (takes `t`) so it is unit tested without mounting CheckoutClient.
 */
export function subscriptionRequiredCopy(code: string, t: (en: string, ar: string) => string) {
  if (code !== 'SUBSCRIPTION_REQUIRED') return null;
  return t(
    'This store is not taking orders right now. Please try again later.',
    'المتجر مش بيستقبل طلبات دلوقتي. جرّب تاني بعدين.'
  );
}

interface PersonalisationRefusal {
  name?: string;
  nameAr?: string | null;
  label?: string;
  labelAr?: string;
}

/**
 * `PERSONALISATION_REQUIRED` at order creation: a cart line of a product whose
 * merchant requires a text (e.g. the name to embroider) has none, typically
 * because it was added before the field became required. The text can only be
 * typed on the product page, so the copy names the item and the field and the
 * alert links back to the cart. Arabic first; each name/label falls back to
 * the other language, never blank.
 */
export function personalisationRequiredCopy(
  code: string,
  details: unknown,
  t: (en: string, ar: string) => string,
  language: string
): string | null {
  if (code !== 'PERSONALISATION_REQUIRED') return null;
  const ar = language === 'ar';
  const raw = (details as { products?: unknown } | null | undefined)?.products;
  const items = (Array.isArray(raw) ? raw : []) as PersonalisationRefusal[];
  const pick = (en?: string | null, arText?: string | null) =>
    (ar ? arText || en : en || arText) || '';
  const parts = items
    .map(p => ({ label: pick(p.label, p.labelAr), product: pick(p.name, p.nameAr) }))
    .filter(p => p.product);
  if (parts.length === 0) {
    return t(
      'An item in your cart needs your personalisation. Add it on the product page.',
      'في منتج في سلتك محتاج تخصيص. اكتبه من صفحة المنتج.'
    );
  }
  return parts
    .map(p =>
      t(
        `Add “${p.label || 'your personalisation'}” for ${p.product} on its product page.`,
        `اكتب ${p.label || 'التخصيص'} لـ ${p.product} من صفحة المنتج.`
      )
    )
    .join(' ');
}
