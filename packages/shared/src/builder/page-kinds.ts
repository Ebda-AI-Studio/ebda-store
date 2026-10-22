/**
 * Page kinds the visual editor edits as section documents (Ruling VE-3, amended 2026-10-22).
 *
 * Like Shopify's JSON page templates: `home`, `product`, `collection` and `cart` each have their own
 * per-store document. Every kind has ONE pinned "main" section, the page's real content (the product
 * gallery with its buy box, the product listing with its filters, the cart lines with their summary).
 * The merchant can move it and add, move, hide and remove the other sections around it, but cannot
 * remove or hide it. A store with no saved document for a kind gets `defaultPageDocument(kind)`, which
 * renders exactly what the page rendered before documents existed (so nothing is migrated).
 * Checkout and locations stay page settings: they carry payment and legal flow.
 */
export const PAGE_KINDS = ['home', 'product', 'collection', 'cart'] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

/** Every kind except the home page: pages whose document holds sections only (no theme, chrome or typography patch). */
export const SECTION_PAGE_KINDS = ['product', 'collection', 'cart'] as const;
export type SectionPageKind = (typeof SECTION_PAGE_KINDS)[number];

export const isPageKind = (v: unknown): v is PageKind =>
  typeof v === 'string' && (PAGE_KINDS as readonly string[]).includes(v);

export const isSectionPageKind = (v: unknown): v is SectionPageKind =>
  typeof v === 'string' && (SECTION_PAGE_KINDS as readonly string[]).includes(v);

/** The pinned section type of each non-home kind. */
export const MAIN_SECTION_TYPE: Record<SectionPageKind, string> = {
  product: 'product-main',
  collection: 'collection-main',
  cart: 'cart-main',
};

export const PAGE_KIND_LABELS: Record<PageKind, { en: string; ar: string }> = {
  home: { en: 'Home', ar: 'الرئيسية' },
  product: { en: 'Product', ar: 'المنتج' },
  collection: { en: 'Collection', ar: 'المجموعة' },
  cart: { en: 'Cart', ar: 'السلة' },
};
