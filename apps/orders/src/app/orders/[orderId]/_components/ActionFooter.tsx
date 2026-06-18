'use client';

import { useLanguage } from '@/contexts/LanguageContext';
import { VALID_TRANSITIONS, type OrderDetail } from '@/lib/orders';
import { PaymentLinkButton } from './PaymentLinkButton';
import { RefreshPaymentButton } from './RefreshPaymentButton';
import { RefundButton } from './RefundButton';
import { RefreshRefundStatusButton } from './RefreshRefundStatusButton';
import { InvoiceButton } from './InvoiceButton';

interface ActionFooterProps {
  order: OrderDetail;
  storeId: string;
  isUpdating: boolean;
  onStatusChange: (newStatus: string) => void;
  onMarkPaid: () => void;
  onRefetch: () => void;
}

/**
 * Sticky action footer — ports the admin ActionFooter gating logic to the PWA.
 * Status-advance + cancel, payment-link / refresh-payment (when unpaid),
 * refund-via-provider + refresh-refund-status (when a card payment exists),
 * manual mark-paid (COD / no-provider-row only), and invoice view/email.
 *
 * Mark-paid gating mirrors admin exactly: the MANUAL button only shows when
 * there is no provider-payment row (provider-paid status must come from the
 * webhook, not a manual flip — financial integrity).
 */
export function ActionFooter({
  order,
  storeId,
  isUpdating,
  onStatusChange,
  onMarkPaid,
  onRefetch,
}: ActionFooterProps) {
  const { t } = useLanguage();
  const ta = t.detail.actions;

  const transitions = VALID_TRANSITIONS[order.status] ?? [];
  const nextStatus = transitions.find(s => s !== 'cancelled') ?? null;
  const canCancel = transitions.includes('cancelled');
  const isFinal = ['delivered', 'cancelled', 'refunded'].includes(order.status);

  const showMarkPaid = order.paymentStatus !== 'paid';
  const hasProviderPayment = order.payments?.some(
    p => p.provider !== 'cod' && (p.paymentUrl || p.paymentLink || p.transactionId)
  );
  const showManualMarkPaid = showMarkPaid && !hasProviderPayment;

  const completedOnlinePayment = order.payments?.find(
    p => p.status === 'completed' && p.transactionId && p.provider !== 'cod'
  );
  const showRefundViaProvider =
    order.paymentStatus === 'paid' && !!completedOnlinePayment && order.status !== 'refunded';

  const refundedPayment = order.payments?.find(
    p =>
      (p.status === 'refunded' || p.status === 'partially_refunded') &&
      p.transactionId &&
      p.provider !== 'cod'
  );
  const showRefreshRefundStatus = !!refundedPayment;

  const existingPaymentUrl =
    [...(order.payments ?? [])]
      .filter(p => p.status !== 'paid' && (p.paymentUrl || p.paymentLink))
      .sort((a, b) => +new Date(b.createdAt ?? 0) - +new Date(a.createdAt ?? 0))[0]?.paymentUrl ??
    [...(order.payments ?? [])]
      .filter(p => p.status !== 'paid' && (p.paymentUrl || p.paymentLink))
      .sort((a, b) => +new Date(b.createdAt ?? 0) - +new Date(a.createdAt ?? 0))[0]?.paymentLink ??
    null;

  return (
    <div
      className="sticky bottom-0 -mx-4 mt-4 border-t border-border bg-background/95 backdrop-blur"
      style={{
        paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1rem)',
        paddingTop: '1rem',
        paddingLeft: '1rem',
        paddingRight: '1rem',
      }}
      role="toolbar"
      aria-label="Order actions"
    >
      <div className="mx-auto flex max-w-2xl flex-wrap items-center gap-2">
        {nextStatus && !isFinal && (
          <button
            type="button"
            onClick={() => onStatusChange(nextStatus)}
            disabled={isUpdating}
            className="inline-flex h-11 min-w-[8rem] flex-1 items-center justify-center gap-2 rounded-xl bg-success px-4 text-sm font-semibold text-success-foreground active:bg-success/90 disabled:opacity-60"
          >
            {isUpdating ? (
              '…'
            ) : (
              <>
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
                    strokeWidth={2.5}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                {t.status[nextStatus] ?? ta.processed}
              </>
            )}
          </button>
        )}

        {showMarkPaid && (
          <PaymentLinkButton
            storeId={storeId}
            orderId={order.id}
            orderNumber={order.orderNumber ?? ''}
            disabled={isUpdating}
            existingPaymentUrl={existingPaymentUrl}
          />
        )}

        {showMarkPaid && (
          <RefreshPaymentButton
            storeId={storeId}
            orderId={order.id}
            disabled={isUpdating}
            onRefreshed={onRefetch}
          />
        )}

        {showRefundViaProvider && (
          <RefundButton
            storeId={storeId}
            orderId={order.id}
            orderNumber={order.orderNumber ?? ''}
            total={order.total}
            currency={order.currency}
            disabled={isUpdating}
            onRefunded={onRefetch}
          />
        )}

        {showRefreshRefundStatus && (
          <RefreshRefundStatusButton
            storeId={storeId}
            orderId={order.id}
            disabled={isUpdating}
            onRefreshed={onRefetch}
          />
        )}

        {showManualMarkPaid && (
          <button
            type="button"
            onClick={onMarkPaid}
            disabled={isUpdating}
            className="inline-flex h-11 min-w-[8rem] flex-1 items-center justify-center gap-2 rounded-xl border-2 border-primary bg-primary/5 px-4 text-sm font-semibold text-primary active:bg-primary/10 disabled:opacity-60"
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
                d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            {ta.markPaid}
          </button>
        )}

        {canCancel && !isFinal && (
          <button
            type="button"
            onClick={() => onStatusChange('cancelled')}
            disabled={isUpdating}
            className="inline-flex h-11 min-w-[8rem] flex-1 items-center justify-center rounded-xl border-2 border-destructive bg-card px-4 text-sm font-semibold text-destructive active:bg-destructive/5 disabled:opacity-60"
          >
            {ta.cancel}
          </button>
        )}

        <InvoiceButton storeId={storeId} orderId={order.id} disabled={isUpdating} />
      </div>
    </div>
  );
}
