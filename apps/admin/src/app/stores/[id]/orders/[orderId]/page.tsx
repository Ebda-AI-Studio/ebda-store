'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useToast } from '@ebda/ui';
import { AdminLayout } from '../../../../../components/AdminLayout';
import { OrderStatusBadge } from '../../../../../components/OrderStatusBadge';
import { apiGet, apiPut, apiPost } from '../../../../../lib/api';
import { useAuth } from '../../../../../lib/auth';
import { useT } from '@/i18n/useT';
import { useLocale } from 'next-intl';
import { ConfirmActionModal } from '../../../../../components/ConfirmActionModal';
import { DeliveryCard } from './_components/DeliveryCard';
import { PaymentCard } from './_components/PaymentCard';
import { SummaryCard } from './_components/SummaryCard';
import { ItemsCard } from './_components/ItemsCard';
import { PlatformCard } from './_components/PlatformCard';
import { CustomerCard } from './_components/CustomerCard';
import { NotesCard } from './_components/NotesCard';
import { ShipmentCard } from './_components/ShipmentCard';
import { ActionFooter } from './_components/ActionFooter';
import { OrderInstapayPanel } from './_components/OrderInstapayPanel';
import { OrderLifecycleTimeline } from '../../../../../components/order-timeline/OrderLifecycleTimeline';
import type { OrderDetail } from './_components/types';
import { manualRefundBody, type ManualRefundInput } from '../_components/manualRefundCopy';
import { ManualRefundModal } from '../../../../../components/ManualRefundModal';
import { OrderDocumentsCard } from './_components/OrderDocumentsCard';
import { OrderCodRiskCard } from './_components/OrderCodRiskCard';
import { OrderEtaCard } from './_components/OrderEtaCard';
import { useFeatures } from '@/hooks/useFeatures';

export default function OrderDetailPage() {
  const params = useParams();
  const router = useRouter();
  const storeId = params?.id as string;
  const orderId = params?.orderId as string;
  const { isEnabled, isLoading: featuresLoading } = useFeatures();
  const t = useT('orders.detail');
  const tList = useT('orders.list');
  const locale = useLocale();
  const { success: toastSuccess, error: toastError } = useToast();
  const { user } = useAuth();

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [confirmMarkPaidOpen, setConfirmMarkPaidOpen] = useState(false);
  const [confirmRefundOpen, setConfirmRefundOpen] = useState(false);
  const [confirmInstapayOpen, setConfirmInstapayOpen] = useState(false);

  const fetchOrder = useCallback(async () => {
    if (!storeId || !orderId) return;
    setIsLoading(true);
    setError(null);
    try {
      const { data, error: apiError } = await apiGet<{ order: OrderDetail }>(
        `/api/v1/stores/${storeId}/orders/${orderId}`
      );
      if (apiError) {
        setError(apiError.message || t('errors.fetchFailed'));
      } else if (data?.order) {
        setOrder(data.order);
      }
    } catch {
      setError(t('errors.fetchFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [storeId, orderId, t]);

  useEffect(() => {
    fetchOrder();
  }, [fetchOrder]);

  // Choosing "Refunded" only RECORDS a refund: no money moves (that is
  // "Refund via provider"). Confirm first, the same as the order list (#762) —
  // the footer offers it as the primary action on a paid, cancelled order.
  const canRefund = !!user && user.role !== 'staff';
  const requestStatusChange = (newStatus: string) => {
    if (newStatus === 'refunded') {
      if (canRefund) setConfirmRefundOpen(true);
    } else void handleStatusChange(newStatus);
  };

  const handleStatusChange = async (newStatus: string) => {
    if (!order) return;
    setIsUpdating(true);
    try {
      const { error: apiError } = await apiPut(
        `/api/v1/stores/${storeId}/orders/${order.id}/status`,
        { status: newStatus }
      );
      if (apiError) {
        toastError(t('errors.statusUpdateFailed'), apiError.message ?? '');
      } else {
        setOrder(o => (o ? { ...o, status: newStatus } : o));
        toastSuccess(t('toast.statusUpdated'));
      }
    } catch {
      toastError(t('errors.statusUpdateFailed'));
    } finally {
      setIsUpdating(false);
    }
  };

  // Records a refund the merchant has already paid out. Resolves to null on success, or the API's
  // message (403 for staff, 409 REFUND_NOT_RECORDED) for the dialog to show.
  const handleManualRefund = async (input: ManualRefundInput) => {
    if (!order) return null;
    setIsUpdating(true);
    try {
      const { error: apiError } = await apiPut(
        `/api/v1/stores/${storeId}/orders/${order.id}/status`,
        manualRefundBody(input)
      );
      if (apiError) return apiError.message || t('errors.statusUpdateFailed');
      toastSuccess(t('toast.statusUpdated'));
      await fetchOrder();
      return null;
    } catch {
      return t('errors.statusUpdateFailed');
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
        toastError(tList('errors.markPaid'), apiError.message ?? '');
      } else {
        toastSuccess(tList('toast.markedPaidTitle'));
        // The mark-paid endpoint also advances `status` (pending →
        // confirmed) when the order was unpaid. If we just patched
        // paymentStatus locally and left `status` stale, the next
        // "Processed" tap re-sent status: pending and the API errored
        // with "Cannot transition from confirmed to confirmed". Refetch
        // so local state matches the server's transitioned status too.
        await fetchOrder();
      }
    } catch {
      toastError(tList('errors.markPaid'));
    } finally {
      setIsUpdating(false);
      setConfirmMarkPaidOpen(false);
    }
  };

  // InstaPay: the merchant saw the transfer. The endpoint is idempotent (a second
  // tap answers changed:false) and refuses an order whose window expired.
  const handleConfirmInstapay = async () => {
    if (!order) return;
    setIsUpdating(true);
    try {
      const { data, error: apiError } = await apiPost<{ changed: boolean }>(
        `/api/v1/stores/${storeId}/orders/${order.id}/confirm-instapay`,
        {}
      );
      if (apiError) {
        toastError(tList('errors.confirmInstapay'), apiError.message ?? '');
      } else {
        toastSuccess(
          data?.changed === false
            ? tList('toast.instapayAlready')
            : tList('toast.instapayConfirmed')
        );
      }
      await fetchOrder();
    } catch {
      toastError(tList('errors.confirmInstapay'));
    } finally {
      setIsUpdating(false);
      setConfirmInstapayOpen(false);
    }
  };

  const openInvoice = () => {
    router.push(`/stores/${storeId}/orders/${orderId}/invoice`);
  };

  return (
    <AdminLayout
      mode="store_admin"
      storeId={storeId}
      title={order?.orderNumber ?? t('loading')}
      subtitle={tList('title')}
    >
      <div className="mx-auto max-w-5xl px-4 pb-24 pt-4 sm:px-6 sm:pb-6">
        {/* Header strip */}
        <div className="flex items-center justify-between mb-5">
          <Link
            href={`/stores/${storeId}/orders`}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-muted text-foreground hover:bg-muted/70 transition-colors"
            aria-label={t('back')}
          >
            <svg
              className={`h-5 w-5 ${locale === 'ar' ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </Link>
          <h1 className="text-lg font-bold text-foreground">{order?.orderNumber ?? '…'}</h1>
          <button
            type="button"
            onClick={openInvoice}
            className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-2 text-sm font-medium text-foreground hover:bg-muted/70 transition-colors cursor-pointer"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 17v-2a4 4 0 014-4h6m0 0l-3-3m3 3l-3 3M3 12a9 9 0 1018 0 9 9 0 00-18 0z"
              />
            </svg>
            <span className="hidden sm:inline">{t('openInvoice')}</span>
          </button>
        </div>

        {isLoading && (
          <div className="rounded-2xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            {t('loading')}
          </div>
        )}

        {error && !isLoading && (
          <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-6 text-center">
            <p className="text-sm text-destructive-ink">{error}</p>
            <button
              type="button"
              onClick={fetchOrder}
              className="mt-3 inline-flex items-center justify-center rounded-lg border border-destructive px-4 py-2 text-sm font-medium text-destructive-ink hover:bg-destructive/10 cursor-pointer"
            >
              {tList('errors.retry')}
            </button>
          </div>
        )}

        {order && !isLoading && (
          <>
            {/* Status pill row */}
            <div className="mb-5 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <OrderStatusBadge status={order.status} />
                {order.source === 'agent' && (
                  // Reuses OrderStatusBadge's colorMap override (same
                  // pattern the returns/shipments/notifications surfaces
                  // use) rather than inventing a new chip style —
                  // every-data-needs-a-UI surface for Order.source.
                  <OrderStatusBadge
                    status="agent"
                    label={`🤖 ${t('agent')}`}
                    colorMap={{ agent: { className: 'bg-violet-50 text-violet-700' } }}
                  />
                )}
              </div>
              <span className="text-xs text-muted-foreground">
                {new Date(order.createdAt).toLocaleString(locale, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                  numberingSystem: 'latn', // Latin digits in both locales (issue 1971)
                })}
              </span>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-4">
                <DeliveryCard order={order} locale={locale} />
                <ShipmentCard
                  storeId={storeId}
                  orderId={orderId}
                  onChanged={fetchOrder}
                  courierHints={!featuresLoading && isEnabled('customer_intelligence')}
                />
                <PaymentCard order={order} userRole={user?.role} />
                <OrderInstapayPanel
                  order={order}
                  storeId={storeId}
                  userRole={user?.role}
                  isUpdating={isUpdating}
                  onApprove={() => setConfirmInstapayOpen(true)}
                  onChanged={fetchOrder}
                />
                <CustomerCard order={order} />
                <NotesCard order={order} />
              </div>
              <div className="space-y-4">
                <ItemsCard order={order} previewLimit={5} />
                <SummaryCard order={order} />
                <OrderDocumentsCard storeId={storeId} orderId={orderId} />
                {!featuresLoading && isEnabled('customer_intelligence') ? (
                  <OrderCodRiskCard storeId={storeId} orderId={orderId} />
                ) : null}
                {!featuresLoading && isEnabled('eta_ereceipt') ? (
                  <OrderEtaCard storeId={storeId} orderId={orderId} />
                ) : null}
                <PlatformCard order={order} />
              </div>
            </div>

            <OrderLifecycleTimeline storeId={storeId} orderId={orderId} />

            <ActionFooter
              order={order}
              storeId={storeId}
              isUpdating={isUpdating}
              canRefund={canRefund}
              onStatusChange={requestStatusChange}
              onMarkPaid={() => setConfirmMarkPaidOpen(true)}
              onConfirmInstapay={() => setConfirmInstapayOpen(true)}
              onPrintInvoice={openInvoice}
              onPaymentRefreshed={fetchOrder}
              userRole={user?.role}
            />
          </>
        )}

        <ConfirmActionModal
          open={confirmMarkPaidOpen}
          title={tList('confirm.markPaidTitle')}
          description={tList('confirm.markPaidDescription')}
          confirmLabel={tList('confirm.confirm')}
          cancelLabel={tList('confirm.cancel')}
          onConfirm={handleMarkPaid}
          onClose={() => setConfirmMarkPaidOpen(false)}
        />

        <ConfirmActionModal
          open={confirmInstapayOpen}
          title={tList('confirm.instapayTitle')}
          description={tList('confirm.instapayDescription')}
          confirmLabel={tList('confirm.confirm')}
          cancelLabel={tList('confirm.cancel')}
          isLoading={isUpdating}
          onConfirm={handleConfirmInstapay}
          onClose={() => setConfirmInstapayOpen(false)}
        />

        <ManualRefundModal
          open={confirmRefundOpen}
          orderStatus={order?.status}
          onConfirm={handleManualRefund}
          onClose={() => setConfirmRefundOpen(false)}
        />
      </div>
    </AdminLayout>
  );
}
