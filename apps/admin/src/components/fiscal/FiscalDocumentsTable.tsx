'use client';

import { buttonVariants } from '@/components/ui/Button';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { useLocale } from 'next-intl';
import { Badge } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { DataTable, type DataTableColumn } from '../mobile/DataTable';
import {
  formatFiscalDate,
  formatFiscalMoney,
  type FiscalDocument,
} from '../../lib/fiscal-documents';

interface FiscalDocumentsTableProps {
  documents: FiscalDocument[];
  timeZone?: string | null;
  /** Link to the order the document belongs to; null/undefined hides the link. */
  orderHref?: (doc: FiscalDocument) => string | null;
  /** Where "Open" goes (the HTML viewer page). */
  openHref: (doc: FiscalDocument) => string;
  emptyState?: ReactNode;
}

/** One table for the merchant Invoices page and the super-admin archive. */
export function FiscalDocumentsTable({
  documents,
  timeZone,
  orderHref,
  openHref,
  emptyState,
}: FiscalDocumentsTableProps) {
  const t = useT('invoices');
  const locale = useLocale();

  const columns: DataTableColumn<FiscalDocument>[] = [
    {
      header: t('columns.number'),
      primaryOnMobile: true,
      cell: d => (
        <span dir="ltr" className="font-mono text-sm font-medium text-foreground">
          {d.number}
        </span>
      ),
    },
    {
      header: t('columns.type'),
      cell: d => (
        <div>
          <span>{t(`types.${d.docType}`)}</span>
          {d.originalNumber && (
            <p className="text-xs text-muted-foreground">
              {t('againstInvoice')}{' '}
              <span dir="ltr" className="font-mono">
                {d.originalNumber}
              </span>
            </p>
          )}
        </div>
      ),
    },
    {
      header: t('columns.status'),
      mobileBadge: true,
      cell: d => (
        <Badge variant={d.status === 'cancelled' ? 'destructive' : 'success'}>
          {t(`statuses.${d.status}`)}
        </Badge>
      ),
    },
    {
      header: t('columns.issuedAt'),
      hideOnMobile: true,
      cell: d => (
        <span className="text-muted-foreground">
          {formatFiscalDate(d.issuedAt, locale, timeZone)}
        </span>
      ),
    },
    {
      header: t('columns.order'),
      hideOnMobile: true,
      cell: d => {
        const href = orderHref?.(d) ?? null;
        if (!d.orderNumber) return <span className="text-muted-foreground">—</span>;
        return href ? (
          <Link href={href} className="font-mono text-primary hover:underline" dir="ltr">
            {d.orderNumber}
          </Link>
        ) : (
          <span dir="ltr" className="font-mono">
            {d.orderNumber}
          </span>
        );
      },
    },
    {
      header: t('columns.net'),
      hideOnMobile: true,
      cell: d => <span dir="ltr">{formatFiscalMoney(d.netAmount, d.currency)}</span>,
    },
    {
      header: t('columns.vat'),
      hideOnMobile: true,
      cell: d => <span dir="ltr">{formatFiscalMoney(d.vatAmount, d.currency)}</span>,
    },
    {
      header: t('columns.total'),
      cell: d => (
        <span dir="ltr" className="font-semibold text-foreground">
          {formatFiscalMoney(d.totalAmount, d.currency)}
        </span>
      ),
    },
    {
      header: t('columns.actions'),
      cell: d => (
        <Link href={openHref(d)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          {t('open')}
        </Link>
      ),
    },
  ];

  return (
    <DataTable<FiscalDocument>
      ariaLabel={t('title')}
      columns={columns}
      rows={documents}
      rowKey={d => d.id}
      emptyState={emptyState}
    />
  );
}
