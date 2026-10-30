import { acrossStores, prisma } from '@ebda/database';
import logger from '../lib/logger';
import {
  evaluateCalibration,
  evaluateStoreGates,
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

/**
 * Per-store auto-gating (Ruling CI-13). Runs inside the store's own tenant scope with that store's rows
 * only: a feature whose OWN hints were off by more than 10 points (>= 30 resolved) gets a `ci_store_gates`
 * row, which pauses that feature for that store alone; a paused feature whose own numbers are no longer off
 * (or have aged out of the 90-day window, since a paused feature logs nothing new) is reopened. Never writes
 * the platform gate and never reads another store.
 */
export async function applyStoreGates(
  storeId: string,
  rows: CalibrationRow[]
): Promise<{ closed: string[]; reopened: string[] }> {
  const verdicts = evaluateStoreGates(rows.filter(r => r.storeId === storeId));
  const existing = await prisma.ciStoreGate.findMany({
    where: { storeId },
    select: { feature: true },
    take: 50,
  });
  const paused = new Set(existing.map(e => e.feature));
  const closed: string[] = [];
  for (const v of verdicts.filter(x => x.off)) {
    const data = {
      band: v.band!,
      predictedRate: v.predicted!,
      actualRate: v.actual!,
      resolved: v.resolved,
    };
    await prisma.ciStoreGate.upsert({
      where: { storeId_feature: { storeId, feature: v.feature } },
      create: { storeId, feature: v.feature, ...data },
      update: data,
    });
    if (!paused.has(v.feature)) closed.push(v.feature);
  }
  const stillOff = new Set(verdicts.filter(v => v.off).map(v => v.feature));
  const reopened = [...paused].filter(f => !stillOff.has(f));
  if (reopened.length) {
    await prisma.ciStoreGate.deleteMany({ where: { storeId, feature: { in: reopened } } });
  }
  if (closed.length || reopened.length) {
    logger.info({ storeId, closed, reopened }, '[ci-calibration] store gate changed');
  }
  return { closed, reopened };
}

export interface CalibrationDeps {
  collect(): Promise<CalibrationRow[]>;
  alert(feature: string, reason: string): Promise<unknown>;
}

const defaultDeps: CalibrationDeps = {
  async collect() {
    const per = await acrossStores(
      async id => {
        const rows = await resolveAndSummarise(id);
        // One store's gating failing must not lose its rows for the platform check.
        await applyStoreGates(id, rows).catch(err =>
          logger.error({ err, storeId: id }, '[ci-calibration] store gate failed')
        );
        return rows;
      },
      {
        onStoreError: (storeId, err) =>
          logger.error({ err, storeId }, '[ci-calibration] store failed'),
      }
    );
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
