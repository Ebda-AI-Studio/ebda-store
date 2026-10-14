import { minorToDecimalString } from '@ebda/shared';
/**
 * Pure builder for the public AI product feed (agent_feed feature).
 * Field naming follows the OpenAI Product Feed conventions:
 * item_id / title / description / link / image_link / price / sale_price / availability.
 * Prices are stored in piastres; rendered as "125.00 EGP".
 */
export interface FeedStore {
  id: string;
  name: string;
  slug: string;
  currency: string;
}
export interface FeedProductInput {
  id: string;
  name: string;
  nameAr?: string | null;
  slug: string;
  description?: string | null;
  descriptionAr?: string | null;
  price: number;
  compareAtPrice?: number | null;
  inStock: boolean;
  acceptsBackorder: boolean;
  updatedAt: Date | string;
  images: Array<{ url: string; alt?: string | null; position: number }>;
  categories: Array<{ category: { name: string; slug: string } }>;
}
/**
 * A purchasable bundle, as it reaches the feed builder — the same shape
 * `bundle.service.ts`'s `listPurchasableBundles`/`describeBundleContents`
 * produce, kept as a separate input type (rather than reusing
 * `PurchasableBundleSummary` directly) so this file doesn't depend on
 * `@ebda/database`'s `DbClient` types. `componentSum` is the bundle's
 * pre-discount total — used ONLY as the feed's "was" price (mirrors
 * `compareAtPrice` for a product); the per-component allocation is never
 * exposed here (see `ResolvedBundle`'s doc comment in bundle.service.ts).
 */
export interface FeedBundleInput {
  id: string;
  name: string;
  nameAr?: string | null;
  slug: string;
  image?: string | null;
  price: number;
  componentSum: number;
  description?: string;
  descriptionAr?: string;
  updatedAt: Date | string;
}
export interface ProductFeedItem {
  item_id: string;
  title: string;
  title_ar?: string;
  description?: string;
  description_ar?: string;
  /**
   * Present on every entry — products link to `/products/<slug>`, bundles to
   * `/bundles/<slug>`. Kept optional in the type only so a future entry kind
   * without a page doesn't force a fake URL; nothing emits an entry without
   * one today.
   */
  link?: string;
  image_link?: string;
  additional_image_links?: string[];
  price: string;
  sale_price?: string;
  availability: 'in_stock' | 'out_of_stock' | 'backorder';
  categories: string[];
  updated_at: string;
  /**
   * Present (and `true`) ONLY on a bundle entry — absent on every product
   * entry, so a store with no purchasable bundles emits byte-identical
   * product entries to before this field existed. Lets a feed consumer
   * distinguish a bundle's catalog-table id from a product's without
   * guessing from the presence/absence of `link`.
   */
  is_bundle?: true;
}
export interface ProductFeedJson {
  version: '1.0';
  generated_at: string;
  store: { name: string; url: string; currency: string };
  product_count: number;
  products: ProductFeedItem[];
}

const money = (piastres: number, currency: string) =>
  `${minorToDecimalString(piastres, currency)} ${currency}`;

export function buildProductFeed(
  store: FeedStore,
  products: FeedProductInput[],
  baseUrl: string,
  bundles: FeedBundleInput[] = []
): ProductFeedJson {
  const items = products.map((p): ProductFeedItem => {
    const onSale = p.compareAtPrice != null && p.compareAtPrice > p.price;
    const images = [...p.images].sort((a, b) => a.position - b.position);
    return {
      item_id: p.id,
      title: p.name,
      ...(p.nameAr ? { title_ar: p.nameAr } : {}),
      ...(p.description ? { description: p.description } : {}),
      ...(p.descriptionAr ? { description_ar: p.descriptionAr } : {}),
      link: `${baseUrl}/products/${p.slug}`,
      ...(images[0] ? { image_link: images[0].url } : {}),
      ...(images.length > 1 ? { additional_image_links: images.slice(1).map(i => i.url) } : {}),
      price: money(onSale ? p.compareAtPrice! : p.price, store.currency),
      ...(onSale ? { sale_price: money(p.price, store.currency) } : {}),
      availability: p.inStock ? 'in_stock' : p.acceptsBackorder ? 'backorder' : 'out_of_stock',
      categories: p.categories.map(c => c.category.name),
      updated_at: new Date(p.updatedAt).toISOString(),
    };
  });

  // Bundles are only ever passed in when the `bundles` feature is enabled
  // for the store (see public.routes.ts) AND already filtered to
  // purchasable-right-now — sellable (`listSellableBundles`) and inside the
  // sale window, applied per request after the cache read (issues 2327 /
  // 2328) — this function trusts its
  // input rather than re-deriving that gate, same as it trusts `products`
  // is already limited to active ones.
  const bundleItems = bundles.map((b): ProductFeedItem => {
    // componentSum (the pre-discount total) plays the same role
    // compareAtPrice plays for a product: the crossed-out "was" price.
    const onSale = b.componentSum > b.price;
    return {
      item_id: b.id,
      title: b.name,
      ...(b.nameAr ? { title_ar: b.nameAr } : {}),
      ...(b.description ? { description: b.description } : {}),
      ...(b.descriptionAr ? { description_ar: b.descriptionAr } : {}),
      // P2-4 (final review): `/bundles/<slug>` shipped later in this branch
      // (apps/web/src/app/bundles/[slug]/page.tsx) — it is in the sitemap and
      // carries JSON-LD — so the comment that used to sit here ("no bundle
      // detail page exists on the storefront yet") was false, and an agent
      // reading the feed got a bundle it could not link a shopper to.
      link: `${baseUrl}/bundles/${b.slug}`,
      ...(b.image ? { image_link: b.image } : {}),
      price: money(onSale ? b.componentSum : b.price, store.currency),
      ...(onSale ? { sale_price: money(b.price, store.currency) } : {}),
      // Only ever `isPurchasable` bundles reach here (available >= 1,
      // including the UNTRACKED_AVAILABILITY_CAP case) — always in_stock,
      // never a raw availability count.
      availability: 'in_stock',
      categories: [],
      updated_at: new Date(b.updatedAt).toISOString(),
      is_bundle: true,
    };
  });

  const allItems = [...items, ...bundleItems];
  return {
    version: '1.0',
    generated_at: new Date().toISOString(),
    store: { name: store.name, url: baseUrl, currency: store.currency },
    product_count: allItems.length,
    products: allItems,
  };
}
