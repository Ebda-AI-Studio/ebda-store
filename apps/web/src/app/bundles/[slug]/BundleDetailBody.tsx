import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ResolvedStore } from '../../../lib/store-resolver';
import { API_URL, type PublicBundleDetail } from '../../../lib/api';
import { pickMetaDescription } from '../../../lib/seo/meta-description';
import { buildOgImages } from '../../../lib/seo/og-images';
import type { StorefrontLocale } from '../../../lib/seo/resolve-locale';
import {
  bundleJsonLd,
  breadcrumbJsonLd,
  storeAbsoluteUrl,
  localizedField,
  BREADCRUMB_LABELS,
} from '../../../lib/structured-data';
import { JsonLd } from '../../../components/JsonLd';
import BundleDetailClient from './BundleDetailClient';

import { fromMinor, REGION } from '@ebda/shared';
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
      next: { revalidate: 60, tags: [`products:${store.id}`, `bundles:${store.id}`] },
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
  store: Pick<ResolvedStore, 'name' | 'slug' | 'domain'> & { nameAr?: string | null },
  locale: StorefrontLocale = 'en'
): Metadata {
  const { name: storeName, slug: storeSlug, domain: storeDomain } = store;
  // Arabic locale reads the merchant's Arabic name when present — else the
  // English name is what would render (issue #1857: the AR fallback
  // description interpolated `bundle.name`/`store.name`, i.e. English text,
  // under `<html lang="ar">`). A blank/whitespace-only Arabic name falls back
  // to the English one rather than rendering an empty title.
  const localizedName = locale === 'ar' ? bundle.nameAr?.trim() || bundle.name : bundle.name;
  const localizedStoreName = locale === 'ar' ? store.nameAr?.trim() || storeName : storeName;
  const title = localizedName;
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
      ? `تسوق ${localizedName} من ${localizedStoreName}. توصيل سريع في مصر.`
      : `Buy ${localizedName} at ${localizedStoreName}. Fast delivery in Egypt.`);
  const canonicalUrl = storeAbsoluteUrl(
    { slug: storeSlug, domain: storeDomain },
    `/bundles/${bundle.slug}`
  );

  const ogImages = buildOgImages(bundle.image, storeSlug, localizedStoreName, localizedName);

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
    // See the identical comment in ProductDetailBody.buildProductMetadata —
    // without an explicit `twitter` block Next.js does not derive one from
    // the top-level description, it deep-merges the ROOT layout's `twitter`
    // (the store's home description) instead.
    twitter: {
      card: 'summary_large_image',
      title: `${title} | ${localizedStoreName}`,
      description,
      ...(ogImages.length ? { images: [ogImages[0].url] } : {}),
    },
    other: {
      'product:price:amount': String(fromMinor(bundle.price)),
      'product:price:currency': REGION.currency,
    },
  };
}

export async function BundleDetailBody({
  store,
  slug,
  locale = 'en',
}: {
  store: ResolvedStore;
  slug: string;
  /** The locale the page's <title>/og resolved to — the JSON-LD must match it (#2196). */
  locale?: StorefrontLocale;
}) {
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
        bundleJsonLd(initialBundle, store, locale),
        breadcrumbJsonLd([
          { name: BREADCRUMB_LABELS[locale].home, url: storeAbsoluteUrl(store, '') },
          { name: BREADCRUMB_LABELS[locale].bundles, url: storeAbsoluteUrl(store, '/bundles') },
          {
            name: localizedField(initialBundle.name, initialBundle.nameAr, locale),
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
