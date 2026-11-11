'use client';

import { useState } from 'react';
import { useToast } from '@ebda/ui';
import { apiPost } from '../../../../../../lib/api';
import { useT } from '@/i18n/useT';

import { Button } from '@/components/ui/Button';
interface RefreshPaymentButtonProps {
  storeId: string;
  orderId: string;
  /** Re-fetch the parent order after a successful refresh so the UI updates. */
  onRefreshed?: () => void;
  disabled?: boolean;
}

/**
 * Manual sync of payment status with the provider (Paymob / Kashier / Fawry).
 * Use when a webhook didn't fire (provider portal misconfigured,
 * signature mismatch, network blip) but the customer says they paid.
 * Mirrors webhook handler's state-transition logic so the order /
 * payment row + Inngest notification fanout all catch up.
 */
export function RefreshPaymentButton({
  storeId,
  orderId,
  onRefreshed,
  disabled = false,
}: RefreshPaymentButtonProps) {
  const t = useT('orders.detail.refreshPayment');
  const tCommon = useT('common');
  const [busy, setBusy] = useState(false);
  const { success: toastSuccess, error: toastError } = useToast();

  const handleRefresh = async () => {
    setBusy(true);
    try {
      const { data, error } = await apiPost<{
        providerStatus: string;
        paymentStatus: string;
        statusChanged: boolean;
      }>(`/api/v1/stores/${storeId}/orders/${orderId}/refresh-payment-status`, {});
      if (error || !data) {
        toastError(t('toastFailedTitle'), error?.message ?? '');
        return;
      }
      if (data.statusChanged) {
        toastSuccess(t('toastUpdated', { status: data.paymentStatus }));
        onRefreshed?.();
      } else {
        toastSuccess(t('toastNoChange', { status: data.providerStatus }));
      }
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
    <Button
      type="button"
      onClick={handleRefresh}
      disabled={disabled || busy}
      title={t('buttonTooltip')}
      variant="outline"
      className="flex-1 min-w-[8rem] justify-center gap-2 font-semibold"
    >
      <svg
        className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
        />
      </svg>
      {busy ? t('checkingButton') : t('button')}
    </Button>
  );
}
