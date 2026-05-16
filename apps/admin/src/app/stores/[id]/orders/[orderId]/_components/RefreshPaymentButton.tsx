'use client';

import { useState } from 'react';
import { useToast } from '@force/ui';
import { apiPost } from '../../../../../../lib/api';

interface RefreshPaymentButtonProps {
  storeId: string;
  orderId: string;
  /** Re-fetch the parent order after a successful refresh so the UI updates. */
  onRefreshed?: () => void;
  disabled?: boolean;
}

/**
 * Manual sync of payment status with the provider (MyFatoorah etc.).
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
        toastError('Refresh failed', error?.message ?? '');
        return;
      }
      if (data.statusChanged) {
        toastSuccess(`Payment status updated to ${data.paymentStatus}`);
        onRefreshed?.();
      } else {
        toastSuccess(`Provider status: ${data.providerStatus} (no change)`);
      }
    } catch (e) {
      toastError('Refresh failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleRefresh}
      disabled={disabled || busy}
      title="Re-check payment status with the provider (use when webhook didn't fire)"
      className="flex-1 min-w-[8rem] inline-flex items-center justify-center gap-2 rounded-xl border-2 border-warning bg-warning/5 px-4 py-2.5 text-sm font-semibold text-warning hover:bg-warning/10 disabled:opacity-60 transition-colors cursor-pointer"
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
      {busy ? 'Checking…' : 'Refresh payment'}
    </button>
  );
}
