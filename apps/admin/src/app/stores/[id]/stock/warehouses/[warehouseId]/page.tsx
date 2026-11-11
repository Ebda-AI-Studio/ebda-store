'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { SearchInput } from '@/components/SearchInput';
import { DataTable } from '@/components/mobile/DataTable';
import { useT } from '@/i18n/useT';
import { ArrowStart, ArrowEnd } from '@/components/ArrowStart';
import { apiGet, apiPost, apiPut } from '@/lib/api';
import { useFeatures } from '@/hooks/useFeatures';
import { useLatestRequest } from '@/hooks/useLatestRequest';
import { VariantText, useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { FIELD_CLASSES } from '@/components/ui/tokens';

// ─── Types ────────────────────────────────────────────────────────────────────

interface StockRow {
  id: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  updatedAt: string;
  productName: string;
  productSku: string | null;
  variantTitle: string | null;
  variantSku: string | null;
}

interface Warehouse {
  id: string;
  name: string;
  code: string;
  isDefault: boolean;
  totalSkus: number;
  totalUnits: number;
}

interface AdjustModal {
  row: StockRow;
  delta: number;
  reason: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function WarehouseStockPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const warehouseId = params?.warehouseId as string;
  const t = useT('stock.warehouseStock');
  const tc = useT('common');
  const { success: toastSuccess, error: toastError } = useToast();
  const { isEnabled } = useFeatures();
  const multiWarehouseEnabled = isEnabled('inventory.multi_warehouse');

  const [warehouse, setWarehouse] = useState<Warehouse | null>(null);
  const [rows, setRows] = useState<StockRow[]>([]);
  const [total, setTotal] = useState(0);
  // The search matched more than the API's 1,000-match cap: say so instead of a silent total.
  const [truncated, setTruncated] = useState(false);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // Bumped after a stock write: the stock effect owns EVERY request, so the refetch reads the
  // CURRENT page/search instead of ones captured by the handler's closure (issue 2443).
  const [refreshKey, setRefreshKey] = useState(0);
  // Latest-request-wins: a slower response for a previous page/search must not repaint its rows.
  const beginRequest = useLatestRequest();

  // Inline quantity edit state: rowId → pending value
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});

  // Adjust modal
  const [adjustModal, setAdjustModal] = useState<AdjustModal | null>(null);
  const [adjustSaving, setAdjustSaving] = useState(false);

  // Reconcile-to-aggregate action
  const [reconciling, setReconciling] = useState(false);

  const LIMIT = 50;

  async function loadWarehouse() {
    const { data } = await apiGet<{ warehouse: Warehouse }>(
      `/api/v1/stores/${storeId}/warehouses/${warehouseId}`
    );
    if (data?.warehouse) {
      setWarehouse(data.warehouse);
    }
  }

  async function loadStock() {
    const isLatest = beginRequest();
    setLoading(true);
    setErr(null);
    const qs = new URLSearchParams({
      page: String(page),
      limit: String(LIMIT),
      ...(search && { search }),
    });
    const { data, error: apiError } = await apiGet<{
      rows: StockRow[];
      total: number;
      truncated?: boolean;
    }>(`/api/v1/stores/${storeId}/warehouses/${warehouseId}/stock?${qs}`);
    if (!isLatest()) return;
    if (apiError) {
      setErr(apiError.message);
    } else {
      setRows(data?.rows ?? []);
      setTotal(data?.total ?? 0);
      setTruncated(!!data?.truncated);
    }
    setLoading(false);
  }

  useEffect(() => {
    if (storeId && warehouseId) {
      loadWarehouse();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, warehouseId]);

  useEffect(() => {
    if (storeId && warehouseId) {
      loadStock();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, warehouseId, page, search, refreshKey]);

  async function handleSetQty(row: StockRow) {
    const val = editing[row.id];
    if (val === undefined) return;
    const qty = parseInt(val);
    if (isNaN(qty) || qty < 0) {
      toastError(t('invalidQty'));
      return;
    }
    setSaving(s => ({ ...s, [row.id]: true }));
    try {
      const { error: putError } = await apiPut(
        `/api/v1/stores/${storeId}/warehouses/${warehouseId}/stock`,
        {
          productId: row.productId,
          variantId: row.variantId,
          quantity: qty,
        }
      );
      if (putError) throw new Error(putError.message);
      toastSuccess(t('qtyUpdated'));
      setEditing(e => {
        const copy = { ...e };
        delete copy[row.id];
        return copy;
      });
      setRefreshKey(k => k + 1);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : t('saveFailed');
      toastError(msg);
    } finally {
      setSaving(s => ({ ...s, [row.id]: false }));
    }
  }

  async function handleAdjust() {
    if (!adjustModal) return;
    if (adjustModal.delta === 0) {
      toastError(t('zeroDelta'));
      return;
    }
    setAdjustSaving(true);
    try {
      const { error: adjError } = await apiPost(
        `/api/v1/stores/${storeId}/warehouses/${warehouseId}/stock/adjust`,
        {
          productId: adjustModal.row.productId,
          variantId: adjustModal.row.variantId,
          delta: adjustModal.delta,
          reason: adjustModal.reason || undefined,
        }
      );
      if (adjError) throw new Error(adjError.message);
      toastSuccess(t('adjustDone'));
      setAdjustModal(null);
      setRefreshKey(k => k + 1);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : t('adjustFailed');
      toastError(msg);
    } finally {
      setAdjustSaving(false);
    }
  }

  async function handleReconcile() {
    setReconciling(true);
    try {
      // Fixed 2026-07-23: the endpoint is now async — it enqueues an
      // Inngest job (`warehouse/reconcile-requested`) and returns
      // `{ accepted: true }` immediately rather than the old synchronous
      // {skusReconciled, skusFailed} counts. Counts arrive later via the
      // async job + the daily completeness sweep, not this response.
      const { error: apiError } = await apiPost<{ accepted: boolean }>(
        `/api/v1/stores/${storeId}/warehouses/reconcile-all`
      );
      if (apiError) {
        toastError(apiError.message);
      } else {
        toastSuccess(t('reconcileStarted'));
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : t('reconcileFailed');
      toastError(msg);
    } finally {
      setReconciling(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <AdminLayout
      title={warehouse ? `${t('title')} — ${warehouse.name}` : t('title')}
      subtitle={
        warehouse ? t('subtitle', { code: warehouse.code, units: warehouse.totalUnits }) : undefined
      }
      parent={{ label: t('breadcrumb'), href: `/stores/${storeId}/stock/warehouses` }}
      actions={
        multiWarehouseEnabled ? (
          <Button variant="outline" onClick={handleReconcile} disabled={reconciling}>
            {reconciling ? t('reconciling') : t('reconcileAction')}
          </Button>
        ) : undefined
      }
    >
      {/* Search */}
      <div className="mb-4">
        <SearchInput
          value={search}
          onSearch={value => {
            setSearch(value);
            setPage(1);
          }}
          placeholder={t('searchPlaceholder')}
        />
        {search && truncated && (
          <p className="mt-2 text-xs text-muted-foreground">{t('searchTruncated')}</p>
        )}
      </div>

      {/* Reconcile helper note */}
      {multiWarehouseEnabled && (
        <p className="mb-4 text-xs text-muted-foreground">{t('reconcileHint')}</p>
      )}

      {/* Error */}
      {err && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive-ink">
          {err}{' '}
          <button className="underline" onClick={() => setRefreshKey(k => k + 1)}>
            {tc('retry')}
          </button>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="h-14 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      )}

      {/* Empty */}
      {!loading && !err && rows.length === 0 && (
        <div className="py-16 text-center text-muted-foreground">
          {search ? t('noResults') : t('empty')}
        </div>
      )}

      {/* Table */}
      {!loading && rows.length > 0 && (
        <>
          <DataTable<StockRow>
            ariaLabel={t('title')}
            columns={[
              {
                header: t('colProduct'),
                primaryOnMobile: true,
                cell: row => <span className="font-medium">{row.productName}</span>,
              },
              {
                header: t('colSku'),
                cell: row => (
                  <span className="font-mono text-xs text-muted-foreground">
                    {row.variantSku ?? row.productSku ?? '—'}
                  </span>
                ),
              },
              {
                header: t('colVariant'),
                cell: row => (
                  <span className="text-muted-foreground">
                    {row.variantTitle ? <VariantText title={row.variantTitle} /> : '—'}
                  </span>
                ),
              },
              {
                header: t('colQty'),
                alignEnd: true,
                cell: row => {
                  const isEditing = editing[row.id] !== undefined;
                  return isEditing ? (
                    <input
                      type="number"
                      min={0}
                      className={`${FIELD_CLASSES} w-20 text-end`}
                      value={editing[row.id]}
                      onChange={e => setEditing(ed => ({ ...ed, [row.id]: e.target.value }))}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleSetQty(row);
                        if (e.key === 'Escape')
                          setEditing(ed => {
                            const c = { ...ed };
                            delete c[row.id];
                            return c;
                          });
                      }}
                      autoFocus
                    />
                  ) : (
                    <span
                      className="cursor-pointer tabular-nums hover:underline"
                      onClick={() => setEditing(ed => ({ ...ed, [row.id]: String(row.quantity) }))}
                      title={t('clickToEdit')}
                    >
                      {row.quantity}
                    </span>
                  );
                },
              },
              {
                header: tc('actions'),
                alignEnd: true,
                mobileActions: true,
                cell: row => {
                  const isEditing = editing[row.id] !== undefined;
                  const isSaving = saving[row.id] === true;
                  return (
                    <div className="flex items-center justify-end gap-1">
                      {isEditing ? (
                        <>
                          <Button
                            onClick={() => handleSetQty(row)}
                            disabled={isSaving}
                            variant="ghost"
                            size="sm"
                          >
                            {isSaving ? tc('saving') : tc('save')}
                          </Button>
                          <Button
                            onClick={() =>
                              setEditing(ed => {
                                const c = { ...ed };
                                delete c[row.id];
                                return c;
                              })
                            }
                            variant="ghost"
                            size="sm"
                          >
                            {tc('cancel')}
                          </Button>
                        </>
                      ) : (
                        <Button
                          onClick={() => setAdjustModal({ row, delta: 0, reason: '' })}
                          variant="ghost"
                          size="sm"
                        >
                          {t('adjust')}
                        </Button>
                      )}
                    </div>
                  );
                },
              },
            ]}
            rows={rows}
            rowKey={row => row.id}
          />

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
              <span>
                {t('showing', {
                  from: (page - 1) * LIMIT + 1,
                  to: Math.min(page * LIMIT, total),
                  total,
                })}
              </span>
              <div className="flex gap-2">
                <Button
                  disabled={page === 1}
                  onClick={() => setPage(p => p - 1)}
                  aria-label={t('pagePrev')}
                  variant="outline"
                  size="icon-sm"
                >
                  <ArrowStart />
                </Button>
                <Button
                  disabled={page === totalPages}
                  onClick={() => setPage(p => p + 1)}
                  aria-label={t('pageNext')}
                  variant="outline"
                  size="icon-sm"
                >
                  <ArrowEnd />
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Adjust Delta Modal */}
      {adjustModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={e => {
            if (e.target === e.currentTarget) setAdjustModal(null);
          }}
        >
          <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-xl">
            <h2 className="mb-1 text-base font-semibold">{t('adjustTitle')}</h2>
            <p className="mb-4 text-sm text-muted-foreground">
              {adjustModal.row.productName}
              {adjustModal.row.variantTitle && (
                <>
                  {' · '}
                  <VariantText title={adjustModal.row.variantTitle} />
                </>
              )}
            </p>

            <div className="space-y-4">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t('deltaLabel')} {t('deltaHint')}
                </span>
                <input
                  type="number"
                  value={adjustModal.delta}
                  onChange={e =>
                    setAdjustModal(m => m && { ...m, delta: parseInt(e.target.value) || 0 })
                  }
                  className={FIELD_CLASSES}
                  placeholder={t('deltaExample')}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('newQtyPreview', {
                    new: Math.max(0, adjustModal.row.quantity + (adjustModal.delta || 0)),
                  })}
                </p>
              </label>

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t('reasonLabel')}
                </span>
                <input
                  type="text"
                  value={adjustModal.reason}
                  onChange={e => setAdjustModal(m => m && { ...m, reason: e.target.value })}
                  className={FIELD_CLASSES}
                  placeholder={t('reasonPlaceholder')}
                />
              </label>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <Button variant="ghost" onClick={() => setAdjustModal(null)} disabled={adjustSaving}>
                {tc('cancel')}
              </Button>
              <Button onClick={handleAdjust} disabled={adjustSaving}>
                {adjustSaving ? tc('saving') : t('applyAdjust')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
