/**
 * Ported from the dispatcher half of tests/integration/sms-marketing-consent.test.ts (Postgres). The REAL notification dispatcher and the
 * REAL SmsConsentService run on the StoreDO schema (node:sqlite through prisma-lite, one database per store as in production); `prisma` and the
 * `withStore` tx THROW, so a path that reaches Postgres fails. Only the SMS queue is spied (nothing is sent). Proves: no consent -> no promotional
 * SMS while a transactional SMS still sends; a granted consent sends once, matched across phone formats, with a 68-character opt-out token on the
 * store's own origin, and the opt-out token names the consent row; withdrawn consent (even with an older granted guest row for the same phone) ->
 * no SMS; another store's consent does not count; two back-in-stock shoppers never share an idempotency key; availability needs the sms feature,
 * a configured provider and a promotional event on; the opt-out link base is read once per fan-out (issue 2426) and a cold cache picks up a new
 * domain. The consent service itself is pinned in sms-marketing-consent-do.test.ts; the account / unsubscribe routes, the checkout box and the
 * GDPR export/erase are covered by consent-on-do / consent-residue-on-do (mock level).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openSqlite, META } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { createPrismaLite } from '../../packages/repo/src/prisma-lite/client';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const OFF = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => {
  return {
    enqueue: vi.fn(async (..._a: unknown[]) => undefined),
    sms: new Map<string, boolean>(),
    stores: new Map<string, { domain: string | null; slug: string; settings: unknown }>(),
    reads: vi.fn(),
  };
});
const dbs = {
  [A]: openSqlite(),
  [B]: openSqlite(),
  [OFF]: openSqlite(),
} as Record<string, ReturnType<typeof openSqlite>>;
const lites = Object.fromEntries(
  Object.entries(dbs).map(([k, d]) => [
    k,
    createPrismaLite(META, nodeSqlRunner(d), 'store-do', { unscoped: true }) as any,
  ])
) as Record<string, any>;
// the lite client has no `store` delegate (the real DO record is read through storeRecord): a stub answers the two fields the dispatcher reads
const dbOf = (id: string) =>
  new Proxy(lites[id], {
    get: (t, p) =>
      p === 'store'
        ? {
            findUnique: async () => {
              h.reads(id);
              return h.stores.get(id) ?? null;
            },
          }
        : t[p as string],
  });

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
  storeDb: async (id: string) => dbOf(id),
  storeWriter: async (id: string) => dbOf(id),
  storeRepo: async (id: string) => ({ backend: 'do', db: dbOf(id) }),
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: async (id: string) => h.sms.get(id) ?? true },
}));
vi.mock('@api/services/notification-config.service', () => ({
  notificationConfigService: {
    getConfig: async (id: string, ch: string) =>
      ch === 'sms' && id !== OFF
        ? { enabled: true, credentials: { appSid: 'app', senderId: 'TEST' } }
        : null,
  },
}));
vi.mock('@api/services/sms-queue.service', () => ({ smsQueue: { enqueue: h.enqueue } }));
vi.mock('@api/services/push.service', () => ({
  pushService: { sendToStore: async () => undefined },
}));
vi.mock('@api/services/redis.service', () => ({ redis: { incrementRateLimit: async () => 1 } }));
vi.mock('@api/lib/store-operational', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/lib/store-operational')>()),
  storeMayMessageCustomers: async () => true,
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/config', () => ({
  config: { webUrl: 'https://ebda.app', encryptionKey: 'a'.repeat(64) },
}));

import {
  notificationDispatcher,
  __clearOptOutBaseCacheForTests,
} from '@api/services/notification-dispatcher.service';
import { SmsConsentService } from '@api/services/sms-consent.service';
import { SMS_OPT_OUT_TOKEN_V3_LENGTH, verifySmsOptOutToken } from '@api/lib/sms-consent';
import { storefrontOrigin } from '@ebda/shared';

let n = 0;
const egMobile = () => `010${String(20_000_000 + ++n).padStart(8, '0')}`;
const spaced = (l: string) => `+20 ${l.slice(1, 4)} ${l.slice(4, 8)} ${l.slice(8)}`;
const cart = (phone: string, storeId: string) => ({
  customerName: 'Shop Per',
  customerPhone: phone,
  orderNumber: `cart-${++n}`,
  storeId,
  storeName: 'S',
  cartUrl: 'https://example.test/cart',
});
const promoSentTo = (phone: string) =>
  h.enqueue.mock.calls.filter(
    ([m]: any[]) => m.recipientPhone === phone && String(m.event).startsWith('cart_abandoned')
  );

describe('SMS marketing consent through the dispatcher on the StoreDO schema (issue 206)', () => {
  beforeEach(() => {
    h.enqueue.mockClear();
    h.reads.mockClear();
    h.sms.clear();
    __clearOptOutBaseCacheForTests();
    h.stores.set(A, { domain: null, slug: 'smsc-a', settings: {} });
    h.stores.set(B, { domain: null, slug: 'smsc-b', settings: {} });
    h.stores.set(OFF, { domain: null, slug: 'smsc-off', settings: {} });
  });

  it('no consent -> no promotional SMS; a transactional SMS still sends', async () => {
    const phone = egMobile();
    await notificationDispatcher.dispatch(A, 'cart_abandoned_step1', cart(phone, A));
    expect(promoSentTo(phone)).toHaveLength(0);
    await notificationDispatcher.dispatch(A, 'order_shipped', {
      ...cart(phone, A),
      orderNumber: `ORD-${++n}`,
    });
    expect(h.enqueue.mock.calls.some(([m]: any[]) => m.event === 'order_shipped')).toBe(true);
  });

  it('granted consent -> sends once across phone formats, with a working opt-out link on the store origin', async () => {
    const local = egMobile();
    await SmsConsentService.recordGrant(A, {
      customerKey: spaced(local),
      phone: spaced(local),
      source: 'checkout',
    });
    await notificationDispatcher.dispatch(A, 'cart_abandoned_step1', cart(local, A));
    const sent = promoSentTo(local);
    expect(sent).toHaveLength(1);
    const text: string = (sent[0]![0] as any).messageText;
    const m = text.match(/\/sms-unsubscribe\?t=([A-Za-z0-9_.-]+)/);
    expect(m).not.toBeNull();
    expect(m![1]).toHaveLength(SMS_OPT_OUT_TOKEN_V3_LENGTH);
    // the label follows the store's language (region default: Egyptian Arabic) and the link sits on the platform-path base
    expect(
      text.endsWith(
        ` إيقاف العروض: ${storefrontOrigin({ slug: 'smsc-a' })}/sms-unsubscribe?t=${m![1]}`
      )
    ).toBe(true);
    const consentId = verifySmsOptOutToken(m![1]);
    expect(consentId).not.toBeNull();
    // the token names the consent row it withdraws (what the unsubscribe route reads), and withdrawing stops the gate
    expect(await SmsConsentService.lookupForUnsubscribe(A, consentId!)).toMatchObject({
      id: consentId,
      granted: true,
    });
    expect(await SmsConsentService.revoke(A, { phone: local }, 'unsubscribe')).toBe(1);
    h.enqueue.mockClear();
    await notificationDispatcher.dispatch(A, 'cart_abandoned_step2', cart(local, A));
    expect(promoSentTo(local)).toHaveLength(0);
    expect(verifySmsOptOutToken(`${m![1].slice(0, -2)}AA`)).toBeNull();
  });

  it('withdrawn consent -> no SMS, even with an older granted guest row for the same phone', async () => {
    const phone = egMobile();
    await SmsConsentService.recordGrant(A, { customerKey: phone, phone, source: 'checkout' });
    await SmsConsentService.recordGrant(A, {
      customerKey: `guest-${++n}@example.test`,
      phone: `20${phone.slice(1)}`,
      source: 'checkout',
    });
    expect(await SmsConsentService.revoke(A, { phone }, 'account')).toBe(2);
    await notificationDispatcher.dispatch(A, 'cart_abandoned_step1', cart(phone, A));
    expect(promoSentTo(phone)).toHaveLength(0);
  });

  it("another store's consent does not count", async () => {
    const phone = egMobile();
    await SmsConsentService.recordGrant(A, { customerKey: phone, phone, source: 'checkout' });
    await notificationDispatcher.dispatch(B, 'cart_abandoned_step1', cart(phone, B));
    expect(promoSentTo(phone)).toHaveLength(0);
  });

  it('back-in-stock SMS for two shoppers do not share one idempotency key', async () => {
    const [p1, p2] = [egMobile(), egMobile()];
    for (const p of [p1, p2]) {
      await SmsConsentService.recordGrant(A, { customerKey: p, phone: p, source: 'checkout' });
      await notificationDispatcher.dispatch(A, 'back_in_stock', {
        customerName: 'X',
        customerPhone: p,
        orderNumber: '',
        dedupeKey: `prod_${p}_2026-10-01`,
        storeId: A,
        storeName: 'S',
        productName: 'P',
        productUrl: 'https://example.test/p',
      });
    }
    const keys = h.enqueue.mock.calls
      .filter(([m]: any[]) => m.event === 'back_in_stock')
      .map(([m]: any[]) => m.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it('availability: needs the sms feature, a configured provider and a promotional event on', async () => {
    expect(await notificationDispatcher.isSmsMarketingAvailable(A)).toBe(true);
    h.sms.set(B, false);
    expect(await notificationDispatcher.isSmsMarketingAvailable(B)).toBe(false); // feature off
    expect(await notificationDispatcher.isSmsMarketingAvailable(OFF)).toBe(false); // no provider configured
    for (const event of [
      'cart_abandoned_step1',
      'cart_abandoned_step2',
      'cart_abandoned_step3',
      'back_in_stock',
    ])
      dbs[A]!.prepare(
        `INSERT INTO notification_event_configs (id, store_id, event, sms, push) VALUES (?, ?, ?, 0, 1)`
      ).run(`nec-${event}`, A, event);
    expect(await notificationDispatcher.isSmsMarketingAvailable(A)).toBe(false); // every promotional event switched off
    dbs[A]!.prepare('DELETE FROM notification_event_configs').run(); // leave the store as the other cases expect it
  });

  it('the opt-out link reads the store once per fan-out, not once per recipient (issue 2426); a cold cache picks up a new domain', async () => {
    const [p1, p2, p3] = [egMobile(), egMobile(), egMobile()];
    for (const p of [p1, p2, p3])
      await SmsConsentService.recordGrant(A, { customerKey: p, phone: p, source: 'checkout' });
    await notificationDispatcher.dispatch(A, 'cart_abandoned_step1', cart(p1, A));
    // the store moves to a custom domain between two sends of one sweep: bounded-stale (120s), the second link keeps the first read
    h.stores.set(A, { domain: 'smsc-new.example.test', slug: 'smsc-a', settings: {} });
    await notificationDispatcher.dispatch(A, 'cart_abandoned_step1', cart(p2, A));
    const link = (p: string) => (promoSentTo(p)[0]![0] as any).messageText as string;
    const slugOrigin = storefrontOrigin({ slug: 'smsc-a' });
    expect(link(p1)).toContain(`${slugOrigin}/sms-unsubscribe?t=`);
    expect(link(p2)).toContain(`${slugOrigin}/sms-unsubscribe?t=`);
    expect(link(p2)).not.toContain('smsc-new.example.test');
    __clearOptOutBaseCacheForTests();
    await notificationDispatcher.dispatch(A, 'cart_abandoned_step1', cart(p3, A));
    expect(link(p3)).toContain('https://smsc-new.example.test/sms-unsubscribe?t=');
  });
});
