'use client';

import { useState } from 'react';
import { Modal, useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { apiRequest } from '../../../../../../lib/api';
import { useT } from '@/i18n/useT';

import { minorToDecimalString } from '@ebda/shared';
import { TEXTAREA_CLASSES } from '@/components/ui/tokens';
interface RefundButtonProps {
  storeId: string;
  orderId: string;
  orderNumber: string;
  /** Piastres the provider will be asked for (the payment's refundable remainder) — quoted in the confirm. */
  total: number;
  currency: string;
  /** Re-fetch the parent order after a successful refund. */
  onRefunded?: () => void;
  disabled?: boolean;
}

/**
 * Admin-initiated refund via the payment provider (Paymob / Kashier / Fawry).
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
  const t = useT('orders.detail.refundViaProvider');
  const tCommon = useT('common');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  // One Idempotency-Key per dialog open (#628): a retry of THIS refund (double click, a timeout) reuses it, so the API
  // answers the first result or refuses; a new dialog is a new refund.
  const [attemptKey, setAttemptKey] = useState(() => crypto.randomUUID());
  const { success: toastSuccess, error: toastError } = useToast();

  const closeIfIdle = () => {
    if (busy) return;
    setReason('');
    setOpen(false);
  };

  const handleRefund = async () => {
    setBusy(true);
    try {
      const { data, error } = await apiRequest<{
        refundId: string;
        refundAmount: number;
        provider: string;
        status: string;
      }>(`/api/v1/stores/${storeId}/orders/${orderId}/refund-via-provider`, {
        method: 'POST',
        headers: { 'Idempotency-Key': attemptKey },
        body: JSON.stringify({ reason: reason.trim() || undefined }),
      });
      if (error || !data) {
        toastError(t('toastFailedTitle'), error?.message ?? '');
        return;
      }
      // A gateway may queue or review a refund, so "issued" is misleading —
      // the customer's card hasn't necessarily moved yet.
      toastSuccess(
        t('toastSuccessBody', {
          amount: minorToDecimalString(data.refundAmount),
          currency,
          provider: data.provider,
        })
      );
      onRefunded?.();
      setReason('');
      setOpen(false);
    } catch (e) {
      toastError(
        t('toastFailedTitle'),
        e instanceof Error ? e.message : tCommon('errors.boundary.unknown')
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        onClick={() => {
          setAttemptKey(crypto.randomUUID());
          setOpen(true);
        }}
        disabled={disabled || busy}
        title={t('buttonTooltip')}
        variant="outline"
        className="flex-1 min-w-[8rem] justify-center gap-2 font-semibold text-destructive-ink"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"
          />
        </svg>
        {t('button')}
      </Button>

      <Modal isOpen={open} onClose={closeIfIdle} title={t('modalTitle', { orderNumber })} size="sm">
        <p className="text-sm text-muted-foreground">
          {t.rich('modalBodyIntro', {
            b: chunks => <strong className="text-foreground">{chunks}</strong>,
            amount: minorToDecimalString(total),
            currency,
          })}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">{t('modalBodySideEffects')}</p>

        <div className="mt-4">
          <label htmlFor="refund-reason" className="block text-xs font-medium text-foreground mb-1">
            {t('reasonLabel')}
          </label>
          <textarea
            id="refund-reason"
            value={reason}
            onChange={e => setReason(e.target.value)}
            disabled={busy}
            rows={2}
            maxLength={500}
            placeholder={t('reasonPlaceholder')}
            className={TEXTAREA_CLASSES}
          />
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <Button variant="outline" onClick={closeIfIdle} disabled={busy}>
            {tCommon('cancel')}
          </Button>
          <Button variant="destructive" onClick={handleRefund} disabled={busy} isLoading={busy}>
            {busy ? t('refundingButton') : t('refundNowButton')}
          </Button>
        </div>
      </Modal>
    </>
  );
}
