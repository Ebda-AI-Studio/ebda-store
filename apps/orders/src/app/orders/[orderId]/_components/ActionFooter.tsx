'use client';

import { orderActionVisibility, refundViaProviderRemaining } from '@ebda/shared';
import { useLanguage } from '@/contexts/LanguageContext';
import { statusOptionsForRole, type OrderDetail } from '@/lib/orders';
import { PaymentLinkButton } from './PaymentLinkButton';
import { RefreshPaymentButton } from './RefreshPaymentButton';
import { RefundButton } from './RefundButton';
import { RefreshRefundStatusButton } from './RefreshRefundStatusButton';
import { InvoiceButton } from './InvoiceButton';
import { ConfirmInstapayButton } from '@/components/ConfirmInstapayButton';

interface ActionFooterProps {
  order: OrderDetail;
  storeId: string;
  isUpdating: boolean;
  /** False for staff (no orders:refund): no Refund button and no "Refunded" status. */
  canRefund: boolean;
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
  canRefund,
  onStatusChange,
  onMarkPaid,
  onRefetch,
}: ActionFooterProps) {
  const { t } = useLanguage();
  const ta = t.detail.actions;

  // Same options the admin offers (#1936): a PAID cancelled order's only
  // option is `refunded`, so `cancelled` is not final here. The page confirms
  // a `refunded` pick before sending it.
  const transitions = statusOptionsForRole(order, canRefund);
  const nextStatus = transitions.find(s => s !== 'cancelled') ?? null;
  const canCancel = transitions.includes('cancelled');
  // Final = the shared transition map offers nothing more (#2144). A hand-kept
  // list here treated `delivered` as final, hiding the `refunded` the map
  // offers for a delivered order — the same contradiction #1947 fixed for
  // `cancelled`.
  const isFinal = transitions.length === 0;

  // Shared with the admin ActionFooter — one gating rule for both surfaces.
  const {
    showMarkPaid,
    showManualMarkPaid,
    showConfirmInstapay,
    showRefundViaProvider,
    showRefreshRefundStatus,
  } = orderActionVisibility(order);

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
        {/* InstaPay: the one primary action while the transfer is unconfirmed. */}
        {showConfirmInstapay && (
          <ConfirmInstapayButton
            storeId={storeId}
            orderId={order.id}
            amountMinor={Math.max(0, order.total - (order.walletAmount ?? 0))}
            currency={order.currency ?? 'EGP'}
            onConfirmed={onRefetch}
          />
        )}
        {nextStatus && !isFinal && (
          <button
            type="button"
            onClick={() => onStatusChange(nextStatus)}
            disabled={isUpdating}
            className="inline-flex h-11 min-w-0 flex-1 basis-[8rem] items-center justify-center gap-2 rounded-xl bg-success px-3 text-center text-xs font-semibold leading-tight text-success-foreground active:bg-success/90 disabled:opacity-60"
          >
            {isUpdating ? (
              '…'
            ) : (
              <>
                <span className="min-w-0">
                  {t.action[nextStatus] ?? t.status[nextStatus] ?? ta.processed}
                </span>
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

        {showRefundViaProvider && canRefund && (
          <RefundButton
            storeId={storeId}
            orderId={order.id}
            orderNumber={order.orderNumber ?? ''}
            // What the PROVIDER refunds (#2069): the refundable remainder of the
            // payment row the route picks — after a partial refund that is less
            // than the order value. Older payloads without the figures fall back
            // to the order value less any customer-wallet spend (D1).
            total={refundViaProviderRemaining(order) ?? order.total - (order.walletAmount ?? 0)}
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
            className="inline-flex h-11 min-w-0 flex-1 basis-[8rem] items-center justify-center gap-2 rounded-xl border-2 border-primary bg-primary/5 px-3 text-center text-xs font-semibold leading-tight text-primary-ink active:bg-primary/10 disabled:opacity-60"
          >
            <svg
              className="h-4 w-4 shrink-0"
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
            <span className="min-w-0">{ta.markPaid}</span>
          </button>
        )}

        {canCancel && !isFinal && (
          <button
            type="button"
            onClick={() => onStatusChange('cancelled')}
            disabled={isUpdating}
            className="inline-flex h-11 min-w-0 flex-1 basis-[8rem] items-center justify-center rounded-xl border-2 border-destructive bg-card px-3 text-center text-xs font-semibold leading-tight text-destructive-ink active:bg-destructive/5 disabled:opacity-60"
          >
            <span className="min-w-0">{ta.cancel}</span>
          </button>
        )}

        <InvoiceButton storeId={storeId} orderId={order.id} disabled={isUpdating} />
      </div>
    </div>
  );
}
