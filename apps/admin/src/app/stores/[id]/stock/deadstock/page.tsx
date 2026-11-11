'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';
import { ArrowStart, ArrowEnd } from '@/components/ArrowStart';
import { useAuth } from '@/lib/auth';
import { apiGet, apiPost } from '@/lib/api';
import { formatPrice } from '@/lib/format';
import { withNumerals } from '@ebda/shared';

import { Button } from '@/components/ui/Button';
// ─── Types ────────────────────────────────────────────────────────────────────

interface DeadstockProduct {
  id: string;
  name: string;
  sku: string | null;
}

interface DeadStockFlag {
  id: string;
  productId: string;
  daysSinceSale: number;
  stockOnHand: number;
  /** null = the product has no cost price, so its value is unknown. */
  stockValueFils: number | null;
  suggestedDiscountBps: number;
  clearanceCopyEn: string;
  clearanceCopyAr: string | null;
  status: 'open' | 'accepted_clearance' | 'dismissed' | 'expired';
  couponCode: string | null;
  product: DeadstockProduct;
  scannedAt: string;
}

interface ListMeta {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

/** The scan records "no paid sale ever" as 9999 days. */
const NEVER_SOLD_DAYS = 9999;

// ─── Flag card ────────────────────────────────────────────────────────────────

function FlagCard({
  item,
  onClearance,
  onDismiss,
  t,
  tc,
}: {
  item: DeadStockFlag;
  onClearance: (id: string) => void;
  onDismiss: (id: string) => void;
  t: (k: string, p?: Record<string, string | number>) => string;
  tc: (k: string) => string;
}) {
  const [running, setRunning] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const discountPct = Math.round(item.suggestedDiscountBps / 100);

  async function handleClearance() {
    if (running || dismissing) return;
    setRunning(true);
    await onClearance(item.id);
    setRunning(false);
  }

  async function handleDismiss() {
    if (running || dismissing) return;
    setDismissing(true);
    await onDismiss(item.id);
    setDismissing(false);
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      {/* Header */}
      <div className="space-y-0.5">
        <p className="font-medium text-sm">{item.product.name}</p>
        {item.product.sku && (
          <p className="text-xs text-muted-foreground font-mono">{item.product.sku}</p>
        )}
      </div>

      {/* AI clearance copy */}
      <p className="text-sm text-muted-foreground leading-relaxed">{item.clearanceCopyEn}</p>
      {item.clearanceCopyAr && (
        <p className="text-sm text-muted-foreground leading-relaxed" dir="rtl">
          {item.clearanceCopyAr}
        </p>
      )}

      {/* Details grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
        <div>
          <span className="text-muted-foreground">
            {item.daysSinceSale >= NEVER_SOLD_DAYS
              ? t('card.neverSold')
              : t('card.daysSinceSale', { days: item.daysSinceSale })}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground">{t('card.stockValue')}: </span>
          {item.stockValueFils === null ? (
            <span className="font-medium text-muted-foreground">{t('card.valueUnknown')}</span>
          ) : (
            <span className="font-medium font-mono">{formatPrice(item.stockValueFils)}</span>
          )}
        </div>
        <div>
          <span className="text-muted-foreground">{t('card.suggestedDiscount')}: </span>
          <span className="font-medium text-warning-ink">{discountPct}%</span>
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        <Button
          type="button"
          onClick={handleClearance}
          disabled={running || dismissing}
          variant="default"
          size="sm"
          className="flex-1"
        >
          {running ? tc('saving') : t('card.runClearance')}
        </Button>
        <Button
          type="button"
          onClick={handleDismiss}
          disabled={running || dismissing}
          variant="outline"
          size="sm"
          className="text-muted-foreground"
        >
          {dismissing ? tc('saving') : t('card.dismiss')}
        </Button>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DeadstockPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('stock.deadstock');
  const tc = useT('common');
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';

  const [items, setItems] = useState<DeadStockFlag[]>([]);
  const [meta, setMeta] = useState<ListMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);
  const [lastScanned, setLastScanned] = useState<string | null>(null);
  const [valueUnknownCount, setValueUnknownCount] = useState(0);

  const load = useCallback(
    async (page = 1) => {
      if (!storeId) return;
      setLoading(true);
      const { data, error: apiError } = await apiGet<{
        data: DeadStockFlag[];
        meta: ListMeta;
        valueUnknownCount?: number;
      }>(`/api/v1/stores/${storeId}/stock/deadstock-flags?status=open&page=${page}&perPage=20`);
      setLoading(false);
      if (apiError) {
        setError(apiError.message);
        return;
      }
      if (data) {
        setItems(data.data);
        setMeta(data.meta);
        setValueUnknownCount(data.valueUnknownCount ?? 0);
        if (data.data.length > 0) {
          setLastScanned(data.data[0].scannedAt);
        }
      }
    },
    [storeId]
  );

  useEffect(() => {
    load();
  }, [load]);

  async function handleClearance(id: string) {
    const { error: apiError } = await apiPost(
      `/api/v1/stores/${storeId}/stock/deadstock-flags/${id}/clearance`,
      {}
    );
    if (!apiError) {
      setItems(prev => prev.filter(f => f.id !== id));
    }
  }

  async function handleDismiss(id: string) {
    const { error: apiError } = await apiPost(
      `/api/v1/stores/${storeId}/stock/deadstock-flags/${id}/dismiss`,
      {}
    );
    if (!apiError) {
      setItems(prev => prev.filter(f => f.id !== id));
    }
  }

  async function handleRescan() {
    if (rescanning) return;
    setRescanning(true);
    await apiPost(`/api/v1/stores/${storeId}/stock/deadstock-scan/run-now`, {});
    setRescanning(false);
  }

  return (
    <AdminLayout title={t('title')}>
      <div className="max-w-3xl space-y-6">
        {/* Header bar */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">{t('description')}</p>
            {lastScanned && (
              <p className="text-xs text-muted-foreground">
                {t('lastScanned', {
                  time: new Date(lastScanned).toLocaleString(undefined, withNumerals()),
                })}
              </p>
            )}
          </div>
          {isSuperAdmin && (
            <Button
              type="button"
              onClick={handleRescan}
              disabled={rescanning}
              variant="outline"
              size="sm"
            >
              {rescanning ? tc('loading') : t('rescanNow')}
            </Button>
          )}
        </div>

        {/* Error */}
        {error && <p className="text-sm text-destructive-ink">{error}</p>}

        {/* Loading */}
        {loading && <p className="text-sm text-muted-foreground">{tc('loading')}</p>}

        {/* Empty state */}
        {!loading && !error && items.length === 0 && (
          <div className="rounded-xl border border-border bg-muted/10 p-6 text-center">
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          </div>
        )}

        {/* Flags whose product has no cost price — value unknown */}
        {!loading && !error && valueUnknownCount > 0 && (
          <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-ink">
            {t('valueUnknownBanner', { count: valueUnknownCount })}
          </div>
        )}

        {/* Cards */}
        {items.length > 0 && (
          <div className="space-y-4">
            {items.map(item => (
              <FlagCard
                key={item.id}
                item={item}
                onClearance={handleClearance}
                onDismiss={handleDismiss}
                t={t}
                tc={tc}
              />
            ))}
          </div>
        )}

        {/* Pagination */}
        {meta && meta.totalPages > 1 && (
          <div className="flex items-center gap-2 text-sm">
            <Button
              type="button"
              disabled={meta.page === 1}
              onClick={() => load(meta.page - 1)}
              aria-label={t('pagePrev')}
              variant="outline"
              size="icon-sm"
            >
              <ArrowStart />
            </Button>
            <span className="text-muted-foreground">
              {meta.page} / {meta.totalPages}
            </span>
            <Button
              type="button"
              disabled={meta.page >= meta.totalPages}
              onClick={() => load(meta.page + 1)}
              aria-label={t('pageNext')}
              variant="outline"
              size="icon-sm"
            >
              <ArrowEnd />
            </Button>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
