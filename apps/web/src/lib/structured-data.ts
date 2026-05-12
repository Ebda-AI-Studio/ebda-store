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
  /** Verified-purchase published reviews for JSON-LD. Server MUST pre-filter
   *  (status='published' AND verifiedPurchase=true) before passing here. */
  reviews?: Array<{
    author: string;
    rating: number;
    body: string;
    datePublished: string; // ISO 8601
    inLanguage?: 'en' | 'ar';
  }>;
  /** Aggregate over verified-purchase published reviews only. */
  aggregateRating?: {
    ratingValue: number;
    reviewCount: number;
  };
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
    // Emit aggregateRating only when there are real verified reviews.
    ...(product.aggregateRating && product.aggregateRating.reviewCount > 0
      ? { aggregateRating: aggregateRatingJsonLd(product.aggregateRating) }
      : {}),
    // Embed up to 20 review snippets inside the Product node.
    ...(product.reviews && product.reviews.length > 0
      ? { review: product.reviews.map(r => reviewJsonLd(r)) }
      : {}),
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

// ---------------------------------------------------------------------------
// BreadcrumbList — used on every interior page so AI agents understand the
// site hierarchy. Pass an array of { name, url } in order from root to leaf.
// ---------------------------------------------------------------------------
export function breadcrumbList(items: Array<{ name: string; url: string }>): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, idx) => ({
      '@type': 'ListItem',
      position: idx + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

// ---------------------------------------------------------------------------
// ItemList — used on listing pages (all products, category detail). Lists
// the products with inline minimal Product objects.
// ---------------------------------------------------------------------------
interface ItemListProduct {
  name: string;
  url: string;
  image?: string | null;
  price?: number | null; // in fils (KWD * 1000)
  currency?: string;
  inStock?: boolean;
}

export function itemList(products: ItemListProduct[], listName?: string): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    ...(listName ? { name: listName } : {}),
    numberOfItems: products.length,
    itemListElement: products.map((p, idx) => ({
      '@type': 'ListItem',
      position: idx + 1,
      item: {
        '@type': 'Product',
        name: p.name,
        url: p.url,
        ...(p.image ? { image: p.image } : {}),
        ...(p.price !== null && p.price !== undefined
          ? {
              offers: {
                '@type': 'Offer',
                price: (p.price / 1000).toFixed(3),
                priceCurrency: p.currency ?? 'KWD',
                availability:
                  p.inStock !== false
                    ? 'https://schema.org/InStock'
                    : 'https://schema.org/OutOfStock',
              },
            }
          : {}),
      },
    })),
  };
}

// ---------------------------------------------------------------------------
// Store — richer than the existing Organization schema. Used on store home.
// "Store" is a Schema.org subtype that maps to physical/online retail.
// ---------------------------------------------------------------------------
interface StoreSchemaData {
  name: string;
  url: string;
  logo?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  description?: string | null;
  social?: string[]; // sameAs URLs (Instagram, TikTok, Wikidata, etc.)
  inLanguage?: 'en' | 'ar';
  priceRange?: string; // e.g. "$$" — Schema.org Local Business signal
}

export function storeJsonLd(s: StoreSchemaData): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'Store',
    name: s.name,
    url: s.url,
    ...(s.logo ? { logo: s.logo, image: s.logo } : {}),
    ...(s.description ? { description: s.description } : {}),
    ...(s.email ? { email: s.email } : {}),
    ...(s.phone ? { telephone: s.phone } : {}),
    ...(s.address
      ? {
          address: {
            '@type': 'PostalAddress',
            streetAddress: s.address,
            addressCountry: 'KW', // Kuwait — platform-wide default for Force Store
          },
        }
      : {}),
    ...(s.social && s.social.length > 0 ? { sameAs: s.social } : {}),
    ...(s.inLanguage ? { inLanguage: s.inLanguage } : {}),
    ...(s.priceRange ? { priceRange: s.priceRange } : {}),
  };
}

// ---------------------------------------------------------------------------
// FAQPage — used on store home (if FAQs are set) + dedicated /help page.
// Each entry is a Question with an acceptedAnswer Answer.
// ---------------------------------------------------------------------------
export function faqPageJsonLd(faqs: Array<{ question: string; answer: string }>): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(f => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: f.answer,
      },
    })),
  };
}

// ---------------------------------------------------------------------------
// HowTo — used on dedicated /help page when HowTo guides exist. Each step
// is a HowToStep with a position + name + text + optional image.
// ---------------------------------------------------------------------------
export function howToJsonLd(data: {
  name: string;
  description: string;
  steps: Array<{ name: string; text: string; image?: string }>;
  totalTime?: string; // ISO 8601 duration e.g. "PT5M"
}): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name: data.name,
    description: data.description,
    ...(data.totalTime ? { totalTime: data.totalTime } : {}),
    step: data.steps.map((s, idx) => ({
      '@type': 'HowToStep',
      position: idx + 1,
      name: s.name,
      text: s.text,
      ...(s.image ? { image: s.image } : {}),
    })),
  };
}

// ---------------------------------------------------------------------------
// AggregateRating + Review — used on product pages ONLY when populated from
// real verified-purchase reviews. Never accept AI-generated content here.
// See docs/superpowers/plans/2026-05-12-ai-discovery-bilingual-email.md
// Track C (Tasks 26-31) for the enforcement architecture.
// ---------------------------------------------------------------------------
export function aggregateRatingJsonLd(data: {
  ratingValue: number;
  reviewCount: number;
  bestRating?: number;
  worstRating?: number;
}): object {
  return {
    '@type': 'AggregateRating',
    ratingValue: data.ratingValue.toFixed(1),
    reviewCount: data.reviewCount,
    bestRating: data.bestRating ?? 5,
    worstRating: data.worstRating ?? 1,
  };
}

export function reviewJsonLd(r: {
  author: string;
  rating: number;
  body: string;
  datePublished: string; // ISO 8601
  inLanguage?: 'en' | 'ar';
}): object {
  return {
    '@type': 'Review',
    author: { '@type': 'Person', name: r.author },
    reviewRating: {
      '@type': 'Rating',
      ratingValue: r.rating,
      bestRating: 5,
      worstRating: 1,
    },
    reviewBody: r.body,
    datePublished: r.datePublished,
    ...(r.inLanguage ? { inLanguage: r.inLanguage } : {}),
  };
}

/**
 * Resolve the canonical site URL for this store.
 */
export function getSiteUrl(store?: ResolvedStore): string {
  // Whitespace defense: a stray newline in the Vercel env var silently breaks
  // every URL in robots.txt + sitemap.xml (Google then can't fetch the map).
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return process.env.NEXT_PUBLIC_SITE_URL.trim().replace(/\/$/, '');
  }
  if (store?.domain) {
    return `https://${store.domain.trim()}`;
  }
  return 'https://store.forcemediakw.com';
}
