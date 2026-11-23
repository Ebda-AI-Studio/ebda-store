'use client';

import { useState, useRef, useEffect } from 'react';
import { orderActionVisibility, refundViaProviderRemaining } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { statusOptionsForRole } from '../../_components/types';
import { orderActionKey } from '../../_components/order-action';
import { PaymentLinkButton } from './PaymentLinkButton';
import { RefreshPaymentButton } from './RefreshPaymentButton';
import { RefundButton } from './RefundButton';
import { PartialRefundButton } from './PartialRefundButton';
import { InstapayRefundButton } from './InstapayRefundButton';
import { RefreshRefundStatusButton } from './RefreshRefundStatusButton';
import type { OrderDetail } from './types';

import { Button } from '@/components/ui/Button';
interface ActionFooterProps {
  order: OrderDetail;
  storeId: string;
  isUpdating: boolean;
  /**
   * False for staff: refunding (via the provider or by recording one) needs the API's
   * `orders:refund` permission, so neither the Refund button nor the "Refunded" status is shown.
   */
  canRefund: boolean;
  onStatusChange: (newStatus: string) => void;
  onMarkPaid: () => void;
  /** InstaPay: the merchant saw the transfer arrive. */
  onConfirmInstapay?: () => void;
  onPrintInvoice: () => void;
  onPaymentRefreshed?: () => void;
  /** Viewer role: staff lack orders:refund; Ebda's super-admin has no say on a store's InstaPay. */
  userRole?: 'super_admin' | 'store_admin' | 'customer' | 'staff';
}

export function ActionFooter({
  order,
  storeId,
  isUpdating,
  canRefund,
  onStatusChange,
  onMarkPaid,
  onConfirmInstapay,
  onPrintInvoice,
  onPaymentRefreshed,
  userRole,
}: ActionFooterProps) {
  const t = useT('orders.detail.actions');
  const tStatus = useT('orders.status');
  const tAction = useT('orders.action');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  // statusOptionsFor, not the raw map: it drops `refunded` from an unpaid
  // pending/cancelled order, the same options the order list offers. A PAID
  // cancelled order's only option is `refunded` (PR #770), so `cancelled` is
  // not final here; before #1947 it was, and this page offered no way to
  // record that refund. The page confirms a `refunded` pick before sending it.
  const transitions = statusOptionsForRole(order, canRefund);
  const nextStatus = transitions.find(s => s !== 'cancelled') ?? null;
  const canCancel = transitions.includes('cancelled');
  // Final = the shared transition map offers nothing more (#2144). A hand-kept
  // list here treated `delivered` as final, hiding the `refunded` the map
  // offers for a delivered order — the same contradiction #1947 fixed for
  // `cancelled`.
  const isFinal = transitions.length === 0;
  // Money-action gating lives in @ebda/shared's orderActionVisibility,
  // shared with the orders PWA so the two surfaces cannot drift (#1908):
  //   - showMarkPaid: promoted out of the overflow on mobile — the PWA flow
  //     drops the merchant here from a "mark paid" deep link.
  //   - showManualMarkPaid: only with NO provider-payment row. A provider
  //     order's paid status MUST come from the webhook; a manual flip could
  //     mark paid an order the customer never paid. PaymentLinkButton +
  //     RefreshPaymentButton still follow showMarkPaid.
  //   - showRefundViaProvider: paid, a completed or partially refunded online
  //     payment with a transactionId (never COD), not already refunded.
  //   - showRefreshRefundStatus: a provider-issued refund exists — the safety
  //     net for a missed refund webhook.
  const {
    showMarkPaid,
    showManualMarkPaid,
    showConfirmInstapay,
    showRefundViaProvider,
    showRefreshRefundStatus,
  } = orderActionVisibility(order);
  // InstaPay refund RECORD: the store owner only, for a paid InstaPay payment.
  const instapayPayment = (order.payments ?? []).find(
    p =>
      p.provider === 'instapay' && (p.status === 'completed' || p.status === 'partially_refunded')
  );
  const showInstapayRefund =
    userRole === 'store_admin' && !!instapayPayment && order.status !== 'refunded';
  const instapayRemaining = instapayPayment
    ? Math.max(0, instapayPayment.amount - (instapayPayment.refundedAmount ?? 0))
    : 0;

  return (
    // Lifted above the fixed MobileBottomNav (h-14 = 56px) on mobile so the
    // action buttons aren't hidden behind it — rule 6 "fixed-bottom UI" recipe.
    // md:bottom-0 because the nav is md:hidden (desktop = sidebar).
    <div
      className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] md:bottom-0 z-20 -mx-4 mt-6 border-t border-border bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-2xl sm:border sm:bg-card sm:p-3 print:hidden"
      role="toolbar"
      aria-label={t('toolbarLabel')}
    >
      <div className="flex flex-wrap items-center gap-2">
        {/* InstaPay: the one primary action. Idempotent on the server, so a second tap is safe. */}
        {showConfirmInstapay && onConfirmInstapay && userRole !== 'super_admin' && (
          <Button
            type="button"
            onClick={onConfirmInstapay}
            disabled={isUpdating}
            data-testid="confirm-instapay"
            variant="ghost"
            className="flex-1 min-w-0 justify-center gap-2 text-center font-semibold"
          >
            {isUpdating ? '…' : t('confirmInstapay')}
          </Button>
        )}
        {nextStatus && !isFinal && (
          <Button
            type="button"
            onClick={() => onStatusChange(nextStatus)}
            disabled={isUpdating}
            variant="ghost"
            className="flex-1 min-w-0 justify-center gap-2 text-center font-semibold"
          >
            {isUpdating ? (
              '…'
            ) : (
              <>
                <span className="min-w-0">
                  {orderActionKey(nextStatus)
                    ? tAction(nextStatus)
                    : tStatus(nextStatus) || t('processed')}
                </span>
              </>
            )}
          </Button>
        )}
        {/* Payment Link — surface the existing payment URL when the
            order already has one (WhatsApp-origin orders mint a link
            at creation), otherwise open the issue-new modal. Picks the
            most recent non-paid Payment row with a usable URL. */}
        {showMarkPaid && (
          <PaymentLinkButton
            storeId={storeId}
            orderId={order.id}
            orderNumber={order.orderNumber}
            disabled={isUpdating}
            existingPaymentUrl={
              [...(order.payments ?? [])]
                .filter(p => p.status !== 'paid' && (p.paymentUrl || p.paymentLink))
                .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))[0]?.paymentUrl ??
              [...(order.payments ?? [])]
                .filter(p => p.status !== 'paid' && (p.paymentUrl || p.paymentLink))
                .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))[0]?.paymentLink ??
              null
            }
          />
        )}
        {showManualMarkPaid && (
          <Button
            type="button"
            onClick={onMarkPaid}
            disabled={isUpdating}
            variant="outline"
            className="flex-1 min-w-0 justify-center gap-2 text-center font-semibold"
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
            <span className="min-w-0">{t('markPaid')}</span>
          </Button>
        )}
        <div className="relative ms-auto" ref={menuRef}>
          <Button
            type="button"
            onClick={() => setMenuOpen(o => !o)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={t('more')}
            variant="ghost"
            size="icon"
            className="text-muted-foreground"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="12" r="1.6" />
              <circle cx="12" cy="12" r="1.6" />
              <circle cx="19" cy="12" r="1.6" />
            </svg>
          </Button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute end-0 bottom-full mb-2 w-64 overflow-hidden rounded-xl border border-border bg-popover py-1 shadow-lg"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onPrintInvoice();
                }}
                className="flex min-h-11 w-full items-center px-4 text-start text-sm text-foreground hover:bg-muted cursor-pointer"
              >
                {t('printInvoice')}
              </button>
              {/* Money + diagnostic actions: reachable in one tap, never beside the primary (rule 7). */}
              <div className="flex flex-col gap-2 p-2">
                {/* Refresh payment — diagnostic. Re-check provider status when
                    webhook didn't fire (provider portal misconfigured /
                    signature mismatch / network blip). Same fanout as the
                    real webhook so notifications catch up. */}
                {showMarkPaid && (
                  <RefreshPaymentButton
                    storeId={storeId}
                    orderId={order.id}
                    disabled={isUpdating}
                    onRefreshed={onPaymentRefreshed}
                  />
                )}
                {/* Refund via provider — actually moves money back to the
                    customer's card. Distinct from the "Refunded" status menu
                    entry, which is only DB bookkeeping for already-refunded
                    COD / bank-transfer cases. */}
                {showInstapayRefund && instapayRemaining > 0 && (
                  <InstapayRefundButton
                    storeId={storeId}
                    orderId={order.id}
                    orderNumber={order.orderNumber}
                    remainingMinor={instapayRemaining}
                    disabled={isUpdating}
                    onRecorded={onPaymentRefreshed}
                  />
                )}
                {/* Partial refund (STORE-QA-76): chosen lines + quantities, per-line restock, any method. Delivered + paid orders;
                    the server re-checks everything (refundable balance, line quantities, permission per method). */}
                {canRefund &&
                  order.status === 'delivered' &&
                  (order.paymentStatus === 'paid' ||
                    order.paymentStatus === 'partially_refunded') && (
                    <PartialRefundButton
                      storeId={storeId}
                      orderId={order.id}
                      orderNumber={order.orderNumber}
                      currency={order.currency}
                      disabled={isUpdating}
                      onRefunded={onPaymentRefreshed}
                    />
                  )}
                {showRefundViaProvider && canRefund && (
                  <RefundButton
                    storeId={storeId}
                    orderId={order.id}
                    orderNumber={order.orderNumber}
                    // What the PROVIDER refunds (#2069): the refundable remainder of the
                    // payment row the route picks — after a partial refund that is less
                    // than the order value. Older payloads without the figures fall back
                    // to the order value less any customer-wallet spend (D1).
                    total={
                      refundViaProviderRemaining(order) ?? order.total - (order.walletAmount ?? 0)
                    }
                    currency={order.currency}
                    disabled={isUpdating}
                    onRefunded={onPaymentRefreshed}
                  />
                )}
                {/* Refresh refund status — diagnostic. Re-check provider status
                    for an already-submitted refund. A gateway may queue refunds
                    for 1-3 days; this button confirms when the finance team
                    has actually executed the refund (so the customer's card
                    reflects the credit). Same safety-net pattern as Refresh
                    Payment — autonomous webhook handles the common case, this
                    covers missed webhooks. */}
                {showRefreshRefundStatus && (
                  <RefreshRefundStatusButton
                    storeId={storeId}
                    orderId={order.id}
                    disabled={isUpdating}
                    onRefreshed={onPaymentRefreshed}
                  />
                )}
              </div>
              {canCancel && !isFinal && (
                <>
                  <div role="separator" className="my-1 h-px bg-border" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onStatusChange('cancelled');
                    }}
                    disabled={isUpdating}
                    className="flex min-h-11 w-full items-center px-4 text-start text-sm font-medium text-destructive-ink hover:bg-destructive/5 disabled:opacity-60 cursor-pointer"
                  >
                    {t('cancel')}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
