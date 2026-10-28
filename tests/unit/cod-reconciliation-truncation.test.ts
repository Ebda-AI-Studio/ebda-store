/**
 * M-101 (Ruling P18-4): the COD reconciliation report no longer reconciles a silently truncated set.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  shipments: vi.fn(),
  remittances: vi.fn(),
}));
vi.mock('@ebda/database', () => ({
  prisma: {
    shipment: { findMany: mocks.shipments },
    codRemittance: { findMany: mocks.remittances, createMany: vi.fn() },
  },
}));

import {
  codReconciliationService,
  COD_REPORT_MAX_SHIPMENTS,
  COD_REPORT_MAX_LINES,
} from '@api/services/cod-reconciliation.service';

const shipment = (i: number) => ({
  id: `s${i}`,
  orderId: `o${i}`,
  carrier: 'bosta',
  carrierName: 'Bosta',
  trackingNumber: `T${i}`,
  status: 'delivered',
  codAmount: 1000,
  statusHistory: [],
  order: { orderNumber: `N${i}` },
});
const line = (i: number) => ({
  id: `l${i}`,
  shipmentId: null,
  carrier: 'bosta',
  trackingNumber: `T${i}`,
  batchId: null,
  grossAmount: 1000,
  feeAmount: 0,
  netAmount: 1000,
  remittedAt: new Date('2026-10-01T00:00:00Z'),
  source: 'csv',
});

describe('getReport caps', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks for one row more than the cap so a capped read is detectable', async () => {
    mocks.shipments.mockResolvedValue([]);
    mocks.remittances.mockResolvedValue([]);
    await codReconciliationService.getReport('store-1');
    expect(mocks.shipments.mock.calls[0][0].take).toBe(COD_REPORT_MAX_SHIPMENTS + 1);
    expect(mocks.remittances.mock.calls[0][0].take).toBe(COD_REPORT_MAX_LINES + 1);
  });

  it('a complete report has totals and no truncation flag', async () => {
    mocks.shipments.mockResolvedValue([shipment(1), shipment(2)]);
    mocks.remittances.mockResolvedValue([line(1)]);
    const r = await codReconciliationService.getReport('store-1');
    expect(r.truncated).toBeNull();
    expect(r.summary).not.toBeNull();
    expect(r.total).toBe(2);
  });

  it('a report that hit the shipment cap says so and shows no totals (unknown is not zero)', async () => {
    mocks.shipments.mockResolvedValue(
      Array.from({ length: COD_REPORT_MAX_SHIPMENTS + 1 }, (_, i) => shipment(i))
    );
    mocks.remittances.mockResolvedValue([]);
    const r = await codReconciliationService.getReport('store-1', { limit: 100 });
    expect(r.truncated).toEqual({ shipments: true, lines: false });
    expect(r.summary).toBeNull();
    expect(r.total).toBe(COD_REPORT_MAX_SHIPMENTS); // the extra probe row is not reported
  });

  it('a report that hit the remittance-line cap says so too', async () => {
    mocks.shipments.mockResolvedValue([shipment(1)]);
    mocks.remittances.mockResolvedValue(
      Array.from({ length: COD_REPORT_MAX_LINES + 1 }, (_, i) => line(i))
    );
    const r = await codReconciliationService.getReport('store-1');
    expect(r.truncated).toEqual({ shipments: false, lines: true });
    expect(r.summary).toBeNull();
  });

  it('exactly at the cap is complete', async () => {
    mocks.shipments.mockResolvedValue(
      Array.from({ length: COD_REPORT_MAX_SHIPMENTS }, (_, i) => shipment(i))
    );
    mocks.remittances.mockResolvedValue([]);
    const r = await codReconciliationService.getReport('store-1');
    expect(r.truncated).toBeNull();
    expect(r.summary).not.toBeNull();
  });
});
