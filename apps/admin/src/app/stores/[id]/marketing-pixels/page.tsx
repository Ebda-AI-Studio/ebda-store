'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { AdminSkeletonDetail } from '../../../../components/AdminSkeleton';
import { MarketingPixelsInfoBanner } from './_components/MarketingPixelsInfoBanner';
import { PixelsList } from './_components/PixelsList';
import { TrackedEventsCard } from './_components/TrackedEventsCard';
import { useMarketingPixels } from './_hooks/useMarketingPixels';
import { useRequireFeature } from '../../../../hooks/useRequireFeature';
import { Button } from '@/components/ui/Button';

export default function MarketingPixelsPage() {
  const { gate } = useRequireFeature('marketing_pixels');

  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('marketingPixels');
  const tPage = useT('marketingPixels.page');

  const { store, pixels, isLoading, isSaving, save, updatePixel, togglePlatform } =
    useMarketingPixels(storeId);

  if (gate) return gate;

  // Loading + not-found render INSIDE <AdminLayout> so the sidebar, hub tabs
  // and topbar stay mounted — an early return before the layout made the
  // whole admin chrome vanish and reappear (audit 2026-09-30 §8, fixed as a
  // class across every admin page).
  if (isLoading || !store) {
    return (
      <AdminLayout title={tPage('title')} subtitle={tPage('subtitle')}>
        {isLoading ? (
          <AdminSkeletonDetail showHeader={false} />
        ) : (
          <div className="text-center py-12">
            <p className="text-muted-foreground">{t('notFound.title')}</p>
            <Link href="/stores" className="text-primary hover:underline mt-2 inline-block">
              {t('notFound.backToStores')}
            </Link>
          </div>
        )}
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title={tPage('title')}
      subtitle={tPage('subtitle')}
      actions={
        <Button variant="default" size="md" type="button" onClick={save} disabled={isSaving}>
          {isSaving ? t('save.saving') : t('save.button')}
        </Button>
      }
    >
      <div className="space-y-6">
        <MarketingPixelsInfoBanner />
        <PixelsList
          pixels={pixels}
          onFieldChange={(platformId, field, value) => updatePixel(platformId, field, value)}
          onToggle={togglePlatform}
        />
        <TrackedEventsCard />
      </div>
    </AdminLayout>
  );
}
