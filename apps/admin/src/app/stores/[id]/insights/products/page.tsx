'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGet } from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProductVelocityRow {
  rank: number;
  productId: string;
  sku: string | null;
  name: string;
  nameAr: string | null;
  unitsSold7d: number;
  unitsSold30d: number;
  velocityPerDay: number;
  avgSellingPriceFils: number;
  stockOnHand: number | null;
  costPriceFils: number | null;
}

interface ProductsData {
  products: ProductVelocityRow[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function kwd(fils: number): string {
  return (fils / 1000).toFixed(3);
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function InsightsProductsPage() {
  const params = useParams();
  const router = useRouter();
  const storeId = params?.id as string;
  const t = useT('insights.products');
  const tc = useT('common');

  const [data, setData] = useState<ProductsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!storeId) return;
    apiGet<ProductsData>(`/api/v1/stores/${storeId}/insights/products?perPage=50`)
      .then(({ data: d, error: apiError }) => {
        if (apiError) setError(apiError.message);
        else if (d) setData(d);
      })
      .catch(() => setError('Failed to load product velocity data'));
  }, [storeId]);

  if (error) {
    return (
      <AdminLayout title={t('title')}>
        <div className="p-6 text-red-600 text-sm">{error}</div>
      </AdminLayout>
    );
  }

  if (!data) {
    return (
      <AdminLayout title={t('title')}>
        <div className="p-6 text-muted-foreground text-sm">{tc('loading')}</div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout title={t('title')} subtitle={t('description')}>
      <div className="max-w-6xl space-y-6">
        {data.products.length === 0 ? (
          <div className="rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground">
            No product velocity data yet. Insights populate after the first nightly rollup at 02:00
            KW.
          </div>
        ) : (
          <div className="rounded-xl border border-border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-max">
                <thead>
                  <tr className="border-b border-border/60 bg-muted/40">
                    <th className="px-3 py-2 text-end text-xs font-medium text-muted-foreground w-10">
                      {t('rank')}
                    </th>
                    <th className="px-3 py-2 text-start text-xs font-medium text-muted-foreground">
                      {t('sku')}
                    </th>
                    <th className="px-3 py-2 text-start text-xs font-medium text-muted-foreground">
                      {t('name')}
                    </th>
                    <th className="px-3 py-2 text-end text-xs font-medium text-muted-foreground">
                      {t('sold7d')}
                    </th>
                    <th className="px-3 py-2 text-end text-xs font-medium text-muted-foreground">
                      {t('sold30d')}
                    </th>
                    <th className="px-3 py-2 text-end text-xs font-medium text-muted-foreground">
                      {t('velocity')}
                    </th>
                    <th className="px-3 py-2 text-end text-xs font-medium text-muted-foreground">
                      {t('asp')}
                    </th>
                    <th className="px-3 py-2 text-end text-xs font-medium text-muted-foreground">
                      {t('stockOnHand')}
                    </th>
                    <th className="px-3 py-2 text-end text-xs font-medium text-muted-foreground">
                      {t('costPrice')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.products.map(row => (
                    <tr
                      key={row.productId}
                      className="border-b border-border/40 last:border-0 hover:bg-muted/30 cursor-pointer transition-colors"
                      onClick={() => router.push(`/stores/${storeId}/products/${row.productId}`)}
                    >
                      <td className="px-3 py-2 text-end font-mono text-xs text-muted-foreground">
                        {row.rank}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                        {row.sku ?? '—'}
                      </td>
                      <td className="px-3 py-2">
                        <span className="font-medium">{row.name}</span>
                        {row.nameAr && (
                          <span className="ms-2 text-xs text-muted-foreground" dir="rtl">
                            {row.nameAr}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-end font-mono">{row.unitsSold7d}</td>
                      <td className="px-3 py-2 text-end font-mono">{row.unitsSold30d}</td>
                      <td className="px-3 py-2 text-end font-mono text-xs">
                        {row.velocityPerDay.toFixed(2)}{' '}
                        <span className="text-muted-foreground">{t('velocityUnit')}</span>
                      </td>
                      <td className="px-3 py-2 text-end font-mono">
                        {kwd(row.avgSellingPriceFils)}
                      </td>
                      <td className="px-3 py-2 text-end font-mono">
                        {row.stockOnHand !== null ? (
                          <span
                            className={row.stockOnHand <= 5 ? 'text-amber-600 font-semibold' : ''}
                          >
                            {row.stockOnHand}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-end font-mono text-muted-foreground">
                        {row.costPriceFils !== null ? kwd(row.costPriceFils) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
