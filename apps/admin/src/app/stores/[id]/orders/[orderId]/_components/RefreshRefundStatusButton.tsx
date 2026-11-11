'use client';

import { useState } from 'react';
import { useToast } from '@ebda/ui';
import { apiPost } from '../../../../../../lib/api';
import { useT } from '@/i18n/useT';

import { Button } from '@/components/ui/Button';
interface RefreshRefundStatusButtonProps {
  storeId: string;
  orderId: string;
  /** Re-fetch the parent order after a successful refresh so the UI updates. */
  onRefreshed?: () => void;
  disabled?: boolean;
}

/**
 * Manual sync of refund status with the provider. Use after submitting
 * a refund via "Refund via provider" — a gateway may not execute
 * a refund instantly (some review it first, for 1-3 business days), so
 * this button asks "is the refund actually settled at the card network?"
 * without waiting for the webhook.
 *
 * Acts as the safety-net counterpart to the automatic webhook. The
 * webhook still fires when the gateway executes the refund — this is
 * here for the case where the webhook didn't arrive or the merchant
 * wants to confirm before notifying the customer.
 */
export function RefreshRefundStatusButton({
  storeId,
  orderId,
  onRefreshed,
  disabled = false,
}: RefreshRefundStatusButtonProps) {
  const t = useT('orders.detail.refreshRefundStatus');
  const tCommon = useT('common');
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
        toastError(t('toastFailedTitle'), error?.message ?? '');
        return;
      }
      if (data.statusChanged) {
        const label =
          data.refundStatus === 'completed'
            ? t('statusCompleted')
            : data.refundStatus === 'failed'
              ? t('statusCanceled')
              : t('statusPending');
        toastSuccess(t('toastStatusChanged', { label }));
        onRefreshed?.();
      } else {
        toastSuccess(t('toastNoChange', { status: data.refundStatus }));
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
