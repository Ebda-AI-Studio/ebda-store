'use client';

import { Modal } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import type { Product } from './types';

interface DeleteProductModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  product: Product | null;
  deleting: boolean;
}

export function DeleteProductModal({
  isOpen,
  onClose,
  onConfirm,
  product,
  deleting,
}: DeleteProductModalProps) {
  const t = useT('products.list.deleteModal');

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('title')}>
      <p className="text-sm text-muted-foreground">
        {t('messageBefore')} <strong>{product?.name ?? ''}</strong> {t('messageAfter')}
      </p>
      <div className="mt-6 flex justify-end gap-3">
        <Button variant="outline" onClick={onClose} disabled={deleting}>
          {t('cancel')}
        </Button>
        <Button variant="destructive" onClick={onConfirm} disabled={deleting}>
          {deleting ? t('deleting') : t('confirm')}
        </Button>
      </div>
    </Modal>
  );
}
