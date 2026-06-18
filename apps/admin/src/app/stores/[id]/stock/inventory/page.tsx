'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { SearchInput } from '@/components/SearchInput';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost } from '@/lib/api';
import { formatPrice } from '@/lib/format';
import { Button, useToast } from '@force/ui';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProductRow {
  id: string;
  name: string;
  sku: string | null;
  inventory: number;
  /** Variant-aware stock total from the API (variant sum for variant products, else `inventory`). */
  totalInventory?: number;
  hasVariants?: boolean;
  lowStockThreshold: number;
  allowBackorder: boolean;
  status: string;
  /** Unit selling price in fils. */
  price: number;
  /** Cost-of-goods in fils. Null for rows that never had a cost set. */
  costPrice: number | null;
  /** Total units sold across realized-sale orders. Supplied by the API when
   *  the list is requested with `withSalesQuantity=true`. */
  soldQuantity: number;
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

// Rows fetched per inventory page. The server allows up to 500; 100 keeps the
// table responsive. Larger catalogues are paginated (Prev/Next below the table)
// rather than silently truncated.
const INVENTORY_PAGE_LIMIT = 100;

// ─── Component ────────────────────────────────────────────────────────────────

export default function StockInventoryPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const router = useRouter();
  const t = useT('stock.inventory');
  const tc = useT('common');

  const [products, setProducts] = useState<ProductRow[] | null>(null);
  // Total SKUs matching the current filter (from API meta). Used to surface a
  // "showing N of M" indicator + a truncation notice — the list is hard-capped
  // at INVENTORY_PAGE_LIMIT so larger catalogues used to truncate silently.
  const [totalSkus, setTotalSkus] = useState(0);
  // Pagination — the API returns meta.totalPages; we render Prev/Next below the
  // table. Resets to page 1 whenever the search term changes.
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [suggestedSet, setSuggestedSet] = useState<Set<string>>(new Set());
  const [deadSet, setDeadSet] = useState<Set<string>>(new Set());
  // Per-fetch error: products failure used to trigger an early-return blank page.
  // Now we render the table with an inline error banner + retry button so the
  // bulk-backorder action and any other page chrome still render.
  const [productsErr, setProductsErr] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  // Debounced search term (SearchInput owns the debounce) — filters the list
  // by name + SKU server-side, matching the Products page search.
  const [search, setSearch] = useState('');
  // Bulk low-stock-threshold control state.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [thresholdInput, setThresholdInput] = useState('');
  const { success: toastSuccess, error: toastError } = useToast();

  // Build the inventory list URL. Lists ALL items (no status filter) so the
  // merchant sees draft/archived stock too; opts into the sold-units aggregate.
  const buildListUrl = (term: string, page: number) => {
    const qs = new URLSearchParams({
      limit: String(INVENTORY_PAGE_LIMIT),
      page: String(page),
      withSalesQuantity: 'true',
    });
    if (term) qs.set('search', term);
    return `/api/v1/stores/${storeId}/products?${qs.toString()}`;
  };

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

  // Reset to the first page whenever the search term changes so the merchant
  // never lands on an out-of-range page for a narrower result set.
  useEffect(() => {
    setCurrentPage(1);
  }, [search]);

  useEffect(() => {
    if (!storeId) return;

    // Products list — re-fetches when the debounced search term or page changes.
    setProducts(null);
    setSelectedIds([]);
    apiGet<ProductsResponse>(buildListUrl(search, currentPage))
      .then(({ data, error: apiError }) => {
        if (apiError) {
          setProductsErr(apiError.message);
        } else {
          setProducts(data?.products ?? []);
          setTotalSkus(data?.meta?.total ?? data?.products?.length ?? 0);
          setTotalPages(data?.meta?.totalPages ?? 1);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, search, currentPage]);

  // Retry handler — clears the error and re-fires the products fetch
  const retryProducts = () => {
    if (!storeId) return;
    setProductsErr(null);
    setProducts(null);
    apiGet<ProductsResponse>(buildListUrl(search, currentPage))
      .then(({ data, error: apiError }) => {
        if (apiError) {
          setProductsErr(apiError.message);
        } else {
          setProducts(data?.products ?? []);
          setTotalSkus(data?.meta?.total ?? data?.products?.length ?? 0);
          setTotalPages(data?.meta?.totalPages ?? 1);
        }
      })
      .catch(() => setProductsErr('Failed to load inventory'));
  };

  // ─── Bulk low-stock-threshold ────────────────────────────────────────────
  const allSelected = useMemo(
    () => Boolean(products && products.length > 0 && selectedIds.length === products.length),
    [products, selectedIds]
  );

  const toggleSelection = (id: string) => {
    setSelectedIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  };

  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? [] : (products ?? []).map(p => p.id));
  };

  const handleBulkSetThreshold = async () => {
    const value = parseInt(thresholdInput, 10);
    if (Number.isNaN(value) || value < 0 || selectedIds.length === 0) return;
    setBulkBusy(true);
    try {
      const { data, error: apiError } = await apiPost<{ updated: number }>(
        `/api/v1/stores/${storeId}/products/bulk-set-low-stock-threshold`,
        { productIds: selectedIds, lowStockThreshold: value }
      );
      if (apiError) {
        toastError(t('bulkThresholdFailed'), apiError.message || '');
        return;
      }
      toastSuccess(t('bulkThresholdDone', { count: data?.updated ?? 0 }));
      // Reflect the change locally without a full re-fetch.
      setProducts(prev =>
        prev
          ? prev.map(p => (selectedIds.includes(p.id) ? { ...p, lowStockThreshold: value } : p))
          : prev
      );
      setSelectedIds([]);
      setThresholdInput('');
    } catch (err) {
      toastError(t('bulkThresholdFailed'), err instanceof Error ? err.message : String(err));
    } finally {
      setBulkBusy(false);
    }
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
      <div className="max-w-6xl">
        {/* Search bar — same debounced component the Products page uses. */}
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <SearchInput
            value={search}
            onSearch={setSearch}
            placeholder={t('searchPlaceholder')}
            className="w-full sm:w-72"
          />
          {selectedIds.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 p-2">
              <span className="text-xs text-muted-foreground">
                {t('selectedCount', { count: selectedIds.length })}
              </span>
              <input
                type="number"
                min={0}
                value={thresholdInput}
                onChange={e => setThresholdInput(e.target.value)}
                placeholder={t('lowStockThreshold')}
                aria-label={t('bulkSetThreshold')}
                className="w-28 rounded-lg border border-border bg-card px-3 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <Button size="sm" disabled={bulkBusy} onClick={handleBulkSetThreshold}>
                {bulkBusy ? '…' : t('bulkSetThreshold')}
              </Button>
            </div>
          )}
        </div>

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
          <>
            {/* "Showing N of M" indicator — so a catalogue larger than the
                page cap is never silently truncated. */}
            <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
              <span>{t('showingCount', { shown: products.length, total: totalSkus })}</span>
            </div>
            {totalPages > 1 && (
              <div className="mb-3 rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                {t('truncatedNotice', { shown: products.length, total: totalSkus })}
              </div>
            )}
            <div className="rounded-xl border border-border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/30">
                  <tr>
                    <th className="px-3 py-2 w-10">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={toggleSelectAll}
                        aria-label={t('selectAll')}
                        className="rounded border-border"
                      />
                    </th>
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
                    <th className="text-end px-3 py-2 font-medium text-muted-foreground w-24">
                      {t('cost')}
                    </th>
                    <th className="text-end px-3 py-2 font-medium text-muted-foreground w-24">
                      {t('price')}
                    </th>
                    <th className="text-end px-3 py-2 font-medium text-muted-foreground w-24">
                      {t('salesQuantity')}
                    </th>
                    <th className="text-center px-3 py-2 font-medium text-muted-foreground w-28">
                      {t('allowsBackorder')}
                    </th>
                    <th className="px-3 py-2 w-28" />
                  </tr>
                </thead>
                <tbody>
                  {products.map(p => {
                    // Variant products carry their stock on the variants, so the
                    // API returns a variant-aware `totalInventory`. Resolve On-Hand
                    // + low-stock colouring against that value.
                    const onHand = p.hasVariants ? (p.totalInventory ?? 0) : p.inventory;
                    const isLow = onHand > 0 && onHand <= p.lowStockThreshold;
                    const hasReorder = suggestedSet.has(p.id);
                    const hasDead = deadSet.has(p.id);
                    return (
                      <tr key={p.id} className="border-t border-border/40">
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={selectedIds.includes(p.id)}
                            onChange={() => toggleSelection(p.id)}
                            aria-label={p.name}
                            className="rounded border-border"
                          />
                        </td>
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
                            onHand === 0 ? 'text-red-600' : isLow ? 'text-amber-600' : ''
                          }`}
                        >
                          {onHand}
                        </td>
                        <td className="px-3 py-2 text-end font-mono text-xs text-muted-foreground">
                          {p.lowStockThreshold}
                        </td>
                        <td className="px-3 py-2 text-end font-mono text-xs text-muted-foreground">
                          {p.costPrice == null ? '—' : formatPrice(p.costPrice)}
                        </td>
                        <td className="px-3 py-2 text-end font-mono text-xs">
                          {formatPrice(p.price)}
                        </td>
                        <td className="px-3 py-2 text-end font-mono text-xs">{p.soldQuantity}</td>
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
            {/* Paginator — Prev/Next + "page X of N". Disabled at the ends. */}
            {totalPages > 1 && (
              <div className="mt-3 flex items-center justify-between gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage <= 1}
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                >
                  {tc('previous')}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {t('pageOf', { page: currentPage, total: totalPages })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage >= totalPages}
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                >
                  {tc('next')}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </AdminLayout>
  );
}
