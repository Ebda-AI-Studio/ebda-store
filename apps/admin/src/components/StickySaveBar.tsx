'use client';

import { useEffect } from 'react';
import { Button } from '@ebda/ui';
import { useT } from '@/i18n/useT';

interface StickySaveBarProps {
  /** The form has unsaved changes. The bar renders nothing while this is false. */
  dirty: boolean;
  onSave: () => void;
  onReset: () => void;
  saving?: boolean;
  /** Optional outcome label: "احفظ الشحن" beats a page of identical "حفظ" buttons (rule 9). */
  saveLabel?: string;
}

/**
 * Edit forms longer than one screen (rule 5): one Save per page, shown only while dirty, sitting above the mobile
 * bottom nav (`--bottom-chrome`). Also warns before the tab closes with unsaved changes.
 */
export function StickySaveBar({
  dirty,
  onSave,
  onReset,
  saving = false,
  saveLabel,
}: StickySaveBarProps) {
  const t = useT('components.stickySaveBar');

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (!dirty) return null;
  return (
    <div
      role="region"
      aria-label={t('regionLabel')}
      className="fixed inset-x-0 bottom-[calc(var(--bottom-chrome))] z-30 border-t border-border bg-card/95 px-4 py-3 shadow-lg backdrop-blur-md lg:start-72"
    >
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-foreground" role="status">
          {t('dirtyMessage')}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onReset} disabled={saving}>
            {t('reset')}
          </Button>
          <Button onClick={onSave} disabled={saving} isLoading={saving}>
            {saveLabel ?? t('save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
