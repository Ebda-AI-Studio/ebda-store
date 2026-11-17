/**
 * What the page-builder AI may know about THIS store (page-builder AI v2): its name, template and look,
 * a bounded sample of its products and categories, and the references it is allowed to point a section at.
 * Read through the store's own scope (`storeDb`), so another store's catalogue can never appear here.
 * Product and category NAMES are merchant text: the caller hands them to the model as data, never as
 * instructions. Prices, stock, customers and orders are not read at all.
 */
import type { AiPatchAllow } from '@ebda/shared';
import { withStore } from '@ebda/database';
import { storeDb } from '../lib/repo-factory';

/** A page document is small; the catalogue sample must not dwarf it. */
export const AI_CONTEXT_MAX_PRODUCTS = 40;
export const AI_CONTEXT_MAX_CATEGORIES = 30;
/** Internal pages a section may link to, besides each listed product and category. */
const STATIC_LINKS = ['/products', '/categories', '/about', '/contact', '/faq'] as const;

export interface BuilderAiCatalogue {
  store: { name: string; nameAr: string | null; template: string | null; look: string | null };
  categories: Array<{ slug: string; name: string; nameAr: string | null }>;
  products: Array<{
    id: string;
    slug: string;
    name: string;
    nameAr: string | null;
    imageUrl: string | null;
  }>;
  allow: AiPatchAllow;
}

const clip = (s: string | null | undefined, n = 80) => (s ? s.slice(0, n) : null);

export async function loadBuilderAiCatalogue(storeId: string): Promise<BuilderAiCatalogue | null> {
  return withStore(storeId, async () => {
    const db = await storeDb(storeId);
    const store = await db.store.findUnique({
      where: { id: storeId },
      select: { name: true, nameAr: true, template: true, look: true },
    });
    if (!store) return null;
    const [products, categories] = await Promise.all([
      db.product.findMany({
        where: { storeId, status: 'active', deletedAt: null, audience: 'public' },
        orderBy: [{ featured: 'desc' }, { createdAt: 'desc' }],
        take: AI_CONTEXT_MAX_PRODUCTS,
        select: {
          id: true,
          slug: true,
          name: true,
          nameAr: true,
          images: { orderBy: { position: 'asc' }, take: 1, select: { url: true } },
        },
      }),
      db.category.findMany({
        where: { storeId, isActive: true },
        orderBy: { position: 'asc' },
        take: AI_CONTEXT_MAX_CATEGORIES,
        select: { slug: true, name: true, nameAr: true },
      }),
    ]);
    const prods = products.map(p => ({
      id: p.id,
      slug: p.slug,
      name: clip(p.name) ?? '',
      nameAr: clip(p.nameAr),
      imageUrl: p.images[0]?.url ?? null,
    }));
    const cats = categories.map(c => ({
      slug: c.slug,
      name: clip(c.name) ?? '',
      nameAr: clip(c.nameAr),
    }));
    return {
      store: {
        name: clip(store.name) ?? '',
        nameAr: clip(store.nameAr),
        template: store.template ?? null,
        look: store.look ?? null,
      },
      categories: cats,
      products: prods,
      allow: {
        productIds: new Set(prods.map(p => p.id)),
        categorySlugs: new Set(cats.map(c => c.slug)),
        imageUrls: new Set(prods.flatMap(p => (p.imageUrl ? [p.imageUrl] : []))),
        linkPaths: new Set([
          ...STATIC_LINKS,
          ...prods.map(p => `/products/${p.slug}`),
          ...cats.map(c => `/products?category=${c.slug}`),
        ]),
      },
    };
  });
}

/** The slice of the catalogue the prompt carries: references and names only. */
export function describeCatalogueForPrompt(c: BuilderAiCatalogue) {
  return {
    store: c.store,
    categories: c.categories,
    products: c.products.map(p => ({
      id: p.id,
      name: p.name,
      nameAr: p.nameAr,
      image: p.imageUrl,
      link: `/products/${p.slug}`,
    })),
    links: [...c.allow.linkPaths],
  };
}
