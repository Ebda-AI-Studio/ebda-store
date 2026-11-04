'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useLocale } from 'next-intl';
import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';
import { ArrowStart, ArrowEnd } from '@/components/ArrowStart';
import { useAuth } from '@/lib/auth';
import { apiGet, apiPost } from '@/lib/api';
import { VariantText, useToast } from '@ebda/ui';
import { withNumerals } from '@ebda/shared';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReorderProduct {
  id: string;
  name: string;
  nameAr?: string | null;
  sku: string | null;
}

/** The variant a per-variant suggestion is for (null = product with no variants). */
interface ReorderVariant {
  id: string;
  title: string;
  titleAr: string | null;
  sku: string | null;
}

interface ReorderSupplier {
  id: string;
  name: string;
}

interface ReorderSuggestion {
  id: string;
  productId: string;
  variantId: string | null;
  suggestedQty: number;
  velocity7d: number;
  urgencyDays: number;
  supplierId: string | null;
  reasoningEn: string;
  reasoningAr: string | null;
  status: 'open' | 'accepted' | 'dismissed' | 'expired';
  product: ReorderProduct;
  variant: ReorderVariant | null;
  supplier: ReorderSupplier | null;
  scannedAt: string;
}

interface ListMeta {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

// ─── Urgency badge ────────────────────────────────────────────────────────────

function UrgencyBadge({
  days,
  t,
}: {
  days: number;
  t: (k: string, p?: Record<string, string | number>) => string;
}) {
  if (days < 3) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
        {t('card.urgencyDays', { days })}
      </span>
    );
  }
  if (days < 7) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-warning/10 text-warning-ink">
        {t('card.urgencyDays', { days })}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground">
      {t('card.urgencyDays', { days })}
    </span>
  );
}

// ─── Suggestion card ──────────────────────────────────────────────────────────

function SuggestionCard({
  item,
  onAccept,
  onDismiss,
  t,
  tc,
}: {
  item: ReorderSuggestion;
  onAccept: (id: string) => void;
  onDismiss: (id: string) => void;
  t: (k: string, p?: Record<string, string | number>) => string;
  tc: (k: string) => string;
}) {
  const [accepting, setAccepting] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const isAr = useLocale() === 'ar';
  const productName = (isAr && item.product.nameAr) || item.product.name;
  const variantName = item.variant ? (isAr && item.variant.titleAr) || item.variant.title : null;
  const sku = item.variant?.sku ?? item.product.sku;

  async function handleAccept() {
    if (accepting || dismissing) return;
    setAccepting(true);
    await onAccept(item.id);
    setAccepting(false);
  }

  async function handleDismiss() {
    if (accepting || dismissing) return;
    setDismissing(true);
    await onDismiss(item.id);
    setDismissing(false);
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-0.5 min-w-0">
          <p className="font-medium text-sm truncate">{productName}</p>
          {variantName && (
            <p className="text-xs text-foreground truncate">
              <span className="text-muted-foreground">{t('card.variantLabel')}: </span>
              <VariantText title={variantName} />
            </p>
          )}
          {sku && <p className="text-xs text-muted-foreground font-mono">{sku}</p>}
        </div>
        <UrgencyBadge days={item.urgencyDays} t={t} />
      </div>

      {/* Bilingual reasoning */}
      <p className="text-sm text-muted-foreground leading-relaxed">{item.reasoningEn}</p>
      {item.reasoningAr && (
        <p className="text-sm text-muted-foreground leading-relaxed" dir="rtl">
          {item.reasoningAr}
        </p>
      )}

      {/* Details row */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <span className="text-muted-foreground">{t('card.qtyLabel')}: </span>
          <span className="font-medium">{item.suggestedQty}</span>
        </div>
        {item.supplier && (
          <div>
            <span className="text-muted-foreground">{t('card.supplierLabel')}: </span>
            <span className="font-medium">{item.supplier.name}</span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={handleAccept}
          disabled={accepting || dismissing}
          className="flex-1 px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm font-medium disabled:opacity-60 hover:bg-primary/90 transition-colors"
        >
          {accepting ? tc('saving') : t('card.draftPo')}
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          disabled={accepting || dismissing}
          className="px-3 py-1.5 rounded border border-border text-sm text-muted-foreground disabled:opacity-60 hover:bg-muted/40 transition-colors"
        >
          {dismissing ? tc('saving') : t('card.dismiss')}
        </button>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ReorderPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('stock.reorder');
  const tc = useT('common');
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';
  const { success: toastSuccess, error: toastError } = useToast();

  const [items, setItems] = useState<ReorderSuggestion[]>([]);
  const [meta, setMeta] = useState<ListMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);
  const [lastScanned, setLastScanned] = useState<string | null>(null);

  const load = useCallback(
    async (page = 1) => {
      if (!storeId) return;
      setLoading(true);
      const { data, error: apiError } = await apiGet<{
        data: ReorderSuggestion[];
        meta: ListMeta;
      }>(`/api/v1/stores/${storeId}/stock/reorder-suggestions?status=open&page=${page}&perPage=20`);
      setLoading(false);
      if (apiError) {
        setError(apiError.message);
        return;
      }
      if (data) {
        setItems(data.data);
        setMeta(data.meta);
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

  async function handleAccept(id: string) {
    const { error: apiError } = await apiPost(
      `/api/v1/stores/${storeId}/stock/reorder-suggestions/${id}/accept`,
      {}
    );
    if (apiError) {
      toastError(t('draftPo.failed'), apiError.message || '');
    } else {
      setItems(prev => prev.filter(s => s.id !== id));
      toastSuccess(t('draftPo.created'));
    }
  }

  async function handleDismiss(id: string) {
    const { error: apiError } = await apiPost(
      `/api/v1/stores/${storeId}/stock/reorder-suggestions/${id}/dismiss`,
      {}
    );
    if (!apiError) {
      setItems(prev => prev.filter(s => s.id !== id));
    }
  }

  async function handleRescan() {
    if (rescanning) return;
    setRescanning(true);
    await apiPost(`/api/v1/stores/${storeId}/stock/reorder-scan/run-now`, {});
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
            <button
              type="button"
              onClick={handleRescan}
              disabled={rescanning}
              className="px-3 py-1.5 rounded border border-border text-sm text-foreground disabled:opacity-60 hover:bg-muted/40 transition-colors"
            >
              {rescanning ? tc('loading') : t('rescanNow')}
            </button>
          )}
        </div>

        {/* Error */}
        {error && <p className="text-sm text-red-600">{error}</p>}

        {/* Loading */}
        {loading && <p className="text-sm text-muted-foreground">{tc('loading')}</p>}

        {/* Empty state */}
        {!loading && !error && items.length === 0 && (
          <div className="rounded-xl border border-border bg-muted/10 p-6 text-center">
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          </div>
        )}

        {/* Cards */}
        {items.length > 0 && (
          <div className="space-y-4">
            {items.map(item => (
              <SuggestionCard
                key={item.id}
                item={item}
                onAccept={handleAccept}
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
            <button
              type="button"
              disabled={meta.page === 1}
              onClick={() => load(meta.page - 1)}
              className="px-3 py-1 rounded border border-border disabled:opacity-40"
              aria-label={t('pagePrev')}
            >
              <ArrowStart />
            </button>
            <span className="text-muted-foreground">
              {meta.page} / {meta.totalPages}
            </span>
            <button
              type="button"
              disabled={meta.page >= meta.totalPages}
              onClick={() => load(meta.page + 1)}
              className="px-3 py-1 rounded border border-border disabled:opacity-40"
              aria-label={t('pageNext')}
            >
              <ArrowEnd />
            </button>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
