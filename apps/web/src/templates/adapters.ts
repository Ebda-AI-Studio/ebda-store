import type { Product, Category } from '@/lib/api';
import type { TemplateProduct, TemplateCategory } from './types';

/**
 * Map the API's Product shape into the TemplateProduct shape that every
 * template's ProductCard / ProductGrid accepts. Used wherever a page
 * renders products through the template system.
 */
export function toTemplateProduct(p: Product): TemplateProduct {
  return {
    id: p.id,
    name: p.name,
    // Preserve nameAr so RTL templates render Arabic product names instead
    // of falling through to the English `name`. The API consistently returns
    // `nameAr` for tenants that have entered it (e.g. Wady Aljuz).
    nameAr: p.nameAr,
    slug: p.slug,
    price: p.price,
    compareAtPrice: p.compareAtPrice ?? undefined,
    // Bug A fix: pass discountType + discountValue through so getDiscountBadgeText
    // can render "Save EGP X.XX" instead of "-Y%" for fixed-amount discounts.
    discountType: p.discountType ?? undefined,
    discountValue: p.discountValue ?? undefined,
    // Merchant-authored card badge. This adapter is an explicit whitelist, so
    // a field that is not named here is DROPPED — every card downstream would
    // render no badge while the admin showed a saved label. Same class of bug
    // as the `nameAr` and `discountType` lines above.
    badgeLabel: p.badgeLabel ?? undefined,
    badgeLabelAr: p.badgeLabelAr ?? undefined,
    images: (p.images || []).map(img => ({
      id: img.id || p.id,
      url: img.url,
      alt: img.alt,
    })),
    inStock: p.inventory === undefined || p.inventory === null || p.inventory > 0,
    // Pass variant prices through so the cards can derive
    // "From <min>" headlines for multi-variant products.
    variants: p.variants
      ? p.variants.map(v => ({
          price: typeof v.price === 'number' ? v.price : undefined,
          compareAtPrice: typeof v.compareAtPrice === 'number' ? v.compareAtPrice : undefined,
        }))
      : undefined,
    // Whitelist adapter: without this the card swatch dots never render.
    options: p.options,
  };
}

/**
 * Map the API's Category shape into the TemplateCategory shape.
 */
export function toTemplateCategory(c: Category): TemplateCategory {
  return {
    id: c.id,
    name: c.name,
    nameAr: c.nameAr,
    slug: c.slug || c.name.toLowerCase().replace(/\s+/g, '-'),
    image: c.image,
    productCount: c.productCount,
  };
}
