'use client';

import { Button } from '@ebda/ui';
import { useT } from '@/i18n/useT';

interface DangerZoneProps {
  isDeleting: boolean;
  onRequestDelete: () => void;
}

// Visually distinct red-bordered card. Rendered only for super_admin
// (the parent enforces that), so store admins never see it.
export function DangerZone({ isDeleting, onRequestDelete }: DangerZoneProps) {
  const t = useT('stores.dashboard.dangerZone');

  return (
    <div className="mt-8">
      <h2 className="mb-4 font-semibold text-destructive-ink">{t('title')}</h2>
      <div className="rounded-xl border-2 border-destructive/40 bg-destructive/5 p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex-1">
            <p className="text-sm font-medium text-foreground">{t('description')}</p>
            <ul className="mt-3 list-disc space-y-1 ps-5 text-sm text-muted-foreground">
              <li>{t('bulletData')}</li>
              <li>{t('bulletIrreversible')}</li>
            </ul>
          </div>
          <div className="shrink-0">
            <Button
              variant="destructive"
              onClick={onRequestDelete}
              disabled={isDeleting}
              aria-disabled={isDeleting}
            >
              {t('deleteButton')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
