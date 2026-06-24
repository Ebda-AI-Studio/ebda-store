'use client';

import { useState } from 'react';
import { apiPost } from '@/lib/api';
import { useToast } from '@/contexts/ToastContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { fmt } from '@/lib/format';

interface RefreshRefundStatusButtonProps {
  storeId: string;
  orderId: string;
  onRefreshed?: () => void;
  disabled?: boolean;
}

/**
 * Manual re-sync of refund status with the provider — ported from the admin
 * RefreshRefundStatusButton. Use after submitting a refund to confirm whether
 * the provider's finance team has executed it, without waiting for the webhook.
 */
export function RefreshRefundStatusButton({
  storeId,
  orderId,
  onRefreshed,
  disabled = false,
}: RefreshRefundStatusButtonProps) {
  const { t } = useLanguage();
  const ta = t.detail.actions;
  const { notify } = useToast();
  const [busy, setBusy] = useState(false);

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
        notify(error?.message || ta.refreshRefundFailed, 'error');
        return;
      }
      if (data.statusChanged) {
        const label =
          data.refundStatus === 'completed'
            ? ta.refundStatusCompleted
            : data.refundStatus === 'failed'
              ? ta.refundStatusFailed
              : ta.refundStatusPending;
        notify(label, 'success');
        onRefreshed?.();
      } else {
        notify(fmt(ta.refundStatusNoChange, { status: data.refundStatus }), 'info');
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : ta.refreshRefundFailed, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleRefresh}
      disabled={disabled || busy}
      className="inline-flex h-11 min-w-0 flex-1 basis-[8rem] items-center justify-center gap-2 rounded-xl border-2 border-warning bg-warning/5 px-3 text-center text-xs font-semibold leading-tight text-warning active:bg-warning/10 disabled:opacity-60"
    >
      <svg
        className={`h-4 w-4 shrink-0 ${busy ? 'animate-spin' : ''}`}
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
      <span className="min-w-0">{busy ? ta.refreshRefundChecking : ta.refreshRefund}</span>
    </button>
  );
}
