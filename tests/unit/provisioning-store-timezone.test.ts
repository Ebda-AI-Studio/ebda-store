/**
 * Provisioning writes the operator's time zone to the `stores.timezone` COLUMN
 * (issue 2412). The column is what finance reports / tax periods read (Ruling
 * FRT-2); the old `settings.timezone` JSON key had zero readers, so a Dubai
 * store provisioned with `settings.timezone = 'Asia/Dubai'` still counted
 * Kuwait days. The JSON key is no longer written.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { storeCreate } = vi.hoisted(() => ({ storeCreate: vi.fn() }));

vi.mock('@force/database', () => {
  const tx = {
    $executeRaw: vi.fn(),
    user: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: 'u1', email: 'o@x.com' })),
    },
    store: { create: storeCreate },
    category: { create: vi.fn() },
    paymentConfig: { create: vi.fn() },
  };
  return {
    prisma: { store: { findUnique: vi.fn(async () => null) } },
    Prisma: {},
    StoreStatus: {},
    withMoneyTx: vi.fn(async (_p: unknown, fn: (t: unknown) => unknown) => fn(tx)),
    withRlsBypass: vi.fn(),
  };
});
vi.mock('bcryptjs', () => ({ default: { hash: vi.fn(async () => 'hash') } }));
vi.mock('../../apps/api/src/services/store.service', () => ({ bustStoreCaches: vi.fn() }));
vi.mock('../../apps/api/src/services/email.service', () => ({
  EmailService: { sendWelcome: vi.fn(async () => undefined) },
}));
vi.mock('../../apps/api/src/services/domain-provider', () => ({
  resolveDomainService: () => ({ providerName: 'x', addDomain: vi.fn(), removeDomain: vi.fn() }),
}));
vi.mock('../../apps/api/src/services/resend.service', () => ({
  ResendService: { provisionStoreDomain: vi.fn() },
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

  it('never writes an unresolvable zone to the column', async () => {
    await ProvisioningService.provisionStore({ ...base, settings: { timezone: 'Mars/Olympus' } });
    expect(createdData()).not.toHaveProperty('timezone');
  });
});
