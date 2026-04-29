'use client';

import { useEffect, useState } from 'react';
import { Button, Input, Modal } from '@force/ui';
import { useT } from '@/i18n/useT';

interface DeleteStoreModalProps {
  isOpen: boolean;
  storeName: string;
  isDeleting: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function DeleteStoreModal({
  isOpen,
  storeName,
  isDeleting,
  onClose,
  onConfirm,
}: DeleteStoreModalProps) {
  const t = useT('stores.dashboard.dangerZone');
  const [typed, setTyped] = useState('');

  // Reset the typed value whenever the modal opens/closes so a previous
  // attempt's input doesn't unlock the next one.
  useEffect(() => {
    if (!isDeleting) setTyped('');
  }, [isOpen, isDeleting]);

  const matches = typed.trim() === storeName.trim() && typed.length > 0;

  return (
    <Modal isOpen={isOpen} onClose={isDeleting ? () => {} : onClose} title={t('modalTitle')}>
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('modalBody', { name: storeName })}</p>

        <div>
          <label
            htmlFor="delete-store-confirm-input"
            className="mb-2 block text-sm font-medium text-foreground"
          >
            {t('typeNameLabel', { name: storeName })}
          </label>
          <Input
            id="delete-store-confirm-input"
            value={typed}
            onChange={e => setTyped(e.target.value)}
            placeholder={t('typeNamePlaceholder')}
            disabled={isDeleting}
            autoComplete="off"
            // dir auto so the typed string follows the user's input direction
            // even though the page chrome may be RTL.
            dir="auto"
          />
        </div>
      </div>

      <div className="mt-6 flex justify-end gap-3">
        <Button variant="outline" onClick={onClose} disabled={isDeleting}>
          {t('cancelButton')}
        </Button>
        <Button
          variant="destructive"
          onClick={onConfirm}
          disabled={!matches || isDeleting}
          aria-disabled={!matches || isDeleting}
        >
          {isDeleting ? t('deleting') : t('confirmButton')}
        </Button>
      </div>
    </Modal>
  );
}
