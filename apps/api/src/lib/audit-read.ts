/**
 * Audit rows of one resource, read where the store's audit trail LIVES (NEON-ZERO N-10d): a store on its Durable Object keeps
 * them in its StoreDO (the DO has no `users` table, so `user` is null there); a Postgres store keeps them in Postgres, read
 * in the request's tenant scope with the actor joined.
 */
import { prisma } from '@ebda/database';
import { storeRepo } from './repo-factory';

export interface AuditByResource {
  id: string;
  action: string;
  details: unknown;
  createdAt: Date;
  user: { firstName: string | null; lastName: string | null; role?: string | null } | null;
}

export async function readAuditByResource(
  storeId: string,
  resourceType: string,
  resourceId: string,
  take = 200
): Promise<AuditByResource[]> {
  const where = { storeId, resourceType, resourceId };
  const repo = await storeRepo(storeId);
  if (repo.backend === 'do') {
    const rows = await repo.db.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
    });
    return rows.map(r => ({
      id: r.id,
      action: r.action,
      details: r.details,
      createdAt: r.createdAt,
      user: null,
    }));
  }
  return prisma.auditLog.findMany({
    where,
    include: { user: { select: { firstName: true, lastName: true, role: true } } },
    orderBy: { createdAt: 'desc' },
    take,
  });
}
