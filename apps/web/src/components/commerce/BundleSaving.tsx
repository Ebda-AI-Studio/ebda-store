'use client';

/**
 * PDP bundle-saving line (Phase B3, Ruling B3-6): ONE line, "وفّر 15% لما تشتريه مع الروتين",
 * only when an active, purchasable bundle containing this product gives a real saving > 0. It
 * links to the bundle page. Renders NOTHING otherwise (including when the `bundles` feature is
 * off, which is read off `store.enabledFeatures`, never probed with a request).
 *
 * CACHE CLASS: NEVER-stale for price. The percentage is fetched live from
 * `GET /stores/public/:storeId/bundle-savings`, which computes it from the cart's own bundle
 * price (`resolveBundle`) on every request and answers `no-store`; nothing here caches it, so a
 * bundle price edit changes the line on the next view.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type BundleSavingInfo } from '../../lib/api';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { bundlesNavVisible } from '../../lib/bundles-nav';

export function BundleSaving({ productId }: { productId: string }) {
  const { store } = useStore();
  const { t } = useLanguage();
  const storeUrl = useStoreUrl();
  const enabled = bundlesNavVisible(store.enabledFeatures);
  const [best, setBest] = useState<BundleSavingInfo | null>(null);

  useEffect(() => {
    if (!enabled || !store.id || store.id === 'demo') return;
    let live = true;
    api
      .getBundleSavings(store.id, [productId])
      .then(res => {
        if (!live) return;
        setBest(res.success && res.data?.savings?.length ? res.data.savings[0] : null);
      })
      .catch(() => {
        if (live) setBest(null);
      });
    return () => {
      live = false;
    };
  }, [enabled, store.id, productId]);

  if (!enabled || !best || best.percent < 1) return null;
  const text = t(
    'Save {n}% when you buy it with the routine',
    translations['Save {n}% when you buy it with the routine']
  ).replace('{n}', String(best.percent));
  return (
    <Link
      href={storeUrl(`/bundles/${best.slug}`)}
      data-zone="bundleSaving"
      className="mt-2 inline-flex min-h-[44px] items-center text-sm font-medium text-foreground underline decoration-primary underline-offset-4 hover:decoration-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {text}
    </Link>
  );
}
