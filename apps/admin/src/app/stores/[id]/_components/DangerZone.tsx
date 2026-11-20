'use client';

import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { StoreStatusControl } from '@/components/store-status/StoreStatusControl';

interface DangerZoneProps {
  onRequestDelete: () => void;
  /** Store status; suspend / reinstate sits here, away from the everyday actions (UX:D-4). */
  storeId: string;
  storeName: string;
  status: string;
  onStatusChanged: () => void | Promise<void>;
}

// Visually distinct red-bordered card. Rendered only for super_admin
// (the parent enforces that), so store admins never see it.
export function DangerZone({
  onRequestDelete,
  storeId,
  storeName,
  status,
  onStatusChanged,
}: DangerZoneProps) {
  const t = useT('stores.dashboard.dangerZone');

  return (
    <div className="mt-8">
      <h2 className="mb-4 font-semibold text-destructive-ink">{t('title')}</h2>
      <div className="rounded-xl border-2 border-destructive/40 bg-destructive/5 p-6 shadow-sm">
        {/* Suspend / Reinstate: super_admin only. PATCH /stores/:id/status also enforces super_admin + MFA
            server-side, so hiding it here is defence in depth, not the only gate. */}
        <div className="mb-6 border-b border-destructive/20 pb-6">
          <StoreStatusControl
            storeId={storeId}
            storeName={storeName}
            status={status}
            onChanged={onStatusChanged}
          />
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
            <Button variant="destructive" onClick={onRequestDelete}>
              {t('deleteButton')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
