'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type PublicBundle } from '@/lib/api';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { ShopChrome } from '../../components';
import { recordLastListing } from '@/lib/last-listing';
import { BundleCard } from './BundleCard';

interface BundlesClientProps {
  /** Server-fetched, already `isPurchasable`-filtered bundle list — covers
   *  the first (server) render. */
  bundles: PublicBundle[];
}

/**
 * `/bundles` index — mirrors `CategoriesClient`'s shape (a single
 * unpaginated grid, no filter sidebar; `GET /stores/public/:storeId/bundles`
 * has no pagination param — see that route's own doc comment: a merchant
 * hand-curates a small set of bundles) rather than `ProductsClient`'s
 * (no category filter, no page-builder layout settings to fetch — see
 * `bundles/[slug]/BundleDetailBody.tsx`'s doc comment on why a bundle page
 * has no page-builder layout config).
 */
export default function BundlesClient({ bundles: initialBundles }: BundlesClientProps) {
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const { t } = useLanguage();

  const [bundles, setBundles] = useState<PublicBundle[]>(initialBundles);
  const [isLoading, setIsLoading] = useState(false);

  // Mirrors CategoriesClient/BundleDetailClient's own client-side re-fetch:
  // `initialBundles` covers the first (server) render, this covers
  // client-side navigation onto /bundles without a full page reload.
  useEffect(() => {
    if (!store?.id || store.id === 'demo') return;
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      try {
        const res = await api.getPublicBundles(store.id);
        if (!cancelled && res.success && res.data?.bundles) {
          setBundles(res.data.bundles);
        }
      } catch {
        // Non-fatal — keep whatever the server already rendered.
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [store?.id]);

  // Record this page as the last-browsed listing so "Continue Shopping" in
  // the cart returns the shopper here instead of /products — same pattern
  // as CategoriesClient.
  useEffect(() => {
    const path = window.location.pathname + window.location.search;
    const storePrefix = store?.slug && store.id !== 'demo' ? `/${store.slug}` : '';
    const relative =
      storePrefix && path.startsWith(storePrefix) ? path.slice(storePrefix.length) : path;
    recordLastListing(store?.id, relative || '/bundles');
  }, [store?.id, store?.slug]);

  return (
    <ShopChrome>
      <div className="flex-1">
        <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8" data-zone="products">
          {/* Breadcrumb */}
          <nav className="mb-6 flex items-center gap-2 text-sm text-muted-foreground">
            <Link href={storeUrl('/')} className="transition-colors hover:text-primary">
              {t('Home', translations['Home'])}
            </Link>
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            <span className="text-foreground">{t('Bundles', 'الباقات')}</span>
          </nav>

          <div className="mb-8">
            <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
              {t('Bundles', 'الباقات')}
            </h1>
            <p className="mt-2 text-muted-foreground">
              {t(
                'Curated kits at a special price — buy the whole box in one click.',
                'باقات مختارة بسعر خاص — اشترِ الصندوق كاملاً بنقرة واحدة.'
              )}
            </p>
          </div>

          {isLoading && bundles.length === 0 ? (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 sm:gap-6 lg:grid-cols-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <div
                  key={i}
                  className="animate-pulse overflow-hidden rounded-2xl border border-border bg-card"
                >
                  <div className="aspect-square bg-muted" />
                  <div className="space-y-2 p-4">
                    <div className="h-4 w-3/4 rounded bg-muted" />
                    <div className="h-4 w-1/2 rounded bg-muted" />
                  </div>
                </div>
              ))}
            </div>
          ) : bundles.length === 0 ? (
            <div className="py-12 text-center">
              <p className="mb-4 text-muted-foreground">
                {t('No bundles available right now.', 'لا توجد باقات متاحة حالياً.')}
              </p>
              <Link href={storeUrl('/products')} className="text-primary hover:underline">
                {t('Browse all products', 'تصفح جميع المنتجات')}
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 sm:gap-6 lg:grid-cols-4">
              {bundles.map(bundle => (
                <BundleCard key={bundle.id} bundle={bundle} />
              ))}
            </div>
          )}
        </div>
      </div>
    </ShopChrome>
  );
}
