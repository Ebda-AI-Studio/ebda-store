'use client';

import { useEffect, useState } from 'react';
import { Modal } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';

interface RejectReasonModalProps {
  open: boolean;
  onConfirm: (reason: string) => void;
  onClose: () => void;
  isLoading?: boolean;
}

/**
 * Free-text reason input for rejecting a return. Replaces the native
 * window.prompt() that was previously used. The parent owns the open state
 * and resolves the reason promise via onConfirm/onClose.
 */
export function RejectReasonModal({
  open,
  onConfirm,
  onClose,
  isLoading = false,
}: RejectReasonModalProps) {
  const t = useT('returns.modal');
  const [reason, setReason] = useState('');

  // Reset the textarea each time the modal is opened so a stale value from a
  // previous interaction doesn't carry over.
  useEffect(() => {
    if (open) {
      setReason('');
    }
  }, [open]);

  const submit = () => {
    const trimmed = reason.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
  };

  return (
    <Modal isOpen={open} onClose={onClose} title={t('rejectTitle')} size="md">
      <div className="space-y-4">
        <label className="block text-sm font-medium text-foreground">
          {t('rejectLabel')}
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder={t('rejectPlaceholder')}
            rows={4}
            className="mt-1 w-full rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            autoFocus
          />
        </label>
      </div>
      <div className="mt-6 flex justify-end gap-3">
        <Button variant="outline" onClick={onClose} disabled={isLoading}>
          {t('cancel')}
        </Button>
        <Button
          variant="destructive"
          onClick={submit}
          disabled={isLoading || !reason.trim()}
          isLoading={isLoading}
        >
          {t('rejectConfirm')}
        </Button>
      </div>
    </Modal>
  );
}
