'use client';

import { useState } from 'react';
import { apiPost } from '@/lib/api';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/contexts/ToastContext';
import { formatMoney } from '@/lib/format';

/**
 * The one-thumb "Payment received" control for an InstaPay order (SP6a).
 *
 * A big full-width button (>= 48px) opens a bottom sheet that restates the exact
 * amount, so a mis-tap cannot confirm money that has not arrived. The server
 * confirm is idempotent (a second tap answers `changed:false`) and refuses an
 * order whose window expired, so retries and double taps are safe.
 */
export function ConfirmInstapayButton({
  storeId,
  orderId,
  amountMinor,
  currency,
  onConfirmed,
  className = '',
}: {
  storeId: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  onConfirmed: () => void;
  className?: string;
}) {
  const { t } = useLanguage();
  const { notify } = useToast();
  const ti = t.instapay;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    try {
      const { data, error } = await apiPost<{ changed: boolean }>(
        `/api/v1/stores/${storeId}/orders/${orderId}/confirm-instapay`,
        {}
      );
      if (error) {
        notify(error.code === 'INSTAPAY_CONFIRMATION_EXPIRED' ? ti.expired : ti.failed, 'error');
      } else {
        notify(data?.changed === false ? ti.alreadyConfirmed : ti.confirmed, 'success');
      }
      setOpen(false);
      onConfirmed();
    } catch {
      notify(ti.failed, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="confirm-instapay"
        className={`inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-success px-4 text-sm font-bold text-success-foreground active:bg-success/90 ${className}`}
      >
        {ti.confirm}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end bg-black/50"
          role="dialog"
          aria-modal="true"
          aria-label={ti.sheetTitle}
          onClick={() => !busy && setOpen(false)}
        >
          <div
            className="w-full rounded-t-2xl bg-background p-5 shadow-xl"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1.25rem)' }}
            onClick={e => e.stopPropagation()}
          >
            <h2 className="text-base font-bold text-foreground">{ti.sheetTitle}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {ti.sheetBody.replace('{amount}', formatMoney(amountMinor, currency))}
            </p>
            <button
              type="button"
              onClick={() => void confirm()}
              disabled={busy}
              className="mt-4 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-success px-4 text-sm font-bold text-success-foreground active:bg-success/90 disabled:opacity-60"
            >
              {busy ? '…' : ti.sheetYes}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={busy}
              className="mt-2 inline-flex min-h-12 w-full items-center justify-center rounded-xl border border-border px-4 text-sm font-medium text-foreground"
            >
              {ti.sheetNo}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
