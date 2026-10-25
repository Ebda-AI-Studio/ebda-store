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

import {
  recordProviderOperation,
  reportConnectionCheck,
  resetProviderVerificationCache,
  isProviderVerified,
} from '@api/services/provider-verification.service';

const op = (over: Record<string, unknown> = {}) => ({
  storeId: 'store-1',
  provider: 'paymob',
  op: 'create_payment' as const,
  ok: true,
  ref: 'inv-1',
  ...over,
});

beforeEach(() => {
  h.prior = null;
  h.counters = { provider: 'paymob', successCount: 1, failureCount: 0, verifiedAt: null };
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

  it('flips verified after N successes, once, with an info alert', async () => {
    h.prior = { id: 'e1' };
    h.counters = { ...h.counters, successCount: 3 };
    await recordProviderOperation(op());
    expect(h.alerts.map(a => a.level)).toEqual(['info']);
    expect(h.alerts[0].source).toBe('provider.auto_verified');
  });

  it('does not flip below N, nor when another request already flipped it', async () => {
    h.prior = { id: 'e1' };
    h.counters = { ...h.counters, successCount: 2 };
    await recordProviderOperation(op());
    expect(h.alerts).toHaveLength(0);
    h.counters = { ...h.counters, successCount: 3 };
    h.flipCount = 0;
    await recordProviderOperation(op());
    expect(h.alerts).toHaveLength(0);
  });

  it('PROVIDER_AUTO_VERIFY_AFTER overrides N', async () => {
    process.env.PROVIDER_AUTO_VERIFY_AFTER = '1';
    h.prior = { id: 'e1' };
    await recordProviderOperation(op());
    expect(h.alerts.map(a => a.source)).toEqual(['provider.auto_verified']);
  });

  it('ignores catalog-verified (kashier), manual (cod) and unknown providers entirely', async () => {
    for (const provider of ['kashier', 'cod', 'instapay', 'nope']) {
      await recordProviderOperation(op({ provider }));
    }
    expect(h.alerts).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it('ignores an already auto-verified provider', async () => {
    h.verifiedRows = [{ provider: 'paymob' }];
    await recordProviderOperation(op());
    expect(h.alerts).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it('never throws into the money path when bookkeeping fails', async () => {
    h.upsertThrows = true;
    await expect(recordProviderOperation(op())).resolves.toBeUndefined();
  });
});

describe('isProviderVerified', () => {
  it('catalog-verified and manual are verified; unverified is not until auto-verified', async () => {
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
