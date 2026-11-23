'use client';

import { useEffect, useId, useState } from 'react';
import { Modal } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import {
  MANUAL_REFUND_METHODS,
  manualRefundDescriptionKey,
  type ManualRefundInput,
  type ManualRefundMethod,
} from '../app/stores/[id]/orders/_components/manualRefundCopy';

interface ManualRefundModalProps {
  open: boolean;
  /** The order's current status — picks the description copy (issue 2140). */
  orderStatus: string | null | undefined;
  /**
   * Records the refund. Resolves to null on success (the modal closes) or to the message to
   * show inside the dialog (a 403 for staff, a 409 REFUND_NOT_RECORDED, ...).
   */
  onConfirm: (input: ManualRefundInput) => Promise<string | null>;
  onClose: () => void;
}

/**
 * "Refunded" status confirm. It records a refund the merchant has ALREADY paid out, so it asks
 * how they paid it (and an optional reference) and says plainly that no money is sent.
 */
export function ManualRefundModal({
  open,
  orderStatus,
  onConfirm,
  onClose,
}: ManualRefundModalProps) {
  const t = useT('orders.list.confirm');
  const methodId = useId();
  const refId = useId();
  const [method, setMethod] = useState<ManualRefundMethod>('cash');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setMethod('cash');
      setReference('');
      setError(null);
    }
  }, [open]);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const message = await onConfirm({ method, reference });
      if (message) setError(message);
      else onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const field =
    'mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground';

  return (
    <Modal isOpen={open} onClose={onClose} title={t('manualRefundTitle')} size="sm">
      <p className="text-sm text-muted-foreground">{t(manualRefundDescriptionKey(orderStatus))}</p>
      {/* a partial / per-line refund (with restock, and for guest orders too) lives in the order page's menu, not here */}
      <p className="mt-2 text-sm text-muted-foreground">{t('manualRefundPartialHint')}</p>

      <div className="mt-4 space-y-3">
        <div>
          <label htmlFor={methodId} className="text-sm font-medium text-foreground">
            {t('refundMethodLabel')}
          </label>
          <select
            id={methodId}
            value={method}
            onChange={e => setMethod(e.target.value as ManualRefundMethod)}
            disabled={submitting}
            className={field}
          >
            {MANUAL_REFUND_METHODS.map(m => (
              <option key={m} value={m}>
                {t(`refundMethods.${m}`)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={refId} className="text-sm font-medium text-foreground">
            {t('refundReferenceLabel')}
          </label>
          <input
            id={refId}
            type="text"
            value={reference}
            maxLength={120}
            onChange={e => setReference(e.target.value)}
            placeholder={t('refundReferencePlaceholder')}
            disabled={submitting}
            className={field}
          />
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive-ink">
          {error}
        </p>
      )}

      <div className="mt-6 flex justify-end gap-3">
        <Button variant="outline" onClick={onClose} disabled={submitting}>
          {t('cancel')}
        </Button>
        <Button variant="destructive" onClick={submit} disabled={submitting} isLoading={submitting}>
          {t('confirm')}
        </Button>
      </div>
    </Modal>
  );
}
