'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { ErrorState } from '../../../../components/ErrorState';
import { useRequireFeature } from '../../../../hooks/useRequireFeature';
import { useFeedHealth } from './_hooks/useFeedHealth';
import { FeedsSkeleton } from './_components/FeedsSkeleton';
import { PlatformCard } from './_components/PlatformCard';
import { FeedHealthPanel } from './_components/FeedHealthPanel';
import type { FeedLang, PlatformKey } from './_components/types';

const PLATFORMS: PlatformKey[] = ['google', 'meta', 'tiktok'];
const LANGS: FeedLang[] = ['ar', 'en'];

/**
 * Product feeds (Ruling FEEDS-1, feature `product_feeds`): copy-ready links for Google Merchant Center, Meta Commerce
 * Manager and TikTok Catalog Manager, their setup steps, and a feed health report (what is left out and why).
 * Gate -> hooks -> `if (gate) return gate` AFTER every hook, like answer-engine/page.tsx.
 */
export default function ProductFeedsPage() {
  const { enabled, gate } = useRequireFeature('product_feeds');
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('productFeeds');
  const tError = useT('components.errorState');
  const [lang, setLang] = useState<FeedLang>('ar');

  const { health, isLoading, error, refetch } = useFeedHealth({ storeId, lang, enabled });

  if (gate) return gate;

  return (
    <AdminLayout title={t('page.title')} subtitle={t('page.subtitle')}>
      {isLoading && !health ? (
        <FeedsSkeleton />
      ) : error !== null || !health ? (
        <ErrorState message={error || tError('loadFailed')} onRetry={refetch} />
      ) : (
        <div className="space-y-6">
          <p className="text-sm text-muted-foreground max-w-3xl" dir="auto">
            {t('intro')}
          </p>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {PLATFORMS.map(p => (
              <PlatformCard key={p} platform={p} origin={health.origin} />
            ))}
          </div>

          <div
            role="group"
            aria-label={t('health.title')}
            className="inline-flex rounded-lg border border-border p-0.5"
          >
            {LANGS.map(l => (
              <button
                key={l}
                type="button"
                aria-pressed={lang === l}
                onClick={() => setLang(l)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${
                  lang === l
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {t(`language.${l}`)}
              </button>
            ))}
          </div>
          <FeedHealthPanel health={health} lang={lang} onRefresh={refetch} />
        </div>
      )}
    </AdminLayout>
  );
}
