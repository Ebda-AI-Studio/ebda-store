'use client';

import { useState } from 'react';
import { apiPost } from '@/lib/api';
import { useToast } from '@/contexts/ToastContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { fmt } from '@/lib/format';

interface PaymentLinkButtonProps {
  storeId: string;
  orderId: string;
  orderNumber: string;
  disabled?: boolean;
  /** Existing payment URL from a prior createPayment (WhatsApp-origin orders). */
  existingPaymentUrl?: string | null;
}

interface PaymentLinkResult {
  paymentUrl: string;
  /** Fawry: the reference code the customer pays at an outlet (no URL). */
  instruction?: { kind: string; code?: string };
  invoiceId?: string;
  notifyVia: 'link';
}

/**
 * "Issue payment link" button + modal — ported from the admin PaymentLinkButton
 * to the PWA's ToastContext + plain elements. When the order already has a
 * payment URL it's surfaced directly with copy/open; otherwise the modal lets the
 * merchant generate one with the store's gateway and copy it (the only channel:
 * none of the Egyptian gateways sends the customer a message for us).
 */
export function PaymentLinkButton({
  storeId,
  orderId,
  orderNumber,
  disabled = false,
  existingPaymentUrl,
}: PaymentLinkButtonProps) {
  const { t } = useLanguage();
  const ta = t.detail.actions;
  const { notify } = useToast();
  const [open, setOpen] = useState(false);
  const [isIssuing, setIsIssuing] = useState(false);
  const [result, setResult] = useState<PaymentLinkResult | null>(null);

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      notify(ta.linkCopied, 'success');
    } catch {
      notify(ta.clipboardError, 'error');
    }
  };

  const issue = async () => {
    setIsIssuing(true);
    try {
      const { data, error: apiError } = await apiPost<PaymentLinkResult>(
        `/api/v1/stores/${storeId}/orders/${orderId}/payment-link`,
        { notifyVia: 'link' }
      );
      if (apiError || !data) {
        notify(apiError?.message || ta.issueLinkFailed, 'error');
        return;
      }
      setResult(data);
    } catch (e) {
      notify(e instanceof Error ? e.message : ta.issueLinkFailed, 'error');
    } finally {
      setIsIssuing(false);
    }
  };

  const close = () => {
    setOpen(false);
    setTimeout(() => setResult(null), 200);
  };

  return (
    <>
      {existingPaymentUrl ? (
        <div className="flex min-w-[10rem] flex-1 flex-col gap-1.5">
          <div className="flex items-center gap-1.5 rounded-xl border-2 border-info bg-info/5 px-3 py-2">
            <span className="flex-1 truncate font-mono text-xs text-info-ink" dir="ltr">
              {existingPaymentUrl}
            </span>
            <button
              type="button"
              onClick={() => copy(existingPaymentUrl)}
              disabled={disabled}
              className="shrink-0 rounded-md p-1.5 text-info-ink active:bg-info/10"
              aria-label={ta.copyLink}
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                />
              </svg>
            </button>
            <a
              href={existingPaymentUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 rounded-md p-1.5 text-info-ink active:bg-info/10"
              aria-label={t.detail.paymentLink}
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                />
              </svg>
            </a>
          </div>
          <button
            type="button"
            onClick={() => setOpen(true)}
            disabled={disabled || isIssuing}
            className="self-start text-[11px] text-muted-foreground underline active:text-foreground"
          >
            {ta.issueNewLink}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={disabled || isIssuing}
          className="inline-flex h-11 min-w-0 flex-1 basis-[8rem] items-center justify-center gap-2 rounded-xl border-2 border-info bg-info/5 px-3 text-center text-xs font-semibold leading-tight text-info-ink active:bg-info/10 disabled:opacity-60"
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
              d="M13.828 10.172a4 4 0 015.656 0l1.414 1.414a4 4 0 010 5.656l-2.828 2.828a4 4 0 01-5.656 0L11 18.828m-1.828-7.656a4 4 0 00-5.656 0L1.69 12.586a4 4 0 000 5.656l2.828 2.828a4 4 0 005.656 0L11.828 19.5"
            />
          </svg>
          <span className="min-w-0">{ta.paymentLink}</span>
        </button>
      )}

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="pwa-payment-link-title"
          onClick={close}
        >
          <div
            className="w-full max-w-md rounded-t-2xl bg-card p-5 shadow-2xl sm:rounded-2xl"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1.25rem)' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h2 id="pwa-payment-link-title" className="text-lg font-bold text-foreground">
                  {ta.issueModalTitle}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {fmt(ta.issueModalDesc, { order: orderNumber })}
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label={ta.done}
                className="rounded-lg p-1.5 text-muted-foreground active:bg-muted"
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
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            {!result ? (
              <>
                <div className="space-y-3">
                  <button
                    type="button"
                    onClick={() => issue()}
                    disabled={isIssuing}
                    className="w-full rounded-xl border-2 border-primary bg-primary/5 p-4 text-start active:bg-primary/10 disabled:opacity-60"
                  >
                    <p className="font-semibold text-foreground">{ta.copyLink}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{ta.copyLinkDesc}</p>
                  </button>
                </div>
                {isIssuing && (
                  <p className="mt-4 text-center text-sm text-muted-foreground">{ta.issuing}</p>
                )}
              </>
            ) : (
              <div className="space-y-4">
                <div className="rounded-xl border border-success/20 bg-success/10 p-4">
                  <p className="text-sm font-semibold text-success-ink">{ta.linkGenerated}</p>
                </div>
                <div>
                  <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {ta.paymentUrl}
                  </label>
                  <div className="flex items-stretch gap-2">
                    <input
                      type="text"
                      readOnly
                      value={result.paymentUrl || result.instruction?.code || ''}
                      onFocus={e => e.currentTarget.select()}
                      dir="ltr"
                      className="flex-1 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-foreground focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => copy(result.paymentUrl || result.instruction?.code || '')}
                      className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground active:bg-primary/90"
                    >
                      {ta.copyLink}
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={close}
                  className="w-full rounded-xl bg-muted px-4 py-2.5 text-sm font-semibold text-foreground active:bg-muted/70"
                >
                  {ta.done}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
