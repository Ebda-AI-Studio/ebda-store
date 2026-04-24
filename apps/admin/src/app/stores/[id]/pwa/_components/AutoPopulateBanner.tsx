'use client';

import { useT } from '@/i18n/useT';
import type { StoreInfo } from './types';

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
            {storeInfo.nameAr && <span dir="rtl">{storeInfo.nameAr}</span>}
          </p>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
        </div>
      </div>
      <button
        type="button"
        onClick={onPopulate}
        className="px-4 py-2 bg-info text-white text-sm rounded-lg hover:bg-info/90 transition-colors whitespace-nowrap"
      >
        {t('button')}
      </button>
    </div>
  );
}
