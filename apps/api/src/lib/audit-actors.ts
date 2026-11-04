/**
 * Audit rows of one resource WITH the display name of the user who acted (NEON-ZERO-1, Ruling NZ-A-3).
 *
 * `AuditLog.user` is a join to `User`, which lives in the identity service: a store on its Durable Object cannot join it. On
 * Postgres the join is unchanged (one query, same select). On a DO store the rows are read from the DO and the names come from
 * ONE identity call (`getAccountsBrief`); an actor the identity service no longer knows (erased) reads as no user, exactly
 * like the `userId` of an erased user did on the join.
 */
import type { AuditLog } from '@ebda/database';
import { storeDb, storeMoney } from './repo-factory';
import { getAccountsBrief } from './identity-client';

export type AuditActor = { firstName: string; lastName: string; role: string };
export type AuditRowWithActor = AuditLog & { user: AuditActor | null };

export async function listAuditWithActors(
  storeId: string,
  where: { resourceType: string; resourceId: string },
  take: number
): Promise<AuditRowWithActor[]> {
  const db = await storeDb(storeId);
  const base = { where: { storeId, ...where }, orderBy: { createdAt: 'desc' as const }, take };
  if (!(await storeMoney(storeId))) {
    return (await db.auditLog.findMany({
      ...base,
      include: { user: { select: { firstName: true, lastName: true, role: true } } },
    })) as unknown as AuditRowWithActor[];
  }
  const rows = (await db.auditLog.findMany(base)) as AuditLog[];
  const ids = [...new Set(rows.map(r => r.userId).filter((x): x is string => !!x))];
  const briefs = new Map((ids.length ? await getAccountsBrief(ids) : []).map(b => [b.id, b]));
  return rows.map(r => {
    const b = r.userId ? briefs.get(r.userId) : undefined;
    return {
      ...r,
      user: b ? { firstName: b.firstName, lastName: b.lastName, role: b.role } : null,
    };
  });
}
