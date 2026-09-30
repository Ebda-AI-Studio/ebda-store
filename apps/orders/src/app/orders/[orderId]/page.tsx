'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { apiGet, apiPost, apiPut } from '@/lib/api';
import { statusUpdateSchema, type OrderDetail } from '@/lib/orders';
import { useStore } from '@/contexts/StoreContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/contexts/ToastContext';
import { can } from '@/lib/permissions';
import { StatusBadge } from '@/components/StatusBadge';
import { formatDateTime } from '@/lib/format';
import { DeliveryCard } from './_components/DeliveryCard';
import { PaymentCard } from './_components/PaymentCard';
import { CustomerCard } from './_components/CustomerCard';
import { ItemsCard } from './_components/ItemsCard';
import { SummaryCard } from './_components/SummaryCard';
import { NotesCard } from './_components/NotesCard';
import { OrderTimeline } from './_components/OrderTimeline';
import { ActionFooter } from './_components/ActionFooter';

export default function OrderDetailPage() {
  const params = useParams();
  const search = useSearchParams();
  const orderId = params?.orderId as string;
  // Store id comes from the ?store= query param set by the list links; fall
  // back to the currently selected store.
  const { selectedStoreId } = useStore();
  const storeId = search?.get('store') || selectedStoreId || '';
  const { t, locale } = useLanguage();
  const { user } = useAuth();
  const { notify } = useToast();

  const canManage = can(user, 'orders:manage');

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [confirmRefundOpen, setConfirmRefundOpen] = useState(false);

  const fetchOrder = useCallback(async () => {
    if (!storeId || !orderId) return;
    setIsLoading(true);
    setError(null);
    try {
      const { data, error: apiError } = await apiGet<{ order: OrderDetail }>(
        `/api/v1/stores/${storeId}/orders/${orderId}`
      );
      if (apiError) {
        setError(apiError.message || t.detail.notFound);
      } else if (data?.order) {
        setOrder(data.order);
      } else {
        setError(t.detail.notFound);
      }
    } catch {
      setError(t.detail.notFound);
    } finally {
      setIsLoading(false);
    }
  }, [storeId, orderId, t.detail.notFound]);

  useEffect(() => {
    fetchOrder();
  }, [fetchOrder]);

  // Choosing "Refunded" only RECORDS a refund: no money moves (that is
  // "Refund via provider"). Confirm first — the footer offers it as the
  // primary action on a paid, cancelled order (#1936).
  const requestStatusChange = (newStatus: string) => {
    if (newStatus === 'refunded') setConfirmRefundOpen(true);
    else void handleStatusChange(newStatus);
  };

  const handleStatusChange = async (newStatus: string) => {
    if (!order) return;
    // Defence in depth — the API Zod-validates server-side regardless.
    const parsed = statusUpdateSchema.safeParse({ status: newStatus });
    if (!parsed.success) return;

    setIsUpdating(true);
    try {
      const { error: apiError } = await apiPut(
        `/api/v1/stores/${storeId}/orders/${order.id}/status`,
        parsed.data
      );
      if (apiError) {
        notify(apiError.message || t.detail.notFound, 'error');
      } else {
        notify(t.detail.statusUpdated, 'success');
        await fetchOrder();
      }
    } catch {
      notify(t.orders.error, 'error');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleMarkPaid = async () => {
    if (!order) return;
    setIsUpdating(true);
    try {
      const { error: apiError } = await apiPost(
        `/api/v1/stores/${storeId}/orders/${order.id}/mark-paid`,
        {}
      );
      if (apiError) {
        notify(apiError.message || t.orders.error, 'error');
      } else {
        notify(t.detail.paidMarked, 'success');
        // mark-paid also advances status (pending → confirmed); refetch so
        // local state matches the server's transitioned status.
        await fetchOrder();
      }
    } catch {
      notify(t.orders.error, 'error');
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <div className="min-h-dvh pb-[calc(env(safe-area-inset-bottom,0px)+1.5rem)]">
      <header
        className="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur"
        style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
      >
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 pb-2 pt-2">
          <Link
            href="/orders"
            aria-label={t.detail.back}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-muted text-foreground active:bg-muted/60"
          >
            <span className={locale === 'ar' ? 'inline-block rotate-180' : 'inline-block'}>‹</span>
          </Link>
          <h1 className="truncate text-base font-bold text-foreground">
            {order?.orderNumber ?? '…'}
          </h1>
        </div>
      </header>

      <main className="mx-auto max-w-2xl space-y-4 px-4 pt-4">
        {isLoading && (
          <div className="space-y-3">
            {[0, 1, 2].map(i => (
              <div
                key={i}
                className="h-32 animate-pulse rounded-2xl border border-border bg-card"
              />
            ))}
          </div>
        )}

        {error && !isLoading && (
          <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-6 text-center text-sm text-destructive-ink">
            <p>{error}</p>
            <button
              type="button"
              onClick={fetchOrder}
              className="mt-4 inline-flex h-11 min-w-[44px] items-center rounded-full border border-destructive/30 px-5 text-sm font-semibold text-destructive-ink active:bg-destructive/10"
            >
              {t.orders.retry}
            </button>
          </div>
        )}

        {order && !isLoading && (
          <>
            <div className="flex items-center justify-between">
              <StatusBadge status={order.status} />
              <span className="text-xs text-muted-foreground">
                {formatDateTime(order.createdAt, locale)}
              </span>
            </div>

            {/* Same sections the admin shows — single-column for the mobile PWA. */}
            <DeliveryCard order={order} />
            <PaymentCard order={order} />
            <CustomerCard order={order} />
            <ItemsCard order={order} previewLimit={5} />
            <SummaryCard order={order} />
            <NotesCard order={order} />
            <OrderTimeline storeId={storeId} orderId={orderId} />

            {canManage ? (
              <ActionFooter
                order={order}
                storeId={storeId}
                isUpdating={isUpdating}
                onStatusChange={requestStatusChange}
                onMarkPaid={handleMarkPaid}
                onRefetch={fetchOrder}
              />
            ) : (
              <p className="py-2 text-center text-xs text-muted-foreground">{t.detail.readOnly}</p>
            )}
          </>
        )}
      </main>

      {confirmRefundOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="manual-refund-title"
        >
          <div className="w-full max-w-sm rounded-t-3xl border border-border bg-card p-5 shadow-xl sm:rounded-3xl">
            <p id="manual-refund-title" className="text-sm font-semibold text-foreground">
              {t.detail.actions.manualRefundTitle}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {t.detail.actions.manualRefundDesc}
            </p>
            <div className="mt-4 flex gap-3">
              <button
                type="button"
                disabled={isUpdating}
                onClick={async () => {
                  await handleStatusChange('refunded');
                  setConfirmRefundOpen(false);
                }}
                className="flex-1 inline-flex h-11 items-center justify-center rounded-xl bg-destructive text-sm font-semibold text-destructive-foreground disabled:opacity-50 active:opacity-80"
              >
                {isUpdating ? '…' : t.detail.actions.manualRefundConfirm}
              </button>
              <button
                type="button"
                disabled={isUpdating}
                onClick={() => setConfirmRefundOpen(false)}
                className="flex-1 inline-flex h-11 items-center justify-center rounded-xl border border-border bg-card text-sm font-semibold text-foreground disabled:opacity-50 active:bg-muted/60"
              >
                {t.detail.actions.cancel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
