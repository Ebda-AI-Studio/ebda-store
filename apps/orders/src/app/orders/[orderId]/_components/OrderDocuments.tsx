'use client';

import { useEffect, useState } from 'react';
import { apiGet } from '@/lib/api';
import { useLanguage } from '@/contexts/LanguageContext';
import { formatDateTime, formatMoney } from '@/lib/format';

interface FiscalDocumentRow {
  id: string;
  docType: string;
  number: string;
  status: 'issued' | 'cancelled';
  issuedAt: string;
  totalAmount: number;
  currency: string;
}

interface OrderDocumentsProps {
  storeId: string;
  orderId: string;
}

/**
 * Documents card: the fiscal documents issued for this order (tax invoice / receipt, credit note
 * or refund receipt per refund). List only — opening and printing them is done in the admin.
 */
export function OrderDocuments({ storeId, orderId }: OrderDocumentsProps) {
  const { t, locale } = useLanguage();
  const td = t.detail.documents;
  const [documents, setDocuments] = useState<FiscalDocumentRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!storeId || !orderId) return;
    let cancelled = false;
    void apiGet<{ documents: FiscalDocumentRow[] }>(
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
    <section className="rounded-2xl border border-border bg-card p-4" aria-label={td.title}>
      <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {td.title}
      </h3>
      {documents === null ? (
        <p className="text-sm text-muted-foreground">…</p>
      ) : failed ? (
        <p role="alert" className="text-sm text-destructive-ink">
          {td.loadFailed}
        </p>
      ) : documents.length === 0 ? (
        <p className="text-sm text-muted-foreground">{td.empty}</p>
      ) : (
        <ul className="divide-y divide-border">
          {documents.map(d => (
            <li key={d.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">
                  {td.types[d.docType] ?? d.docType}{' '}
                  <span dir="ltr" className="font-mono">
                    {d.number}
                  </span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatDateTime(d.issuedAt, locale)}
                  {' · '}
                  <span dir="ltr">{formatMoney(d.totalAmount, d.currency)}</span>
                </p>
              </div>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                  d.status === 'cancelled'
                    ? 'bg-destructive/10 text-destructive-ink'
                    : 'bg-success/10 text-success-ink'
                }`}
              >
                {d.status === 'cancelled' ? td.cancelled : td.issued}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
