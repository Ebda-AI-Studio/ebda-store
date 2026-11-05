/**
 * BE:F-5 / QA P2-5: provisioning creates the default category with an Arabic name and description, so an Arabic-default
 * storefront never shows the English label.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { storeCreate, categoryCreate } = vi.hoisted(() => ({
  storeCreate: vi.fn(),
  categoryCreate: vi.fn(),
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
    storeSubscription: { upsert: vi.fn(), findUnique: vi.fn(async () => null), update: vi.fn() },
    category: { create: categoryCreate },
    taxRate: { create: vi.fn() },
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

const base = { storeName: 'Cat Shop', ownerEmail: 'o@x.com', ownerName: 'Owner One' };

beforeEach(() => {
  vi.clearAllMocks();
  storeCreate.mockResolvedValue({ id: 's1', name: 'Cat Shop', slug: 'cat-shop', domain: null });
});

describe('provisioning default category', () => {
  it('has an Arabic name and description next to the English ones', async () => {
    await ProvisioningService.provisionStore({ ...base });
    expect(categoryCreate).toHaveBeenCalledTimes(1);
    expect(categoryCreate.mock.calls[0]![0].data).toMatchObject({
      storeId: 's1',
      name: 'Products',
      nameAr: 'المنتجات',
      slug: 'products',
      description: 'All products',
      descriptionAr: 'كل المنتجات',
    });
  });
});
