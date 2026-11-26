import { d1All, onD1 } from './platform/billing-d1';

/**
 * The atomic claim of a pending VAT change request (self-service A10). On the platform D1 the prisma-lite `deleteMany` is a
 * SELECT of the primary keys followed by a DELETE per key, so two concurrent claims BOTH see the row and both report
 * `count: 1` (measured on real D1 in workers-do/tax-change-claim-d1.test.ts). One `DELETE ... RETURNING` is a single statement
 * and only one caller gets the row back. On Postgres (not the hub's home any more) `deleteMany` is a real DELETE with a real
 * count, so the caller keeps its prisma path (`null` here).
 */
export async function claimPendingChangeD1(
  key: string,
  requestId: string
): Promise<boolean | null> {
  if (!(await onD1('platform'))) return null;
  const rows = await d1All<{ id: string }>(
    `DELETE FROM system_settings WHERE key = ?1 AND json_extract(value, '$.id') = ?2 RETURNING id`,
    key,
    requestId
  );
  return rows.length > 0;
}
