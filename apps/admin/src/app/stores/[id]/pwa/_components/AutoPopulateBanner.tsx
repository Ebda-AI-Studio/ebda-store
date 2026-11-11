'use client';

import { useT } from '@/i18n/useT';
import type { StoreInfo } from './types';
import { Button } from '@/components/ui/Button';

interface AutoPopulateBannerProps {
  storeInfo: StoreInfo;
  onPopulate: () => void;
}

/**
 * Top banner that shows the store's current branding and offers a shortcut
 * to copy it into the PWA settings form.
 */
export function AutoPopulateBanner({ storeInfo, onPopulate }: AutoPopulateBannerProps) {
  const t = useT('pwa.autoPopulate');

  return (
    <div className="bg-info/5 border border-info/30 rounded-xl p-4 flex items-center justify-between">
      <div className="flex items-center gap-3">
        {storeInfo.logo && (
          <img
            src={storeInfo.logo}
            alt={t('logoAlt')}
            className="w-10 h-10 rounded-lg object-contain bg-white border"
          />
        )}
        <div>
          <p className="font-medium text-foreground">
            {storeInfo.name}
            {storeInfo.nameAr && <span className="text-muted-foreground mx-2">|</span>}
            {storeInfo.nameAr && (
              <span lang="ar" dir="rtl">
                {storeInfo.nameAr}
              </span>
            )}
          </p>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
        </div>
      </div>
      <Button variant="default" size="md" type="button" onClick={onPopulate}>
        {t('button')}
      </Button>
    </div>
  );
}
