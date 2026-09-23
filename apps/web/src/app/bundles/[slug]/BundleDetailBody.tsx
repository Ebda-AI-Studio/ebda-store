import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ResolvedStore } from '../../../lib/store-resolver';
import { API_URL, type PublicBundleDetail } from '../../../lib/api';
import { pickMetaDescription } from '../../../lib/seo/meta-description';
import type { StorefrontLocale } from '../../../lib/seo/resolve-locale';
import { bundleJsonLd, breadcrumbJsonLd, storeAbsoluteUrl } from '../../../lib/structured-data';
import { JsonLd } from '../../../components/JsonLd';
import BundleDetailClient from './BundleDetailClient';

/**
 * Bundle detail (PDP-equivalent for a fixed kit) page body — mirrors
 * `products/[slug]/ProductDetailBody.tsx`'s server/client split (server
 * fetch for metadata + JSON-LD, client component for the interactive
 * page), trimmed to what a bundle actually has: no variants, no reviews/
 * FAQ, a single `image` field rather than a gallery, and no
 * shipping-zone-driven JSON-LD (bundles don't carry per-line shipping
 * details).
 *
 * Unlike the product page, this does NOT fetch the store's page-builder
 * layout settings server-side — there is no bundle-specific layout config
 * to gate a section on, so `ShopChrome` falls back to the client-side
 * `ctxLayout` (see its own doc comment: "Prop layout wins... ctx layout is
 * the lazy-fetched fallback") exactly like every OTHER storefront page that
 * doesn't pass a `layout` prop.
 */

export async function fetchInitialBundle(
  slug: string,
  store: { id: string; domain?: string }
): Promise<PublicBundleDetail | null> {
  const storeId = store.id !== 'demo' ? store.id : null;
  if (!storeId) return null;

  // NOTE: network errors intentionally propagate (no try/catch) — a
  // transient fetch failure must 500, not be swallowed into a false 404.
  // See ProductDetailBody.fetchInitialProduct for the identical rationale.
  const response = await fetch(
    `${API_URL}/stores/public/${encodeURIComponent(storeId)}/bundles/${encodeURIComponent(slug)}`,
    {
      next: { revalidate: 60, tags: [`products:${store.id}`] },
      headers: {
        'Content-Type': 'application/json',
        'X-Store-ID': store.id,
        ...(store.domain ? { 'x-store-domain': store.domain } : {}),
      },
    }
  );
  // A deactivated bundle 404s; a store without the `bundles` feature 403s
  // (see requireFeature) — both mean "nothing here" to a customer, and
  // must be indistinguishable from a genuinely unknown slug.
  if (response.status === 404 || response.status === 403) return null;
  if (!response.ok) throw new Error(`bundle fetch failed: ${response.status}`);
  const data = await response.json();
  return data?.data?.bundle ?? null;
}

export function buildBundleMetadata(
  bundle: PublicBundleDetail,
  store: Pick<ResolvedStore, 'name' | 'slug' | 'domain'>,
  locale: StorefrontLocale = 'en'
): Metadata {
  const { name: storeName, slug: storeSlug, domain: storeDomain } = store;
  const title = bundle.name;
  // Bundles carry no metaDescription*/Aeo* columns (schema.prisma Bundle
  // model), so `pickMetaDescription` always falls through to
  // description/descriptionAr — the locale param is what selects between
  // them. Same locale-aware fallback as products (A1 fix step 5): don't
  // fall back to the English `description` on an Arabic-default store.
  const rawDescription =
    pickMetaDescription(bundle, locale) ||
    (locale === 'ar' ? bundle.descriptionAr : bundle.description) ||
    undefined;
  const description =
    rawDescription?.slice(0, 160) ||
    (locale === 'ar'
      ? `تسوق ${bundle.name} من ${storeName}. توصيل سريع في الكويت.`
      : `Buy ${bundle.name} at ${storeName}. Fast delivery in Kuwait.`);
  const canonicalUrl = storeAbsoluteUrl(
    { slug: storeSlug, domain: storeDomain },
    `/bundles/${bundle.slug}`
  );

  const ogImages = bundle.image
    ? [{ url: bundle.image, alt: bundle.name }]
    : storeSlug
      ? [
          {
            url: `/og?slug=${encodeURIComponent(storeSlug)}`,
            width: 1200,
            height: 630,
            alt: storeName,
          },
        ]
      : [];

  return {
    title,
    description,
    alternates: { canonical: canonicalUrl },
    openGraph: {
      title: `${title} | ${storeName}`,
      description,
      type: 'website',
      url: canonicalUrl,
      ...(ogImages.length ? { images: ogImages } : {}),
    },
    // See the identical comment in ProductDetailBody.buildProductMetadata —
    // without an explicit `twitter` block Next.js does not derive one from
    // the top-level description, it deep-merges the ROOT layout's `twitter`
    // (the store's home description) instead.
    twitter: {
      card: 'summary_large_image',
      title: `${title} | ${storeName}`,
      description,
      ...(ogImages.length ? { images: [ogImages[0].url] } : {}),
    },
    other: {
      'product:price:amount': String(bundle.price / 1000),
      'product:price:currency': 'KWD',
    },
  };
}

export async function BundleDetailBody({ store, slug }: { store: ResolvedStore; slug: string }) {
  const initialBundle = store.id !== 'demo' ? await fetchInitialBundle(slug, store) : null;

  // Genuine miss (unknown slug, cross-store slug, deactivated bundle, or
  // the `bundles` feature not enabled for this store) — no slug-redirect
  // mechanism exists for bundles (there is no rename history to resolve),
  // so this goes straight to a real 404, unlike the product page's
  // redirect-on-miss detour.
  if (!initialBundle && store.id !== 'demo') {
    notFound();
  }

  const jsonLdScripts = initialBundle
    ? [
        bundleJsonLd(initialBundle, store),
        breadcrumbJsonLd([
          { name: 'Home', url: storeAbsoluteUrl(store, '') },
          { name: 'Bundles', url: storeAbsoluteUrl(store, '/bundles') },
          {
            name: initialBundle.name,
            url: storeAbsoluteUrl(store, `/bundles/${initialBundle.slug}`),
          },
        ]),
      ]
    : [];

  return (
    <>
      {jsonLdScripts.map((jsonLd, i) => (
        <JsonLd key={i} data={jsonLd} />
      ))}
      <BundleDetailClient initialBundle={initialBundle} />
    </>
  );
}
