/**
 * Merchant-facing Customer Intelligence (CI-3, Ruling CI-10). ADVISE, NEVER BLOCK: every function here
 * returns data for a note, a ranking or a card. The checkout, order-create and booking code must not
 * import this module (`tests/unit/ci-hints-no-block.test.ts` greps for it).
 *
 * Callers run inside the request's tenant context (the route's `tenantContext`), so every Prisma read is
 * scoped to the store; a store id that does not resolve throws instead of defaulting.
 */
import { prisma } from '@ebda/database';
import { storeUpdateMany } from '../lib/repo-factory';
import { featureService } from './feature.service';
import { loadHintData } from '../lib/ci/hints/data';
import { codRiskHint, type BuyerHistory, type CodRiskHint } from '../lib/ci/hints/cod-risk';
import { rankCouriers } from '../lib/ci/hints/courier';
import { feeHint } from '../lib/ci/hints/fee';
import {
  allGates,
  gateState,
  storeGateClosed,
  storeGates,
  type CiHintFeature,
} from '../lib/ci/hints/gates';
import { AppError } from '../middleware/error-handler';

/** Never call a hint without the merchant's switch, the platform gate AND this store's own auto-gate (CI-13). */
async function enabled(storeId: string, feature: CiHintFeature): Promise<boolean> {
  if (!(await featureService.isFeatureEnabled(storeId, 'customer_intelligence'))) return false;
  if (!(await gateState(feature)).enabled) return false;
  return !(await storeGateClosed(storeId, feature));
}

async function buyerHistory(
  storeId: string,
  orderId: string,
  buyerKey: string | null
): Promise<BuyerHistory | null> {
  if (!buyerKey) return null;
  const where = { storeId, order: { buyerKey, id: { not: orderId } } };
  const [returned, delivered] = await Promise.all([
    prisma.shipment.count({ where: { ...where, returnedAt: { not: null } } }),
    prisma.shipment.count({ where: { ...where, returnedAt: null, deliveredAt: { not: null } } }),
  ]);
  return { shipped: returned + delivered, returned };
}

export type OrderHintResult =
  | { enabled: false }
  | { enabled: true; applicable: false }
  | { enabled: true; applicable: true; hint: CodRiskHint };

/** COD risk note for one order. Logs the hint (once per order) so calibration can compare it to what happened. */
export async function orderCodRisk(storeId: string, orderId: string): Promise<OrderHintResult> {
  if (!(await enabled(storeId, 'cod_risk'))) return { enabled: false };
  const o = await prisma.order.findFirst({
    where: { id: orderId, storeId },
    select: { areaKey: true, buyerKey: true, payments: { select: { provider: true } } },
  });
  if (!o) throw new AppError(404, 'NOT_FOUND', 'Order not found');
  if (!o.payments.some(p => p.provider === 'cod')) return { enabled: true, applicable: false };

  const data = await loadHintData(storeId);
  const hint = codRiskHint(data, o.areaKey, await buyerHistory(storeId, orderId, o.buyerKey));
  await prisma.ciHintLog.createMany({
    data: [
      {
        storeId,
        orderId,
        feature: 'cod_risk',
        band: hint.band,
        source: hint.source,
        n: hint.n,
        predictedRate: hint.rate,
      },
    ],
    skipDuplicates: true,
  });
  return { enabled: true, applicable: true, hint };
}

export async function courierSuggestion(storeId: string, orderId: string, carriers: string[]) {
  if (!(await enabled(storeId, 'courier'))) return { enabled: false as const };
  const o = await prisma.order.findFirst({
    where: { id: orderId, storeId },
    select: { areaKey: true },
  });
  if (!o) throw new AppError(404, 'NOT_FOUND', 'Order not found');
  const data = await loadHintData(storeId);
  return { enabled: true as const, ...rankCouriers(data, o.areaKey, carriers) };
}

export interface CiOverview {
  hintsEnabled: boolean;
  ciSharing: boolean;
  gates: Array<{ feature: CiHintFeature; enabled: boolean }>;
  /** Features paused for THIS store because its own hints were off (Ruling CI-13). */
  pausedForStore: Array<{
    feature: string;
    band: string;
    predictedRate: number;
    actualRate: number;
    resolved: number;
  }>;
  fee: ReturnType<typeof feeHint> | null;
  aggregates: { storeAsOf: string | null; cohortAsOf: string | null };
  shown30d: Array<{ feature: string; band: string; count: number }>;
}

export async function ciOverview(storeId: string): Promise<CiOverview> {
  const [hintsEnabled, store, gates, paused] = await Promise.all([
    featureService.isFeatureEnabled(storeId, 'customer_intelligence'),
    prisma.store.findFirst({ where: { id: storeId }, select: { ciSharing: true } }),
    allGates(),
    storeGates(storeId),
  ]);
  if (!store) throw new AppError(404, 'NOT_FOUND', 'Store not found');
  const data = await loadHintData(storeId);
  const feeOpen =
    hintsEnabled &&
    (gates.find(g => g.feature === 'fee')?.enabled ?? true) &&
    !paused.some(p => p.feature === 'fee');
  const since = new Date(Date.now() - 30 * 86_400_000);
  const rows = await prisma.ciHintLog.groupBy({
    by: ['feature', 'band'],
    where: { storeId, createdAt: { gte: since } },
    _count: { _all: true },
  });
  return {
    hintsEnabled,
    ciSharing: store.ciSharing,
    gates: gates.map(g => ({ feature: g.feature, enabled: g.enabled })),
    pausedForStore: paused.map(({ closedAt: _closedAt, ...p }) => p),
    fee: feeOpen ? feeHint(data) : null,
    aggregates: { storeAsOf: data.window?.asOf ?? null, cohortAsOf: data.cohort?.asOf ?? null },
    shown30d: rows.map(r => ({ feature: r.feature, band: r.band, count: r._count._all })),
  };
}

export async function setCiSharing(storeId: string, ciSharing: boolean): Promise<void> {
  const r = await storeUpdateMany(prisma, {
    where: { id: storeId },
    data: { ciSharing, ciSharingChangedAt: new Date() },
  });
  if (r.count === 0) throw new AppError(404, 'NOT_FOUND', 'Store not found');
}
