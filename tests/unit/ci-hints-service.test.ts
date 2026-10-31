/** The hint service: both switches, COD only, tenant-scoped lookups that throw, one log row per order. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  feature: vi.fn(),
  gate: vi.fn(),
  order: vi.fn(),
  shipCount: vi.fn(),
  createMany: vi.fn(),
  load: vi.fn(),
  storeGate: vi.fn(),
  storeGates: vi.fn(),
}));
vi.mock('@ebda/database', () => ({
  prisma: {
    order: { findFirst: h.order },
    shipment: { count: h.shipCount },
    ciHintLog: { createMany: h.createMany },
  },
}));
vi.mock('../../apps/api/src/services/feature.service', () => ({
  featureService: { isFeatureEnabled: h.feature },
}));
vi.mock('../../apps/api/src/lib/ci/hints/gates', () => ({
  gateState: h.gate,
  allGates: vi.fn(),
  storeGateClosed: h.storeGate,
  storeGates: h.storeGates,
}));
vi.mock('../../apps/api/src/lib/ci/hints/data', () => ({ loadHintData: h.load }));

import { courierSuggestion, orderCodRisk } from '../../apps/api/src/services/ci-hints.service';

const ST = '3f6f0a52-6b0a-4c55-8e38-2b2b6b1c8a10';
const OR = '0d8ea0f4-5a47-4c7d-9a49-6ff3d3b8f6a1';
const NOW = new Date('2026-11-10T09:00:00Z');
const cohort = (cell: unknown) => ({
  window: null,
  now: NOW,
  cohort: {
    v: 1,
    asOf: '2026-11-09',
    windowDays: 90,
    metrics: {
      return_rate: {
        '*|*': { n: 1000, hit: 100, sum: 0, stores: 8, maxShare: 0.2 },
        '*|EG-C': cell,
      },
      delivery_hours: {},
      cod_confirmation: {},
      cod_return_by_amount: {},
    },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  h.feature.mockResolvedValue(true);
  h.gate.mockResolvedValue({ enabled: true });
  h.storeGate.mockResolvedValue(false);
  h.storeGates.mockResolvedValue([]);
});

describe('orderCodRisk', () => {
  it('is off when the merchant switch or the platform gate is off, and reads nothing then', async () => {
    h.feature.mockResolvedValueOnce(false);
    expect(await orderCodRisk(ST, OR)).toEqual({ enabled: false });
    h.gate.mockResolvedValueOnce({ enabled: false });
    expect(await orderCodRisk(ST, OR)).toEqual({ enabled: false });
    expect(h.order).not.toHaveBeenCalled();
  });

  it("is off when THIS store's own auto-gate is closed, and reads nothing then (CI-13)", async () => {
    h.storeGate.mockResolvedValueOnce(true);
    expect(await orderCodRisk(ST, OR)).toEqual({ enabled: false });
    expect(h.storeGate).toHaveBeenCalledWith(ST, 'cod_risk');
    expect(h.order).not.toHaveBeenCalled();
  });

  it('an order that is not in this store throws 404 (never defaults)', async () => {
    h.order.mockResolvedValue(null);
    await expect(orderCodRisk(ST, OR)).rejects.toMatchObject({ statusCode: 404 });
    expect(h.order).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: OR, storeId: ST } })
    );
  });

  it('a prepaid order has no COD note', async () => {
    h.order.mockResolvedValue({
      areaKey: 'EG-C',
      buyerKey: null,
      payments: [{ provider: 'paymob' }],
    });
    expect(await orderCodRisk(ST, OR)).toEqual({ enabled: true, applicable: false });
    expect(h.createMany).not.toHaveBeenCalled();
  });

  it('a COD order gets a band, logged once with its n, and the buyer history is read inside the store', async () => {
    h.order.mockResolvedValue({
      areaKey: 'EG-C',
      buyerKey: 'ab'.padEnd(64, 'c'),
      payments: [{ provider: 'cod' }],
    });
    h.load.mockResolvedValue(cohort({ n: 400, hit: 60, sum: 0, stores: 8, maxShare: 0.2 }));
    h.shipCount.mockResolvedValue(0);
    const r = await orderCodRisk(ST, OR);
    expect(r).toMatchObject({
      enabled: true,
      applicable: true,
      hint: { band: 'elevated', n: 400 },
    });
    expect(h.shipCount.mock.calls[0]![0].where).toMatchObject({ storeId: ST });
    expect(h.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          storeId: ST,
          orderId: OR,
          feature: 'cod_risk',
          band: 'elevated',
          n: 400,
        }),
      ],
      skipDuplicates: true,
    });
  });
});

describe('courierSuggestion', () => {
  it('returns a ranking only while both switches are on', async () => {
    h.feature.mockResolvedValueOnce(false);
    expect(await courierSuggestion(ST, OR, ['bosta'])).toEqual({ enabled: false });
    h.order.mockResolvedValue({ areaKey: 'EG-C' });
    h.load.mockResolvedValue({ window: null, cohort: null, now: NOW });
    expect(await courierSuggestion(ST, OR, ['bosta'])).toEqual({
      enabled: true,
      ranked: [{ carrier: 'bosta', status: 'insufficient' }],
      suggested: null,
    });
    h.order.mockResolvedValue(null);
    await expect(courierSuggestion(ST, OR, ['bosta'])).rejects.toMatchObject({ statusCode: 404 });
  });
});
