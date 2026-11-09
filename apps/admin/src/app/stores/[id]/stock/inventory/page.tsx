'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { SearchInput } from '@/components/SearchInput';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { useT } from '@/i18n/useT';
import { useLatestRequest } from '@/hooks/useLatestRequest';
import { apiGet, apiPost } from '@/lib/api';
import { formatPrice } from '@/lib/format';
import { Button, useToast } from '@ebda/ui';
import { RowActions } from '@/components/RowActions';
import { useConfirm } from '@/hooks/useConfirm';

// ─── Select-all checkbox (indeterminate-aware) ─────────────────────────────────

function IndeterminateCheckbox({
  checked,
  indeterminate,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      className="rounded border-border"
      aria-label={ariaLabel}
    />
  );
}

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
  /** Unit selling price in piastres. */
  price: number;
  /** Cost-of-goods in piastres. Null for rows that never had a cost set. */
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

// Valid stock-status filter values that can arrive via ?filter= from KPI cards.
type StockFilterParam = 'low_stock' | 'out_of_stock';

function isStockFilterParam(v: string | null): v is StockFilterParam {
  return v === 'low_stock' || v === 'out_of_stock';
}

export default function StockInventoryPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useT('stock.inventory');
  const tc = useT('common');

  // ?filter= is set when navigating from a KPI card in InventoryStatsCards.
  // Accepted values: 'low_stock' | 'out_of_stock'. Applied client-side so we
  // avoid adding a new API param for a simple display filter.
  const filterParam = searchParams.get('filter');
  const activeStockFilter: StockFilterParam | null = isStockFilterParam(filterParam)
    ? filterParam
    : null;

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
  // Bumped by Retry: the fetch effect owns EVERY products request, so a retry reads the CURRENT
  // search/page instead of ones captured by a handler closure (issues 2441, 2443).
  const [refreshKey, setRefreshKey] = useState(0);
  // Latest-request-wins: a slower response for a previous search/page must not repaint its rows.
  const beginRequest = useLatestRequest();
  const askConfirm = useConfirm();
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

  // Client-side stock-status filter driven by the ?filter= query param set by
  // KPI card navigation. The API fetches all products; we narrow the display
  // here so the filter reacts instantly without a new network request.
  const visibleProducts = useMemo(() => {
    if (!products) return null;
    if (!activeStockFilter) return products;
    return products.filter(p => {
      const onHand = p.totalInventory ?? p.inventory;
      if (activeStockFilter === 'out_of_stock') return onHand === 0;
      if (activeStockFilter === 'low_stock') return onHand > 0 && onHand <= p.lowStockThreshold;
      return true;
    });
  }, [products, activeStockFilter]);

  // Whether every loaded product already allows backorder. Drives the
  // toggle button's label between "Enable all" and "Disable all".
  const allBackorderEnabled = Boolean(
    products && products.length > 0 && products.every(p => p.allowBackorder)
  );

  const handleBulkSetBackorder = async (enabled: boolean) => {
    if (!products || products.length === 0) return;
    const confirmed = await askConfirm({
      object: t('backorderObject', { count: products.length }),
      consequence: enabled ? t('backorderEnableConsequence') : t('backorderDisableConsequence'),
      confirmLabel: enabled ? t('bulkBackorderEnable') : t('bulkBackorderDisable'),
      tone: 'default',
    });
    if (!confirmed) return;
    setBulkBusy(true);
    try {
      const { data, error: apiError } = await apiPost<{ updated: number; enabled: boolean }>(
        `/api/v1/stores/${storeId}/products/bulk-set-backorder`,
        { enabled }
      );
      if (apiError) {
        toastError(enabled ? t('backorderEnableFailed') : t('backorderDisableFailed'));
        return;
      }
      const updated = data?.updated ?? 0;
      toastSuccess(
        enabled
          ? t('backorderEnabledDone', { count: updated })
          : t('backorderDisabledDone', { count: updated })
      );
      // Optimistic UI update — no need to re-fetch the whole list
      setProducts(prev => (prev ? prev.map(p => ({ ...p, allowBackorder: enabled })) : prev));
    } catch (err) {
      toastError(enabled ? t('backorderEnableFailed') : t('backorderDisableFailed'));
    } finally {
      setBulkBusy(false);
    }
  };

  // The page reset lives in the search handler (not a separate effect): an effect keyed on
  // `search` runs AFTER the fetch effect of the same commit, so the fetch would read the stale
  // page and a second request would follow (issue 2441).
  const handleSearch = (value: string) => {
    setSearch(value);
    setCurrentPage(1);
  };

  // Products list — the single owner of every products request; re-fetches when the debounced
  // search term, page or refreshKey (Retry) changes.
  useEffect(() => {
    if (!storeId) return;
    const isLatest = beginRequest();
    setProducts(null);
    setProductsErr(null);
    setSelectedIds([]);
    apiGet<ProductsResponse>(buildListUrl(search, currentPage))
      .then(({ data, error: apiError }) => {
        if (!isLatest()) return;
        if (apiError) {
          setProductsErr(apiError.message);
        } else {
          setProducts(data?.products ?? []);
          setTotalSkus(data?.meta?.total ?? data?.products?.length ?? 0);
          setTotalPages(data?.meta?.totalPages ?? 1);
        }
      })
      .catch(() => {
        if (!isLatest()) return;
        setProductsErr(t('loadFailedShort'));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, search, currentPage, refreshKey]);

  useEffect(() => {
    if (!storeId) return;

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

  // Retry handler — bumps the key so the products effect re-fires with the current search/page
  const retryProducts = () => {
    if (!storeId) return;
    setRefreshKey(k => k + 1);
  };

  // ─── Bulk low-stock-threshold ────────────────────────────────────────────
  // allSelected / toggleSelectAll operate on visibleProducts so when the stock
  // filter is active, "select all" only selects the visible (filtered) rows.
  const allSelected = useMemo(
    () =>
      Boolean(
        visibleProducts &&
        visibleProducts.length > 0 &&
        selectedIds.length === visibleProducts.length
      ),
    [visibleProducts, selectedIds]
  );

  const toggleSelection = (id: string) => {
    setSelectedIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  };

  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? [] : (visibleProducts ?? []).map(p => p.id));
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

  // A store-wide switch is not the page's main job: it lives in the "..." menu (rule 2), never as a header button.
  const bulkBackorderMenu =
    products && products.length > 0 ? (
      <RowActions
        menuLabel={t('moreActions')}
        items={[
          {
            label: allBackorderEnabled ? t('bulkBackorderDisable') : t('bulkBackorderEnable'),
            disabled: bulkBusy,
            onSelect: () => handleBulkSetBackorder(!allBackorderEnabled),
          },
        ]}
      />
    ) : null;

  return (
    <AdminLayout title={t('title')} subtitle={t('description')} actions={bulkBackorderMenu}>
      <div className="max-w-6xl">
        {/* Search bar — same debounced component the Products page uses. */}
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <SearchInput
            value={search}
            onSearch={handleSearch}
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
          <div className="mb-4 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive-ink flex items-center justify-between gap-4">
            <span title={productsErr}>{t('loadFailed', { error: productsErr })}</span>
            <button
              type="button"
              onClick={retryProducts}
              className="shrink-0 rounded-lg border border-destructive/40 px-3 py-1.5 text-xs font-medium hover:bg-destructive/10 transition-colors"
            >
              {tc('retry')}
            </button>
          </div>
        )}

        {/* Active stock-filter chip — shown when navigated here via a KPI card */}
        {activeStockFilter && (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <span>
              {t('filteredLabel')}{' '}
              <span className="font-medium text-foreground">
                {activeStockFilter === 'low_stock' ? t('filterLowStock') : t('filterOutOfStock')}
              </span>
            </span>
            <button
              type="button"
              onClick={() => router.replace(`/stores/${storeId}/stock/inventory`)}
              className="ms-auto rounded border border-border px-2 py-0.5 hover:bg-muted transition-colors"
            >
              {t('clearFilter')}
            </button>
          </div>
        )}

        {/* Loading skeleton while first fetch is in-flight */}
        {!products && !productsErr && (
          <div className="p-6 text-muted-foreground text-sm">{tc('loading')}</div>
        )}

        {visibleProducts && visibleProducts.length === 0 && (
          <p className="text-muted-foreground text-sm">{tc('noResults')}</p>
        )}
        {visibleProducts && visibleProducts.length > 0 && (
          <>
            {/* "Showing N of M" indicator — so a catalogue larger than the
                page cap is never silently truncated. */}
            <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {activeStockFilter
                  ? t('showingFiltered', {
                      shown: visibleProducts.length,
                      total: products?.length ?? 0,
                    })
                  : t('showingCount', { shown: visibleProducts.length, total: totalSkus })}
              </span>
            </div>
            {!activeStockFilter && totalPages > 1 && (
              <div className="mb-3 rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                {t('truncatedNotice', { shown: visibleProducts.length, total: totalSkus })}
              </div>
            )}
            {(() => {
              const someSelected = selectedIds.length > 0;
              const inventoryColumns: DataTableColumn<ProductRow>[] = [
                {
                  header: '',
                  className: 'w-10',
                  // Select-all checkbox is injected via the overlay below.
                  cell: p => (
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(p.id)}
                      onChange={() => toggleSelection(p.id)}
                      onClick={e => e.stopPropagation()}
                      aria-label={p.name}
                      className="rounded border-border"
                    />
                  ),
                },
                {
                  header: t('sku'),
                  className: 'w-28',
                  cell: p => (
                    <span className="font-mono text-xs text-muted-foreground">{p.sku ?? '—'}</span>
                  ),
                },
                {
                  header: t('name'),
                  primaryOnMobile: true,
                  cell: p => {
                    const hasReorder = suggestedSet.has(p.id);
                    const hasDead = deadSet.has(p.id);
                    return (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate max-w-[10rem]">{p.name}</span>
                        {hasReorder && (
                          <span className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs font-medium bg-red-100 text-red-800 shrink-0">
                            {t('badgeReorder')}
                          </span>
                        )}
                        {hasDead && (
                          <span className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs font-medium bg-yellow-100 text-yellow-800 shrink-0">
                            {t('badgeDeadstock')}
                          </span>
                        )}
                      </div>
                    );
                  },
                },
                {
                  header: t('onHand'),
                  alignEnd: true,
                  className: 'w-24',
                  cell: p => {
                    const onHand = p.totalInventory ?? p.inventory;
                    const isLow = onHand > 0 && onHand <= p.lowStockThreshold;
                    return (
                      <span
                        className={`font-mono text-xs font-semibold ${
                          onHand === 0 ? 'text-red-600' : isLow ? 'text-warning-ink' : ''
                        }`}
                      >
                        {onHand}
                      </span>
                    );
                  },
                },
                {
                  header: t('lowStockThreshold'),
                  alignEnd: true,
                  hideOnMobile: true,
                  className: 'w-24',
                  cell: p => (
                    <span className="font-mono text-xs text-muted-foreground">
                      {p.lowStockThreshold}
                    </span>
                  ),
                },
                {
                  header: t('cost'),
                  alignEnd: true,
                  className: 'w-24',
                  cell: p => (
                    <span className="font-mono text-xs text-muted-foreground">
                      {p.costPrice == null ? '—' : formatPrice(p.costPrice)}
                    </span>
                  ),
                },
                {
                  header: t('price'),
                  alignEnd: true,
                  className: 'w-24',
                  cell: p => <span className="font-mono text-xs">{formatPrice(p.price)}</span>,
                },
                {
                  header: t('salesQuantity'),
                  alignEnd: true,
                  hideOnMobile: true,
                  className: 'w-24',
                  cell: p => <span className="font-mono text-xs">{p.soldQuantity}</span>,
                },
                {
                  header: t('allowsBackorder'),
                  className: 'w-28',
                  cell: p => (
                    <div className="text-center text-muted-foreground">
                      {p.allowBackorder ? '✓' : '—'}
                    </div>
                  ),
                },
                {
                  header: '',
                  alignEnd: true,
                  mobileActions: true,
                  className: 'w-28',
                  cell: p => (
                    <button
                      type="button"
                      onClick={() =>
                        router.push(
                          `/stores/${storeId}/stock/adjustments/new?productId=${p.id}&newQty=${p.totalInventory ?? p.inventory}`
                        )
                      }
                      className="text-primary text-xs underline underline-offset-2 hover:opacity-80 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:px-2"
                    >
                      {t('quickAdjust')}
                    </button>
                  ),
                },
              ];
              return (
                <div className="relative">
                  {/* Inject the select-all checkbox into the first column header
                      via a sibling overlay (matches ProductsTable's convention)
                      so DataTable itself doesn't need a header-checkbox concept. */}
                  <div className="hidden md:flex absolute top-0 start-0 h-11 w-10 items-center justify-center z-10 pointer-events-auto">
                    <IndeterminateCheckbox
                      checked={allSelected}
                      indeterminate={!allSelected && someSelected}
                      onChange={toggleSelectAll}
                      ariaLabel={t('selectAll')}
                    />
                  </div>
                  <DataTable<ProductRow>
                    ariaLabel={t('title')}
                    columns={inventoryColumns}
                    rows={visibleProducts}
                    rowKey={p => p.id}
                  />
                </div>
              );
            })()}
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
