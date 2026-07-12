/**
 * Pure builder for the public AI product feed (agent_feed feature).
 * Field naming follows the OpenAI Product Feed conventions:
 * item_id / title / description / link / image_link / price / sale_price / availability.
 * Prices are stored in fils; rendered as "12.500 KWD".
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
export interface ProductFeedItem {
  item_id: string;
  title: string;
  title_ar?: string;
  description?: string;
  description_ar?: string;
  link: string;
  image_link?: string;
  additional_image_links?: string[];
  price: string;
  sale_price?: string;
  availability: 'in_stock' | 'out_of_stock' | 'backorder';
  categories: string[];
  updated_at: string;
}
export interface ProductFeedJson {
  version: '1.0';
  generated_at: string;
  store: { name: string; url: string; currency: string };
  product_count: number;
  products: ProductFeedItem[];
}

const money = (fils: number, currency: string) => `${(fils / 1000).toFixed(3)} ${currency}`;

export function buildProductFeed(
  store: FeedStore,
  products: FeedProductInput[],
  baseUrl: string
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
  return {
    version: '1.0',
    generated_at: new Date().toISOString(),
    store: { name: store.name, url: baseUrl, currency: store.currency },
    product_count: items.length,
    products: items,
  };
}
