'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGet } from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface FinanceDashboard {
  thisMonth: { revenue: number; expenses: number; net: number };
  cash: { code: string; nameEn: string; balance: number }[];
  stockValue: number;
  balanceSheet: { totalAssets: number; totalLiabilities: number; totalEquity: number };
}

interface ProductsResponse {
  products: unknown[];
  meta: { total: number };
}

interface LowStockResponse {
  products: unknown[] | null;
}

type BackordersArray = unknown[];

// ─── Component ────────────────────────────────────────────────────────────────

export default function StockDashboardPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('stock.dashboard');
  const tc = useT('common');

  const [dashboard, setDashboard] = useState<FinanceDashboard | null>(null);
  const [onHandCount, setOnHandCount] = useState<number | null>(null);
  const [lowStockCount, setLowStockCount] = useState<number | null>(null);
  const [backorderCount, setBackorderCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!storeId) return;

    // Finance dashboard (stock value)
    apiGet<FinanceDashboard>(`/api/v1/stores/${storeId}/finance/dashboard`).then(
      ({ data, error: e }) => {
        if (e) setError(e.message);
        else if (data) setDashboard(data);
      }
    );

    // On-hand SKUs (active products count)
    apiGet<ProductsResponse>(`/api/v1/stores/${storeId}/products?status=active&limit=1`).then(
      ({ data }) => {
        if (data) setOnHandCount(data.meta?.total ?? data.products?.length ?? 0);
      }
    );

    // Low-stock SKUs
    apiGet<LowStockResponse>(`/api/v1/stores/${storeId}/analytics/low-stock`).then(({ data }) => {
      if (data) setLowStockCount(data.products?.length ?? 0);
    });

    // Open backorders
    apiGet<BackordersArray>(`/api/v1/stores/${storeId}/backorders`).then(({ data }) => {
      if (data) setBackorderCount(data.length);
    });
  }, [storeId]);

  if (error) {
    return (
      <AdminLayout title={t('title')}>
        <div className="p-6 text-red-600 text-sm">{error}</div>
      </AdminLayout>
    );
  }

  if (!dashboard) {
    return (
      <AdminLayout title={t('title')}>
        <div className="p-6 text-muted-foreground text-sm">{tc('loading')}</div>
      </AdminLayout>
    );
  }

  const kpis = [
    {
      label: t('stockValue'),
      value: `${(dashboard.stockValue / 1000).toFixed(3)} KWD`,
      highlight: true,
    },
    {
      label: t('onHandSkus'),
      value: onHandCount !== null ? String(onHandCount) : '…',
    },
    {
      label: t('lowStockSkus'),
      value: lowStockCount !== null ? String(lowStockCount) : '…',
      warn: lowStockCount !== null && lowStockCount > 0,
    },
    {
      label: t('openBackorders'),
      value: backorderCount !== null ? String(backorderCount) : '…',
    },
    {
      label: t('reorderSuggestions'),
      value: t('comingBatch3'),
      muted: true,
    },
  ];

  return (
    <AdminLayout title={t('title')}>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 max-w-5xl">
        {kpis.map(kpi => (
          <div key={kpi.label} className="rounded-xl border border-border bg-card p-5 space-y-1">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {kpi.label}
            </p>
            <p
              className={[
                'text-2xl font-semibold font-mono',
                kpi.highlight ? 'text-primary' : '',
                kpi.warn ? 'text-amber-600' : '',
                kpi.muted ? 'text-muted-foreground text-base' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {kpi.value}
            </p>
          </div>
        ))}
      </div>
    </AdminLayout>
  );
}
