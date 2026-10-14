import type { Metadata } from 'next';
import { permanentRedirect, notFound } from 'next/navigation';
import type { ResolvedStore } from '../../../lib/store-resolver';
import { API_URL } from '../../../lib/api';
import { publicLayoutUrl } from '../../../lib/preview-draft';
import { fetchSlugRedirect, storeRedirectUrl } from '../../../lib/slug-redirect';
import { fetchPublicShippingZones } from '../../../lib/shipping-public';
import { resolveLayoutSettings, type StoreLayoutSettings, fromMinor, REGION } from '@ebda/shared';
import { pickMetaDescription } from '../../../lib/seo/meta-description';
import { buildOgImages } from '../../../lib/seo/og-images';
import type { StorefrontLocale } from '../../../lib/seo/resolve-locale';
import {
  productJsonLd,
  localizedField,
  BREADCRUMB_LABELS,
  breadcrumbJsonLd,
  faqPageJsonLd,
  storeAbsoluteUrl,
} from '../../../lib/structured-data';
import { JsonLd } from '../../../components/JsonLd';
import ProductDetailClient from './ProductDetailClient';

/**
 * Product detail (PDP) page body — extracted 2026-07-12 (tenant-cacheable
 * routing, Phase 1) so the SAME rendering logic serves both
 * `app/products/[slug]/page.tsx` (legacy, header-based) and
 * `app/tenant-store/[tenant]/[locale]/products/[slug]/page.tsx` (new,
 * params-based, dark-launched). See
 * docs/plans/2026-07-12-tenant-cacheable-routing.md §3.6/§9.
 */

/**
 * Fetch the store's layout settings server-side so the client component
 * can gate the ReviewSection on `layout.reviewSection.enabled` without a
 * round-trip. Mirrors the home page pattern. Falls back to defaults if
 * the API call fails — the section will then be hidden (default-off).
 */
export async function fetchProductDetailLayoutSettings(
  storeId: string,
  draftToken?: string
): Promise<StoreLayoutSettings> {
  if (!storeId || storeId === 'demo') return resolveLayoutSettings({});
  try {
    const res = await fetch(
      publicLayoutUrl(API_URL, storeId, draftToken),
      draftToken ? { cache: 'no-store' } : { next: { revalidate: 60, tags: [`layout:${storeId}`] } }
    );
    if (!res.ok) return resolveLayoutSettings({});
    const json = await res.json();
    return resolveLayoutSettings(json?.data?.layout ?? {});
  } catch {
    return resolveLayoutSettings({});
  }
}

interface ProductData {
  name: string;
  nameAr?: string | null;
  slug: string;
  description?: string;
  descriptionAr?: string;
  metaDescription?: string | null;
  metaDescriptionAr?: string | null;
  metaDescriptionAeo?: string | null;
  metaDescriptionAeoAr?: string | null;
  price: number;
  images?: Array<{ url: string; alt?: string }>;
  categories?: Array<{ category?: { name?: string } }>;
}

export function buildProductMetadata(
  product: ProductData,
  store: Pick<ResolvedStore, 'name' | 'slug' | 'domain'> & { nameAr?: string | null },
  locale: StorefrontLocale = 'en'
): Metadata {
  const { name: storeName, slug: storeSlug, domain: storeDomain } = store;
  // Arabic locale reads the merchant's Arabic name when present — else the
  // English name is what would render (issue #1857: the new AR fallback
  // description interpolated `product.name`/`store.name`, i.e. English text,
  // under `<html lang="ar">`). A blank/whitespace-only Arabic name falls back
  // to the English one rather than rendering an empty title.
  const localizedName = locale === 'ar' ? product.nameAr?.trim() || product.name : product.name;
  const localizedStoreName = locale === 'ar' ? store.nameAr?.trim() || storeName : storeName;
  const title = localizedName;
  // AEO > SEO > plain description (truncated to 160 chars for meta tag).
  // The plain-description fallback must match `locale` too — with only the
  // locale threaded into `pickMetaDescription` fixed, a product with no AEO/SEO
  // copy but a real `descriptionAr` would still fall through to the English
  // `description` field on an Arabic-default store (A1 fix step 5).
  const rawDescription =
    pickMetaDescription(product, locale) ||
    (locale === 'ar' ? product.descriptionAr : product.description);
  const description =
    rawDescription?.slice(0, 160) ||
    (locale === 'ar'
      ? `تسوق ${localizedName} من ${localizedStoreName}. توصيل سريع في مصر.`
      : `Buy ${localizedName} at ${localizedStoreName}. Fast delivery in Egypt.`);
  const ogImage = product.images?.[0]?.url;
  const category = product.categories?.[0]?.category?.name;
  // Platform-path stores need the `/<slug>` prefix (see storeAbsoluteUrl doc
  // comment) — without it, the canonical/og:url pointed at the wrong
  // (store-less) URL for every non-custom-domain store.
  const canonicalUrl = storeAbsoluteUrl(
    { slug: storeSlug, domain: storeDomain },
    `/products/${product.slug}`
  );

  // og:image — the product photo when present, else the store-aware OG card
  // (`/og?slug=`, resolved against the layout's metadataBase) so an imageless
  // product still gets the store's branded preview instead of a blank card.
  const ogImages = buildOgImages(ogImage, storeSlug, localizedStoreName, localizedName);

  return {
    title,
    description,
    alternates: { canonical: canonicalUrl },
    openGraph: {
      title: `${title} | ${localizedStoreName}`,
      description,
      type: 'website',
      url: canonicalUrl,
      ...(ogImages.length ? { images: ogImages } : {}),
    },
    // Without an explicit `twitter` block, Next.js does NOT derive one from
    // the top-level `title`/`description` above — it deep-merges only with
    // the ROOT layout's `twitter` object (which carries the STORE's home
    // description), so every product/bundle page silently showed the
    // store-wide description on Twitter/X and iMessage-style unfurls
    // instead of its own. Explicit block here matches `openGraph` exactly.
    twitter: {
      card: 'summary_large_image',
      title: `${title} | ${localizedStoreName}`,
      description,
      ...(ogImages.length ? { images: [ogImages[0].url] } : {}),
    },
    other: {
      ...(category ? { 'product:category': category } : {}),
      'product:price:amount': String(fromMinor(product.price)),
      'product:price:currency': REGION.currency,
    },
  };
}

export async function fetchInitialProduct(slug: string, store: { id: string; domain?: string }) {
  const storeId = store.id !== 'demo' ? store.id : null;
  if (!storeId) return null;

  // Public endpoint only — storefront SSR is unauthenticated, so the
  // /stores/:id/products/:slug call always 401'd before this fallback.
  // NOTE: network errors intentionally propagate (no try/catch) — a transient
  // fetch failure must 500, not be swallowed into a false 404.
  const response = await fetch(`${API_URL}/public/products/${encodeURIComponent(slug)}`, {
    next: { revalidate: 60, tags: [`products:${store.id}`] },
    headers: {
      'Content-Type': 'application/json',
      'X-Store-ID': store.id,
      ...(store.domain ? { 'x-store-domain': store.domain } : {}),
    },
  });
  if (response.status === 404) return null; // definitive miss → caller resolves redirect / 404s
  if (!response.ok) throw new Error(`product fetch failed: ${response.status}`); // transient (5xx) → let it 500
  const data = await response.json();
  return data?.data?.product ?? null;
}

export async function ProductDetailBody({
  store,
  slug,
  draftToken,
  locale = 'en',
}: {
  store: ResolvedStore;
  slug: string;
  /** The locale the page's <title>/og resolved to — the JSON-LD must match it (#2196). */
  locale?: StorefrontLocale;
  /** Always `undefined` from the new `tenant-store` tree — see HomePageBody's
   *  doc comment for why Track-A never carries a draft token. */
  draftToken?: string;
}) {
  const [initialProduct, layout, shippingZones] = await Promise.all([
    fetchInitialProduct(slug, store),
    fetchProductDetailLayoutSettings(store.id, draftToken),
    // Feeds `offers.shippingDetails` in the Product JSON-LD below. Resolves to
    // [] on any failure, so it can never turn a product page into an error.
    fetchPublicShippingZones(store.id),
  ]);

  // Genuine miss on a real store: try to resolve a renamed-slug 308 before
  // giving up. See `storeRedirectUrl`'s doc comment for why the platform
  // `/<slug>` path prefix must be preserved for platform-path stores.
  if (!initialProduct && store.id !== 'demo') {
    const toSlug = await fetchSlugRedirect(store, 'product', slug);
    if (toSlug && toSlug !== slug) {
      // `encodeURIComponent` — the 308 target becomes a `Location` HEADER, and a
      // raw non-ASCII (Arabic) handle there throws
      // `TypeError: Invalid character in header content ["location"]`. The
      // ?category= redirect below already encoded; these path redirects did not.
      permanentRedirect(storeRedirectUrl(store, `/products/${encodeURIComponent(toSlug)}`));
    }
    notFound();
  }
  // demo store with no product: falls through to the existing behavior
  // below, rendering `ProductDetailClient` with `initialProduct={null}`.

  // Per-product FAQ JSON-LD (separate FAQPage block alongside the Product block)
  const productFaqItems: Array<{ question: string; answer: string }> =
    initialProduct?.faqs?.length > 0
      ? initialProduct.faqs.map((f: { question: string; answer: string }) => ({
          question: f.question,
          answer: f.answer,
        }))
      : [];

  // Build review and aggregateRating inputs for JSON-LD.
  // The API already filtered to status='published' + verifiedPurchase=true
  // — we just map the shape here.
  const reviewsForJsonLd =
    initialProduct?.reviews?.map(
      (r: {
        customer?: { firstName?: string; lastName?: string } | null;
        rating: number;
        body?: string | null;
        createdAt: string;
        language?: string | null;
      }) => ({
        author:
          r.customer?.firstName || r.customer?.lastName
            ? [r.customer.firstName, r.customer.lastName].filter(Boolean).join(' ')
            : 'Verified Buyer',
        rating: r.rating,
        body: r.body ?? '',
        datePublished: new Date(r.createdAt).toISOString().slice(0, 10),
        inLanguage: (r.language as 'en' | 'ar') ?? undefined,
      })
    ) ?? [];

  const aggregateRatingForJsonLd =
    initialProduct?.ratingStats?.ratingCount > 0
      ? {
          ratingValue: initialProduct.ratingStats.ratingAverage ?? 0,
          reviewCount: initialProduct.ratingStats.ratingCount,
        }
      : undefined;

  const jsonLdScripts = initialProduct
    ? [
        productJsonLd(
          {
            ...initialProduct,
            reviews: reviewsForJsonLd.length > 0 ? reviewsForJsonLd : undefined,
            aggregateRating: aggregateRatingForJsonLd,
          },
          store,
          { shippingZones, locale }
        ),
        breadcrumbJsonLd([
          { name: BREADCRUMB_LABELS[locale].home, url: storeAbsoluteUrl(store, '') },
          { name: BREADCRUMB_LABELS[locale].products, url: storeAbsoluteUrl(store, '/products') },
          {
            name: localizedField(initialProduct.name, initialProduct.nameAr, locale),
            url: storeAbsoluteUrl(store, `/products/${initialProduct.slug}`),
          },
        ]),
        ...(productFaqItems.length > 0 ? [faqPageJsonLd(productFaqItems)] : []),
      ]
    : [];

  return (
    <>
      {jsonLdScripts.map((jsonLd, i) => (
        <JsonLd key={i} data={jsonLd} />
      ))}
      <ProductDetailClient initialProduct={initialProduct} layout={layout} />
    </>
  );
}
