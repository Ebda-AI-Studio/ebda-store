/**
 * CI-13 per-store auto-gating: applyStoreGates writes ONLY the given store's `ci_store_gates` rows from that
 * store's own rows; the platform gate (system_settings) is never touched; the hint service honours the gate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  findMany: vi.fn(),
  upsert: vi.fn(),
  deleteMany: vi.fn(),
  settingUpsert: vi.fn(),
}));
vi.mock('@ebda/database', () => ({
  prisma: {
    ciStoreGate: { findMany: db.findMany, upsert: db.upsert, deleteMany: db.deleteMany },
    systemSetting: { upsert: db.settingUpsert },
  },
  acrossStores: vi.fn(),
}));
vi.mock('../../apps/api/src/services/alerts.service', () => ({ sendAlert: vi.fn() }));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { applyStoreGates } from '../../apps/api/src/services/ci-calibration.service';
import type { CalibrationRow } from '../../apps/api/src/lib/ci/hints/calibration';

const A = '3f6f0a52-6b0a-4c55-8e38-2b2b6b1c8a10';
const B = '9b2f4c1e-0c2e-4c3a-8a4e-0a9c6d7e1f20';
const off = (storeId: string): CalibrationRow => ({
  storeId,
  feature: 'cod_risk',
  band: 'elevated',
  resolved: 40,
  returned: 8,
  predictedSum: 16, // 40% predicted vs 20% actual
});
const fine = (storeId: string): CalibrationRow => ({ ...off(storeId), returned: 16 });

beforeEach(() => {
  vi.clearAllMocks();
  db.findMany.mockResolvedValue([]);
});

describe('applyStoreGates', () => {
  it("closes the feature for this store from this store's own rows", async () => {
    const r = await applyStoreGates(A, [off(A)]);
    expect(r).toEqual({ closed: ['cod_risk'], reopened: [] });
    expect(db.upsert).toHaveBeenCalledTimes(1);
    const arg = db.upsert.mock.calls[0]![0];
    expect(arg.where).toEqual({ storeId_feature: { storeId: A, feature: 'cod_risk' } });
    expect(arg.create).toMatchObject({
      storeId: A,
      feature: 'cod_risk',
      band: 'elevated',
      resolved: 40,
    });
  });

  it("another store's rows in the list never close this store's gate (and never the platform gate)", async () => {
    const r = await applyStoreGates(A, [off(B), fine(A)]);
    expect(r).toEqual({ closed: [], reopened: [] });
    expect(db.upsert).not.toHaveBeenCalled();
    expect(db.settingUpsert).not.toHaveBeenCalled();
  });

  it('reports a feature as closed only the first time; refreshes the numbers while it stays off', async () => {
    db.findMany.mockResolvedValue([{ feature: 'cod_risk' }]);
    const r = await applyStoreGates(A, [off(A)]);
    expect(r).toEqual({ closed: [], reopened: [] });
    expect(db.upsert).toHaveBeenCalledTimes(1);
  });

  it('reopens a paused feature once its own numbers are back within the gap', async () => {
    db.findMany.mockResolvedValue([{ feature: 'cod_risk' }]);
    const r = await applyStoreGates(A, [fine(A)]);
    expect(r).toEqual({ closed: [], reopened: ['cod_risk'] });
    expect(db.deleteMany).toHaveBeenCalledWith({
      where: { storeId: A, feature: { in: ['cod_risk'] } },
    });
  });

  it('reopens when the evidence has aged out (a paused feature logs nothing new)', async () => {
    db.findMany.mockResolvedValue([{ feature: 'cod_risk' }]);
    const r = await applyStoreGates(A, []);
    expect(r.reopened).toEqual(['cod_risk']);
  });

  it('every read and write is keyed by the given store id', async () => {
    db.findMany.mockResolvedValue([{ feature: 'cod_risk' }]);
    await applyStoreGates(A, [fine(A)]);
    expect(db.findMany.mock.calls[0]![0].where).toEqual({ storeId: A });
    expect(db.deleteMany.mock.calls[0]![0].where.storeId).toBe(A);
  });
});
