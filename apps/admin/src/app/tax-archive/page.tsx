'use client';

/**
 * Super-admin tax archive — /tax-archive (ruling MONEYB-4).
 *
 * Fiscal documents are kept for seven years, including those of stores that were later deleted.
 * This page lists every store that has archived documents with its document count, last document,
 * issued totals for the chosen period and its tax registration / ETA status; opening one shows
 * its documents.
 *
 * Route guard: super_admin only (RequireSuperAdmin + the API's authorize('super_admin')).
 */

import { FIELD_CLASSES } from '@/components/ui/tokens';
import { buttonVariants } from '@/components/ui/Button';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useLocale } from 'next-intl';
import { Badge } from '@ebda/ui';
import { AdminLayout } from '../../components/AdminLayout';
import { RequireSuperAdmin } from '../../components/RequireSuperAdmin';
import { DataTable, type DataTableColumn } from '../../components/mobile/DataTable';
import { apiGet } from '../../lib/api';
import {
  formatFiscalDate,
  formatFiscalMoney,
  periodRange,
  type ArchivePeriod,
  type ArchiveStoreSummary,
} from '../../lib/fiscal-documents';
import { useT } from '../../i18n/useT';

interface ArchiveStore {
  storeId: string;
  storeName: string | null;
  documentCount: number;
  lastIssuedAt: string | null;
  storeExists: boolean;
  summary: ArchiveStoreSummary | null;
}

const PERIODS: ArchivePeriod[] = ['thisMonth', 'lastMonth', 'thisYear'];

function TaxArchiveInner() {
  const t = useT('taxArchive');
  const locale = useLocale();
  const [stores, setStores] = useState<ArchiveStore[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [period, setPeriod] = useState<ArchivePeriod>('thisMonth');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const { from, to } = periodRange(period);
    void apiGet<{ stores: ArchiveStore[] }>(
      `/api/v1/admin/fiscal-archive?${new URLSearchParams({ from, to })}`
    ).then(({ data, error }) => {
      if (cancelled) return;
      setLoadError(!!error);
      setStores(data?.stores ?? []);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [period]);

  const columns = useMemo<DataTableColumn<ArchiveStore>[]>(
    () => [
      {
        header: t('columns.store'),
        primaryOnMobile: true,
        cell: s => (
          <span className="font-medium text-foreground">
            {s.storeName ?? s.storeId}
            {!s.storeExists && (
              <Badge variant="destructive" className="ms-2">
                {t('deletedStore')}
              </Badge>
            )}
          </span>
        ),
      },
      {
        header: t('columns.documents'),
        cell: s => <span>{s.documentCount}</span>,
      },
      {
        header: t('columns.lastIssued'),
        hideOnMobile: true,
        cell: s => (
          <div className="text-muted-foreground">
            <span>{s.lastIssuedAt ? formatFiscalDate(s.lastIssuedAt, locale) : '—'}</span>
            {s.summary?.lastNumber && (
              <p dir="ltr" className="font-mono text-sm">
                {s.summary.lastNumber}
              </p>
            )}
          </div>
        ),
      },
      {
        header: t('columns.periodTotals'),
        hideOnMobile: true,
        cell: s =>
          s.summary ? (
            <div dir="ltr" className="text-sm">
              <p>
                {t('totals.net')} {formatFiscalMoney(s.summary.period.net, 'EGP')}
              </p>
              <p className="text-muted-foreground">
                {t('totals.vat')} {formatFiscalMoney(s.summary.period.vat, 'EGP')}
              </p>
              <p className="font-semibold text-foreground">
                {t('totals.gross')} {formatFiscalMoney(s.summary.period.gross, 'EGP')}
              </p>
              <p className="text-sm text-muted-foreground">
                {t('totals.count', { count: s.summary.period.count })}
              </p>
            </div>
          ) : (
            <span className="text-muted-foreground">{t('noLiveData')}</span>
          ),
      },
      {
        header: t('columns.taxStatus'),
        hideOnMobile: true,
        cell: s =>
          s.summary ? (
            <div className="space-y-1">
              <Badge variant={s.summary.trnPresent ? 'success' : 'warning'}>
                {s.summary.trnPresent ? t('trn.present') : t('trn.missing')}
              </Badge>
              <br />
              <Badge variant={s.summary.etaConnected ? 'success' : 'secondary'}>
                {s.summary.etaConnected
                  ? s.summary.etaEnabled
                    ? t('eta.connected')
                    : t('eta.connectedOff')
                  : t('eta.notConnected')}
              </Badge>
            </div>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        header: t('columns.actions'),
        cell: s => (
          <Link
            href={`/tax-archive/${s.storeId}`}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            {t('viewDocuments')}
          </Link>
        ),
      },
    ],
    [t, locale]
  );

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <p className="text-sm text-muted-foreground">{t('retention')}</p>
      <label className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t('periodLabel')}</span>
        <select
          value={period}
          onChange={e => setPeriod(e.target.value as ArchivePeriod)}
          className={`${FIELD_CLASSES} sm:w-auto`}
        >
          {PERIODS.map(p => (
            <option key={p} value={p}>
              {t(`periods.${p}`)}
            </option>
          ))}
        </select>
      </label>
      <p className="text-sm text-muted-foreground">{t('totalsNote')}</p>
      {loading ? (
        <div className="rounded-lg border border-border px-3 py-6 text-center text-muted-foreground">
          {t('loading')}
        </div>
      ) : (
        <DataTable<ArchiveStore>
          ariaLabel={t('title')}
          columns={columns}
          rows={stores}
          rowKey={s => s.storeId}
          emptyState={
            loadError ? (
              <div
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-6 text-center text-destructive-ink"
              >
                {t('loadFailed')}
              </div>
            ) : (
              <div className="rounded-lg border border-border px-3 py-6 text-center text-muted-foreground">
                {t('empty')}
              </div>
            )
          }
        />
      )}
    </div>
  );
}

export default function TaxArchivePage() {
  const t = useT('taxArchive');
  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')} mode="super_admin">
      <RequireSuperAdmin>
        <TaxArchiveInner />
      </RequireSuperAdmin>
    </AdminLayout>
  );
}
