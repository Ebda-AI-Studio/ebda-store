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
import { StatusActions } from '@/components/StatusActions';
import { formatMoney, formatDateTime, formatAddressLines, customerName } from '@/lib/format';

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

  const handleStatusChange = async (newStatus: string) => {
    if (!order) return;
    // Validate the payload client-side too — defence in depth (the API
    // Zod-validates it server-side regardless).
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
        await fetchOrder();
      }
    } catch {
      notify(t.orders.error, 'error');
    } finally {
      setIsUpdating(false);
    }
  };

  const addressLines = order ? formatAddressLines(order.shippingAddress) : [];

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
            <span className={locale === 'ar' ? 'rotate-180 inline-block' : 'inline-block'}>‹</span>
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
          <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-6 text-center text-sm text-destructive">
            <p>{error}</p>
            <button
              type="button"
              onClick={fetchOrder}
              className="mt-4 inline-flex h-11 min-w-[44px] items-center rounded-full border border-destructive/30 px-5 text-sm font-semibold text-destructive active:bg-destructive/10"
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

            {/* Items */}
            <section className="rounded-2xl border border-border bg-card p-4">
              <h2 className="mb-3 text-sm font-bold text-foreground">{t.detail.items}</h2>
              <ul className="space-y-3">
                {order.items.map(item => (
                  <li key={item.id} className="flex items-start justify-between gap-3 text-sm">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-foreground">{item.productName}</p>
                      {item.variantName && (
                        <p className="truncate text-xs text-muted-foreground">{item.variantName}</p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {t.detail.qty}: {item.quantity}
                      </p>
                    </div>
                    <span className="shrink-0 font-semibold text-foreground">
                      {formatMoney(item.total ?? (item.price ?? 0) * item.quantity, order.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            {/* Summary */}
            <section className="rounded-2xl border border-border bg-card p-4">
              <h2 className="mb-3 text-sm font-bold text-foreground">{t.detail.summary}</h2>
              <dl className="space-y-2 text-sm">
                <Row
                  label={t.detail.subtotal}
                  value={formatMoney(order.subtotal, order.currency)}
                />
                {order.discount > 0 && (
                  <Row
                    label={t.detail.discount}
                    value={`- ${formatMoney(order.discount, order.currency)}`}
                  />
                )}
                {order.shipping > 0 && (
                  <Row
                    label={t.detail.shipping}
                    value={formatMoney(order.shipping, order.currency)}
                  />
                )}
                {order.tax > 0 && (
                  <Row label={t.detail.tax} value={formatMoney(order.tax, order.currency)} />
                )}
                <div className="flex items-center justify-between border-t border-border pt-2">
                  <dt className="font-bold text-foreground">{t.detail.total}</dt>
                  <dd className="text-base font-bold text-foreground">
                    {formatMoney(order.total, order.currency)}
                  </dd>
                </div>
                <Row
                  label={t.detail.paymentStatus}
                  value={order.paymentStatus === 'paid' ? t.filters.paid : order.paymentStatus}
                />
              </dl>
            </section>

            {/* Customer + address */}
            <section className="rounded-2xl border border-border bg-card p-4 text-sm">
              <h2 className="mb-3 text-sm font-bold text-foreground">{t.detail.customer}</h2>
              <p className="font-medium text-foreground">{customerName(order.customer)}</p>
              {order.customer?.phone && (
                <a
                  href={`tel:${order.customer.phone}`}
                  className="mt-0.5 block text-primary underline"
                  dir="ltr"
                >
                  {order.customer.phone}
                </a>
              )}
              {order.customer?.email && (
                <p className="mt-0.5 break-all text-muted-foreground">{order.customer.email}</p>
              )}
              {addressLines.length > 0 && (
                <div className="mt-3 border-t border-border pt-3">
                  <p className="mb-1 text-xs font-semibold text-muted-foreground">
                    {t.detail.address}
                  </p>
                  {addressLines.map((line, i) => (
                    <p key={i} className="text-foreground">
                      {line}
                    </p>
                  ))}
                </div>
              )}
            </section>

            {/* Notes */}
            {(order.customerNotes || order.notes) && (
              <section className="rounded-2xl border border-border bg-card p-4 text-sm">
                {order.customerNotes && (
                  <div>
                    <p className="mb-1 text-xs font-semibold text-muted-foreground">
                      {t.detail.customerNotes}
                    </p>
                    <p className="text-foreground">{order.customerNotes}</p>
                  </div>
                )}
                {order.notes && (
                  <div className={order.customerNotes ? 'mt-3' : ''}>
                    <p className="mb-1 text-xs font-semibold text-muted-foreground">
                      {t.detail.notes}
                    </p>
                    <p className="text-foreground">{order.notes}</p>
                  </div>
                )}
              </section>
            )}

            {/* Sticky action bar */}
            <div
              className="sticky bottom-0 -mx-4 mt-4 border-t border-border bg-background/95 backdrop-blur"
              style={{
                paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1rem)',
                paddingTop: '1rem',
                paddingLeft: '1rem',
                paddingRight: '1rem',
              }}
            >
              <div className="mx-auto max-w-2xl space-y-3">
                {canManage && order.paymentStatus !== 'paid' && (
                  <button
                    type="button"
                    disabled={isUpdating}
                    onClick={handleMarkPaid}
                    className="h-11 w-full rounded-full border border-success/40 bg-success/5 text-sm font-semibold text-success active:bg-success/10 disabled:opacity-50"
                  >
                    {isUpdating ? t.detail.updating : t.detail.markPaid}
                  </button>
                )}
                <StatusActions
                  status={order.status}
                  canManage={canManage}
                  isUpdating={isUpdating}
                  onChange={handleStatusChange}
                />
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{value}</dd>
    </div>
  );
}
