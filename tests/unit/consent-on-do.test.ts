/**
 * NEON-ZERO class sweep (P1 2026-11-09): the shopper's marketing-consent writes on a Durable Object store. Before the port,
 * `SmsConsentService.recordGrant` / `revoke` and the WhatsApp opt-in (`GET`/`POST /public/cart/whatsapp-optin`) went to
 * Postgres (a raw INSERT, `prisma.<model>`, a `runInTenantContext` transaction, an advisory lock) and threw POSTGRES_REMOVED.
 * Here `prisma` and `runInTenantContext` THROW: a DO path that still reaches either fails the test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  writes: [] as Array<{ model: string; op: string; args: Record<string, unknown> }>,
  notified: [] as Array<{ model: string; op: string }>,
  orders: [] as Array<{ shippingAddress: { phone: string } }>,
  consent: null as null | { userId: string | null; granted: boolean },
}));

vi.mock('@ebda/database', async () =>
  (await import('./helpers/database-mock')).databaseMock({
    prisma: new Proxy(
      {},
      {
        get: (_t, p) => {
          throw new Error(`Postgres touched: prisma.${String(p)}`);
        },
      }
    ),
    extra: {
      runInTenantContext: async () => {
        throw new Error('Postgres touched: runInTenantContext');
      },
      notifyModelWrite: (model: string, op: string) => void h.notified.push({ model, op }),
    },
  })
);

const writer = (model: string) => ({
  upsert: async (args: Record<string, unknown>) => {
    h.writes.push({ model, op: 'upsert', args });
    return { ...(args.create as object) };
  },
  updateMany: async (args: Record<string, unknown>) => {
    h.writes.push({ model, op: 'updateMany', args });
    return { count: 1 };
  },
});

vi.mock('@api/lib/repo-factory', () => ({
  storeRepo: async () => ({ backend: 'do' }),
  storeWriter: async () => ({
    smsMarketingConsent: writer('SmsMarketingConsent'),
    storeWhatsAppConsent: writer('StoreWhatsAppConsent'),
  }),
  storeDb: async () => ({
    order: { findMany: async () => h.orders },
    cart: { findFirst: async () => ({ id: 'cart-1' }) },
    storeWhatsAppConsent: { findUnique: async () => h.consent },
  }),
}));
vi.mock('@api/lib/customer-directory', () => ({
  customerRow: async () => ({ phone: '01001234567' }),
  customerRows: async () => [],
}));
vi.mock('@api/lib/jobs/store-db', () => ({
  readStoreDb: async (_s: string, fn: (db: unknown) => unknown) =>
    fn({ storeWhatsAppConsent: { findUnique: async () => h.consent } }),
}));
vi.mock('@api/lib/wa/config', () => ({ suiteBuyerKeySecret: () => 'k'.repeat(48) }));

import { SmsConsentService } from '@api/services/sms-consent.service';
import { WhatsAppConsentService } from '@api/lib/wa/consent';

const STORE = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  h.writes = [];
  h.notified = [];
  h.orders = [{ shippingAddress: { phone: '+201001234567' } }];
  h.consent = null;
});

describe('SMS marketing consent on a DO store', () => {
  it('a checkout / account grant is one DO upsert on (store, customer key)', async () => {
    const ok = await SmsConsentService.recordGrant(STORE, {
      customerKey: 'cust-1',
      userId: 'cust-1',
      phone: '01001234567',
      source: 'checkout',
    });
    expect(ok).toBe(true);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({
      model: 'SmsMarketingConsent',
      op: 'upsert',
      args: {
        where: { storeId_customerKey: { storeId: STORE, customerKey: 'cust-1' } },
        update: { granted: true, grantedSource: 'checkout' },
      },
    });
  });

  it('a withdrawal is phone-wide on the DO', async () => {
    expect(
      await SmsConsentService.revoke(STORE, { phone: '01001234567', userId: 'cust-1' }, 'account')
    ).toBe(1);
    expect(h.writes[0]).toMatchObject({
      model: 'SmsMarketingConsent',
      op: 'updateMany',
      args: { where: { storeId: STORE, granted: true }, data: { granted: false } },
    });
  });
});

describe('WhatsApp marketing consent on a DO store', () => {
  it('GET state: the delivered-order proof reads the DO', async () => {
    h.consent = { userId: 'cust-1', granted: true };
    expect(await WhatsAppConsentService.stateForUser(STORE, 'cust-1')).toEqual({
      granted: true,
      proven: true,
    });
  });

  it('POST grant: DO upsert, announced to the consent observer, no Postgres lock', async () => {
    const r = await WhatsAppConsentService.recordForCart(STORE, 'sess-1', 'cust-1', {
      consent: true,
      locale: 'ar',
    });
    expect(r).toEqual({ status: 'recorded', granted: true, cartId: 'cart-1' });
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({
      model: 'StoreWhatsAppConsent',
      op: 'upsert',
      args: { update: { granted: true, grantedSource: 'checkout', userId: 'cust-1' } },
    });
    expect(h.notified).toEqual([{ model: 'StoreWhatsAppConsent', op: 'upsert' }]);
  });

  it('POST withdraw of an unproven number the account does not own is refused (no write)', async () => {
    h.orders = [];
    h.consent = { userId: 'someone-else', granted: true };
    const r = await WhatsAppConsentService.recordForCart(STORE, 'sess-1', 'cust-1', {
      consent: false,
    });
    expect(r).toEqual({ status: 'phone_unproven' });
    expect(h.writes).toEqual([]);
  });
});
