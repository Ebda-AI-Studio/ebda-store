'use client';

import { Modal } from '@ebda/ui';
import { Button } from '@/components/ui/Button';

interface ConfirmActionModalProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  variant?: 'default' | 'destructive';
  onConfirm: () => void;
  onClose: () => void;
  isLoading?: boolean;
}

/**
 * Reusable styled confirmation modal. Replaces native window.confirm() with an
 * accessible dialog that supports an optional destructive variant. The shared
 * @ebda/ui Modal handles the dialog/aria-modal/labelledby wiring, ESC key,
 * backdrop click, and focus trap; we just compose the content + actions.
 */
export function ConfirmActionModal({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  variant = 'default',
  onConfirm,
  onClose,
  isLoading = false,
}: ConfirmActionModalProps) {
  return (
    <Modal isOpen={open} onClose={onClose} title={title} size="sm">
      <p className="text-sm text-muted-foreground">{description}</p>
      <div className="mt-6 flex justify-end gap-3">
        <Button variant="outline" onClick={onClose} disabled={isLoading}>
          {cancelLabel}
        </Button>
        <Button
          variant={variant === 'destructive' ? 'destructive' : 'default'}
          onClick={onConfirm}
          disabled={isLoading}
          isLoading={isLoading}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
