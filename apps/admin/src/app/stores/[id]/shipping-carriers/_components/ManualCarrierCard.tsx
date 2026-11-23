'use client';

import Link from 'next/link';
import { useT } from '@/i18n/useT';
import { ProviderLogo } from '@/components/ProviderLogo';

/**
 * The manual carrier needs no settings: it is always offered on the order page, for a courier
 * with no API (the merchant types its name and the tracking number). This card says so, and
 * links to the COD reconciliation page that covers every carrier, manual included.
 */
export function ManualCarrierCard({ storeId }: { storeId: string }) {
  const t = useT('shipping.carriers.manual');
  return (
    <div className="bg-card rounded-xl border border-border p-6">
      <div className="flex items-center gap-3">
        <ProviderLogo code="manual" name={t('title')} />
        <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
      </div>
      <p className="text-sm text-muted-foreground mt-1">{t('description')}</p>
      <Link
        href={`/stores/${storeId}/cod-reconciliation`}
        className="inline-block mt-4 text-sm font-medium text-primary hover:underline"
      >
        {t('codLink')}
      </Link>
    </div>
  );
}
