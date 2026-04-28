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
    images: (p.images || []).map(img => ({
      id: img.id || p.id,
      url: img.url,
      alt: img.alt,
    })),
    inStock: p.inventory === undefined || p.inventory === null || p.inventory > 0,
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
