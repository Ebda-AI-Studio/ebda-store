'use client';

import { useEffect, useMemo, useState } from 'react';
import { Modal, useToast } from '@ebda/ui';
import { minorToDecimalString } from '@ebda/shared';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { apiRequest } from '../../../../../../lib/api';
import { RefundLinesPicker } from '../../../../../../components/refund/RefundLinesPicker';
import {
  emptySelection,
  selectionItems,
  useOrderRefundQuote,
  type Selection,
} from '../../../../../../components/refund/useOrderRefundQuote';

interface PartialRefundButtonProps {
  storeId: string;
  orderId: string;
  orderNumber: string;
  currency: string;
  /** Re-fetch the order after a refund. */
  onRefunded?: () => void;
  disabled?: boolean;
}

/** Errors the merchant can act on, each with its own bilingual copy under `orders.detail.partialRefund.errors` (the API text is English-only). */
const KNOWN_ERRORS = new Set([
  'REFUND_EXCEEDS_ORDER',
  'NOTHING_REFUNDABLE',
  'INVALID_QUANTITY',
  'FULL_RETURN_RESTOCK_ALL',
  'GUEST_ORDER_RETURN_UNSUPPORTED',
  'INVALID_ORDER',
  'PROVIDER_REFUND_INDETERMINATE',
  'PROVIDER_REFUND_FAILED',
  'IDEMPOTENCY_IN_PROGRESS',
  'FORBIDDEN',
]);

/**
 * Refund PART of an order: choose lines and quantities, decide per line whether the goods go back on the shelf, pick how the
 * money goes back. The remaining refundable balance and the amount of this refund are shown before anything moves, and the
 * server enforces both again (never more than paid minus already refunded, one Idempotency-Key per dialog open).
 */
export function PartialRefundButton({
  storeId,
  orderId,
  orderNumber,
  currency,
  onRefunded,
  disabled = false,
}: PartialRefundButtonProps) {
  const t = useT('orders.detail.partialRefund');
  const tCommon = useT('common');
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState('');
  const [sel, setSel] = useState<Selection | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // one key per dialog open: a retry of THIS refund (double click, timeout) answers the first result, a new dialog is a new refund
  const [attemptKey, setAttemptKey] = useState(() => crypto.randomUUID());

  const { quote, loading, errorCode } = useOrderRefundQuote(storeId, open ? orderId : null, sel);

  useEffect(() => {
    if (quote && !sel) setSel(emptySelection(quote));
  }, [quote, sel]);

  const methods = useMemo(() => {
    if (!quote) return [] as string[];
    const online =
      quote.paymentProvider !== null &&
      quote.paymentProvider !== 'cod' &&
      quote.paymentProvider !== 'instapay' &&
      quote.canRefundToOriginal;
    return [...(online ? ['original_payment'] : []), 'cash', 'bank_transfer', 'manual'];
  }, [quote]);
  useEffect(() => {
    if (methods.length && !methods.includes(method)) setMethod(methods[0]);
  }, [methods, method]);

  const items = quote && sel ? selectionItems(quote, sel) : [];
  const canSubmit =
    !!quote &&
    quote.returnable.ok &&
    quote.refundable > 0 &&
    items.length > 0 &&
    reason.trim().length > 0 &&
    !!method &&
    !busy;

  const close = () => {
    if (busy) return;
    setOpen(false);
    setSel(null);
    setReason('');
    setFailure(null);
  };

  const submit = async () => {
    if (!quote || !canSubmit) return;
    setBusy(true);
    setFailure(null);
    try {
      const { data, error } = await apiRequest<{ refundAmount: number }>(
        `/api/v1/stores/${storeId}/orders/${orderId}/partial-refund`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': attemptKey },
          body: JSON.stringify({ items, reason: reason.trim(), refundMethod: method }),
        }
      );
      if (error || !data) {
        setFailure(error && KNOWN_ERRORS.has(error.code) ? error.code : 'UNKNOWN');
        return;
      }
      toast.success(
        t('toastSuccessTitle'),
        t('toastSuccessBody', { amount: minorToDecimalString(data.refundAmount), currency })
      );
      onRefunded?.();
      setOpen(false);
      setSel(null);
      setReason('');
    } finally {
      setBusy(false);
    }
  };

  const guestOrNotDelivered = quote && !quote.returnable.ok ? quote.returnable.reason : null;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={() => {
          setAttemptKey(crypto.randomUUID());
          setOpen(true);
        }}
        className="w-full justify-center"
      >
        {t('button')}
      </Button>

      <Modal isOpen={open} onClose={close} title={t('title', { orderNumber })} size="md">
        {loading && !quote ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('loading')}
          </p>
        ) : !quote ? (
          <p role="alert" className="text-sm text-destructive-ink">
            {t('loadFailed')}
            {errorCode ? ` (${errorCode})` : ''}
          </p>
        ) : (
          <div className="space-y-4">
            <dl className="grid grid-cols-3 gap-2 rounded-lg bg-muted p-3 text-center text-sm">
              <div>
                <dt className="text-muted-foreground">{t('paid')}</dt>
                <dd className="font-semibold text-foreground">
                  {minorToDecimalString(quote.paid)} {currency}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('alreadyRefunded')}</dt>
                <dd className="font-semibold text-foreground">
                  {minorToDecimalString(quote.refunded)} {currency}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('remaining')}</dt>
                <dd className="font-semibold text-foreground" data-testid="refund-remaining">
                  {minorToDecimalString(quote.refundable)} {currency}
                </dd>
              </div>
            </dl>

            {guestOrNotDelivered ? (
              <p role="alert" className="text-sm text-destructive-ink">
                {t(`blocked.${guestOrNotDelivered}`)}
              </p>
            ) : quote.refundable <= 0 ? (
              <p role="status" className="text-sm text-foreground">
                {t('nothingLeft')}
              </p>
            ) : (
              <>
                {sel && (
                  <RefundLinesPicker
                    idPrefix="partial-refund"
                    quote={quote}
                    currency={currency}
                    value={sel}
                    onChange={setSel}
                    disabled={busy}
                  />
                )}

                <div>
                  <label
                    htmlFor="partial-refund-method"
                    className="mb-1 block text-xs font-medium text-foreground"
                  >
                    {t('methodLabel')}
                  </label>
                  <select
                    id="partial-refund-method"
                    value={method}
                    onChange={e => setMethod(e.target.value)}
                    disabled={busy}
                    className="h-11 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    {methods.map(m => (
                      <option key={m} value={m}>
                        {t(`methods.${m}`)}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t(`methodHint.${method || 'manual'}`)}
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="partial-refund-reason"
                    className="mb-1 block text-xs font-medium text-foreground"
                  >
                    {t('reasonLabel')}
                  </label>
                  <textarea
                    id="partial-refund-reason"
                    value={reason}
                    onChange={e => setReason(e.target.value)}
                    disabled={busy}
                    rows={2}
                    maxLength={500}
                    placeholder={t('reasonPlaceholder')}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
                  />
                </div>

                <p
                  role="status"
                  aria-live="polite"
                  className="rounded-lg border border-border p-3 text-sm text-foreground"
                  data-testid="refund-estimate"
                >
                  {items.length === 0
                    ? t('pickLines')
                    : loading || quote.estimate === null
                      ? t('estimating')
                      : t('estimate', {
                          amount: minorToDecimalString(quote.estimate),
                          currency,
                        })}
                </p>
              </>
            )}

            {failure && (
              <p role="alert" className="text-sm text-destructive-ink">
                {t(`errors.${failure}`)}
              </p>
            )}

            <div className="mt-2 flex justify-end gap-3">
              <Button variant="outline" onClick={close} disabled={busy}>
                {tCommon('cancel')}
              </Button>
              <Button variant="destructive" onClick={submit} disabled={!canSubmit} isLoading={busy}>
                {busy ? t('refunding') : t('confirm')}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
