'use client';

import { buttonVariants } from '@/components/ui/Button';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale } from 'next-intl';
import { Badge } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { useCurrentStore } from '@/hooks/useCurrentStore';
import { apiGet } from '../../../../../../lib/api';
import {
  formatFiscalDate,
  formatFiscalMoney,
  type FiscalDocument,
} from '../../../../../../lib/fiscal-documents';

interface OrderDocumentsCardProps {
  storeId: string;
  orderId: string;
}

/**
 * The fiscal documents issued for this order (tax invoice / receipt, and a credit note or refund
 * receipt per refund), each linking to the printable viewer. Read-only: they are issued
 * automatically.
 */
export function OrderDocumentsCard({ storeId, orderId }: OrderDocumentsCardProps) {
  const t = useT('invoices');
  const tSlip = useT('packingSlip');
  const locale = useLocale();
  // Issue date in the store's timezone, like the Invoices page.
  const { store } = useCurrentStore(storeId);
  const [documents, setDocuments] = useState<FiscalDocument[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void apiGet<{ documents: FiscalDocument[] }>(
      `/api/v1/stores/${storeId}/orders/${orderId}/fiscal-documents`
    ).then(({ data, error }) => {
      if (cancelled) return;
      setFailed(!!error);
      setDocuments(data?.documents ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [storeId, orderId]);

  return (
    <section
      className="rounded-2xl border border-border bg-card p-5"
      aria-labelledby="order-documents-title"
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2
          id="order-documents-title"
          className="text-sm font-medium uppercase tracking-wide text-muted-foreground"
        >
          {t('documentsCard.title')}
        </h2>
        <Link
          href={`/stores/${storeId}/orders/${orderId}/packing-slip`}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {tSlip('print')}
        </Link>
      </div>

      {documents === null ? (
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      ) : failed ? (
        <p role="alert" className="text-sm text-destructive-ink">
          {t('documentsCard.loadFailed')}
        </p>
      ) : documents.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('documentsCard.empty')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {documents.map(d => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">
                  {t(`types.${d.docType}`)}{' '}
                  <span dir="ltr" className="font-mono">
                    {d.number}
                  </span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatFiscalDate(d.issuedAt, locale, store?.timezone)}
                  {' · '}
                  <span dir="ltr">{formatFiscalMoney(d.totalAmount, d.currency)}</span>
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={d.status === 'cancelled' ? 'destructive' : 'success'}>
                  {t(`statuses.${d.status}`)}
                </Badge>
                <Link
                  href={`/stores/${storeId}/invoices/${d.id}`}
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                >
                  {t('open')}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
