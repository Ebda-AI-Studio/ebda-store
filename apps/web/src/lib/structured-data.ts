import type { ResolvedStore } from './store-resolver';
import { pickMetaDescription } from './seo/meta-description';
import type { StorefrontLocale } from './seo/resolve-locale';

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
/**
 * schema.org Brand.
 *
 * Agents use brand to group and compare products across sellers. FWB stores are
 * single-brand and there is no per-product brand column, so the store name IS
 * the brand — there is nothing more specific to prefer over it.
 */
export function brandJsonLd(store: Pick<ResolvedStore, 'name'>) {
  return { '@type': 'Brand', name: store.name };
}

/**
 * schema.org MerchantReturnPolicy.
 *
 * Emitted ONLY when the merchant explicitly declared a window. `null`/undefined
 * (unset) and `0` mean different things and must not be collapsed:
 *   unset -> "we have not said"      -> omit the block entirely
 *   0     -> "we do not take returns" -> a real, publishable policy
 *
 * There is no sensible default. Publishing a guessed return window is a false
 * public claim about the merchant's business, and Google treats merchant return
 * policy as a commitment, not a hint.
 */
export function merchantReturnPolicyJsonLd(
  store: Pick<ResolvedStore, 'returnWindowDays' | 'returnFeesPaidBy'>
) {
  const days = store.returnWindowDays;
  if (days === null || days === undefined) return null;

  if (days === 0) {
    return {
      '@type': 'MerchantReturnPolicy',
      applicableCountry: 'KW',
      returnPolicyCategory: 'https://schema.org/MerchantReturnNotPermitted',
    };
  }

  return {
    '@type': 'MerchantReturnPolicy',
    applicableCountry: 'KW',
    returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
    merchantReturnDays: days,
    returnMethod: 'https://schema.org/ReturnByMail',
    returnFees:
      store.returnFeesPaidBy === 'merchant'
        ? 'https://schema.org/FreeReturn'
        : 'https://schema.org/ReturnShippingFees',
  };
}

/** Public shape of a ShippingZone row, as served by GET /public/:storeId/shipping. */
export interface PublicShippingZone {
  name: string;
  /** In fils (1 KWD = 1000 fils), like every other money value in this codebase. */
  deliveryFee: number;
  freeShippingThreshold: number | null;
  estimatedDaysMin: number | null;
  estimatedDaysMax: number | null;
  estimatedDays: number | null;
}

/**
 * schema.org OfferShippingDetails.
 *
 * Delivery cost and delivery time are the first things a shopping agent filters
 * on, so this is the highest-value structured field the storefront was missing.
 *
 * We advertise the CHEAPEST active zone. A product page has no delivery address
 * yet, so any single figure is necessarily a "from" price; the cheapest zone is
 * the honest reading of "shipping starts at X" and matches how the storefront
 * already presents it.
 *
 * Returns null when the merchant configured no zones. Emitting a 0 rate instead
 * would advertise free delivery we cannot honour at checkout — omitting the
 * block is the only correct fallback.
 */
export function shippingDetailsJsonLd(zones: PublicShippingZone[], opts: { currency: string }) {
  if (!zones.length) return null;
  const cheapest = zones.reduce((a, z) => (z.deliveryFee < a.deliveryFee ? z : a));

  // A flat `estimatedDays` stands in for both bounds when the merchant didn't
  // give a range. When neither exists we omit deliveryTime rather than invent one.
  const min = cheapest.estimatedDaysMin ?? cheapest.estimatedDays;
  const max = cheapest.estimatedDaysMax ?? cheapest.estimatedDays;

  return {
    '@type': 'OfferShippingDetails',
    shippingRate: {
      '@type': 'MonetaryAmount',
      value: (cheapest.deliveryFee / 1000).toFixed(3),
      currency: opts.currency || 'KWD',
    },
    ...(min !== null && max !== null
      ? {
          deliveryTime: {
            '@type': 'ShippingDeliveryTime',
            transitTime: {
              '@type': 'QuantitativeValue',
              minValue: min,
              maxValue: max,
              unitCode: 'DAY',
            },
          },
        }
      : {}),
  };
}

export function productJsonLd(
  product: ProductForJsonLd,
  store: ResolvedStore,
  opts?: { shippingZones?: PublicShippingZone[] }
) {
  const productUrl = storeAbsoluteUrl(store, `/products/${product.slug}`);
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
    url: productUrl,
    ...(product.categories?.[0]?.category?.name
      ? { category: product.categories[0].category.name }
      : {}),
    brand: brandJsonLd(store),
    ...(() => {
      const rp = merchantReturnPolicyJsonLd(store);
      return rp ? { hasMerchantReturnPolicy: rp } : {};
    })(),
    offers: {
      '@type': 'Offer',
      price: (product.price / 1000).toFixed(3),
      priceCurrency: store.currency || 'KWD',
      availability,
      url: productUrl,
      seller: {
        '@type': 'Organization',
        name: store.name,
      },
      // Nested inside Offer (not Product) — schema.org scopes shipping to the
      // offer, and Google's merchant-listing docs require it there.
      ...(() => {
        const sd = opts?.shippingZones?.length
          ? shippingDetailsJsonLd(opts.shippingZones, { currency: store.currency })
          : null;
        return sd ? { shippingDetails: sd } : {};
      })(),
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

interface BundleForJsonLd {
  name: string;
  description?: string | null;
  slug: string;
  image?: string | null;
  /** The bundle's single selling price (fils) — never a per-component price. */
  price: number;
  available: number;
}

/**
 * Schema.org Product structured data for a bundle detail page
 * (`/bundles/<slug>`). Deliberately a smaller sibling of `productJsonLd`
 * (no sku/category/reviews — bundles carry none of those), reusing the same
 * `brandJsonLd`/`merchantReturnPolicyJsonLd`/`storeAbsoluteUrl` building
 * blocks so a bundle's structured data stays consistent with a product's.
 * `availability` is derived from `available` (the bundle's OWN derived
 * stock, from `resolveBundle`), not from any per-component figure.
 */
export function bundleJsonLd(bundle: BundleForJsonLd, store: ResolvedStore) {
  const bundleUrl = storeAbsoluteUrl(store, `/bundles/${bundle.slug}`);
  const availability =
    bundle.available > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock';

  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: bundle.name,
    ...(bundle.description ? { description: bundle.description } : {}),
    ...(bundle.image ? { image: bundle.image } : {}),
    url: bundleUrl,
    brand: brandJsonLd(store),
    ...(() => {
      const rp = merchantReturnPolicyJsonLd(store);
      return rp ? { hasMerchantReturnPolicy: rp } : {};
    })(),
    offers: {
      '@type': 'Offer',
      price: (bundle.price / 1000).toFixed(3),
      priceCurrency: store.currency || 'KWD',
      availability,
      url: bundleUrl,
      seller: {
        '@type': 'Organization',
        name: store.name,
      },
    },
  };
}

/**
 * Schema.org Organization structured data for the store.
 * When `store.aboutJson` is present (populated by the GEO brand-facts sweep,
 * `apps/api/src/lib/inngest/functions/bulk-ai-geo.ts`), its known keys
 * (`location`, `region`, `currency`, `languages`, `keyCategories`,
 * `contactMethods`) are NOT schema.org properties, so they are folded into
 * `additionalProperty` as `PropertyValue` entries rather than spread onto
 * the node directly (A2 in the 2026-09-22 AEO audit — spreading them raw
 * produced invalid/non-standard keys on a schema.org node). `description`
 * and `areaServed` ARE real schema.org Organization properties and are
 * derived from real store data below; the aboutJson `location`/`region`
 * only feed `areaServed` — every other about* field only ever feeds
 * `additionalProperty`.
 *
 * `locale` selects which of the store's own description fields to emit —
 * pass the SAME locale the page's `<html lang>` resolved to (see
 * `lib/seo/resolve-locale.ts`), or Organization's `description` disagrees
 * with the rest of the page, exactly the A1 bug class.
 */
export function organizationJsonLd(store: ResolvedStore, locale: StorefrontLocale = 'en') {
  const siteUrl = storeAbsoluteUrl(store, '');
  const description = pickMetaDescription(store, locale);

  const aboutJson: Record<string, unknown> =
    store.aboutJson && typeof store.aboutJson === 'object' ? store.aboutJson : {};

  // Real schema.org property. `areaServed` accepts Text — no need to guess
  // a Place/Country/AdministrativeArea @type for AI-generated free text
  // ("Kuwait", "GCC") that isn't guaranteed to be a formal place name.
  // Absent when the merchant/sweep never populated either field — never
  // invented (a default "Kuwait/GCC" would be a false claim for a
  // GCC-adjacent merchant that hasn't actually confirmed its service area).
  const areaServed =
    typeof aboutJson.location === 'string' && aboutJson.location.trim()
      ? aboutJson.location.trim()
      : typeof aboutJson.region === 'string' && aboutJson.region.trim()
        ? aboutJson.region.trim()
        : undefined;

  // Every OTHER aboutJson key (not location/region, already consumed above)
  // becomes a PropertyValue instead of a raw spread — valid schema.org,
  // still fully consumable by an LLM reading the JSON-LD, and no information
  // lost versus the previous raw-spread shape.
  const additionalProperty = Object.entries(aboutJson)
    .filter(([key, value]) => key !== 'location' && key !== 'region' && value !== undefined)
    .map(([key, value]) => ({
      '@type': 'PropertyValue',
      name: key,
      value: Array.isArray(value) ? value.join(', ') : String(value),
    }));

  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: store.name,
    url: siteUrl,
    ...(store.logo ? { logo: store.logo } : {}),
    ...(description ? { description } : {}),
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
    ...(areaServed ? { areaServed } : {}),
    ...(store.socialLinks
      ? {
          sameAs: Object.values(store.socialLinks).filter(Boolean),
        }
      : {}),
    ...(additionalProperty.length ? { additionalProperty } : {}),
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
            addressCountry: 'KW', // Kuwait — platform-wide default for Force AI Store
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
export function getSiteUrl(store?: Pick<ResolvedStore, 'domain'>): string {
  // A merchant's custom domain IS that store's canonical origin, so it MUST win
  // over the platform-wide NEXT_PUBLIC_SITE_URL.
  //
  // This order used to be reversed, and because NEXT_PUBLIC_SITE_URL is always
  // set in production (`https://store.force-ai.co`, inlined at build time), the
  // `store.domain` branch below was DEAD — every custom-domain store advertised
  // `rel=canonical`, `og:url` and every JSON-LD `url` on the platform host. Worse,
  // `storeAbsoluteUrl` only adds the `/<slug>` prefix when `domain` is falsy, so
  // pecannbee.com.kw/products/X claimed a canonical of
  // store.force-ai.co/products/X — a URL that resolves to the DEMO store
  // (verified live 2026-07-29). That tells Google every real merchant page is a
  // duplicate of a demo page. Platform-path stores are unaffected: no domain →
  // still the env var → still prefixed with `/<slug>`.
  if (store?.domain) {
    return `https://${store.domain.trim()}`;
  }
  // Whitespace defense: a stray newline in the env var silently breaks
  // every URL in robots.txt + sitemap.xml (Google then can't fetch the map).
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return process.env.NEXT_PUBLIC_SITE_URL.trim().replace(/\/$/, '');
  }
  // Canonical platform host after the 2026-06 Cloudflare rebrand. Fallback for
  // platform-path stores (no custom domain); drives master sitemap URLs, the
  // robots `Sitemap:` directive, OG `og:url`/`og:image`, and `rel=canonical`.
  // It MUST be the live canonical domain — it was still `store.forcemediakw.com`
  // after the CF cutover, so sitemap + OG advertised the old domain on
  // store.force-ai.co (regression fixed 2026-06-27).
  return 'https://store.force-ai.co';
}

/**
 * Absolute in-store URL that preserves the platform `/<slug>` path prefix.
 * `getSiteUrl()` only returns the bare custom-domain (or platform-default)
 * origin — it does NOT include the `/<slug>` path prefix that platform-path
 * stores (no custom domain, `store.domain` is falsy) need, see
 * `apps/web/src/app/sitemap.ts`'s "master sitemap" branch for the same
 * pattern. Every per-page JSON-LD `url`, breadcrumb `item`, and
 * `rel=canonical` builder MUST route through this (or `getSiteUrl()` for the
 * bare origin) instead of hand-concatenating `${getSiteUrl(store)}${path}` —
 * skipping the prefix points crawlers/agents at a URL that resolves to the
 * wrong store (or the demo store) once it hits middleware.
 *
 * `path` may be given with or without a leading slash; '' or '/' both
 * resolve to the store root.
 */
export function storeAbsoluteUrl(
  store: Pick<ResolvedStore, 'slug' | 'domain'>,
  path: string
): string {
  const prefix = store.domain ? '' : `/${store.slug}`;
  const normalizedPath = path && !path.startsWith('/') ? `/${path}` : path;
  return `${getSiteUrl(store)}${prefix}${normalizedPath}`;
}
