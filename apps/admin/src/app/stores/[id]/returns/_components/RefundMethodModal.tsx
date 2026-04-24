'use client';

import { useEffect, useState } from 'react';
import { Button, Modal } from '@force/ui';
import { useT } from '@/i18n/useT';

type RefundMethod = 'original' | 'store_credit' | 'bank_transfer';

const REFUND_METHODS: RefundMethod[] = ['original', 'store_credit', 'bank_transfer'];

interface RefundMethodModalProps {
  open: boolean;
  onConfirm: (method: RefundMethod) => void;
  onClose: () => void;
  isLoading?: boolean;
}

/**
 * Structured refund-method picker for completing a return. The previous code
 * collected this via a free-text window.prompt() that asked users to type one
 * of three enum values; this modal exposes the options as radio buttons so the
 * input is always valid.
 */
export function RefundMethodModal({
  open,
  onConfirm,
  onClose,
  isLoading = false,
}: RefundMethodModalProps) {
  const t = useT('returns.modal');
  const [method, setMethod] = useState<RefundMethod>('original');

  // Reset selection on open so the dialog always starts from the default.
  useEffect(() => {
    if (open) {
      setMethod('original');
    }
  }, [open]);

  return (
    <Modal isOpen={open} onClose={onClose} title={t('refundMethodTitle')} size="md">
      <fieldset className="space-y-3">
        <legend className="block text-sm font-medium text-foreground mb-2">
          {t('refundMethodLabel')}
        </legend>
        {REFUND_METHODS.map(value => (
          <label
            key={value}
            className="flex items-start gap-3 rounded-lg border border-border p-3 cursor-pointer hover:bg-muted/50 has-[:checked]:border-primary has-[:checked]:bg-primary/5"
          >
            <input
              type="radio"
              name="refundMethod"
              value={value}
              checked={method === value}
              onChange={() => setMethod(value)}
              className="mt-1"
            />
            <span className="flex-1">
              <span className="block text-sm font-medium text-foreground">
                {t(`refundMethodOptions.${value}.label`)}
              </span>
              <span className="block text-xs text-muted-foreground">
                {t(`refundMethodOptions.${value}.description`)}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="mt-6 flex justify-end gap-3">
        <Button variant="outline" onClick={onClose} disabled={isLoading}>
          {t('cancel')}
        </Button>
        <Button
          variant="default"
          onClick={() => onConfirm(method)}
          disabled={isLoading}
          isLoading={isLoading}
        >
          {t('refundMethodConfirm')}
        </Button>
      </div>
    </Modal>
  );
}
