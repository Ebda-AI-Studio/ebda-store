import { storefrontOrigin } from '@ebda/shared';
import { storeDb } from '../repo-factory';
import type { FeedProductRow, FeedStoreInfo } from './build';

/**
 * Chunked reads for the feeds. The old AI feed read `listPublic` once (capped at 100 products). Here the catalogue is read in
 * keyset pages of PRODUCT_CHUNK ids (id > cursor, ordered by id: stable, index-friendly, never an OFFSET) so a store with
 * thousands of products never holds more than one chunk of raw rows at a time (Worker memory/CPU).
 * Only active, non-deleted, PUBLIC-audience products: the same visibility as the storefront listing.
 */
const PRODUCT_CHUNK = 100;

const PRODUCT_SELECT = {
  id: true,
  name: true,
  nameAr: true,
  slug: true,
  description: true,
  descriptionAr: true,
  excerpt: true,
  excerptAr: true,
  price: true,
  compareAtPrice: true,
  sku: true,
  barcode: true,
  inventory: true,
  trackInventory: true,
  allowBackorder: true,
  weight: true,
  facts: true,
  images: { orderBy: { position: 'asc' as const }, select: { url: true, position: true } },
  categories: {
    select: {
      category: { select: { id: true, name: true, nameAr: true, slug: true, parentId: true } },
    },
  },
  options: {
    select: {
      name: true,
      nameAr: true,
      values: { select: { id: true, value: true, valueAr: true } },
    },
  },
  variants: {
    orderBy: { position: 'asc' as const },
    select: {
      id: true,
      title: true,
      titleAr: true,
      sku: true,
      barcode: true,
      price: true,
      compareAtPrice: true,
      inventory: true,
      allowBackorder: true,
      isActive: true,
      weight: true,
      imageUrl: true,
    },
  },
} as const;

interface ProductChunk {
  products: FeedProductRow[];
  /** id to resume after; null = the catalogue ended. */
  nextCursor: string | null;
}

/** One keyset page of feed-ready product rows (variants carry their option value ids). */
export async function loadProductChunk(
  storeId: string,
  after: string | null
): Promise<ProductChunk> {
  const db = await storeDb(storeId);
  const rows = (await db.product.findMany({
    where: {
      storeId,
      status: 'active',
      deletedAt: null,
      audience: 'public',
      ...(after ? { id: { gt: after } } : {}),
    },
    orderBy: { id: 'asc' },
    take: PRODUCT_CHUNK + 1,
    select: PRODUCT_SELECT,
  })) as unknown as Array<
    Omit<FeedProductRow, 'variants'> & {
      variants: Array<Omit<FeedProductRow['variants'][number], 'optionValueIds'>>;
    }
  >;
  const page = rows.slice(0, PRODUCT_CHUNK);
  const variantIds = page.flatMap(p => p.variants.map(v => v.id));
  const links = variantIds.length
    ? ((await db.productVariantOption.findMany({
        where: { variantId: { in: variantIds } },
        select: { variantId: true, valueId: true },
      })) as Array<{ variantId: string; valueId: string }>)
    : [];
  const byVariant = new Map<string, string[]>();
  for (const l of links)
    byVariant.set(l.variantId, [...(byVariant.get(l.variantId) ?? []), l.valueId]);
  return {
    products: page.map(p => ({
      ...p,
      variants: p.variants.map(v => ({ ...v, optionValueIds: byVariant.get(v.id) ?? [] })),
    })),
    nextCursor: rows.length > PRODUCT_CHUNK ? page[page.length - 1].id : null,
  };
}

/** The store row the feeds need + a flat delivery fee when every active rate is the same. */
export async function loadFeedStore(storeId: string): Promise<{
  store: FeedStoreInfo;
  categories: Map<string, { name: string; nameAr?: string | null; parentId?: string | null }>;
}> {
  const db = await storeDb(storeId);
  const s = await db.store.findUniqueOrThrow({
    where: { id: storeId },
    select: { id: true, name: true, nameAr: true, slug: true, currency: true, domain: true },
  });
  const [zones, areas, cats] = await Promise.all([
    db.shippingZone.findMany({ where: { storeId, isActive: true }, select: { deliveryFee: true } }),
    db.shippingAreaRate.findMany({
      where: { storeId, isActive: true },
      select: { deliveryFee: true },
    }),
    db.category.findMany({
      where: { storeId, deletedAt: null },
      select: { id: true, name: true, nameAr: true, parentId: true },
    }),
  ]);
  const fees = new Set<number>([...zones, ...areas].map(r => r.deliveryFee));
  return {
    store: {
      name: s.name,
      nameAr: s.nameAr,
      currency: s.currency,
      // never request-derived: custom domain, else <slug>.ebda.app (feed poisoning, P1-2)
      origin: storefrontOrigin(s),
      flatShippingMinor: fees.size === 1 ? [...fees][0] : null,
    },
    categories: new Map(cats.map(c => [c.id, c])),
  };
}
