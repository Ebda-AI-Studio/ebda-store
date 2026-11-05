'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { QrTab } from './_qr/QrTab';
import { LabelsGate } from './_labels/LabelsGate';
import { ReceiptTab } from './_receipt/ReceiptTab';

const TABS = ['qr', 'labels', 'receipt'] as const;
type Tab = (typeof TABS)[number];

/**
 * QR codes & barcodes (QR-1 + BARCODE-1): one page, three tabs, each with a live preview, a scan
 * self-check badge and save. `?tab=` selects the tab (deep links, the old /qr and /delivery spots).
 * Product labels are gated on the `inventory.barcode` feature; the other two tabs are not.
 */
function CodesBody() {
  const params = useParams();
  const storeId = params.id as string;
  const search = useSearchParams();
  const t = useT('codes');
  const tab: Tab = (TABS as readonly string[]).includes(search.get('tab') ?? '')
    ? (search.get('tab') as Tab)
    : 'qr';

  return (
    <AdminLayout title={t('page.title')} subtitle={t('page.subtitle')}>
      <div
        role="tablist"
        aria-label={t('page.title')}
        className="mb-6 flex gap-1 border-b border-border"
      >
        {TABS.map(id => (
          <Link
            key={id}
            role="tab"
            id={`codes-tab-${id}`}
            aria-selected={tab === id}
            aria-controls="codes-panel"
            href={`/stores/${storeId}/codes?tab=${id}`}
            replace
            scroll={false}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
              tab === id
                ? 'border-primary font-semibold text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t(`tabs.${id}`)}
          </Link>
        ))}
      </div>
      {tab !== 'qr' && (
        <p className="mb-4 text-sm text-muted-foreground">
          {t(`crossLink.${tab}.text`)}{' '}
          <Link
            href={`/stores/${storeId}/${tab === 'labels' ? 'stock/inventory' : 'orders'}`}
            className="font-medium text-primary-ink underline underline-offset-2"
          >
            {t(`crossLink.${tab}.link`)}
          </Link>
        </p>
      )}
      <div role="tabpanel" id="codes-panel" aria-labelledby={`codes-tab-${tab}`}>
        {tab === 'qr' && <QrTab storeId={storeId} />}
        {tab === 'labels' && <LabelsGate storeId={storeId} />}
        {tab === 'receipt' && <ReceiptTab storeId={storeId} />}
      </div>
    </AdminLayout>
  );
}

export default function CodesPage() {
  return (
    <Suspense fallback={null}>
      <CodesBody />
    </Suspense>
  );
}
