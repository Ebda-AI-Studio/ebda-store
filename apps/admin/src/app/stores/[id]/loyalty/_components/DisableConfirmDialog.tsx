'use client';

import { useT } from '@/i18n/useT';
import { Button } from '@/components/ui/Button';

interface DisableConfirmDialogProps {
  saving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Small confirmation dialog shown before turning the loyalty program off.
 * Prevents accidental deactivation which would halt earning/redemption for
 * every customer in the store.
 */
export function DisableConfirmDialog({ saving, onCancel, onConfirm }: DisableConfirmDialogProps) {
  const t = useT('loyalty.disableConfirm');

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-card rounded-xl shadow-xl w-full max-w-sm p-6">
        <h2 className="text-lg font-semibold text-foreground mb-2">{t('title')}</h2>
        <p className="text-sm text-muted-foreground mb-6">{t('description')}</p>
        <div className="flex items-center justify-end gap-3">
          <Button variant="outline" size="md" type="button" onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button
            variant="destructive"
            size="md"
            type="button"
            onClick={onConfirm}
            disabled={saving}
          >
            {t('confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}
