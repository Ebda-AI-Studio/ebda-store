/**
 * NEON-ZERO consent residue (follow-up to consent-on-do.test.ts): the WhatsApp consent account paths (erasure/deactivation
 * revoke, data export, the Ebda Chat STOP consumer, the profile phone-change revoke) and the login-free SMS unsubscribe link on a
 * Durable Object store. `prisma` and `runInTenantContext` THROW here, so a DO path that still reaches Postgres fails the test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({
  jwtSecret: 'session-secret-A-0123456789abcdef0123',
  encryptionKey: 'encryption-key-A-0123456789abcdef012',
}));
vi.mock('@api/config', () => ({ config: cfg }));

type Row = {
  buyerKey: string;
  userId: string | null;
  granted: boolean;
  optOutVersion: number;
};
const h = vi.hoisted(() => ({
  writes: [] as Array<{ model: string; op: string; args: Record<string, any> }>,
  notified: [] as Array<{ model: string; op: string }>,
  orders: [] as Array<{ shippingAddress: { phone: string } }>,
  rows: [] as Row[],
  updateCount: 1,
  sms: null as null | { id: string; phone: string; granted: boolean },
  createError: null as null | { code: string },
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
  updateMany: async (args: Record<string, any>) => {
    h.writes.push({ model, op: 'updateMany', args });
    return { count: h.updateCount };
  },
  create: async (args: Record<string, any>) => {
    h.writes.push({ model, op: 'create', args });
    if (h.createError) throw Object.assign(new Error('unique'), h.createError);
    return args.data;
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
    store: { findUnique: async () => ({ name: 'Shop', nameAr: 'متجر' }) },
    smsMarketingConsent: { findFirst: async () => h.sms },
    storeWhatsAppConsent: {
      findMany: async () => h.rows,
      findUnique: async () => h.rows[0] ?? null,
    },
  }),
}));
vi.mock('@api/lib/customer-directory', () => ({
  customerRow: async () => ({ phone: '01001234567' }),
  customerRows: async () => [],
}));
vi.mock('@api/lib/jobs/store-db', () => ({
  readStoreDb: async (_s: string, fn: (db: unknown) => unknown) =>
    fn({ storeWhatsAppConsent: { findUnique: async () => h.rows[0] ?? null } }),
}));
vi.mock('@api/lib/wa/config', () => ({ suiteBuyerKeySecret: () => 'k'.repeat(48) }));

import {
  WhatsAppConsentService,
  applyOptOutChanged,
  revokeForAccount,
  revokeForPhoneChange,
} from '@api/lib/wa/consent';
import { SmsConsentService } from '@api/services/sms-consent.service';
import {
  parseSmsOptOutToken,
  signSmsOptOutToken,
  verifySmsOptOutToken,
} from '@api/lib/sms-consent';

const STORE = '11111111-1111-4111-8111-111111111111';
const CONSENT = '3f2b8a52-6c0d-4b8e-9d7a-1e2f3a4b5c6d';

beforeEach(() => {
  h.writes = [];
  h.notified = [];
  h.orders = [{ shippingAddress: { phone: '+201001234567' } }];
  h.rows = [{ buyerKey: 'bk-1', userId: 'cust-1', granted: true, optOutVersion: 0 }];
  h.updateCount = 1;
  h.sms = null;
  h.createError = null;
});

describe('WhatsApp consent account paths on a DO store', () => {
  it('account erasure / deactivation revokes what the account owns, source erasure, announced', async () => {
    await revokeForAccount(STORE, 'cust-1', '01001234567');
    const ups = h.writes.filter(w => w.op === 'updateMany');
    expect(ups).toHaveLength(1);
    expect(ups[0].args).toMatchObject({
      where: { storeId: STORE, buyerKey: 'bk-1' },
      data: { granted: false, revokedSource: 'erasure' },
    });
    expect(h.notified).toEqual([{ model: 'StoreWhatsAppConsent', op: 'updateMany' }]);
  });

  it('a profile phone change revokes the old number (source profile), announced', async () => {
    await revokeForPhoneChange(STORE, 'cust-1', '01001234567');
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({
      model: 'StoreWhatsAppConsent',
      op: 'updateMany',
      args: { where: { storeId: STORE, granted: true }, data: { revokedSource: 'profile' } },
    });
    expect(h.notified).toHaveLength(1);
  });

  it('a phone change of an UNPROVEN number only touches rows this account owns', async () => {
    h.orders = [];
    await revokeForPhoneChange(STORE, 'cust-1', '01001234567');
    expect(h.writes[0].args.where).toMatchObject({ userId: 'cust-1' });
  });

  it('export lists the account rows from the DO', async () => {
    const out = await WhatsAppConsentService.exportForAccount(STORE, 'cust-1');
    expect(out).toHaveLength(1);
  });

  it('STOP (opted out) applies on the DO and is announced', async () => {
    expect(await applyOptOutChanged(STORE, 'bk-1', true, 2)).toBe('applied');
    expect(h.writes[0]).toMatchObject({
      op: 'updateMany',
      args: {
        where: { storeId: STORE, buyerKey: 'bk-1', optOutVersion: { lt: 2 } },
        data: { granted: false, revokedSource: 'whatsapp', optOutVersion: 2 },
      },
    });
    expect(h.notified).toEqual([{ model: 'StoreWhatsAppConsent', op: 'updateMany' }]);
  });

  it('STOP for an unknown buyer creates the opt-out row; a replayed older version is ignored', async () => {
    h.updateCount = 0;
    h.rows = [];
    expect(await applyOptOutChanged(STORE, 'bk-9', true, 1)).toBe('applied');
    expect(h.writes.map(w => w.op)).toEqual(['updateMany', 'create']);
    h.writes = [];
    h.rows = [{ buyerKey: 'bk-9', userId: null, granted: false, optOutVersion: 3 }];
    expect(await applyOptOutChanged(STORE, 'bk-9', true, 2)).toBe('ignored');
    expect(h.writes.map(w => w.op)).toEqual(['updateMany']);
  });

  it('a unique collision on create re-runs the version-guarded update; other errors are rethrown', async () => {
    h.updateCount = 0;
    h.rows = [];
    h.createError = { code: 'P2002' };
    expect(await applyOptOutChanged(STORE, 'bk-9', true, 1)).toBe('ignored');
    expect(h.writes.map(w => w.op)).toEqual(['updateMany', 'create', 'updateMany']);
    h.createError = { code: 'X' };
    await expect(applyOptOutChanged(STORE, 'bk-9', true, 1)).rejects.toThrow('unique');
  });
});

describe('SMS unsubscribe link on a DO store', () => {
  it('a v3 token carries the store id, is 68 chars, and is bound to it by the MAC', () => {
    const t = signSmsOptOutToken(CONSENT, STORE);
    expect(t).toHaveLength(68);
    expect(parseSmsOptOutToken(t)).toEqual({ consentId: CONSENT, storeId: STORE });
    expect(verifySmsOptOutToken(t)).toBe(CONSENT);
    // swapping the store segment (another store's id) must not verify
    const [id, , mac] = t.split('.');
    const other = signSmsOptOutToken(CONSENT, '22222222-2222-4222-8222-222222222222').split('.')[1];
    expect(parseSmsOptOutToken(`${id}.${other}.${mac}`)).toBeNull();
  });

  it('a legacy v2 token (no store id) still verifies and names no store', () => {
    const t = signSmsOptOutToken(CONSENT);
    expect(t).toHaveLength(45);
    expect(parseSmsOptOutToken(t)).toEqual({ consentId: CONSENT, storeId: null });
  });

  it('the lookup and the withdrawal never touch Postgres', async () => {
    h.sms = { id: CONSENT, phone: '01001234567', granted: true };
    const row = await SmsConsentService.lookupForUnsubscribe(STORE, CONSENT);
    expect(row).toMatchObject({
      id: CONSENT,
      storeId: STORE,
      granted: true,
      store: { name: 'Shop', nameAr: 'متجر' },
    });
    expect(await SmsConsentService.lookupForUnsubscribe(STORE, 'nope')).toBeNull;
    await SmsConsentService.revoke(STORE, { phone: row!.phone }, 'unsubscribe');
    expect(h.writes[0]).toMatchObject({ model: 'SmsMarketingConsent', op: 'updateMany' });
  });
});
