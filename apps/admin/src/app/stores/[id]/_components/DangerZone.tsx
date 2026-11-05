'use client';

import { Button } from '@ebda/ui';
import { useT } from '@/i18n/useT';

interface DangerZoneProps {
  onRequestDelete: () => void;
  /** Store status; suspend / activate sits here, away from the everyday actions (UX:D-4). */
  status: string;
  isChangingStatus: boolean;
  onRequestSuspend: () => void;
  onActivate: () => void;
}

// Visually distinct red-bordered card. Rendered only for super_admin
// (the parent enforces that), so store admins never see it.
export function DangerZone({
  onRequestDelete,
  status,
  isChangingStatus,
  onRequestSuspend,
  onActivate,
}: DangerZoneProps) {
  const t = useT('stores.dashboard.dangerZone');
  const tq = useT('stores.dashboard.quickActions');

  return (
    <div className="mt-8">
      <h2 className="mb-4 font-semibold text-destructive-ink">{t('title')}</h2>
      <div className="rounded-xl border-2 border-destructive/40 bg-destructive/5 p-6 shadow-sm">
        {/* Suspend / Activate: super_admin only. PATCH /stores/:id/status also enforces authorize('super_admin')
            server-side, so hiding it here is defence in depth, not the only gate. */}
        <div className="mb-6 flex flex-col gap-3 border-b border-destructive/20 pb-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex-1">
            <p className="text-sm font-medium text-foreground">
              {status === 'active' ? tq('suspend') : tq('activate')}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {status === 'active' ? tq('suspendDescription') : tq('activateDescription')}
            </p>
          </div>
          <div className="shrink-0">
            <Button
              variant={status === 'active' ? 'destructive' : 'outline'}
              onClick={status === 'active' ? onRequestSuspend : onActivate}
              disabled={isChangingStatus}
              isLoading={isChangingStatus}
            >
              {status === 'active' ? tq('suspend') : tq('activate')}
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex-1">
            <p className="text-sm font-medium text-foreground">{t('description')}</p>
            <ul className="mt-3 list-disc space-y-1 ps-5 text-sm text-muted-foreground">
              <li>{t('bulletData')}</li>
              <li>{t('bulletIrreversible')}</li>
            </ul>
          </div>
          <div className="shrink-0">
            <Button variant="destructive" className="min-h-11" onClick={onRequestDelete}>
              {t('deleteButton')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
