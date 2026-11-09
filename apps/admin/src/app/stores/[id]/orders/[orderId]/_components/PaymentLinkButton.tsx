'use client';

import { useState } from 'react';
import { useToast } from '@ebda/ui';
import { apiPost } from '../../../../../../lib/api';
import { useT } from '@/i18n/useT';

interface PaymentLinkButtonProps {
  storeId: string;
  orderId: string;
  orderNumber: string;
  /** Disable when the order is already paid — backend rejects with 400. */
  disabled?: boolean;
  /**
   * Existing payment URL from a prior `PaymentService.createPayment`
   * call on this order. When present (typical for WhatsApp-origin
   * orders that minted a link at creation), the button
   * surfaces the existing link first with a Copy/Open action AND
   * exposes a smaller "Issue a new link" option. Without this prop
   * the original modal flow runs unchanged.
   */
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
 * Self-contained "Issue Payment Link" button + modal. Used by the order detail
 * page's action footer when a customer needs a pay-by-link (gateway blocked,
 * abandoned cart). The link is made by the store's default payment gateway and
 * is copied and shared by the merchant: none of the Egyptian gateways sends the
 * customer a message for us, so 'link' is the only channel.
 */
export function PaymentLinkButton({
  storeId,
  orderId,
  orderNumber,
  disabled = false,
  existingPaymentUrl,
}: PaymentLinkButtonProps) {
  const t = useT('orders.paymentLinkButton');
  const tCommon = useT('common');
  const [open, setOpen] = useState(false);
  const [isIssuing, setIsIssuing] = useState(false);
  const [result, setResult] = useState<PaymentLinkResult | null>(null);
  const [copiedExisting, setCopiedExisting] = useState(false);
  const { success: toastSuccess, error: toastError } = useToast();

  const copyExistingLink = async () => {
    if (!existingPaymentUrl) return;
    try {
      await navigator.clipboard.writeText(existingPaymentUrl);
      setCopiedExisting(true);
      toastSuccess(t('linkCopied'));
      setTimeout(() => setCopiedExisting(false), 2000);
    } catch {
      toastError(t('clipboardError'));
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
        toastError(t('issueFailed'), apiError?.message ?? '');
        return;
      }
      setResult(data);
    } catch (e) {
      toastError(
        t('issueFailed'),
        e instanceof Error ? e.message : tCommon('errors.boundary.unknown')
      );
    } finally {
      setIsIssuing(false);
    }
  };

  const copyLink = async () => {
    const text = result?.paymentUrl || result?.instruction?.code;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toastSuccess(t('linkCopied'));
    } catch {
      toastError(t('clipboardError'));
    }
  };

  const close = () => {
    setOpen(false);
    // Reset after close so re-opening starts fresh
    setTimeout(() => setResult(null), 200);
  };

  return (
    <>
      {existingPaymentUrl ? (
        // The order already has a Payment.paymentUrl (typical for
        // WhatsApp-origin orders that minted the link at creation time).
        // Surface the URL directly with Copy + Open actions; the small
        // "Issue a new link" caption still opens the original modal
        // for the rare case where the merchant needs a fresh URL.
        <div className="flex-1 min-w-[10rem] inline-flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5 rounded-xl border-2 border-info bg-info/5 px-3 py-2">
            <svg
              className="h-4 w-4 text-info flex-shrink-0"
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
            <span className="text-xs font-mono text-info-ink truncate flex-1" dir="ltr">
              {existingPaymentUrl}
            </span>
            <button
              type="button"
              onClick={copyExistingLink}
              disabled={disabled}
              className="text-info-ink hover:bg-info/10 rounded-md p-1.5 flex-shrink-0 cursor-pointer"
              aria-label={t('copyAria')}
              title={t('copyAria')}
            >
              {copiedExisting ? (
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              ) : (
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                  />
                </svg>
              )}
            </button>
            <a
              href={existingPaymentUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-info-ink hover:bg-info/10 rounded-md p-1.5 flex-shrink-0"
              aria-label={t('openAria')}
              title={t('openAria')}
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
            className="text-xs text-muted-foreground hover:text-foreground underline self-start"
          >
            {t('issueNewLink')}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={disabled || isIssuing}
          className="flex-1 min-w-[8rem] inline-flex items-center justify-center gap-2 rounded-xl border-2 border-info bg-info/5 px-4 py-2.5 text-sm font-semibold text-info-ink hover:bg-info/10 disabled:opacity-60 transition-colors cursor-pointer"
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
              d="M13.828 10.172a4 4 0 015.656 0l1.414 1.414a4 4 0 010 5.656l-2.828 2.828a4 4 0 01-5.656 0L11 18.828m-1.828-7.656a4 4 0 00-5.656 0L1.69 12.586a4 4 0 000 5.656l2.828 2.828a4 4 0 005.656 0L11.828 19.5"
            />
          </svg>
          {t('buttonLabel')}
        </button>
      )}

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
                  {t('modalTitle')}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t('modalSubtitle', { orderNumber })}
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label={tCommon('close')}
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
                    onClick={() => issue()}
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
                        <p className="font-semibold text-foreground">
                          {t('option.copyLink.title')}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {t('option.copyLink.description')}
                        </p>
                      </div>
                    </div>
                  </button>
                </div>

                {isIssuing && (
                  <p className="mt-4 text-center text-sm text-muted-foreground">{t('issuing')}</p>
                )}
              </>
            ) : (
              <div className="space-y-4">
                <div className="rounded-xl bg-success/10 border border-success/20 p-4">
                  <p className="text-sm font-semibold text-success-ink">{t('successGenerated')}</p>
                </div>

                <div>
                  <label className="block text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                    {t('paymentUrlLabel')}
                  </label>
                  <div className="flex items-stretch gap-2">
                    <input
                      type="text"
                      readOnly
                      value={result.paymentUrl || result.instruction?.code || ''}
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
                      {t('copyButton')}
                    </button>
                  </div>
                </div>

                <p className="text-xs text-muted-foreground">{t('paidAutoUpdateNote')}</p>

                <button
                  type="button"
                  onClick={close}
                  className="w-full rounded-xl bg-muted px-4 py-2.5 text-sm font-semibold text-foreground hover:bg-muted/70 transition-colors cursor-pointer"
                >
                  {t('doneButton')}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
