'use client';

import { useState } from 'react';
import { Button, Modal, useToast } from '@force/ui';
import { apiPost } from '../../../../../../lib/api';

interface RefundButtonProps {
  storeId: string;
  orderId: string;
  orderNumber: string;
  /** Order total in fils — shown in the confirmation modal for full refunds. */
  total: number;
  currency: string;
  /** Re-fetch the parent order after a successful refund. */
  onRefunded?: () => void;
  disabled?: boolean;
}

/**
 * Admin-initiated refund via the payment provider (MyFatoorah / Tap / etc.).
 * Calls the store-scoped refund endpoint which:
 *   1. hits the provider's refund API
 *   2. flips Payment.status -> refunded and Order.status -> refunded
 *   3. fans out side effects via OrderService.applyRefundEffects:
 *      inventory restore, coupon usage decrement, affiliate commission
 *      reversal, loyalty points reversal, customer refund email,
 *      merchant admin push (order/refunded Inngest event).
 *
 * Manual "Refunded" status (the existing menu option) leaves the
 * customer's card untouched — that path is for COD / bank-transfer
 * refunds where the money was already returned out-of-band. This button
 * is the right choice when the customer paid with a card.
 */
export function RefundButton({
  storeId,
  orderId,
  orderNumber,
  total,
  currency,
  onRefunded,
  disabled = false,
}: RefundButtonProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const { success: toastSuccess, error: toastError } = useToast();

  const closeIfIdle = () => {
    if (busy) return;
    setReason('');
    setOpen(false);
  };

  const handleRefund = async () => {
    setBusy(true);
    try {
      const { data, error } = await apiPost<{
        refundId: string;
        refundAmount: number;
        provider: string;
        status: string;
      }>(`/api/v1/stores/${storeId}/orders/${orderId}/refund-via-provider`, {
        reason: reason.trim() || undefined,
      });
      if (error || !data) {
        toastError('Refund failed', error?.message ?? '');
        return;
      }
      toastSuccess(
        `Refunded ${(data.refundAmount / 1000).toFixed(3)} ${currency} via ${data.provider}`
      );
      onRefunded?.();
      setReason('');
      setOpen(false);
    } catch (e) {
      toastError('Refund failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled || busy}
        title="Refund the customer via the original payment provider"
        className="flex-1 min-w-[8rem] inline-flex items-center justify-center gap-2 rounded-xl border-2 border-destructive bg-destructive/5 px-4 py-2.5 text-sm font-semibold text-destructive hover:bg-destructive/10 disabled:opacity-60 transition-colors cursor-pointer"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"
          />
        </svg>
        Refund via provider
      </button>

      <Modal isOpen={open} onClose={closeIfIdle} title={`Refund order ${orderNumber}?`} size="sm">
        <p className="text-sm text-muted-foreground">
          The full amount of{' '}
          <strong className="text-foreground">
            {(total / 1000).toFixed(3)} {currency}
          </strong>{' '}
          will be refunded to the customer&apos;s original payment method. Inventory will be
          restored, coupon usage decremented, loyalty points reversed, and the customer will be
          emailed. This cannot be undone.
        </p>

        <div className="mt-4">
          <label htmlFor="refund-reason" className="block text-xs font-medium text-foreground mb-1">
            Reason (optional, shown to the customer)
          </label>
          <textarea
            id="refund-reason"
            value={reason}
            onChange={e => setReason(e.target.value)}
            disabled={busy}
            rows={2}
            maxLength={500}
            placeholder="Out of stock, customer request, duplicate charge…"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
          />
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <Button variant="outline" onClick={closeIfIdle} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleRefund} disabled={busy} isLoading={busy}>
            {busy ? 'Refunding…' : 'Refund now'}
          </Button>
        </div>
      </Modal>
    </>
  );
}
