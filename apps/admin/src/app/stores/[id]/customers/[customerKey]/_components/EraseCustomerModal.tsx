'use client';

import { useEffect, useState } from 'react';
import { Input, Modal } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';

interface EraseCustomerModalProps {
  isOpen: boolean;
  /** The exact string the merchant must type to unlock the confirm button. */
  confirmValue: string;
  isErasing: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

/**
 * Type-to-confirm modal for merchant-initiated customer erasure
 * (`POST /stores/:storeId/customers/:customerId/erase`). Mirrors
 * `DeleteStoreModal`'s type-the-name pattern — irreversible PII
 * anonymization deserves the same friction as deleting a whole store.
 */
export function EraseCustomerModal({
  isOpen,
  confirmValue,
  isErasing,
  onClose,
  onConfirm,
}: EraseCustomerModalProps) {
  const t = useT('customers.detail.privacy');
  const [typed, setTyped] = useState('');

  // Reset the typed value whenever the modal opens/closes so a previous
  // attempt's input doesn't unlock the next one.
  useEffect(() => {
    if (!isErasing) setTyped('');
  }, [isOpen, isErasing]);

  const matches = typed.trim() === confirmValue.trim() && typed.length > 0;

  return (
    <Modal isOpen={isOpen} onClose={isErasing ? () => {} : onClose} title={t('eraseModalTitle')}>
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('eraseModalBody')}</p>
        <p className="text-sm font-medium text-destructive-ink">{t('eraseModalWarning')}</p>

        <div>
          <label
            htmlFor="erase-customer-confirm-input"
            className="mb-2 block text-sm font-medium text-foreground"
          >
            {t('typeToConfirmLabel', { value: confirmValue })}
          </label>
          <Input
            id="erase-customer-confirm-input"
            value={typed}
            onChange={e => setTyped(e.target.value)}
            placeholder={confirmValue}
            disabled={isErasing}
            autoComplete="off"
            dir="ltr"
          />
        </div>
      </div>

      <div className="mt-6 flex justify-end gap-3">
        <Button variant="outline" onClick={onClose} disabled={isErasing}>
          {t('cancelButton')}
        </Button>
        <Button
          variant="destructive"
          onClick={onConfirm}
          disabled={!matches || isErasing}
          aria-disabled={!matches || isErasing}
          isLoading={isErasing}
        >
          {isErasing ? t('erasing') : t('confirmEraseButton')}
        </Button>
      </div>
    </Modal>
  );
}
