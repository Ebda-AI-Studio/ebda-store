'use client';

import { useState, useRef, useEffect } from 'react';
import { useT } from '@/i18n/useT';
import { VALID_TRANSITIONS } from '../../_components/types';
import { PaymentLinkButton } from './PaymentLinkButton';
import { RefreshPaymentButton } from './RefreshPaymentButton';
import { RefundButton } from './RefundButton';
import { RefreshRefundStatusButton } from './RefreshRefundStatusButton';
import type { OrderDetail } from './types';

interface ActionFooterProps {
  order: OrderDetail;
  storeId: string;
  isUpdating: boolean;
  onStatusChange: (newStatus: string) => void;
  onMarkPaid: () => void;
  onPrintInvoice: () => void;
  onPaymentRefreshed?: () => void;
}

export function ActionFooter({
  order,
  storeId,
  isUpdating,
  onStatusChange,
  onMarkPaid,
  onPrintInvoice,
  onPaymentRefreshed,
}: ActionFooterProps) {
  const t = useT('orders.detail.actions');
  const tStatus = useT('orders.status');
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

  const transitions = VALID_TRANSITIONS[order.status] ?? [];
  const nextStatus = transitions.find(s => s !== 'cancelled') ?? null;
  const canCancel = transitions.includes('cancelled');
  const isFinal = ['delivered', 'cancelled', 'refunded'].includes(order.status);
  // Promoted out of the overflow on mobile — the PWA flow drops the
  // merchant on this page from a "mark paid" deep link, so the action
  // must be one tap away, not buried behind a kebab.
  const showMarkPaid = order.paymentStatus !== 'paid';
  // Refund-via-provider is only meaningful when:
  //   - the order is paid (provider has money to give back)
  //   - we have a completed online payment row with a transactionId
  //     (rules out COD / manual-paid where the customer never gave
  //     us their card)
  //   - it hasn't already been refunded
  const completedOnlinePayment = order.payments?.find(
    p => p.status === 'completed' && p.transactionId && p.provider !== 'cod'
  );
  const showRefundViaProvider =
    order.paymentStatus === 'paid' && !!completedOnlinePayment && order.status !== 'refunded';
  // Refresh refund status — visible whenever there's a provider-issued
  // refund (any payment row with a non-null transactionId AND payment
  // status of refunded / partially_refunded). The button calls the
  // provider's GetRefundStatus to confirm whether the finance team has
  // executed the refund yet. Safety net for missed refund webhooks.
  const refundedPayment = order.payments?.find(
    p =>
      (p.status === 'refunded' || p.status === 'partially_refunded') &&
      p.transactionId &&
      p.provider !== 'cod'
  );
  const showRefreshRefundStatus = !!refundedPayment;

  return (
    <div
      className="sticky bottom-0 z-20 -mx-4 mt-6 border-t border-border bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-2xl sm:border sm:bg-card sm:p-3 print:hidden"
      role="toolbar"
      aria-label="Order actions"
    >
      <div className="flex flex-wrap items-center gap-2">
        {nextStatus && !isFinal && (
          <button
            type="button"
            onClick={() => onStatusChange(nextStatus)}
            disabled={isUpdating}
            className="flex-1 min-w-[8rem] inline-flex items-center justify-center gap-2 rounded-xl bg-success px-4 py-2.5 text-sm font-semibold text-success-foreground hover:bg-success/90 disabled:opacity-60 transition-colors cursor-pointer"
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
                {tStatus(nextStatus) || t('processed')}
              </>
            )}
          </button>
        )}
        {/* Payment Link — surface existing MyFatoorah/Tap URL when the
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
        {showRefundViaProvider && (
          <RefundButton
            storeId={storeId}
            orderId={order.id}
            orderNumber={order.orderNumber}
            total={order.total}
            currency={order.currency}
            disabled={isUpdating}
            onRefunded={onPaymentRefreshed}
          />
        )}
        {/* Refresh refund status — diagnostic. Re-check provider status
            for an already-submitted refund. MyFatoorah refunds queue
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
        {showMarkPaid && (
          <button
            type="button"
            onClick={onMarkPaid}
            disabled={isUpdating}
            className="flex-1 min-w-[8rem] inline-flex items-center justify-center gap-2 rounded-xl border-2 border-primary bg-primary/5 px-4 py-2.5 text-sm font-semibold text-primary hover:bg-primary/10 disabled:opacity-60 transition-colors cursor-pointer"
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
            {t('markPaid')}
          </button>
        )}
        {canCancel && !isFinal && (
          <button
            type="button"
            onClick={() => onStatusChange('cancelled')}
            disabled={isUpdating}
            className="flex-1 min-w-[8rem] inline-flex items-center justify-center rounded-xl border-2 border-destructive bg-card px-4 py-2.5 text-sm font-semibold text-destructive hover:bg-destructive/5 disabled:opacity-60 transition-colors cursor-pointer"
          >
            {t('cancel')}
          </button>
        )}

        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen(o => !o)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={t('more')}
            className="flex h-11 w-11 items-center justify-center rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors cursor-pointer"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2.5}
                d="M4 6h16M4 12h16M4 18h16"
              />
            </svg>
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute end-0 bottom-full mb-2 w-56 overflow-hidden rounded-xl border border-border bg-popover shadow-lg"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onPrintInvoice();
                }}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-start text-sm text-foreground hover:bg-muted cursor-pointer"
              >
                <svg
                  className="h-4 w-4 text-muted-foreground"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"
                  />
                </svg>
                {t('printInvoice')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
