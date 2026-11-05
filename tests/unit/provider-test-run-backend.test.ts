/**
 * runTestForStore records the connection-test result on the store's OWN backend (Durable Object or Postgres) through
 * storeDb / storeWriter, for a payment gateway and for a shipping carrier. There is no 501 for a DO store any more.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const stored = { ok: true, code: 'ok', mode: 'sandbox', at: '2026-11-04T10:00:00.000Z' };
  return {
    stored,
    backend: 'pg' as 'pg' | 'do',
    row: null as Record<string, unknown> | null,
    writes: [] as Array<{ backend: string; model: string; args: any }>,
    carrierTest: vi.fn(),
  };
});

vi.mock('@ebda/database', () => ({
  prisma: new Proxy(
    {},
    {
      get: () => {
        throw new Error('direct prisma use');
      },
    }
  ),
  Prisma: {},
  acrossStoresFlat: vi.fn(),
  asPlatformOperator: vi.fn(),
  runInStoreScope: (_id: string, fn: () => unknown) => fn(),
  storeDirectory: vi.fn(),
  withStore: (_id: string, fn: () => unknown) => fn(),
}));
vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeDb: async () => ({
    paymentConfig: { findFirst: async () => h.row },
    shippingCarrierConfig: { findUnique: async () => h.row },
  }),
  storeWriter: async () => ({
    paymentConfig: {
      update: async (args: unknown) => {
        h.writes.push({ backend: h.backend, model: 'paymentConfig', args });
        h.row = { ...h.row, connectionTest: h.stored };
      },
    },
  }),
}));
vi.mock('../../apps/api/src/middleware/security', () => ({
  auditLog: vi.fn(async () => undefined),
}));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../apps/api/src/services/alerts.service', () => ({ sendAlert: vi.fn() }));
vi.mock('../../apps/api/src/services/email-queue.service', () => ({
  emailQueue: { add: vi.fn() },
}));
vi.mock('../../apps/api/src/services/payment.service', () => ({
  PaymentService: { clearCache: vi.fn() },
}));
vi.mock('../../apps/api/src/services/shipping-carrier.service', () => ({
  shippingCarrierService: {
    invalidateCarrierConfigCache: vi.fn(async () => undefined),
    testConnection: (...a: unknown[]) => h.carrierTest(...a),
  },
}));
vi.mock('../../apps/api/src/services/carriers/carrier-connection.service', () => ({
  carrierTestIsCurrent: () => true,
  carrierTestLooksCurrent: () => true,
}));
vi.mock('../../apps/api/src/services/payment-providers/provider-connection.service', () => ({
  connectionTestIsCurrent: () => true,
  connectionTestLooksCurrent: () => true,
  runConnectionTest: async () => ({ result: { ok: true, code: 'ok' }, stored: h.stored }),
}));

import { runTestForStore } from '../../apps/api/src/services/provider-activation.service';
import { getProviderEntry } from '@ebda/shared';

const actor = { userId: 'admin-1' };
const payProvider = 'paymob';
const carrierProvider = 'bosta';

beforeEach(() => {
  h.writes = [];
  h.row = null;
  h.carrierTest.mockReset();
});

describe('runTestForStore', () => {
  it('catalog fixtures are the kinds the tests assume', () => {
    expect(getProviderEntry(payProvider)?.kind).toBe('payments');
    expect(getProviderEntry(carrierProvider)?.kind).toBe('shipping');
  });

  for (const backend of ['pg', 'do'] as const) {
    it(`payments on a ${backend} store: the result is written through storeWriter and read back`, async () => {
      h.backend = backend;
      h.row = { id: 'pc1', storeId: 's1', provider: payProvider, connectionTest: null };
      const last = await runTestForStore('s1', payProvider, actor);
      expect(h.writes).toHaveLength(1);
      expect(h.writes[0]!.args.where).toEqual({ id: 'pc1', storeId: 's1' });
      expect(h.writes[0]!.args.data).toMatchObject({
        connectionTest: h.stored,
        healthStatus: 'healthy',
        updatedBy: 'admin-1',
      });
      expect(last).toMatchObject({ ok: true, code: 'ok', mode: 'sandbox' });
    });

    it(`payments on a ${backend} store without saved credentials is a 404, nothing written`, async () => {
      h.backend = backend;
      await expect(runTestForStore('s1', payProvider, actor)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(h.writes).toHaveLength(0);
    });

    it(`a carrier on a ${backend} store delegates to the carrier service (which persists via storeWriter)`, async () => {
      h.backend = backend;
      h.row = { id: 'sc1', storeId: 's1', carrier: carrierProvider, connectionTest: h.stored };
      const last = await runTestForStore('s1', carrierProvider, actor);
      expect(h.carrierTest).toHaveBeenCalledWith('s1', carrierProvider);
      expect(last.ok).toBe(true);
    });
  }
});
