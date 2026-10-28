/**
 * Provisioning writes the operator's time zone to the `stores.timezone` COLUMN
 * (issue 2412). The column is what finance reports / tax periods read (Ruling
 * FRT-2); the old `settings.timezone` JSON key had zero readers, so a Dubai
 * store provisioned with `settings.timezone = 'Asia/Dubai'` still counted
 * Egypt days. The JSON key is no longer written.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { storeCreate, taxRateCreate, subUpdate } = vi.hoisted(() => ({
  storeCreate: vi.fn(),
  taxRateCreate: vi.fn(),
  subUpdate: vi.fn(),
}));

vi.mock('@ebda/database', () => {
  const tx = {
    $executeRaw: vi.fn(),
    // the owner is found-or-created by the `ebda_admin_user_ensure` definer, run on this tx
    $queryRaw: vi.fn(async () => [
      {
        user_id: 'u1',
        created: true,
        role: 'store_admin',
        status: 'active',
        email: 'o@x.com',
        first_name: 'Owner',
        last_name: 'One',
      },
    ]),
    user: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: 'u1', email: 'o@x.com' })),
    },
    store: { create: storeCreate },
    storeSubscription: { upsert: vi.fn(), findUnique: vi.fn(async () => null), update: subUpdate },
    category: { create: vi.fn() },
    taxRate: { create: taxRateCreate },
    paymentConfig: { create: vi.fn() },
  };
  return {
    prisma: {},
    Prisma: {},
    StoreStatus: {},
    withMoneyTx: vi.fn(async (_p: unknown, fn: (t: unknown) => unknown) => fn(tx)),
    scopeTransaction: vi.fn(async (t: unknown, _g: unknown, fn: (t: unknown) => unknown) => fn(t)),
  };
});
// `stores` is under RLS: the slug / domain uniqueness probes are definers (null = free).
// The owner definer (`ensureAdminUser`) stays real and runs on the mocked tx above.
vi.mock('../../apps/api/src/lib/definer', async importOriginal => ({
  ...(await importOriginal<typeof import('../../apps/api/src/lib/definer')>()),
  storeIdBySlug: vi.fn(async () => null),
  storeIdByDomain: vi.fn(async () => null),
}));
vi.mock('bcryptjs', () => ({ default: { hash: vi.fn(async () => 'hash') } }));
vi.mock('../../apps/api/src/services/store.service', () => ({ bustStoreCaches: vi.fn() }));
vi.mock('../../apps/api/src/services/email.service', () => ({
  EmailService: { sendWelcome: vi.fn(async () => undefined) },
}));
vi.mock('../../apps/api/src/services/domain-provider', () => ({
  resolveDomainService: () => ({ providerName: 'x', addDomain: vi.fn(), removeDomain: vi.fn() }),
}));
vi.mock('../../apps/api/src/services/store-mailer.service', () => ({
  StoreMailer: { provisionStoreDomain: vi.fn() },
}));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { ProvisioningService } from '../../apps/api/src/services/provisioning.service';

const base = { storeName: 'Dubai Shop', ownerEmail: 'o@x.com', ownerName: 'Owner One' };

function createdData() {
  return (storeCreate.mock.calls[0]![0] as { data: Record<string, any> }).data;
}

beforeEach(() => {
  vi.clearAllMocks();
  storeCreate.mockResolvedValue({ id: 's1', name: 'Dubai Shop', slug: 'dubai-shop', domain: null });
});

describe('provisioning time zone', () => {
  it('writes a valid zone to the column, not the settings JSON', async () => {
    await ProvisioningService.provisionStore({ ...base, settings: { timezone: 'Asia/Dubai' } });
    expect(createdData().timezone).toBe('Asia/Dubai');
    expect(createdData().settings).not.toHaveProperty('timezone');
  });

  it('leaves the column to its Prisma default when no zone is given', async () => {
    await ProvisioningService.provisionStore({ ...base, settings: { currency: 'AED' } });
    expect(createdData()).not.toHaveProperty('timezone');
    expect(createdData().settings).toMatchObject({ currency: 'AED' });
  });

  it('defaults an Ebda store to EGP + Arabic and seeds the 14% default VAT rate INACTIVE (VAT off until verified, ruling TAX-2)', async () => {
    await ProvisioningService.provisionStore({ ...base });
    expect(createdData().settings).toMatchObject({ currency: 'EGP', defaultLanguage: 'ar' });
    // `taxEnabled` is not set and the seeded rate is INACTIVE: a new store starts
    // with VAT OFF and no active rate (ruling TAX-2).
    expect(createdData()).not.toHaveProperty('taxEnabled');
    expect(taxRateCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ storeId: 's1', name: 'VAT', rate: 14, isActive: false }),
    });
  });

  it('never writes an unresolvable zone to the column', async () => {
    await ProvisioningService.provisionStore({ ...base, settings: { timezone: 'Mars/Olympus' } });
    expect(createdData()).not.toHaveProperty('timezone');
  });
});

describe('self-serve Growth trial (locked pricing: 14 days on Growth)', () => {
  it('growthTrial: the subscription becomes growth/trialing for 14 days, in the provisioning transaction', async () => {
    const before = Date.now();
    await ProvisioningService.provisionStore({ ...base, plan: 'professional', growthTrial: true });
    expect(subUpdate).toHaveBeenCalledTimes(1);
    const { where, data } = subUpdate.mock.calls[0]![0];
    expect(where).toEqual({ storeId: 's1' });
    expect(data).toMatchObject({ planCode: 'growth', status: 'trialing' });
    const days = (data.trialEndsAt.getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(13.99);
    expect(days).toBeLessThan(14.01);
    expect(data.currentPeriodEnd).toEqual(data.trialEndsAt);
  });

  it('without growthTrial (super-admin provisioning) no trial is started', async () => {
    await ProvisioningService.provisionStore({ ...base });
    expect(subUpdate).not.toHaveBeenCalled();
  });
});

describe('provisioning template (new stores start on a built Ebda skin)', () => {
  it('defaults to qamar, never the DB default', async () => {
    await ProvisioningService.provisionStore({ ...base });
    expect(createdData().template).toBe('qamar');
  });

  it('refuses a legacy Force skin', async () => {
    await expect(
      ProvisioningService.provisionStore({ ...base, template: 'modern' })
    ).rejects.toMatchObject({ code: 'TEMPLATE_NOT_AVAILABLE' });
    expect(storeCreate).not.toHaveBeenCalled();
  });
});
