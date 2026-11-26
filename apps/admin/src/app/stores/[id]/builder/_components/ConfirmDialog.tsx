'use client';

/**
 * A small in-app confirmation (never `window.confirm`: it is unstyled, not
 * translated by us, and blocks the iframe). A native `<dialog>` so focus is
 * trapped, Escape cancels, and focus returns to what opened it.
 */
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { useRestoreFocus } from '../_lib/use-restore-focus';

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  tone = 'danger',
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  /** `danger` for a removal (the default), `primary` for a safe, reversible choice. */
  tone?: 'danger' | 'primary';
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT('builder.canvasOps');
  useRestoreFocus();
  return (
    <dialog
      ref={el => {
        if (el && !el.open) el.showModal();
      }}
      onCancel={onCancel}
      onClose={onCancel}
      aria-labelledby="confirm-title"
      aria-describedby="confirm-body"
      className="w-[min(26rem,calc(100vw-2rem))] rounded-lg border border-border bg-card p-0 text-foreground backdrop:bg-black/60"
      data-testid="confirm-dialog"
    >
      <div className="space-y-2 p-5">
        <h2 id="confirm-title" className="text-base font-semibold">
          {title}
        </h2>
        <p id="confirm-body" className="text-sm text-muted-foreground">
          {body}
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <Button
            variant="ghost"
            type="button"
            onClick={onCancel}
            autoFocus
            data-testid="confirm-cancel"
          >
            {t('cancel')}
          </Button>
          <Button
            variant={tone === 'danger' ? 'destructive' : 'default'}
            type="button"
            onClick={onConfirm}
            data-testid="confirm-ok"
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
