import { prisma } from '@ebda/database';

/**
 * Durable "this owner deletion was claimed" marker (STORE-LIFECYCLE-1 follow-up). The request lives in the store's own settings,
 * which are GONE once the delete commits, so a post-commit step that throws would leave the retry with nothing: it saw a missing
 * store, skipped the STORE_DELETED_BY_OWNER audit and the "executed" email and the leftover post-commit steps. The marker is a
 * platform `system_settings` row (like `tax.change.<storeId>`), written when the executor claims the request and removed once the
 * audit + email are done; the retry that finds the store missing but the marker present finishes the job.
 */
export interface DeletionMarker {
  requestId: string;
  requestedBy: string;
  slug: string;
  storeName: string;
  ownerId: string;
  onDo: boolean;
  /** Recoveries already queued for a committed delete whose post-commit steps kept failing (capped). */
  recoveries?: number;
}
const key = (storeId: string) => `store.deletion.claimed.${storeId}`;

// ONE prisma site: `system_settings` is a D1-routed platform model (services/platform/router.ts), like tax-change-purge.
const settings = () => prisma.systemSetting;

export async function writeDeletionMarker(storeId: string, m: DeletionMarker): Promise<void> {
  await settings().upsert({
    where: { key: key(storeId) },
    create: { key: key(storeId), value: m as never },
    update: { value: m as never },
  });
}
export async function readDeletionMarker(storeId: string): Promise<DeletionMarker | null> {
  const row = await settings().findUnique({
    where: { key: key(storeId) },
    select: { value: true },
  });
  return row ? (row.value as unknown as DeletionMarker) : null;
}
export async function clearDeletionMarker(storeId: string): Promise<void> {
  await settings().deleteMany({ where: { key: key(storeId) } });
}
