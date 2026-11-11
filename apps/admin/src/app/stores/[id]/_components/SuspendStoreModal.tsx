'use client';

import { Modal } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';

interface SuspendStoreModalProps {
  isOpen: boolean;
  storeName: string;
  isChangingStatus: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function SuspendStoreModal({
  isOpen,
  storeName,
  isChangingStatus,
  onClose,
  onConfirm,
}: SuspendStoreModalProps) {
  const t = useT('stores.dashboard.suspendModal');
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('title')}>
      <p className="text-sm text-muted-foreground">{t('message', { name: storeName })}</p>
      <div className="mt-6 flex justify-end gap-3">
        <Button variant="outline" onClick={onClose} disabled={isChangingStatus}>
          {t('cancel')}
        </Button>
        <Button variant="destructive" onClick={onConfirm} disabled={isChangingStatus}>
          {isChangingStatus ? t('confirming') : t('confirm')}
        </Button>
      </div>
    </Modal>
  );
}
