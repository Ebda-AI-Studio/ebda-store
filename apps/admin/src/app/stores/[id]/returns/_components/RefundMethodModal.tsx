'use client';

import { useEffect, useState } from 'react';
import { Button, Modal } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { apiGet } from '../../../../../lib/api';

import { formatMoney } from '@ebda/shared';
type RefundMethod = 'original' | 'store_credit' | 'bank_transfer' | 'manual';

// 'manual' ("Already refunded — record only") is offered ONLY when a refund for
// this return already went to the provider — see `visibleMethods` below.
const REFUND_METHODS: RefundMethod[] = ['original', 'store_credit', 'bank_transfer', 'manual'];

/** `GET /returns/admin/:id/refund-preview` — ReturnService.refundPreview. */
interface RefundPreview {
  isFullReturn: boolean;
  /** What a non-gateway completion records, in piastres. */
  recordedAmount: number;
  /** With the customer wallet on: what store credit puts in the customer's
   *  wallet, in piastres (complete() credits exactly this). Null = wallet off. */
  storeCreditToWallet?: number | null;
  gateway: {
    available: boolean;
    /** What would be sent to the customer's original payment method, in piastres. */
    amount: number | null;
    /** On an order paid partly from the customer wallet, the part of this
     *  refund that goes back to the wallet instead, in piastres (#1956). */
    walletShare?: number;
    refundableRemaining: number | null;
    unavailableReason: string | null;
    /** Server-decided: the customer already has money back on the original method. */
    alreadyPaidToCustomer?: boolean;
  };
}

/** Reasons the admin has copy for; anything else falls back to `default`. */
const KNOWN_GATEWAY_REASONS = new Set([
  'NO_COMPLETED_PAYMENT',
  'PAYMENT_FULLY_REFUNDED',
  'PARTIAL_REFUND_EXCEEDS_PAYMENT',
  'PARTIAL_REFUND_NOTHING_TO_REFUND',
  'EXCHANGE_CANNOT_REFUND_TO_GATEWAY',
  'REFUND_ALREADY_ISSUED',
  // Issue 2024: the caller can complete returns but not send a gateway refund.
  'REFUND_PERMISSION_REQUIRED',
]);

function formatCurrency(piastres: number) {
  return formatMoney(piastres, 'en', { fixedDecimals: true });
}

interface RefundMethodModalProps {
  open: boolean;
  storeId: string;
  /** The return being completed; its refund preview is loaded on open. */
  returnId: string | null;
  onConfirm: (method: RefundMethod) => void;
  onClose: () => void;
  isLoading?: boolean;
  /** The store has the customer wallet on: store credit lands in the
   *  customer's wallet balance instead of being settled off-platform. */
  walletEnabled?: boolean;
}

/**
 * Completing a return, in two steps: choose how the customer is refunded, then
 * confirm the exact amount.
 *
 * "Original payment method" sends a real, irreversible refund through the
 * payment provider (#1485). It used to be preselected, with no amount anywhere
 * in the dialog, so the default click moved money the merchant never saw —
 * and on a cash-on-delivery order, where there is no provider payment, the
 * same default click failed (#1474). So: nothing is preselected, every option
 * shows what it would record or send, the gateway option is disabled (with
 * the reason) when the order cannot take it, and nothing is sent until the
 * merchant confirms the amount on a second screen.
 */
export function RefundMethodModal({
  open,
  storeId,
  returnId,
  onConfirm,
  onClose,
  isLoading = false,
  walletEnabled = false,
}: RefundMethodModalProps) {
  const t = useT('returns.modal');
  const [method, setMethod] = useState<RefundMethod | null>(null);
  const [step, setStep] = useState<'choose' | 'confirm'>('choose');
  const [preview, setPreview] = useState<RefundPreview | null>(null);
  const [previewState, setPreviewState] = useState<'loading' | 'ready' | 'error'>('loading');

  // Start every opening from nothing selected, and load what each method
  // would actually move for THIS return.
  useEffect(() => {
    if (!open) return;
    setMethod(null);
    setStep('choose');
    setPreview(null);
    if (!returnId) {
      setPreviewState('error');
      return;
    }
    setPreviewState('loading');
    let cancelled = false;
    apiGet<{ preview: RefundPreview }>(
      `/api/v1/stores/${storeId}/returns/admin/${returnId}/refund-preview`
    )
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error || !data?.preview) {
          setPreviewState('error');
          return;
        }
        setPreview(data.preview);
        setPreviewState('ready');
      })
      .catch(() => {
        if (!cancelled) setPreviewState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [open, storeId, returnId]);

  const gateway = preview?.gateway;
  // The server decides (issue 2003); the reason-code fallback covers an API
  // that predates the flag.
  const alreadyPaid =
    gateway?.alreadyPaidToCustomer ??
    (gateway?.unavailableReason === 'REFUND_ALREADY_ISSUED' ||
      gateway?.unavailableReason === 'PAYMENT_FULLY_REFUNDED');
  const visibleMethods = REFUND_METHODS.filter(m => m !== 'manual' || alreadyPaid);
  // Without a confirmed amount the gateway is never offered.
  const gatewayEnabled = previewState === 'ready' && gateway?.available === true;

  // The server's answer, not the prop: it is what complete() will credit.
  const storeCreditToWallet = preview?.storeCreditToWallet ?? null;

  const amountFor = (value: RefundMethod): number | null => {
    if (!preview) return null;
    if (value === 'original') return gateway?.amount ?? null;
    if (value === 'store_credit' && storeCreditToWallet != null) return storeCreditToWallet;
    return preview.recordedAmount;
  };
  const gatewayReasonKey =
    gateway?.unavailableReason && KNOWN_GATEWAY_REASONS.has(gateway.unavailableReason)
      ? gateway.unavailableReason
      : 'default';

  const chosenAmount = method ? amountFor(method) : null;

  return (
    <Modal isOpen={open} onClose={onClose} title={t('refundMethodTitle')} size="md">
      {step === 'choose' ? (
        <>
          <fieldset className="space-y-3">
            <legend className="block text-sm font-medium text-foreground mb-2">
              {t('refundMethodLabel')}
            </legend>
            {previewState === 'loading' && (
              <p className="text-xs text-muted-foreground">{t('previewLoading')}</p>
            )}
            {previewState === 'error' && (
              <p className="text-xs text-destructive-ink">{t('previewError')}</p>
            )}
            {alreadyPaid && (
              <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive-ink">
                {gateway?.unavailableReason === 'REFUND_ALREADY_ISSUED'
                  ? t('alreadyIssuedNotice')
                  : t('alreadyFullyRefundedNotice')}
              </p>
            )}
            {visibleMethods.map(value => {
              const disabled = value === 'original' && !gatewayEnabled;
              const amount = amountFor(value);
              return (
                <label
                  key={value}
                  className={`flex items-start gap-3 rounded-lg border border-border p-3 has-[:checked]:border-primary has-[:checked]:bg-primary/5 ${
                    disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-muted/50'
                  }`}
                >
                  <input
                    type="radio"
                    name="refundMethod"
                    value={value}
                    checked={method === value}
                    disabled={disabled}
                    onChange={() => setMethod(value)}
                    className="mt-1"
                  />
                  <span className="flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {t(`refundMethodOptions.${value}.label`)}
                      </span>
                      {amount != null && !disabled && (
                        <span className="text-sm font-semibold text-foreground tabular-nums">
                          {formatCurrency(amount)}
                        </span>
                      )}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {value === 'store_credit' && (walletEnabled || storeCreditToWallet != null)
                        ? t('refundMethodOptions.store_credit.descriptionWallet')
                        : t(`refundMethodOptions.${value}.description`)}
                    </span>
                    {value === 'original' && disabled && previewState === 'ready' && (
                      <span className="mt-1 block text-xs text-destructive-ink">
                        {t(`gatewayUnavailable.${gatewayReasonKey}`)}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </fieldset>
          <div className="mt-6 flex justify-end gap-3">
            <Button variant="outline" onClick={onClose} disabled={isLoading}>
              {t('cancel')}
            </Button>
            <Button
              variant="default"
              onClick={() => setStep('confirm')}
              disabled={isLoading || !method || previewState === 'loading'}
            >
              {t('continue')}
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="space-y-3">
            {method === 'original' ? (
              <>
                <p className="text-sm text-foreground">
                  {t('confirmOriginal', { amount: formatCurrency(chosenAmount ?? 0) })}
                </p>
                {(gateway?.walletShare ?? 0) > 0 && (
                  <p className="text-sm text-foreground">
                    {t('confirmOriginalWalletShare', {
                      amount: formatCurrency(gateway?.walletShare ?? 0),
                    })}
                  </p>
                )}
                <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive-ink">
                  {t('confirmIrreversible')}
                </p>
              </>
            ) : method === 'store_credit' && storeCreditToWallet != null ? (
              <p className="text-sm text-foreground">
                {t('confirmWallet', { amount: formatCurrency(storeCreditToWallet) })}
              </p>
            ) : method === 'manual' ? (
              <p className="text-sm text-foreground">
                {t('confirmRecordOnly', {
                  amount: chosenAmount != null ? formatCurrency(chosenAmount) : '—',
                })}
              </p>
            ) : (
              <p className="text-sm text-foreground">
                {t('confirmManual', {
                  amount: chosenAmount != null ? formatCurrency(chosenAmount) : '—',
                  method: method ? t(`refundMethodOptions.${method}.label`) : '',
                })}
              </p>
            )}
          </div>
          <div className="mt-6 flex justify-end gap-3">
            <Button variant="outline" onClick={() => setStep('choose')} disabled={isLoading}>
              {t('back')}
            </Button>
            <Button
              variant={method === 'original' ? 'destructive' : 'default'}
              onClick={() => method && onConfirm(method)}
              disabled={isLoading || !method}
              isLoading={isLoading}
            >
              {method === 'original' ? t('confirmSendRefund') : t('refundMethodConfirm')}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
