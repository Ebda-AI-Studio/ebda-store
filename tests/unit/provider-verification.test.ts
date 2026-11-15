/**
 * Ruling PROVIDERS-3: first real use of an unverified provider pages ops, N successes flip it to
 * verified with evidence, and bookkeeping never throws into the money path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  prior: null as null | { id: string },
  counters: {
    provider: 'paymob',
    successCount: 1,
    failureCount: 0,
    verifiedAt: null as Date | null,
  },
  verifiedRows: [] as Array<{ provider: string }>,
  flipCount: 1,
  events: [] as unknown[],
  upsertThrows: false,
  alerts: [] as Array<Record<string, unknown>>,
}));

vi.mock('@ebda/database', () => ({
  prisma: {
    providerVerification: {
      findMany: vi.fn(async () => h.verifiedRows),
      upsert: vi.fn(async () => {
        if (h.upsertThrows) throw new Error('db down');
        return h.counters;
      }),
      updateMany: vi.fn(async () => ({ count: h.flipCount })),
    },
    providerVerificationEvent: {
      findFirst: vi.fn(async () => h.prior),
      create: vi.fn(async (a: unknown) => {
        h.events.push(a);
      }),
      findMany: vi.fn(async () => []),
      groupBy: vi.fn(async () => h.storeGroups),
    },
  },
  withStore: vi.fn(async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({ store: { findFirst: async () => ({ name: 'Shop', slug: 'shop' }) } })
  ),
}));
vi.mock('@api/services/alerts.service', () => ({
  sendAlert: vi.fn(async (o: Record<string, unknown>) => {
    h.alerts.push(o);
    return 'sent';
  }),
}));

import { prisma } from '@ebda/database';
import {
  confirmProviderVerification,
  recordPaymentSettled,
  recordProviderOperation,
  reportConnectionCheck,
  resetProviderVerificationCache,
  isProviderVerified,
} from '@api/services/provider-verification.service';

const op = (over: Record<string, unknown> = {}) => ({
  storeId: 'store-1',
  provider: 'paymob',
  op: 'payment_confirmed' as const,
  ok: true,
  ref: 'pay-1',
  mode: 'live' as const,
  ...over,
});
const stores = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ sourceStoreId: `store-${i + 1}` }));

beforeEach(() => {
  h.prior = null;
  h.counters = {
    provider: 'paymob',
    successCount: 1,
    failureCount: 0,
    readyAt: null,
    verifiedAt: null,
  };
  h.storeGroups = [];
  h.verifiedRows = [];
  h.flipCount = 1;
  h.events = [];
  h.alerts = [];
  h.upsertThrows = false;
  delete process.env.PROVIDER_AUTO_VERIFY_AFTER;
  resetProviderVerificationCache();
});

describe('recordProviderOperation', () => {
  it('pages ops (P1, store scope) on the FIRST real use of an unverified provider, with the outcome', async () => {
    await recordProviderOperation(op());
    const a = h.alerts.find(x => x.level === 'p1')!;
    expect(a.scope).toBe('store');
    expect(a.source).toBe('provider.unverified.first_use');
    expect(JSON.stringify(a)).toContain('paymob');
    expect(JSON.stringify(a)).toContain('SUCCESS');
    expect(h.events).toHaveLength(1);
  });

  it('does not page again for a later success of the same store', async () => {
    h.prior = { id: 'e1' };
    await recordProviderOperation(op());
    expect(h.alerts).toHaveLength(0);
  });

  it('pages on every failure while unverified and carries the error code, not a body', async () => {
    h.prior = { id: 'e1' };
    await recordProviderOperation(op({ ok: false, errorCode: 'PROVIDER_TIMEOUT' }));
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0].source).toBe('provider.unverified.failure');
    expect(JSON.stringify(h.alerts[0])).toContain('PROVIDER_TIMEOUT');
  });

  it('becomes READY (not verified) once N DISTINCT stores settled live operations; alerts info once', async () => {
    h.prior = { id: 'e1' };
    h.storeGroups = stores(3);
    await recordProviderOperation(op());
    expect(h.alerts.map(a => a.source)).toEqual(['provider.ready_to_verify']);
    const db = (await import('@ebda/database')).prisma as unknown as {
      providerVerification: { updateMany: { mock: { calls: Array<[{ data: object }]> } } };
    };
    const data = db.providerVerification.updateMany.mock.calls.at(-1)![0].data;
    expect(data).toHaveProperty('readyAt');
    expect(data).not.toHaveProperty('verifiedAt');
  });

  it('N successes from ONE store never make it ready', async () => {
    h.prior = { id: 'e1' };
    h.storeGroups = stores(1);
    for (let i = 0; i < 5; i++) await recordProviderOperation(op());
    expect(h.alerts).toHaveLength(0);
  });

  it('sandbox successes do not count', async () => {
    h.prior = { id: 'e1' };
    h.storeGroups = stores(3);
    await recordProviderOperation(op({ mode: 'sandbox' }));
    expect(h.alerts).toHaveLength(0);
    const ev = h.events.at(-1) as { data: { counted: boolean; mode: string } };
    expect(ev.data).toMatchObject({ counted: false, mode: 'sandbox' });
  });

  it('an unsettled operation (invoice created only) does not count, even live', async () => {
    h.prior = { id: 'e1' };
    h.storeGroups = stores(3);
    await recordProviderOperation(op({ op: 'create_payment' }));
    expect(h.alerts).toHaveLength(0);
    expect((h.events.at(-1) as { data: { counted: boolean } }).data.counted).toBe(false);
  });

  it('a live settled success is recorded as counted evidence with its mode and store', async () => {
    h.prior = { id: 'e1' };
    await recordProviderOperation(op({ storeId: 'store-9' }));
    expect((h.events.at(-1) as { data: object }).data).toMatchObject({
      counted: true,
      mode: 'live',
      sourceStoreId: 'store-9',
      op: 'payment_confirmed',
    });
  });

  it('first-use and failure alerts keep firing while only READY, until a super admin confirms', async () => {
    h.counters = { ...h.counters, readyAt: new Date() };
    h.prior = { id: 'e1' };
    await recordProviderOperation(op({ ok: false, errorCode: 'X_FAIL' }));
    expect(h.alerts.map(a => a.source)).toEqual(['provider.unverified.failure']);
  });

  it('a confirmed (verified_at) provider is ignored entirely', async () => {
    h.verifiedRows = [{ provider: 'paymob' }];
    await recordProviderOperation(op({ ok: false }));
    expect(h.alerts).toHaveLength(0);
  });

  it('ignores catalog-verified (kashier), manual (cod) and unknown providers entirely', async () => {
    for (const provider of ['kashier', 'cod', 'instapay', 'nope']) {
      await recordProviderOperation(op({ provider }));
    }
    expect(h.alerts).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it('never throws into the money path when bookkeeping fails', async () => {
    h.upsertThrows = true;
    await expect(recordProviderOperation(op())).resolves.toBeUndefined();
  });
});

describe('isProviderVerified', () => {
  it('catalog-verified and manual are verified; unverified is not until confirmed', async () => {
    expect(await isProviderVerified('kashier')).toBe(true);
    expect(await isProviderVerified('cod')).toBe(true);
    expect(await isProviderVerified('paymob')).toBe(false);
    resetProviderVerificationCache();
    h.verifiedRows = [{ provider: 'paymob' }];
    expect(await isProviderVerified('paymob')).toBe(true);
    expect(await isProviderVerified('nope')).toBe(false);
  });
});

describe('reportConnectionCheck', () => {
  it('pages only for an unrecognised answer, because the merchant is told support was informed', async () => {
    await reportConnectionCheck({
      storeId: 's',
      provider: 'paymob',
      mode: 'sandbox',
      code: 'bad_credentials',
    });
    await reportConnectionCheck({
      storeId: 's',
      provider: 'paymob',
      mode: 'sandbox',
      code: 'unreachable',
    });
    expect(h.alerts).toHaveLength(0);
    await reportConnectionCheck({
      storeId: 's',
      provider: 'paymob',
      mode: 'sandbox',
      code: 'unknown',
    });
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0].level).toBe('p1');
  });
});

describe('confirmProviderVerification (super admin only sets verified_at)', () => {
  it('confirms a READY provider', async () => {
    h.flipCount = 1;
    const r = await confirmProviderVerification('paymob', 'admin-1');
    expect(r.provider).toBe('paymob');
    expect(r.verifiedAt).toMatch(/T/);
  });
  it('refuses a provider that is not ready (or already confirmed)', async () => {
    h.flipCount = 0;
    await expect(confirmProviderVerification('paymob', 'admin-1')).rejects.toMatchObject({
      code: 'NOT_READY',
    });
  });
  it('refuses unknown, manual and catalog-verified providers', async () => {
    await expect(confirmProviderVerification('nope', 'a')).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(confirmProviderVerification('cod', 'a')).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(confirmProviderVerification('kashier', 'a')).rejects.toMatchObject({
      code: 'ALREADY_VERIFIED',
    });
  });
});

describe('recordPaymentSettled (one evidence call for the confirm AND webhook paths)', () => {
  it('records a live settled payment_confirmed event for the store (counted)', async () => {
    h.prior = { id: 'e1' };
    // the mode lookup runs withStore(...) -> mocked store tx has no paymentConfig => sandbox,
    // so the evidence is recorded but NOT counted until the connection is live
    await recordPaymentSettled({ storeId: 'store-7', provider: 'paymob', paymentId: 'pay-7' });
    const ev = h.events.at(-1) as { data: { op: string; sourceStoreId: string; ref: string } };
    expect(ev.data).toMatchObject({
      op: 'payment_confirmed',
      sourceStoreId: 'store-7',
      ref: 'pay-7',
    });
  });
  it('is a no-op for a catalog-verified provider', async () => {
    await recordPaymentSettled({ storeId: 'store-7', provider: 'kashier', paymentId: 'p' });
    expect(h.events).toHaveLength(0);
  });
});

// On the platform D1, prisma-lite updateMany is a SELECT of keys then a write per key, so two concurrent claims can BOTH
// report count 1 (measured on Miniflare). The stand-in below reproduces that flaw; the claim lock must still let exactly
// one caller through.
describe('concurrent claims on a D1-style non-atomic updateMany', () => {
  const nonAtomic = () =>
    vi.mocked(prisma.providerVerification.updateMany).mockImplementation((async () => {
      await new Promise(r => setTimeout(r, 5));
      return { count: 1 };
    }) as never);

  it('two concurrent super-admin confirms: exactly one succeeds, the other is 409', async () => {
    nonAtomic();
    const results = await Promise.allSettled([
      confirmProviderVerification('paymob', 'admin-1'),
      confirmProviderVerification('paymob', 'admin-2'),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ statusCode: 409, code: 'NOT_READY' });
  });

  it('two concurrent live successes reaching the threshold send ONE ready-to-verify alert', async () => {
    nonAtomic();
    h.storeGroups = stores(3);
    h.prior = { id: 'e1' };
    h.counters = { ...h.counters, readyAt: null };
    await Promise.all([
      recordProviderOperation(op({ storeId: 'store-8' })),
      recordProviderOperation(op({ storeId: 'store-9' })),
    ]);
    expect(h.alerts.filter(a => a.source === 'provider.ready_to_verify')).toHaveLength(1);
  });
});
