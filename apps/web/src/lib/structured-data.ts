import type { ResolvedStore } from './store-resolver';

interface ProductForJsonLd {
  name: string;
  description?: string;
  price: number;
  compareAtPrice?: number;
  sku?: string;
  slug: string;
  images?: Array<{ url: string; alt?: string }>;
  inventory?: number;
  categories?: Array<{ category?: { name?: string; slug?: string } }>;
}

/**
 * Schema.org Product structured data.
 * Returns a plain object suitable for JSON.stringify inside a <script type="application/ld+json"> tag.
 */
export function productJsonLd(product: ProductForJsonLd, store: ResolvedStore) {
  const siteUrl = getSiteUrl(store);
  const image = product.images?.[0]?.url;
  const availability =
    product.inventory === undefined || product.inventory > 0
      ? 'https://schema.org/InStock'
      : 'https://schema.org/OutOfStock';

  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    ...(product.description ? { description: product.description } : {}),
    ...(image ? { image } : {}),
    ...(product.sku ? { sku: product.sku } : {}),
    url: `${siteUrl}/products/${product.slug}`,
    ...(product.categories?.[0]?.category?.name
      ? { category: product.categories[0].category.name }
      : {}),
    offers: {
      '@type': 'Offer',
      price: (product.price / 1000).toFixed(3),
      priceCurrency: store.currency || 'KWD',
      availability,
      url: `${siteUrl}/products/${product.slug}`,
      seller: {
        '@type': 'Organization',
        name: store.name,
      },
    },
  };
}

/**
 * Schema.org Organization structured data for the store.
 */
export function organizationJsonLd(store: ResolvedStore) {
  const siteUrl = getSiteUrl(store);

  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: store.name,
    url: siteUrl,
    ...(store.logo ? { logo: store.logo } : {}),
    ...(store.email ? { email: store.email } : {}),
    ...(store.phone ? { telephone: store.phone } : {}),
    ...(store.address
      ? {
          address: {
            '@type': 'PostalAddress',
            streetAddress: store.address,
          },
        }
      : {}),
    ...(store.socialLinks
      ? {
          sameAs: Object.values(store.socialLinks).filter(Boolean),
        }
      : {}),
  };
}

interface BreadcrumbItem {
  name: string;
  url: string;
}

/**
 * Schema.org BreadcrumbList structured data.
 */
export function breadcrumbJsonLd(items: BreadcrumbItem[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

/**
 * Resolve the canonical site URL for this store.
 */
export function getSiteUrl(store?: ResolvedStore): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, '');
  }
  if (store?.domain) {
    return `https://${store.domain}`;
  }
  return 'https://force-web-sigma.vercel.app';
}
