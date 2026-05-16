'use client';

import { useState } from 'react';
import { useToast } from '@force/ui';
import { apiPost } from '../../../../../../lib/api';

interface RefreshRefundStatusButtonProps {
  storeId: string;
  orderId: string;
  /** Re-fetch the parent order after a successful refresh so the UI updates. */
  onRefreshed?: () => void;
  disabled?: boolean;
}

/**
 * Manual sync of refund status with the provider. Use after submitting
 * a refund via "Refund via provider" — MyFatoorah refunds aren't
 * instant (their finance team executes them in 1-3 business days), so
 * this button asks "is the refund actually settled at the card network?"
 * without waiting for the webhook.
 *
 * Acts as the safety-net counterpart to the automatic webhook. The
 * webhook still fires when MyFatoorah executes the refund — this is
 * here for the case where the webhook didn't arrive or the merchant
 * wants to confirm before notifying the customer.
 */
export function RefreshRefundStatusButton({
  storeId,
  orderId,
  onRefreshed,
  disabled = false,
}: RefreshRefundStatusButtonProps) {
  const [busy, setBusy] = useState(false);
  const { success: toastSuccess, error: toastError } = useToast();

  const handleRefresh = async () => {
    setBusy(true);
    try {
      const { data, error } = await apiPost<{
        refundStatus: 'pending' | 'completed' | 'failed';
        providerStatus: string;
        refundedAmount?: number;
        refundReference?: string;
        statusChanged: boolean;
      }>(`/api/v1/stores/${storeId}/orders/${orderId}/refresh-refund-status`, {});
      if (error || !data) {
        toastError('Refund status refresh failed', error?.message ?? '');
        return;
      }
      if (data.statusChanged) {
        const label =
          data.refundStatus === 'completed'
            ? 'completed — customer card has been credited'
            : data.refundStatus === 'failed'
              ? 'canceled by provider'
              : 'still pending finance team review';
        toastSuccess(`Refund status: ${label}`);
        onRefreshed?.();
      } else {
        toastSuccess(`Refund still ${data.refundStatus} (no change)`);
      }
    } catch (e) {
      toastError('Refund status refresh failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleRefresh}
      disabled={disabled || busy}
      title="Re-check refund status with the provider (use when refund webhook didn't fire)"
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
      {busy ? 'Checking refund…' : 'Refresh refund status'}
    </button>
  );
}
