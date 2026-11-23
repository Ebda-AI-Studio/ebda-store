import type { ResolvedStore } from './store-resolver';
import { canBuyNow, inStockNow } from './can-buy-now';
import { pickMetaDescription } from './seo/meta-description';
import type { StorefrontLocale } from './seo/resolve-locale';
import { BRAND_MARKETING_URL, storefrontOrigin } from '@ebda/shared';

import { minorToDecimalString, REGION } from '@ebda/shared';
/**
 * The name/description a JSON-LD node publishes for `locale` (#2196): the
 * Arabic field when the page resolved to `ar` and the merchant filled it in,
 * else the English one. MUST be the same locale the page's `<title>` /
 * `og:title` used, or the page's structured data contradicts its own title
 * and Google's rich result keeps the other language.
 */
export function localizedField(
  en: string,
  ar: string | null | undefined,
  locale: StorefrontLocale
): string {
  return locale === 'ar' && ar?.trim() ? ar.trim() : en;
}

/** Fixed breadcrumb labels, in the page's locale (#2196). */
export const BREADCRUMB_LABELS: Record<
  StorefrontLocale,
  { home: string; products: string; bundles: string }
> = {
  en: { home: 'Home', products: 'Products', bundles: 'Bundles' },
  ar: { home: 'الرئيسية', products: 'المنتجات', bundles: 'الباقات' },
};

interface ProductForJsonLd {
  name: string;
  nameAr?: string | null;
  description?: string;
  descriptionAr?: string | null;
  price: number;
  compareAtPrice?: number;
  sku?: string;
  slug: string;
  images?: Array<{ url: string; alt?: string }>;
  inventory?: number;
  /** Server stock flags (enrichStockFlags); a variant product's own `inventory` is 0. */
  inStock?: boolean;
  acceptsBackorder?: boolean;
  categories?: Array<{ category?: { name?: string; nameAr?: string | null; slug?: string } }>;
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
  /** The public 3D model (the API already drops it when `product_3d` is off for the store). */
  model3d?: { modelUrl?: string | null; usdzUrl?: string | null } | null;
}

/**
 * schema.org `3DModel` nodes for a product's models: the GLB always, the USDZ only when the
 * merchant uploaded one. Empty when there is no model URL (never a node without `contentUrl`).
 */
export function model3dJsonLd(
  model: ProductForJsonLd['model3d'],
  name: string
): Array<Record<string, string>> {
  if (!model?.modelUrl) return [];
  const nodes = [
    {
      '@type': '3DModel',
      name,
      encodingFormat: 'model/gltf-binary',
      contentUrl: model.modelUrl,
    },
  ];
  if (model.usdzUrl) {
    nodes.push({
      '@type': '3DModel',
      name,
      encodingFormat: 'model/vnd.usdz+zip',
      contentUrl: model.usdzUrl,
    });
  }
  return nodes;
}

/**
 * Schema.org Product structured data.
 * Returns a plain object suitable for JSON.stringify inside a <script type="application/ld+json"> tag.
 */
/**
 * schema.org Brand.
 *
 * Agents use brand to group and compare products across sellers. Ebda stores are
 * single-brand and there is no per-product brand column, so the store name IS
 * the brand — there is nothing more specific to prefer over it.
 */
export function brandJsonLd(
  store: Pick<ResolvedStore, 'name' | 'nameAr'>,
  locale: StorefrontLocale = 'en'
) {
  return { '@type': 'Brand', name: localizedField(store.name, store.nameAr, locale) };
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
      applicableCountry: 'EG',
      returnPolicyCategory: 'https://schema.org/MerchantReturnNotPermitted',
    };
  }

  return {
    '@type': 'MerchantReturnPolicy',
    applicableCountry: 'EG',
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
  /** In piastres (1 EGP = 100 piastres), like every other money value in this codebase. */
  deliveryFee: number;
  freeShippingThreshold: number | null;
  estimatedDaysMin: number | null;
  estimatedDaysMax: number | null;
  estimatedDays: number | null;
  /** A named zone's area names (en / ar); absent on an area-rate row. Matches an order's address. */
  areas?: string[];
  areasAr?: string[];
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
      value: minorToDecimalString(cheapest.deliveryFee),
      currency: opts.currency || REGION.currency,
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
  opts?: { shippingZones?: PublicShippingZone[]; locale?: StorefrontLocale }
) {
  const locale = opts?.locale ?? 'en';
  // Same rule as the page's metadata (buildProductMetadata): under `ar` the
  // description is the Arabic one or nothing — never the English text.
  const description = locale === 'ar' ? product.descriptionAr?.trim() : product.description;
  const categoryName = product.categories?.[0]?.category?.name
    ? localizedField(
        product.categories[0].category.name,
        product.categories[0].category.nameAr,
        locale
      )
    : undefined;
  const storeName = localizedField(store.name, store.nameAr, locale);
  const productUrl = storeAbsoluteUrl(store, `/products/${product.slug}`);
  // Every gallery image (Google shows up to 10 for a merchant listing); one image stays a plain string.
  const gallery = (product.images ?? [])
    .map(i => i.url)
    .filter(Boolean)
    .slice(0, 10);
  const image = gallery.length > 1 ? gallery : gallery[0];
  // The same answer as the buy button (X-03): read the server's stock flags, not
  // raw `inventory` (0 on every variant product, which told search engines a
  // stocked sized product was out of stock); a backorderable item is BackOrder.
  const availability = inStockNow(product)
    ? 'https://schema.org/InStock'
    : canBuyNow(product)
      ? 'https://schema.org/BackOrder'
      : 'https://schema.org/OutOfStock';

  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: localizedField(product.name, product.nameAr, locale),
    ...(description ? { description } : {}),
    ...(image ? { image } : {}),
    ...(product.sku ? { sku: product.sku } : {}),
    url: productUrl,
    ...(categoryName ? { category: categoryName } : {}),
    brand: brandJsonLd(store, locale),
    ...(() => {
      const rp = merchantReturnPolicyJsonLd(store);
      return rp ? { hasMerchantReturnPolicy: rp } : {};
    })(),
    offers: {
      '@type': 'Offer',
      price: minorToDecimalString(product.price),
      priceCurrency: store.currency || REGION.currency,
      availability,
      url: productUrl,
      seller: {
        '@type': 'Organization',
        name: storeName,
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
    // 3D model (Phase 2): `subjectOf` a 3DModel, only when the product has one.
    ...(() => {
      const models = model3dJsonLd(
        product.model3d,
        `${localizedField(product.name, product.nameAr, locale)} (3D)`
      );
      return models.length ? { subjectOf: models.length === 1 ? models[0] : models } : {};
    })(),
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
  nameAr?: string | null;
  description?: string | null;
  descriptionAr?: string | null;
  slug: string;
  image?: string | null;
  /** The bundle's single selling price (piastres) — never a per-component price. */
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
export function bundleJsonLd(
  bundle: BundleForJsonLd,
  store: ResolvedStore,
  locale: StorefrontLocale = 'en'
) {
  const description = locale === 'ar' ? bundle.descriptionAr?.trim() : bundle.description;
  const bundleUrl = storeAbsoluteUrl(store, `/bundles/${bundle.slug}`);
  const availability =
    bundle.available > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock';

  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: localizedField(bundle.name, bundle.nameAr, locale),
    ...(description ? { description } : {}),
    ...(bundle.image ? { image: bundle.image } : {}),
    url: bundleUrl,
    brand: brandJsonLd(store, locale),
    ...(() => {
      const rp = merchantReturnPolicyJsonLd(store);
      return rp ? { hasMerchantReturnPolicy: rp } : {};
    })(),
    offers: {
      '@type': 'Offer',
      price: minorToDecimalString(bundle.price),
      priceCurrency: store.currency || REGION.currency,
      availability,
      url: bundleUrl,
      seller: {
        '@type': 'Organization',
        name: localizedField(store.name, store.nameAr, locale),
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
  // ("Egypt", "GCC") that isn't guaranteed to be a formal place name.
  // Absent when the merchant/sweep never populated either field — never
  // invented (a default "Egypt/GCC" would be a false claim for a
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
  //
  // Only primitives and arrays of primitives are published (#1892): aboutJson
  // rows written before the API-side schema can hold nested objects, which
  // String() turned into "[object Object]" (and null into "null") in the
  // public JSON-LD. Anything else is skipped rather than serialised.
  const isPrimitive = (v: unknown): v is string | number | boolean =>
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
  const additionalProperty = Object.entries(aboutJson)
    .filter(([key]) => key !== 'location' && key !== 'region')
    .flatMap(([key, value]) => {
      if (isPrimitive(value)) {
        return [{ '@type': 'PropertyValue', name: key, value: String(value) }];
      }
      if (Array.isArray(value) && value.length > 0 && value.every(isPrimitive)) {
        return [{ '@type': 'PropertyValue', name: key, value: value.join(', ') }];
      }
      return [];
    });

  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    // Same locale as `description` below and the page's <title> (#2196).
    name: localizedField(store.name, store.nameAr, locale),
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
  price?: number | null; // in piastres (EGP * 1000)
  currency?: string;
  inStock?: boolean;
  /** Sold out but taking backorders: BackOrder, the same answer as the PDP (X-03). */
  acceptsBackorder?: boolean;
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
                price: minorToDecimalString(p.price),
                priceCurrency: p.currency ?? REGION.currency,
                // The PDP's rule (X-03): an absent flag reads in stock, as before.
                availability:
                  p.inStock !== false
                    ? 'https://schema.org/InStock'
                    : canBuyNow(p)
                      ? 'https://schema.org/BackOrder'
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
            addressCountry: 'EG', // Egypt — platform-wide default for Ebda
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
// (Track C of the AI-discovery work is the enforcement architecture.)
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
 * Resolve the canonical site URL (origin) for this store.
 *
 * A store's origin is its custom domain when it has one, otherwise its free
 * `<slug>.ebda.app` address (`storefrontOrigin`) — NEVER a path under the apex.
 * Called with no store (platform-level callers) it returns the platform origin.
 *
 * History worth keeping: this once preferred the platform-wide
 * NEXT_PUBLIC_SITE_URL over `store.domain`, so every custom-domain store
 * advertised `rel=canonical` on the platform host — a URL that resolved to the
 * DEMO store (verified live 2026-07-29), telling Google each merchant page
 * duplicated a demo page. The store's own origin must always win.
 */
export function getSiteUrl(store?: { slug?: string | null; domain?: string | null }): string {
  if (store?.domain || store?.slug) {
    return storefrontOrigin({ slug: store.slug ?? '', domain: store.domain });
  }
  // Whitespace defense: a stray newline in the env var silently breaks
  // every URL in robots.txt + sitemap.xml (Google then can't fetch the map).
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return process.env.NEXT_PUBLIC_SITE_URL.trim().replace(/\/$/, '');
  }
  // Platform-level fallback (no store): the marketing apex.
  return BRAND_MARKETING_URL;
}

/**
 * Absolute in-store URL: the store's origin (`getSiteUrl(store)`) plus `path`.
 * There is no `/<slug>` path prefix — every store has its own host. Every
 * per-page JSON-LD `url`, breadcrumb `item`, and `rel=canonical` builder MUST
 * route through this instead of hand-concatenating.
 *
 * `path` may be given with or without a leading slash; '' or '/' both
 * resolve to the store root.
 */
export function storeAbsoluteUrl(
  store: Pick<ResolvedStore, 'slug' | 'domain'>,
  path: string
): string {
  const normalizedPath = path && !path.startsWith('/') ? `/${path}` : path;
  return `${getSiteUrl(store)}${normalizedPath}`;
}
