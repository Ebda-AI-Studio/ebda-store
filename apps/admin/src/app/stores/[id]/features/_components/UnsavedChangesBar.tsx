'use client';

import { useT } from '@/i18n/useT';

interface UnsavedChangesBarProps {
  dirtyCount: number;
  saving: boolean;
  onDiscard: () => void;
  onSave: () => void;
}

export function UnsavedChangesBar({
  dirtyCount,
  saving,
  onDiscard,
  onSave,
}: UnsavedChangesBarProps) {
  const t = useT('features');

  return (
    <div className="sticky bottom-4 z-10">
      <div className="bg-card border border-border rounded-xl shadow-lg px-6 py-4 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {t('actions.unsavedChangesBanner')}{' '}
          <span className="font-semibold text-foreground">
            {t('actions.unsavedChanges', { count: dirtyCount })}
          </span>
        </p>
        <div className="flex items-center gap-3">
          <button
            onClick={onDiscard}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium text-foreground border border-border rounded-lg hover:bg-muted transition-colors disabled:opacity-50"
          >
            {t('actions.discard')}
          </button>
          <button
            onClick={onSave}
            disabled={saving}
            className="px-6 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {saving && (
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
            )}
            {t('actions.saveChanges')}
          </button>
        </div>
      </div>
    </div>
  );
}
