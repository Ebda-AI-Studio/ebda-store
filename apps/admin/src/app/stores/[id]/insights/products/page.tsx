'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGet } from '@/lib/api';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { ErrorState } from '@/components/ErrorState';
// Contract shared with apps/api/src/routes/insights.routes.ts — the page was
// once built against six fields the route never returned, so every column
// rendered blank or 0 (2026-09-30 audit, finding 2).
import type { ProductVelocityResponse, ProductVelocityRow } from '@ebda/shared';

import { minorToDecimalString } from '@ebda/shared';
// ─── Helpers ─────────────────────────────────────────────────────────────────

// Unknown (null) renders as "—", never as a fabricated 0.
function major(piastres: number | null | undefined): string {
  if (typeof piastres !== 'number' || !Number.isFinite(piastres)) return '—';
  return minorToDecimalString(piastres);
}

function num(v: number | null | undefined, digits = 2): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function InsightsProductsPage() {
  const params = useParams();
  const router = useRouter();
  const storeId = params?.id as string;
  const t = useT('insights.products');

  const [data, setData] = useState<ProductVelocityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!storeId) return;
    setError(null);
    apiGet<ProductVelocityResponse>(`/api/v1/stores/${storeId}/insights/products?perPage=50`)
      .then(({ data: d, error: apiError }) => {
        if (apiError) setError(apiError.message ?? '');
        else if (d) setData(d);
      })
      .catch(() => setError(''));
  }, [storeId, reloadKey]);

  if (error !== null) {
    return (
      <AdminLayout title={t('title')}>
        <ErrorState message={error || t('loadFailed')} onRetry={() => setReloadKey(k => k + 1)} />
      </AdminLayout>
    );
  }

  if (!data) {
    return (
      <AdminLayout title={t('title')}>
        <div className="flex items-center justify-center h-64">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      </AdminLayout>
    );
  }

  const columns: DataTableColumn<ProductVelocityRow>[] = [
    {
      header: t('rank'),
      alignEnd: true,
      hideOnMobile: true,
      className: 'w-10',
      cell: row => <span className="font-mono text-xs text-muted-foreground">{row.rank}</span>,
    },
    {
      header: t('sku'),
      cell: row => (
        <span className="font-mono text-xs text-muted-foreground">{row.sku ?? '—'}</span>
      ),
    },
    {
      header: t('name'),
      primaryOnMobile: true,
      cell: row => (
        <>
          <span className="font-medium">{row.name ?? '—'}</span>
          {row.nameAr && (
            <span className="ms-2 text-xs text-muted-foreground" dir="rtl">
              {row.nameAr}
            </span>
          )}
        </>
      ),
    },
    {
      header: t('sold7d'),
      alignEnd: true,
      cell: row => <span className="font-mono">{row.unitsSold7d}</span>,
    },
    {
      header: t('sold30d'),
      alignEnd: true,
      cell: row => <span className="font-mono">{row.unitsSold30d}</span>,
    },
    {
      header: t('velocity'),
      alignEnd: true,
      cell: row => (
        <span className="font-mono text-xs">
          {num(row.velocityPerDay, 2)}{' '}
          <span className="text-muted-foreground">{t('velocityUnit')}</span>
        </span>
      ),
    },
    {
      header: t('asp'),
      alignEnd: true,
      cell: row => (
        <span
          className={`font-mono ${row.avgSellingPriceFils === null ? 'text-muted-foreground' : ''}`}
        >
          {major(row.avgSellingPriceFils)}
        </span>
      ),
    },
    {
      header: t('stockOnHand'),
      alignEnd: true,
      cell: row =>
        row.stockOnHand !== null ? (
          <span
            className={`font-mono ${row.stockOnHand <= 5 ? 'text-warning-ink font-semibold' : ''}`}
          >
            {row.stockOnHand}
          </span>
        ) : (
          <span className="font-mono text-muted-foreground">—</span>
        ),
    },
    {
      header: t('costPrice'),
      alignEnd: true,
      hideOnMobile: true,
      cell: row => (
        <span className="font-mono text-muted-foreground">{major(row.costPriceFils)}</span>
      ),
    },
  ];

  return (
    <AdminLayout title={t('title')} subtitle={t('description')}>
      <div className="max-w-6xl space-y-6">
        <DataTable<ProductVelocityRow>
          ariaLabel={t('title')}
          columns={columns}
          rows={data.products}
          rowKey={row => row.productId}
          onRowClick={row => router.push(`/stores/${storeId}/products/${row.productId}`)}
          emptyState={
            <div className="rounded-md border border-border px-4 py-3 text-sm text-muted-foreground">
              {t('empty')}
            </div>
          }
        />
      </div>
    </AdminLayout>
  );
}
