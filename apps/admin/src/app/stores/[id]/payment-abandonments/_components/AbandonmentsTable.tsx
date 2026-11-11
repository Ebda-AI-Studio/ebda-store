'use client';

import Link from 'next/link';
import { useT } from '@/i18n/useT';
import type { AbandonmentRecord, ListMeta } from '../_hooks/usePaymentAbandonments';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';

import { formatPrice } from '@/lib/format';
import { withNumerals } from '@ebda/shared';
import { Button } from '@/components/ui/Button';

/** Converts piastres (integer) to an EGP display string (2 decimals). */
const formatMajor = formatPrice;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(
    undefined,
    withNumerals({
      dateStyle: 'short',
      timeStyle: 'short',
    })
  );
}

/** Display name for a gateway provider slug. */
function gatewayLabel(provider: string | null): string {
  if (!provider) return '—';
  const map: Record<string, string> = {
    paymob: 'Paymob',
    kashier: 'Kashier',
    fawry: 'Fawry',
    geidea: 'Geidea',
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

  const columns: DataTableColumn<AbandonmentRecord>[] = [
    {
      header: t('colOrderNumber'),
      primaryOnMobile: true,
      cell: record => (
        <span className="text-sm font-mono text-foreground whitespace-nowrap">
          #{record.orderNumber}
        </span>
      ),
    },
    {
      header: t('colCustomer'),
      cell: record => <span className="text-sm text-foreground">{customerName(record)}</span>,
    },
    {
      header: t('colPhone'),
      cell: record => {
        const src = record.customer ?? record.guestContact;
        return (
          <span className="text-sm text-muted-foreground font-mono whitespace-nowrap">
            {src?.phoneMasked ?? '—'}
          </span>
        );
      },
    },
    {
      header: t('colEmail'),
      cell: record => {
        const src = record.customer ?? record.guestContact;
        return (
          <span className="text-sm text-muted-foreground whitespace-nowrap">
            {src?.emailMasked ?? '—'}
          </span>
        );
      },
    },
    {
      header: t('colGateway'),
      hideOnMobile: true,
      cell: record => (
        <span className="text-sm text-foreground whitespace-nowrap">
          {gatewayLabel(record.gateway)}
        </span>
      ),
    },
    {
      header: t('colValue'),
      cell: record => (
        <span className="text-sm text-foreground whitespace-nowrap">
          {formatMajor(record.total)}
        </span>
      ),
    },
    {
      header: t('colItems'),
      hideOnMobile: true,
      cell: record => <span className="text-sm text-muted-foreground">{record.itemCount}</span>,
    },
    {
      header: t('colAbandonedAt'),
      cell: record => (
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          {formatDate(record.abandonedAt)}
        </span>
      ),
    },
    {
      header: <span className="sr-only">{t('viewOrder')}</span>,
      alignEnd: true,
      mobileActions: true,
      cell: record => (
        <Link
          href={`/stores/${storeId}/orders/${record.id}`}
          className="text-xs text-primary hover:underline font-medium"
        >
          {t('viewOrder')}
        </Link>
      ),
    },
  ];

  const emptyState = (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
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
    </div>
  );

  return (
    <div className="space-y-4">
      <DataTable<AbandonmentRecord>
        ariaLabel={t('title')}
        columns={columns}
        rows={records}
        rowKey={record => record.id}
        emptyState={emptyState}
      />

      {records.length > 0 && meta.totalPages > 1 && (
        <div className="flex items-center justify-between px-6 py-4 rounded-xl border border-border bg-card">
          <p className="text-sm text-muted-foreground">
            {meta.page} / {meta.totalPages} ({meta.total})
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => onPageChange(Math.max(1, page - 1))}
              disabled={page === 1}
            >
              &larr;
            </Button>
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => onPageChange(Math.min(meta.totalPages, page + 1))}
              disabled={page === meta.totalPages}
            >
              &rarr;
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
