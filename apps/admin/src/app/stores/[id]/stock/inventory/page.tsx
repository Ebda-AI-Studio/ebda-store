'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost } from '@/lib/api';
import { Button, useToast } from '@force/ui';

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

interface FlagItem {
  productId: string;
}

interface FlagListResponse {
  data: FlagItem[];
  meta?: { total: number };
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function StockInventoryPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const router = useRouter();
  const t = useT('stock.inventory');
  const tc = useT('common');

  const [products, setProducts] = useState<ProductRow[] | null>(null);
  const [suggestedSet, setSuggestedSet] = useState<Set<string>>(new Set());
  const [deadSet, setDeadSet] = useState<Set<string>>(new Set());
  // Per-fetch error: products failure used to trigger an early-return blank page.
  // Now we render the table with an inline error banner + retry button so the
  // bulk-backorder action and any other page chrome still render.
  const [productsErr, setProductsErr] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const { success: toastSuccess, error: toastError } = useToast();

  // Whether every loaded product already allows backorder. Drives the
  // toggle button's label between "Enable all" and "Disable all".
  const allBackorderEnabled = Boolean(
    products && products.length > 0 && products.every(p => p.allowBackorder)
  );

  const handleBulkSetBackorder = async (enabled: boolean) => {
    const verb = enabled ? 'enable' : 'disable';
    if (!products || products.length === 0) return;
    const confirmed = window.confirm(
      enabled
        ? `Enable backorder on all ${products.length} active products? Customers will be able to order items even when out of stock.`
        : `Disable backorder on all ${products.length} active products? Out-of-stock items will become unorderable.`
    );
    if (!confirmed) return;
    setBulkBusy(true);
    try {
      const { data, error: apiError } = await apiPost<{ updated: number; enabled: boolean }>(
        `/api/v1/stores/${storeId}/products/bulk-set-backorder`,
        { enabled }
      );
      if (apiError) {
        toastError(`Could not ${verb} backorder`, apiError.message || '');
        return;
      }
      const updated = data?.updated ?? 0;
      toastSuccess(
        enabled
          ? `Backorder enabled on ${updated} products`
          : `Backorder disabled on ${updated} products`
      );
      // Optimistic UI update — no need to re-fetch the whole list
      setProducts(prev => (prev ? prev.map(p => ({ ...p, allowBackorder: enabled })) : prev));
    } catch (err) {
      toastError(`Could not ${verb} backorder`, err instanceof Error ? err.message : String(err));
    } finally {
      setBulkBusy(false);
    }
  };

  useEffect(() => {
    if (!storeId) return;

    // Products list
    apiGet<ProductsResponse>(`/api/v1/stores/${storeId}/products?status=active&limit=100`)
      .then(({ data, error: apiError }) => {
        if (apiError) {
          setProductsErr(apiError.message);
        } else {
          setProducts(data?.products ?? []);
        }
      })
      .catch(() => setProductsErr('Failed to load inventory'));

    // Reorder suggestions — fetch all open, build productId set
    apiGet<FlagListResponse>(
      `/api/v1/stores/${storeId}/stock/reorder-suggestions?status=open&perPage=500`
    ).then(({ data }) => {
      if (data?.data) {
        setSuggestedSet(new Set(data.data.map((s: FlagItem) => s.productId)));
      }
    });

    // Dead-stock flags — fetch all open, build productId set
    apiGet<FlagListResponse>(
      `/api/v1/stores/${storeId}/stock/deadstock-flags?status=open&perPage=500`
    ).then(({ data }) => {
      if (data?.data) {
        setDeadSet(new Set(data.data.map((f: FlagItem) => f.productId)));
      }
    });
  }, [storeId]);

  // Retry handler — clears the error and re-fires the products fetch
  const retryProducts = () => {
    if (!storeId) return;
    setProductsErr(null);
    setProducts(null);
    apiGet<ProductsResponse>(`/api/v1/stores/${storeId}/products?status=active&limit=100`)
      .then(({ data, error: apiError }) => {
        if (apiError) {
          setProductsErr(apiError.message);
        } else {
          setProducts(data?.products ?? []);
        }
      })
      .catch(() => setProductsErr('Failed to load inventory'));
  };

  const bulkBackorderButton =
    products && products.length > 0 ? (
      <Button
        variant="outline"
        size="sm"
        disabled={bulkBusy}
        onClick={() => handleBulkSetBackorder(!allBackorderEnabled)}
        title={
          allBackorderEnabled
            ? 'Turn off backorder for every active product'
            : 'Allow customers to order every product even when out of stock'
        }
      >
        {bulkBusy
          ? '…'
          : allBackorderEnabled
            ? 'Disable backorder on all products'
            : 'Enable backorder on all products'}
      </Button>
    ) : null;

  return (
    <AdminLayout title={t('title')} subtitle={t('description')} actions={bulkBackorderButton}>
      <div className="max-w-5xl">
        {/* Inline error banner: products fetch failed but page stays mounted */}
        {productsErr && (
          <div className="mb-4 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive flex items-center justify-between gap-4">
            <span title={productsErr}>Couldn't load products — {productsErr}</span>
            <button
              type="button"
              onClick={retryProducts}
              className="shrink-0 rounded-lg border border-destructive/40 px-3 py-1.5 text-xs font-medium hover:bg-destructive/10 transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {/* Loading skeleton while first fetch is in-flight */}
        {!products && !productsErr && (
          <div className="p-6 text-muted-foreground text-sm">{tc('loading')}</div>
        )}

        {products && products.length === 0 && (
          <p className="text-muted-foreground text-sm">{tc('noResults')}</p>
        )}
        {products && products.length > 0 && (
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
                  const hasReorder = suggestedSet.has(p.id);
                  const hasDead = deadSet.has(p.id);
                  return (
                    <tr key={p.id} className="border-t border-border/40">
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                        {p.sku ?? '—'}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate max-w-[10rem]">{p.name}</span>
                          {hasReorder && (
                            <span className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium bg-red-100 text-red-800 shrink-0">
                              🔴 {t('badgeReorder')}
                            </span>
                          )}
                          {hasDead && (
                            <span className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium bg-yellow-100 text-yellow-800 shrink-0">
                              🟡 {t('badgeDeadstock')}
                            </span>
                          )}
                        </div>
                      </td>
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
