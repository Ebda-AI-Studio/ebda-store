'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { MarketingPixelsInfoBanner } from './_components/MarketingPixelsInfoBanner';
import { PixelsList } from './_components/PixelsList';
import { TrackedEventsCard } from './_components/TrackedEventsCard';
import { useMarketingPixels } from './_hooks/useMarketingPixels';

export default function MarketingPixelsPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('marketingPixels');
  const tPage = useT('marketingPixels.page');

  const {
    store,
    pixels,
    isLoading,
    isSaving,
    saveError,
    saveSuccess,
    save,
    updatePixel,
    togglePlatform,
  } = useMarketingPixels(storeId);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!store) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">{t('notFound.title')}</p>
        <Link href="/stores" className="text-primary hover:underline mt-2 inline-block">
          {t('notFound.backToStores')}
        </Link>
      </div>
    );
  }

  const saveStatus = saveError
    ? t('save.errorMessage')
    : saveSuccess
      ? t('save.successMessage')
      : null;

  return (
    <AdminLayout
      title={tPage('title')}
      subtitle={tPage('subtitle')}
      actions={
        <div className="flex items-center gap-3">
          {saveStatus && (
            <span className={`text-sm ${saveError ? 'text-destructive' : 'text-success'}`}>
              {saveStatus}
            </span>
          )}
          <button
            onClick={save}
            disabled={isSaving}
            className="px-6 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50 font-medium"
          >
            {isSaving ? t('save.saving') : t('save.button')}
          </button>
        </div>
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
