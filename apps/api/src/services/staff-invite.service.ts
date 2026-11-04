/**
 * Pending staff invitations vs the plan's seats (Ruling ID-13). On a downgrade (a plan assigned to the store, or a plan's
 * maxStaff lowered) the invitations that no longer fit the free seats are expired, oldest kept. Accepting re-checks the seat
 * limit atomically anyway; this keeps the owner's pending list and the links honest.
 */
import { withStore } from '@ebda/database';
import { inAccessScope, onAccessD1 } from './platform/access-d1';
import { countUsage } from './plan-limit.service';
import { getEntitlements } from './plan-entitlements';

export async function expireInvitesBeyondSeats(storeId: string): Promise<number> {
  // After the `access` cutover only the invitations are touched inside the scope; entitlements and the seat count are read
  // outside it (no Postgres transaction is opened for a D1 family).
  const d1 = await onAccessD1();
  const pre = d1
    ? {
        e: await getEntitlements(storeId),
        used: (await countUsage(storeId, 'maxStaff')) ?? 0,
      }
    : null;
  return inAccessScope(storeId, async tx => {
    const e = pre ? pre.e : await getEntitlements(storeId, tx);
    const limit = e?.limits.maxStaff;
    if (typeof limit !== 'number') return 0; // unlimited (null) or unknown store
    const used = pre ? pre.used : ((await countUsage(storeId, 'maxStaff', tx)) ?? 0);
    const free = Math.max(0, limit - used);
    const pending = await tx.staffInvite.findMany({
      where: { storeId, status: 'pending', expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    const drop = pending.slice(free).map(p => p.id);
    if (drop.length === 0) return 0;
    const r = await tx.staffInvite.updateMany({
      where: { id: { in: drop }, storeId, status: 'pending' },
      data: { status: 'expired', decidedAt: new Date() },
    });
    return r.count;
  });
}
