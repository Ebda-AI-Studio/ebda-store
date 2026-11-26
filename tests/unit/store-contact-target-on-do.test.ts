/**
 * NZ-PORT-2: `storeContactTarget` (where a shopper's storefront contact message is mailed) on a Durable Object store. It read
 * `stores.email` and the `owner` relation through Prisma `withStore`: on the Worker that throws POSTGRES_REMOVED, so no contact message
 * could be delivered. Now the store record comes from `storeDb` and the owner's account from the identity service. Here `prisma` and the
 * `withStore` transaction THROW, so a path that still reaches Postgres fails. Ported from the recipient cases of
 * tests/integration/storefront-contact-routing.test.ts (Postgres); the route half runs on the Worker in
 * apps/api/workers-test/storefront-contact-routing.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  record: null as null | Record<string, unknown>,
  accounts: [] as Array<{ id: string; email: string; status: string }>,
  brief: vi.fn(),
}));

vi.mock('@ebda/database', () => ({
  prisma: new Proxy(
    {},
    {
      get: (_t, p) => {
        throw new Error(`Postgres touched: prisma.${String(p)}`);
      },
    }
  ),
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn(
      new Proxy(
        {},
        {
          get: (_t, p) => {
            throw new Error(`Postgres touched: tx.${String(p)}`);
          },
        }
      )
    ),
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => ({ store: { findUnique: async () => h.record } }),
}));
vi.mock('@api/lib/identity-client', () => ({
  getAccountsBrief: (ids: string[]) => {
    h.brief(ids);
    return Promise.resolve(h.accounts.filter(a => ids.includes(a.id)));
  },
}));
vi.mock('@api/config', () => ({ config: { smtpFromEmail: 'No-Reply@mail.ebda.app' } }));

import { storeContactTarget } from '@api/services/store-contact.service';

const OWNER = { id: 'owner-1', email: 'owner@example.test', status: 'active' };
const store = (over: Record<string, unknown> = {}) => ({
  email: null,
  isDemo: false,
  slug: 's',
  deletedAt: null,
  ownerId: 'owner-1',
  ...over,
});

describe('storeContactTarget on a DO store (no Postgres)', () => {
  beforeEach(() => {
    h.record = store();
    h.accounts = [{ ...OWNER }];
    h.brief.mockClear();
  });

  it("recipient: the store's contact email, else the owner's account email", async () => {
    h.record = store({ email: 'shop@example.test' });
    expect(await storeContactTarget('s1')).toMatchObject({
      to: 'shop@example.test',
      isDemo: false,
    });
    expect(h.brief).not.toHaveBeenCalled(); // the owner is only looked up when the store has no usable address
    h.record = store();
    expect(await storeContactTarget('s1')).toMatchObject({ to: 'owner@example.test' });
  });

  it('the demo flag and slug travel with the target', async () => {
    h.record = store({ isDemo: true, slug: 'showroom' });
    expect(await storeContactTarget('s1')).toMatchObject({ isDemo: true, slug: 'showroom' });
  });

  it('a suspended owner is not mailed, and an erased owner (absent from the identity answer) neither', async () => {
    h.accounts = [{ ...OWNER, status: 'suspended' }];
    expect((await storeContactTarget('s1'))?.to).toBeNull();
    h.accounts = [];
    expect((await storeContactTarget('s1'))?.to).toBeNull();
  });

  it('the platform sender address is never a target: skipped for the active owner, null when the owner is not active', async () => {
    h.record = store({ email: 'NO-REPLY@mail.ebda.app' });
    expect((await storeContactTarget('s1'))?.to).toBe('owner@example.test');
    h.accounts = [{ ...OWNER, status: 'suspended' }];
    expect((await storeContactTarget('s1'))?.to).toBeNull();
    // any mailbox on Ebda's own domain is the platform too, including the owner's own address
    h.accounts = [{ ...OWNER, email: 'ops@ebda.app' }];
    expect((await storeContactTarget('s1'))?.to).toBeNull();
  });

  it('a store that is gone or soft-deleted has no target', async () => {
    h.record = null;
    expect(await storeContactTarget('s1')).toBeNull();
    h.record = store({ deletedAt: new Date() });
    expect(await storeContactTarget('s1')).toBeNull();
  });
});
