'use client';

import { useState } from 'react';
import { useToast } from '@force/ui';
import { apiPost } from '../../../../../../lib/api';

interface PaymentLinkButtonProps {
  storeId: string;
  orderId: string;
  orderNumber: string;
  /** Disable when the order is already paid — backend rejects with 400. */
  disabled?: boolean;
}

interface PaymentLinkResult {
  paymentUrl: string;
  invoiceId?: string;
  notifyVia: 'link' | 'email' | 'all';
  customerEmail?: string;
}

/**
 * Self-contained "Issue MyFatoorah Payment Link" button + modal. Used
 * by the order detail page's action footer when a customer needs a
 * pay-by-link (e.g. KNET timeout, gateway blocked, abandoned cart).
 *
 * Two channels exposed: 'link' (copy + share manually) and 'email'
 * (MyFatoorah sends the email natively). SMS deliberately not surfaced
 * yet per Ahmad 2026-05-16. The backend endpoint accepts 'all' too
 * but we don't show it here until SMS is on the table.
 */
export function PaymentLinkButton({
  storeId,
  orderId,
  orderNumber,
  disabled = false,
}: PaymentLinkButtonProps) {
  const [open, setOpen] = useState(false);
  const [isIssuing, setIsIssuing] = useState(false);
  const [result, setResult] = useState<PaymentLinkResult | null>(null);
  const { success: toastSuccess, error: toastError } = useToast();

  const issue = async (notifyVia: 'link' | 'email') => {
    setIsIssuing(true);
    try {
      const { data, error: apiError } = await apiPost<PaymentLinkResult>(
        `/api/v1/stores/${storeId}/orders/${orderId}/payment-link`,
        { notifyVia }
      );
      if (apiError || !data) {
        toastError('Failed to issue payment link', apiError?.message ?? '');
        return;
      }
      setResult(data);
      if (notifyVia === 'email') {
        toastSuccess(`Email sent to ${data.customerEmail ?? 'customer'}`);
      }
    } catch (e) {
      toastError('Failed to issue payment link', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setIsIssuing(false);
    }
  };

  const copyLink = async () => {
    if (!result?.paymentUrl) return;
    try {
      await navigator.clipboard.writeText(result.paymentUrl);
      toastSuccess('Link copied to clipboard');
    } catch {
      toastError('Could not access clipboard — copy the link manually');
    }
  };

  const close = () => {
    setOpen(false);
    // Reset after close so re-opening starts fresh
    setTimeout(() => setResult(null), 200);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled || isIssuing}
        className="flex-1 min-w-[8rem] inline-flex items-center justify-center gap-2 rounded-xl border-2 border-info bg-info/5 px-4 py-2.5 text-sm font-semibold text-info hover:bg-info/10 disabled:opacity-60 transition-colors cursor-pointer"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M13.828 10.172a4 4 0 015.656 0l1.414 1.414a4 4 0 010 5.656l-2.828 2.828a4 4 0 01-5.656 0L11 18.828m-1.828-7.656a4 4 0 00-5.656 0L1.69 12.586a4 4 0 000 5.656l2.828 2.828a4 4 0 005.656 0L11.828 19.5"
          />
        </svg>
        Payment Link
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="payment-link-modal-title"
          onClick={close}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-card p-6 shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h2 id="payment-link-modal-title" className="text-lg font-bold text-foreground">
                  Issue Payment Link
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Order {orderNumber} — generate a MyFatoorah link to collect payment.
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
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
                    onClick={() => issue('link')}
                    disabled={isIssuing}
                    className="w-full rounded-xl border-2 border-primary bg-primary/5 p-4 text-start hover:bg-primary/10 disabled:opacity-60 transition-colors cursor-pointer"
                  >
                    <div className="flex items-start gap-3">
                      <svg
                        className="h-5 w-5 flex-shrink-0 text-primary mt-0.5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        aria-hidden
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                        />
                      </svg>
                      <div>
                        <p className="font-semibold text-foreground">Copy link</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Generate the URL — copy it and share via WhatsApp, email, or any channel
                          you prefer.
                        </p>
                      </div>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => issue('email')}
                    disabled={isIssuing}
                    className="w-full rounded-xl border-2 border-border bg-background p-4 text-start hover:border-info hover:bg-info/5 disabled:opacity-60 transition-colors cursor-pointer"
                  >
                    <div className="flex items-start gap-3">
                      <svg
                        className="h-5 w-5 flex-shrink-0 text-info mt-0.5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        aria-hidden
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                        />
                      </svg>
                      <div>
                        <p className="font-semibold text-foreground">Send via email</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          MyFatoorah delivers the payment link directly to the customer&apos;s email
                          on file.
                        </p>
                      </div>
                    </div>
                  </button>
                </div>

                {isIssuing && (
                  <p className="mt-4 text-center text-sm text-muted-foreground">
                    Issuing payment link…
                  </p>
                )}
              </>
            ) : (
              <div className="space-y-4">
                <div className="rounded-xl bg-success/10 border border-success/20 p-4">
                  <p className="text-sm font-semibold text-success">
                    {result.notifyVia === 'email'
                      ? `✓ Email sent to ${result.customerEmail}`
                      : '✓ Payment link generated'}
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                    Payment URL
                  </label>
                  <div className="flex items-stretch gap-2">
                    <input
                      type="text"
                      readOnly
                      value={result.paymentUrl}
                      className="flex-1 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-foreground focus:outline-none"
                      onFocus={e => e.currentTarget.select()}
                      dir="ltr"
                    />
                    <button
                      type="button"
                      onClick={copyLink}
                      className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
                    >
                      <svg
                        className="h-4 w-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        aria-hidden
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                        />
                      </svg>
                      Copy
                    </button>
                  </div>
                </div>

                <p className="text-xs text-muted-foreground">
                  The customer can pay anytime from this link. Once paid, the order&apos;s payment
                  status updates automatically via webhook.
                </p>

                <button
                  type="button"
                  onClick={close}
                  className="w-full rounded-xl bg-muted px-4 py-2.5 text-sm font-semibold text-foreground hover:bg-muted/70 transition-colors cursor-pointer"
                >
                  Done
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
