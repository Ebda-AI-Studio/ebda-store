import { BRAND } from '@ebda/shared';

/** Product name for a locale: "Ebda Store" / «ابدأ ستور» (BRAND.product, ruling PRODUCT-NAME-1). */
export function productName(locale: string): string {
  return locale === 'ar' ? BRAND.product.nameAr : BRAND.product.nameEn;
}

/** Document title: "<page> · Ebda Store"; the bare product name when there is no page. */
export function pageTitle(page: string | null | undefined, locale: string): string {
  const name = productName(locale);
  const p = page?.trim();
  return p ? `${p} · ${name}` : name;
}
