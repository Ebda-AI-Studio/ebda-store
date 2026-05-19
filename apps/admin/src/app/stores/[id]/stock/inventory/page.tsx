'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGet } from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProductRow {
  id: string;
  name: string;
  sku: string | null;
  inventory: number;
  lowStockThreshold: number;
  allowBackorder: boolean;
  status: string;
}

interface ProductsResponse {
  products: ProductRow[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function StockInventoryPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const router = useRouter();
  const t = useT('stock.inventory');
  const tc = useT('common');

  const [products, setProducts] = useState<ProductRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!storeId) return;
    apiGet<ProductsResponse>(`/api/v1/stores/${storeId}/products?status=active&limit=100`)
      .then(({ data, error: apiError }) => {
        if (apiError) {
          setError(apiError.message);
        } else {
          setProducts(data?.products ?? []);
        }
      })
      .catch(() => setError('Failed to load inventory'));
  }, [storeId]);

  if (error) {
    return (
      <AdminLayout title={t('title')}>
        <div className="p-6 text-red-600 text-sm">{error}</div>
      </AdminLayout>
    );
  }

  if (!products) {
    return (
      <AdminLayout title={t('title')}>
        <div className="p-6 text-muted-foreground text-sm">{tc('loading')}</div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout title={t('title')} subtitle={t('description')}>
      <div className="max-w-5xl">
        {products.length === 0 ? (
          <p className="text-muted-foreground text-sm">{tc('noResults')}</p>
        ) : (
          <div className="rounded-xl border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/30">
                <tr>
                  <th className="text-start px-3 py-2 font-medium text-muted-foreground w-28">
                    {t('sku')}
                  </th>
                  <th className="text-start px-3 py-2 font-medium text-muted-foreground">
                    {t('name')}
                  </th>
                  <th className="text-end px-3 py-2 font-medium text-muted-foreground w-24">
                    {t('onHand')}
                  </th>
                  <th className="text-end px-3 py-2 font-medium text-muted-foreground w-24">
                    {t('lowStockThreshold')}
                  </th>
                  <th className="text-center px-3 py-2 font-medium text-muted-foreground w-28">
                    {t('allowsBackorder')}
                  </th>
                  <th className="px-3 py-2 w-28" />
                </tr>
              </thead>
              <tbody>
                {products.map(p => {
                  const isLow = p.inventory > 0 && p.inventory <= p.lowStockThreshold;
                  return (
                    <tr key={p.id} className="border-t border-border/40">
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                        {p.sku ?? '—'}
                      </td>
                      <td className="px-3 py-2 truncate max-w-[14rem]">{p.name}</td>
                      <td
                        className={`px-3 py-2 text-end font-mono text-xs font-semibold ${
                          p.inventory === 0 ? 'text-red-600' : isLow ? 'text-amber-600' : ''
                        }`}
                      >
                        {p.inventory}
                      </td>
                      <td className="px-3 py-2 text-end font-mono text-xs text-muted-foreground">
                        {p.lowStockThreshold}
                      </td>
                      <td className="px-3 py-2 text-center text-muted-foreground">
                        {p.allowBackorder ? '✓' : '—'}
                      </td>
                      <td className="px-3 py-2 text-end">
                        <button
                          type="button"
                          onClick={() =>
                            router.push(
                              `/stores/${storeId}/stock/adjustments/new?productId=${p.id}&newQty=${p.inventory}`
                            )
                          }
                          className="text-primary text-xs underline underline-offset-2 hover:opacity-80"
                        >
                          {t('quickAdjust')}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
