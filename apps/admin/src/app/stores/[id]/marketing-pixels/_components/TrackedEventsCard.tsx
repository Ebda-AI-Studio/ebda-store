'use client';

import { useT } from '@/i18n/useT';

const EVENT_KEYS = [
  'pageView',
  'viewContent',
  'addToCart',
  'initiateCheckout',
  'purchase',
  'search',
  'addToWishlist',
  'lead',
] as const;

/**
 * Static informational card listing which e-commerce events the platform
 * auto-tracks when a pixel is enabled. All copy is i18n-driven.
 */
export function TrackedEventsCard() {
  const t = useT('marketingPixels.events');

  return (
    <div className="bg-card rounded-md border p-6">
      <h2 className="font-semibold text-lg mb-4">{t('title')}</h2>
      <p className="text-muted-foreground mb-4">{t('description')}</p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {EVENT_KEYS.map(key => (
          <div key={key} className="p-3 bg-muted rounded-lg">
            <div className="font-medium text-sm">{t(`${key}.name`)}</div>
            <div className="text-xs text-muted-foreground">{t(`${key}.description`)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
