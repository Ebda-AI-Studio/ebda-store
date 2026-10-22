/**
 * Section types that exist only on the product, collection and cart pages (Ruling VE-3). Kept out of
 * `registry.ts` so the template work that edits it does not conflict with this block. They are
 * document-only (`legacyKey: null`), carry no settings of their own (each renders an existing
 * storefront component, whose options live in the page settings, Task 8e), and are rendered by the
 * page's own client, not by `PageRenderer`.
 */
import { z } from 'zod';
import type { SectionDefInput, SectionDefinition } from './registry';

// `enabled` is the legacy spelling of `hidden`, added when a node is projected for validation
const empty = z.object({ enabled: z.boolean().optional() }).strict();

type Def = (d: SectionDefInput) => SectionDefinition;

const section = (
  def: Def,
  type: string,
  labelEn: string,
  labelAr: string,
  pages: SectionDefinition['pages'],
  extra: { pinned?: boolean } = {}
): SectionDefinition =>
  def({
    type,
    labelEn,
    labelAr,
    legacyKey: null,
    rendererKey: `page.${type}`,
    group: 'template',
    pages,
    pinned: extra.pinned === true,
    // a pinned main and the singleton blocks appear once per page
    cardinality: 'one',
    maxCount: 1,
    propsSchema: empty,
    settings: [],
    presets: [{ nameEn: labelEn, nameAr: labelAr, settings: {} }],
  });

export function pageKindDefs(def: Def): SectionDefinition[] {
  return [
    // ---- product page: today's order is main, FAQ, reviews, frequently bought together,
    // you might also like, related products
    section(def, 'product-main', 'Product', 'المنتج', ['product'], { pinned: true }),
    section(def, 'product-faq', 'Product questions', 'أسئلة عن المنتج', ['product']),
    section(def, 'product-reviews', 'Reviews', 'التقييمات', ['product']),
    section(def, 'product-bundles', 'Frequently bought together', 'بيتشترى معاه', ['product']),
    section(def, 'product-recommendations', 'You might also like', 'ممكن يعجبك كمان', ['product']),
    section(def, 'product-related', 'Related products', 'منتجات مشابهة', ['product']),
    // ---- collection page (the product listing)
    section(def, 'collection-main', 'Products', 'المنتجات', ['collection'], { pinned: true }),
    // ---- cart page
    section(def, 'cart-main', 'Cart', 'السلة', ['cart'], { pinned: true }),
    section(def, 'cart-recommendations', 'Recommended for your cart', 'مقترح لسلتك', ['cart']),
  ];
}
