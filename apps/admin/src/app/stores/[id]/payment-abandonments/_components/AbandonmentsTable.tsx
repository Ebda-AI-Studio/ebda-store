'use client';

import Link from 'next/link';
import { useT } from '@/i18n/useT';
import type { AbandonmentRecord, ListMeta } from '../_hooks/usePaymentAbandonments';

import { formatPrice } from '@/lib/format';

/** Converts fils (integer) to a KWD display string with 3 decimal places. */
const formatKwd = formatPrice;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

/** Display name for a gateway provider slug. */
function gatewayLabel(provider: string | null): string {
  if (!provider) return '—';
  const map: Record<string, string> = {
    tap: 'Tap',
    myfatoorah: 'MyFatoorah',
    hesabe: 'Hesabe',
    upayments: 'UPayments',
    stripe: 'Stripe',
  };
  return map[provider.toLowerCase()] ?? provider;
}

interface AbandonmentsTableProps {
  storeId: string;
  records: AbandonmentRecord[];
  meta: ListMeta;
  page: number;
  onPageChange: (page: number) => void;
  /** Translations namespace helper — passed from the page to avoid re-calling useT here. */
}

export function AbandonmentsTable({
  storeId,
  records,
  meta,
  page,
  onPageChange,
}: AbandonmentsTableProps) {
  const t = useT('paymentAbandonments.page');

  function customerName(record: AbandonmentRecord): string {
    const src = record.customer ?? record.guestContact;
    if (!src) return t('guest');
    const name = `${src.firstName ?? ''} ${src.lastName ?? ''}`.trim();
    return name || t('guest');
  }

  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      {records.length === 0 ? (
        <div className="force-empty-state px-6">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
            <svg
              className="h-8 w-8 text-muted-foreground"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
              />
            </svg>
          </div>
          <p className="font-semibold text-foreground">{t('empty')}</p>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">{t('emptyHint')}</p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-muted border-b border-border">
                  <th
                    scope="col"
                    className="text-start px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  >
                    {t('colOrderNumber')}
                  </th>
                  <th
                    scope="col"
                    className="text-start px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  >
                    {t('colCustomer')}
                  </th>
                  <th
                    scope="col"
                    className="text-start px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  >
                    {t('colPhone')}
                  </th>
                  <th
                    scope="col"
                    className="text-start px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  >
                    {t('colEmail')}
                  </th>
                  <th
                    scope="col"
                    className="text-start px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  >
                    {t('colGateway')}
                  </th>
                  <th
                    scope="col"
                    className="text-start px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  >
                    {t('colValue')}
                  </th>
                  <th
                    scope="col"
                    className="text-start px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  >
                    {t('colItems')}
                  </th>
                  <th
                    scope="col"
                    className="text-start px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  >
                    {t('colAbandonedAt')}
                  </th>
                  <th scope="col" className="px-4 py-3 text-xs font-medium text-muted-foreground">
                    <span className="sr-only">{t('viewOrder')}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {records.map(record => {
                  const src = record.customer ?? record.guestContact;
                  const phoneMasked = src?.phoneMasked ?? '—';
                  const emailMasked = src?.emailMasked ?? '—';
                  return (
                    <tr key={record.id} className="hover:bg-muted/50">
                      <td className="px-4 py-3 text-sm font-mono text-foreground whitespace-nowrap">
                        #{record.orderNumber}
                      </td>
                      <td className="px-4 py-3 text-sm text-foreground">{customerName(record)}</td>
                      <td className="px-4 py-3 text-sm text-muted-foreground font-mono whitespace-nowrap">
                        {phoneMasked}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground whitespace-nowrap">
                        {emailMasked}
                      </td>
                      <td className="px-4 py-3 text-sm text-foreground whitespace-nowrap">
                        {gatewayLabel(record.gateway)}
                      </td>
                      <td className="px-4 py-3 text-sm text-foreground whitespace-nowrap">
                        {formatKwd(record.total)}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground text-center">
                        {record.itemCount}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground whitespace-nowrap">
                        {formatDate(record.abandonedAt)}
                      </td>
                      <td className="px-4 py-3 text-end whitespace-nowrap">
                        <Link
                          href={`/stores/${storeId}/orders/${record.id}`}
                          className="text-xs text-primary hover:underline font-medium"
                        >
                          {t('viewOrder')}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {meta.totalPages > 1 && (
            <div className="flex items-center justify-between px-6 py-4 border-t border-border">
              <p className="text-sm text-muted-foreground">
                {meta.page} / {meta.totalPages} ({meta.total})
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onPageChange(Math.max(1, page - 1))}
                  disabled={page === 1}
                  className="px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  &larr;
                </button>
                <button
                  type="button"
                  onClick={() => onPageChange(Math.min(meta.totalPages, page + 1))}
                  disabled={page === meta.totalPages}
                  className="px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  &rarr;
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
