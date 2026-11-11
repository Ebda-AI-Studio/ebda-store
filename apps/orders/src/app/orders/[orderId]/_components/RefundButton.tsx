'use client';

import { useState } from 'react';
import { apiRequest } from '@/lib/api';
import { useToast } from '@/contexts/ToastContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { formatMoney, fmt } from '@/lib/format';

import { REGION } from '@ebda/shared';
interface RefundButtonProps {
  storeId: string;
  orderId: string;
  orderNumber: string;
  /** Piastres the provider will be asked for (the payment's refundable remainder) — quoted in the confirm. */
  total: number;
  currency?: string;
  onRefunded?: () => void;
  disabled?: boolean;
}

/**
 * Admin-initiated refund via the payment provider — ported from the admin
 * RefundButton to the PWA's ToastContext + a plain bottom-sheet modal. Moves
 * money back to the customer's card and fans out the refund side effects
 * (inventory restore, coupon decrement, loyalty reversal, customer email).
 */
export function RefundButton({
  storeId,
  orderId,
  orderNumber,
  total,
  currency = REGION.currency,
  onRefunded,
  disabled = false,
}: RefundButtonProps) {
  const { t } = useLanguage();
  const ta = t.detail.actions;
  const { notify } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  // One Idempotency-Key per dialog open (#628): a retry of THIS refund (double click, a timeout) reuses it, so the API
  // answers the first result or refuses; a new dialog is a new refund.
  const [attemptKey, setAttemptKey] = useState(() => crypto.randomUUID());

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
        notify(error?.message || ta.refundFailed, 'error');
        return;
      }
      notify(
        fmt(ta.refundRequested, {
          amount: formatMoney(data.refundAmount, currency),
          provider: data.provider,
        }),
        'success'
      );
      onRefunded?.();
      setReason('');
      setOpen(false);
    } catch (e) {
      notify(e instanceof Error ? e.message : ta.refundFailed, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setAttemptKey(crypto.randomUUID());
          setOpen(true);
        }}
        disabled={disabled || busy}
        className="inline-flex h-11 min-w-0 flex-1 basis-[8rem] items-center justify-center gap-2 rounded-xl border-2 border-destructive bg-destructive/5 px-3 text-center text-xs font-semibold leading-tight text-destructive-ink active:bg-destructive/10 disabled:opacity-60"
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
            d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"
          />
        </svg>
        <span className="min-w-0">{ta.refundViaProvider}</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="pwa-refund-title"
          onClick={closeIfIdle}
        >
          <div
            className="w-full max-w-md rounded-t-2xl bg-card p-5 shadow-2xl sm:rounded-2xl"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1.25rem)' }}
            onClick={e => e.stopPropagation()}
          >
            <h2 id="pwa-refund-title" className="mb-3 text-lg font-bold text-foreground">
              {fmt(ta.refundModalTitle, { order: orderNumber })}
            </h2>
            <p className="text-sm text-muted-foreground">
              {fmt(ta.refundModalDesc, { amount: formatMoney(total, currency) })}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">{ta.refundModalEffects}</p>

            <div className="mt-4">
              <label
                htmlFor="pwa-refund-reason"
                className="mb-1 block text-xs font-medium text-foreground"
              >
                {ta.refundReasonLabel}
              </label>
              <textarea
                id="pwa-refund-reason"
                value={reason}
                onChange={e => setReason(e.target.value)}
                disabled={busy}
                rows={2}
                maxLength={500}
                placeholder={ta.refundReasonPlaceholder}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
              />
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={closeIfIdle}
                disabled={busy}
                className="inline-flex h-11 items-center rounded-xl border border-border px-4 text-sm font-semibold text-foreground active:bg-muted disabled:opacity-60"
              >
                {t.detail.actions.cancel}
              </button>
              <button
                type="button"
                onClick={handleRefund}
                disabled={busy}
                className="inline-flex h-11 items-center rounded-xl bg-destructive px-4 text-sm font-semibold text-destructive-foreground active:bg-destructive/90 disabled:opacity-60"
              >
                {busy ? ta.refunding : ta.refundNow}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
