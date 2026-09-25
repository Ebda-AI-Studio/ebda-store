'use client';

/**
 * Generic in-page confirm dialog for the campaigns editor/detail pages
 * (delete draft, send now, schedule, cancel a scheduled/sending campaign).
 * Modeled on `loyalty/_components/DisableConfirmDialog.tsx` but takes its
 * copy as props so one component covers every confirm step here instead of
 * `window.confirm` (never used in this app).
 */
interface ConfirmDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  saving?: boolean;
  /** Destructive red confirm button (delete/cancel). Defaults to true. */
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel,
  saving = false,
  danger = true,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-card rounded-xl shadow-xl w-full max-w-sm p-6">
        <h2 className="text-lg font-semibold text-foreground mb-2">{title}</h2>
        <p className="text-sm text-muted-foreground mb-6 whitespace-pre-line">{description}</p>
        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="px-4 py-2 text-sm text-foreground border border-border rounded-lg hover:bg-muted disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={saving}
            className={
              danger
                ? 'px-4 py-2 text-sm bg-destructive text-white rounded-lg hover:bg-destructive/90 disabled:opacity-50'
                : 'px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50'
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
