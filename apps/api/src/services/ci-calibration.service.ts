import { acrossStores, prisma } from '@ebda/database';
import logger from '../lib/logger';
import {
  evaluateCalibration,
  type CalibrationResult,
  type CalibrationRow,
} from '../lib/ci/hints/calibration';
import { CI_HINT_FEATURES } from '../lib/ci/hints/gates';
import { sendAlert } from './alerts.service';

const DAY = 86_400_000;
const chunk = <T>(xs: T[], n: number) =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** One store: stamp what happened to the hints still waiting (by order id, never a scan), then sum the resolved ones. */
export async function resolveAndSummarise(
  storeId: string,
  now = new Date()
): Promise<CalibrationRow[]> {
  const open = await prisma.ciHintLog.findMany({
    where: { storeId, outcome: null, createdAt: { gte: new Date(now.getTime() - 120 * DAY) } },
    select: { id: true, orderId: true },
    take: 2000,
  });
  const byOrder = new Map(open.map(o => [o.orderId, o.id]));
  for (const orders of chunk([...byOrder.keys()], 100)) {
    const ships = await prisma.shipment.findMany({
      where: {
        storeId,
        orderId: { in: orders },
        OR: [{ returnedAt: { not: null } }, { deliveredAt: { not: null } }],
      },
      select: { orderId: true, returnedAt: true },
    });
    const returned = ships.filter(s => s.returnedAt).map(s => byOrder.get(s.orderId)!);
    const delivered = ships.filter(s => !s.returnedAt).map(s => byOrder.get(s.orderId)!);
    if (returned.length)
      await prisma.ciHintLog.updateMany({
        where: { storeId, id: { in: returned } },
        data: { outcome: 'returned', outcomeAt: now },
      });
    if (delivered.length)
      await prisma.ciHintLog.updateMany({
        where: { storeId, id: { in: delivered } },
        data: { outcome: 'delivered', outcomeAt: now },
      });
  }
  // Retention (docs/RETENTION.md): hint logs live 400 days.
  await prisma.ciHintLog.deleteMany({
    where: { storeId, createdAt: { lt: new Date(now.getTime() - 400 * DAY) } },
  });
  const done = await prisma.ciHintLog.findMany({
    where: {
      storeId,
      outcome: { not: null },
      predictedRate: { not: null },
      createdAt: { gte: new Date(now.getTime() - 90 * DAY) },
    },
    select: { feature: true, band: true, predictedRate: true, outcome: true },
    take: 20_000,
  });
  const rows = new Map<string, CalibrationRow>();
  for (const d of done) {
    const k = `${d.feature}|${d.band}`;
    const r = rows.get(k) ?? {
      storeId,
      feature: d.feature,
      band: d.band,
      resolved: 0,
      returned: 0,
      predictedSum: 0,
    };
    r.resolved += 1;
    r.returned += d.outcome === 'returned' ? 1 : 0;
    r.predictedSum += d.predictedRate ?? 0;
    rows.set(k, r);
  }
  return [...rows.values()];
}

export interface CalibrationDeps {
  collect(): Promise<CalibrationRow[]>;
  alert(feature: string, reason: string): Promise<unknown>;
}

const defaultDeps: CalibrationDeps = {
  async collect() {
    const per = await acrossStores(id => resolveAndSummarise(id), {
      onStoreError: (storeId, err) =>
        logger.error({ err, storeId }, '[ci-calibration] store failed'),
    });
    return per.flatMap(p => p.value);
  },
  alert: (feature, reason) =>
    sendAlert({
      level: 'p1',
      scope: 'platform',
      source: 'ci.calibration_off',
      title: `Customer Intelligence hint "${feature}" is mis-calibrated: review the gate`,
      body: reason,
    }),
};

/** Weekly: evaluate every band; ALERT for any feature with a band off by more than 10 points. The platform gate is never closed here (Ruling CI-11). */
export async function runCalibration(
  deps: CalibrationDeps = defaultDeps
): Promise<{ results: CalibrationResult[]; alerted: string[] }> {
  const results = evaluateCalibration(await deps.collect());
  const alerted: string[] = [];
  for (const feature of CI_HINT_FEATURES) {
    const off = results.filter(r => r.feature === feature && r.off);
    if (off.length === 0) continue;
    const reason = off
      .map(
        r =>
          `${r.band}: predicted ${(r.predicted! * 100).toFixed(1)}% vs actual ${(r.actual! * 100).toFixed(1)}% over ${r.resolved} hints`
      )
      .join('; ');
    await deps.alert(feature, reason);
    alerted.push(feature);
  }
  return { results, alerted };
}
