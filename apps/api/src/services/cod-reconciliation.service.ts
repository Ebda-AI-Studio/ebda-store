/**
 * COD reconciliation (SP7): the `cod_remittances` ledger plus the per-shipment match.
 *
 * Remittance lines are facts (what a carrier's settlement statement says); whether a shipment
 * is settled, partial or mismatched is COMPUTED from them on every read by the pure matcher in
 * `lib/cod-reconciliation.ts`, so it can never go stale. Both methods run inside the caller's
 * store scope (the admin routes' tenant context).
 */
import { prisma } from '@ebda/database';
import { storeDb, storeStock } from '../lib/repo-factory';
import { inngest } from '../lib/inngest/client';
import logger from '../lib/logger';
import { AppError } from '../middleware/error-handler';
import {
  parseSettlementCsv,
  reconcileShipment,
  summarize,
  type ReconResult,
  type ReconStatus,
  type ReconSummary,
} from '../lib/cod-reconciliation';

/** Largest statement accepted in one upload. */
export const MAX_SETTLEMENT_ROWS = 5000;

export interface ReconRow {
  shipmentId: string;
  orderId: string;
  orderNumber: string;
  carrier: string;
  carrierName: string | null;
  trackingNumber: string | null;
  shipmentStatus: string;
  deliveredAt: string | null;
  lines: Array<{
    id: string;
    grossAmount: number;
    feeAmount: number;
    netAmount: number;
    remittedAt: string;
    batchId: string | null;
    source: string;
  }>;
  result: ReconResult;
}

/** Most rows one report reads; past it the report says so instead of reconciling a partial set (M-101). */
export const COD_REPORT_MAX_SHIPMENTS = 5000;
export const COD_REPORT_MAX_LINES = 20000;

export interface ReconReport {
  /** `null` when the report was capped: totals over a partial set would read as truth (unknown, not zero). */
  summary: ReconSummary | null;
  /** Which read hit its cap, or `null` when the report is complete. */
  truncated: { shipments: boolean; lines: boolean } | null;
  rows: ReconRow[];
  total: number;
  unmatched: Array<{
    id: string;
    carrier: string;
    trackingNumber: string;
    grossAmount: number;
    feeAmount: number;
    netAmount: number;
    remittedAt: string;
  }>;
}

export class CodReconciliationService {
  /**
   * Import a carrier's COD settlement statement (CSV). Idempotent: a line already imported
   * (same reference, or same tracking/date/amounts) is counted as a duplicate and changes
   * nothing. A line for a tracking number the store does not know is kept as `unmatched` and
   * shown, never dropped; it matches as soon as that shipment exists.
   */
  async importSettlement(
    storeId: string,
    carrier: string,
    csv: string,
    opts: { source?: string } = {}
  ) {
    if (!carrier)
      throw new AppError(400, 'INVALID_CARRIER', 'Choose the carrier of this statement');
    const parsed = parseSettlementCsv(csv, carrier);
    if (parsed.rows.length > MAX_SETTLEMENT_ROWS) {
      throw new AppError(
        413,
        'STATEMENT_TOO_LARGE',
        `At most ${MAX_SETTLEMENT_ROWS} lines per upload`
      );
    }
    if (parsed.rows.length === 0) {
      return {
        inserted: 0,
        duplicates: 0,
        unmatched: 0,
        settled: [],
        flagged: [],
        rejected: parsed.rejected,
      };
    }

    // A store on its Durable Object keeps its remittance lines there, beside the shipments they reference (Ruling CF-R7-2):
    // matching and insert are one section, so a line never points at a shipment that is not in the store.
    const stock = await storeStock(storeId);
    if (stock) {
      const r = await stock.importCodRemittances({
        carrier,
        source: opts.source ?? 'csv',
        rows: parsed.rows.map(x => ({
          trackingNumber: x.trackingNumber,
          lineRef: x.lineRef,
          batchId: x.batchId ?? null,
          grossAmount: x.grossAmount,
          feeAmount: x.feeAmount,
          netAmount: x.netAmount,
          remittedAt: x.remittedAt,
        })),
      });
      // S3-O7: the same post-payment fan-out as a COD order paid on delivery (journal posting); idempotent per order.
      for (const o of r.settled)
        inngest
          .send({
            name: 'order/created',
            data: { orderId: o.orderId, storeId, paymentMethod: 'cod', locale: undefined },
          })
          .catch((err: unknown) =>
            logger.error({ err, orderId: o.orderId }, '[cod-statement] fan-out enqueue failed')
          );
      return { ...r, rejected: parsed.rejected };
    }

    const trackings = [...new Set(parsed.rows.map(r => r.trackingNumber))];
    const shipments = await (
      await storeDb(storeId)
    ).shipment.findMany({
      where: { storeId, carrier, trackingNumber: { in: trackings } },
      select: { id: true, trackingNumber: true },
    });
    const byTracking = new Map(shipments.map(s => [s.trackingNumber as string, s.id]));

    const created = await prisma.codRemittance.createMany({
      data: parsed.rows.map(r => ({
        storeId,
        shipmentId: byTracking.get(r.trackingNumber) ?? null,
        carrier,
        trackingNumber: r.trackingNumber,
        lineRef: r.lineRef,
        batchId: r.batchId ?? null,
        grossAmount: r.grossAmount,
        feeAmount: r.feeAmount,
        netAmount: r.netAmount,
        remittedAt: r.remittedAt,
        source: opts.source ?? 'csv',
      })),
      skipDuplicates: true,
    });
    return {
      inserted: created.count,
      duplicates: parsed.rows.length - created.count,
      unmatched: parsed.rows.filter(r => !byTracking.has(r.trackingNumber)).length,
      // S3-O7 settles on the StoreDO only (Postgres is removed in production); the same shape keeps the two backends in parity
      settled: [],
      flagged: [],
      rejected: parsed.rejected,
    };
  }

  /** Every COD shipment of the store with its match, the store totals, and unmatched lines. */
  async getReport(
    storeId: string,
    opts: { carrier?: string; status?: ReconStatus | 'flagged'; page?: number; limit?: number } = {}
  ): Promise<ReconReport> {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 25));

    const [shipmentsRead, linesRead] = await Promise.all([
      (await storeDb(storeId)).shipment.findMany({
        where: {
          storeId,
          status: { notIn: ['creation_failed', 'creating'] },
          OR: [{ codAmount: { gt: 0 } }, { codRemittances: { some: {} } }],
          ...(opts.carrier ? { carrier: opts.carrier } : {}),
        },
        select: {
          id: true,
          orderId: true,
          carrier: true,
          carrierName: true,
          trackingNumber: true,
          status: true,
          codAmount: true,
          statusHistory: true,
          order: { select: { orderNumber: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: COD_REPORT_MAX_SHIPMENTS + 1,
      }),
      (await storeDb(storeId)).codRemittance.findMany({
        where: { storeId, ...(opts.carrier ? { carrier: opts.carrier } : {}) },
        orderBy: { remittedAt: 'asc' },
        take: COD_REPORT_MAX_LINES + 1,
      }),
    ]);
    const capped = {
      shipments: shipmentsRead.length > COD_REPORT_MAX_SHIPMENTS,
      lines: linesRead.length > COD_REPORT_MAX_LINES,
    };
    const shipments = shipmentsRead.slice(0, COD_REPORT_MAX_SHIPMENTS);
    const lines = linesRead.slice(0, COD_REPORT_MAX_LINES);

    // A line belongs to its shipment by id, or (when it was imported before the shipment
    // existed) by carrier + tracking number.
    const idOf = new Map(shipments.map(s => [s.id, s.id]));
    const byTracking = new Map(
      shipments.filter(s => s.trackingNumber).map(s => [`${s.carrier}|${s.trackingNumber}`, s.id])
    );
    const linesOf = new Map<string, typeof lines>();
    const unmatched: typeof lines = [];
    for (const l of lines) {
      const sid =
        (l.shipmentId && idOf.get(l.shipmentId)) ||
        byTracking.get(`${l.carrier}|${l.trackingNumber}`);
      if (!sid) {
        unmatched.push(l);
        continue;
      }
      const arr = linesOf.get(sid) ?? [];
      arr.push(l);
      linesOf.set(sid, arr);
    }

    const all: ReconRow[] = shipments.map(s => {
      const own = linesOf.get(s.id) ?? [];
      const history = Array.isArray(s.statusHistory) ? (s.statusHistory as any[]) : [];
      const delivered = [...history].reverse().find(h => h?.status === 'delivered');
      return {
        shipmentId: s.id,
        orderId: s.orderId,
        orderNumber: s.order.orderNumber,
        carrier: s.carrier,
        carrierName: s.carrierName,
        trackingNumber: s.trackingNumber,
        shipmentStatus: s.status,
        deliveredAt: delivered?.timestamp ?? null,
        lines: own.map(l => ({
          id: l.id,
          grossAmount: l.grossAmount,
          feeAmount: l.feeAmount,
          netAmount: l.netAmount,
          remittedAt: l.remittedAt.toISOString(),
          batchId: l.batchId,
          source: l.source,
        })),
        result: reconcileShipment({ expected: s.codAmount, shipmentStatus: s.status, lines: own }),
      };
    });

    const isTruncated = capped.shipments || capped.lines;
    const summary = isTruncated
      ? null
      : summarize(
          all.map(r => r.result),
          unmatched
        );
    const filtered = all.filter(r =>
      !opts.status
        ? true
        : opts.status === 'flagged'
          ? r.result.flagged
          : r.result.status === opts.status
    );
    return {
      summary,
      truncated: isTruncated ? capped : null,
      rows: filtered.slice((page - 1) * limit, page * limit),
      total: filtered.length,
      unmatched: unmatched.map(l => ({
        id: l.id,
        carrier: l.carrier,
        trackingNumber: l.trackingNumber,
        grossAmount: l.grossAmount,
        feeAmount: l.feeAmount,
        netAmount: l.netAmount,
        remittedAt: l.remittedAt.toISOString(),
      })),
    };
  }
}

export const codReconciliationService = new CodReconciliationService();
