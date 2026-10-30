/**
 * INFRA-CF-1 R6a (Ruling CF-R6A-3): a shopper's account erasure leaves the store's rows in the same state on a Durable Object
 * store as on Postgres. The REAL `AuthService.eraseAccount` runs once per backend over the same fixture shape (one shopper on
 * Postgres, one on the DO schema on SQLite); the store-owned rows afterwards, and the store's rolling send-cap count, must be
 * equal. The legal-record rules are pinned here: orders survive pseudonymised, the wallet ledger survives with the balance
 * written off, a campaign mail sent inside the send-cap window is ANONYMISED (never deleted, so erasure cannot reset the
 * store's cap), and an ambiguous CRM match scrubs nothing.
 */
import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma, withRlsBypass } from '@ebda/database';
import {
  answerMoneyOp,
  decodeRpc,
  encodeRpc,
  ensureMoneyOpsSchema,
  createDoClient,
  createPrismaLite,
  ensureIdempotencySchema,
  runReads,
  runWrites,
} from '@ebda-src/repo';
import { makeMoneyClient, withRepo } from '../../apps/api/src/lib/repo-factory';
import { AppError } from '../../apps/api/src/middleware/error-handler';
import { META, canon, insertSqlite, openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { nodeSyncSql } from '../../packages/repo/test/node-sync-sql';
import { hasDb } from '../helpers/bundle-fixtures';

vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { send: vi.fn(async () => ({ ids: [] })), createFunction: vi.fn(() => ({})) },
}));

const { AuthService } = await import('../../apps/api/src/services/auth.service');
const { sentInLast24h } = await import('../../apps/api/src/services/campaign.service');

const tag = `es${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const sqlite = openSqlite();
const ids = { owner: '', store: '' };
type Side = 'p' | 'd';
let doRepo: any;

function buildDoRepo(storeId: string) {
  const sql = nodeSqlRunner(sqlite);
  ensureIdempotencySchema(sql);
  const sync = nodeSyncSql(sqlite);
  ensureMoneyOpsSchema(sync);
  const lite = createPrismaLite(META as never, sql, 'store-do', { storeId }) as never;
  const c = createDoClient(
    q => runReads(lite, q),
    m => runWrites(lite, sql, m)
  ) as never;
  const money = makeMoneyClient(async (op, args, key) => {
    const r = answerMoneyOp(sync, storeId, op, encodeRpc(args), key);
    if (!r.ok) throw new AppError(r.status, r.code, r.message);
    return decodeRpc(r.json);
  });
  return { storeId, backend: 'do' as const, db: c, writer: c, money };
}

const uuid = () => crypto.randomUUID();
const DAY = 86_400_000;
let seq = 0;

/** One shopper's store-owned rows. Postgres rows go in with Prisma, DO rows with the same objects into SQLite. */
async function world(side: Side, opts: { ambiguousCrm?: boolean } = {}) {
  const S = ids.store;
  const n = ++seq;
  const email = `${tag}${side}${n}@x.test`;
  const phone = side === 'p' ? '+201012345678' : '+201099999999';
  const shopper = await prisma.user.create({
    data: {
      email,
      passwordHash: 'x',
      role: 'customer',
      firstName: 'Shop',
      lastName: 'Per',
      phone,
      storeId: S,
    },
  });
  const U = shopper.id;
  const put = async (model: string, rows: Record<string, unknown>[]) => {
    if (side === 'd') insertSqlite(sqlite, model, rows as never);
    else
      await withRlsBypass(tx =>
        (tx as any)[model[0].toLowerCase() + model.slice(1)].createMany({ data: rows })
      );
  };
  const now = Date.now();
  const product = {
    id: uuid(),
    storeId: S,
    name: `P-${side}`,
    slug: `p-${tag}${side}${n}`,
    price: 1000,
    updatedAt: new Date(),
  };
  const order = (k: string, status: string, extra: Record<string, unknown> = {}) => ({
    id: uuid(),
    storeId: S,
    customerId: U,
    orderNumber: `EB-${tag}${side}${seq}-${k}`,
    status,
    subtotal: 1000,
    total: 1500,
    shippingAddress: { firstName: 'Shop', phone, street: 'x' },
    billingAddress: { firstName: 'Shop' },
    customerNotes: 'leave at the door',
    buyerKey: crypto.createHash('sha256').update(`${tag}${side}${seq}${k}`).digest('hex'),
    areaKey: 'cairo',
    updatedAt: new Date(),
    ...extra,
  });
  const o1 = order('1', 'delivered');
  const o2 = order('2', 'pending');
  const walletId = uuid();
  const campaign = {
    id: uuid(),
    storeId: S,
    name: 'c',
    subject: 's',
    bodyHtml: '<p>x</p>',
    status: 'sent',
    updatedAt: new Date(),
  };
  const campaign2 = { ...campaign, id: uuid() };
  const campaign3 = { ...campaign, id: uuid() };
  const sub = { id: uuid(), storeId: S, email, subscribedAt: new Date(), isActive: true };
  const crm = {
    id: uuid(),
    storeId: S,
    email,
    firstName: 'Shop',
    lastName: 'Per',
    phone,
    notes: 'vip',
    userId: null,
    updatedAt: new Date(),
  };
  const crm2 = {
    id: uuid(),
    storeId: S,
    email: email.toUpperCase(),
    firstName: 'Other',
    lastName: 'Person',
    phone: null,
    updatedAt: new Date(),
  };
  await put('Product', [product]);
  await put('Order', [o1, o2]);
  await put('Review', [
    {
      id: uuid(),
      productId: product.id,
      storeId: S,
      orderId: o1.id,
      customerId: U,
      rating: 5,
      body: 'great',
      updatedAt: new Date(),
    },
  ]);
  await put('CustomerWallet', [
    { id: walletId, storeId: S, customerId: U, balance: 500, updatedAt: new Date() },
  ]);
  await put('WalletTransaction', [
    {
      id: uuid(),
      storeId: S,
      walletId,
      customerId: U,
      amount: 500,
      balanceAfter: 500,
      type: 'admin_adjust',
      idempotencyKey: `k-${tag}${side}${n}`,
      note: 'goodwill for Mrs Shop',
    },
  ]);
  await put('LoyaltyPoints', [
    { id: uuid(), storeId: S, customerId: U, points: 40, updatedAt: new Date() },
  ]);
  await put('LoyaltyTransaction', [
    { id: uuid(), storeId: S, customerId: U, points: 40, type: 'earn_manual' },
  ]);
  await put('Customer', [crm, ...(opts.ambiguousCrm ? [crm2] : [])]);
  await put('CustomerAddress', [
    { id: uuid(), customerId: crm.id, street: 's', area: 'a', updatedAt: new Date() },
  ]);
  await put('NewsletterSubscriber', [sub]);
  await put('Campaign', [campaign, campaign2, campaign3]);
  await put('CampaignRecipient', [
    {
      id: uuid(),
      campaignId: campaign.id,
      storeId: S,
      email,
      subscriberId: sub.id,
      locale: 'en',
      status: 'sent',
      sentAt: new Date(now - 3_600_000),
      providerMessageId: 'msg-1',
      error: 'x',
    },
    {
      id: uuid(),
      campaignId: campaign2.id,
      storeId: S,
      email,
      locale: 'en',
      status: 'sent',
      sentAt: new Date(now - 2 * DAY),
      providerMessageId: 'msg-0',
    },
    { id: uuid(), campaignId: campaign3.id, storeId: S, email, locale: 'en' },
  ]);
  await put('SmsMarketingConsent', [
    {
      id: uuid(),
      storeId: S,
      customerKey: U,
      userId: U,
      phone,
      phoneKey: phone.slice(1),
      updatedAt: new Date(),
    },
    {
      id: uuid(),
      storeId: S,
      customerKey: email,
      phone,
      phoneKey: phone.slice(1),
      updatedAt: new Date(),
    },
  ]);
  await put('StoreWhatsAppConsent', [
    {
      storeId: S,
      buyerKey: crypto.createHash('sha256').update(`own${tag}${side}${n}`).digest('hex'),
      userId: U,
      granted: true,
      updatedAt: new Date(),
    },
    {
      storeId: S,
      buyerKey: crypto.createHash('sha256').update(`stop${tag}${side}${n}`).digest('hex'),
      userId: U,
      granted: false,
      revokedSource: 'whatsapp',
      updatedAt: new Date(),
    },
  ]);
  await put('Cart', [
    { id: uuid(), storeId: S, sessionId: `s-${side}-${n}`, customerId: U, updatedAt: new Date() },
  ]);
  await put('Wishlist', [{ id: uuid(), userId: U, storeId: S, updatedAt: new Date() }]);
  return { U, email, side };
}

const TABLES: Array<[string, string, string]> = [
  [
    'orders',
    'customer_id, shipping_address, billing_address, customer_notes, buyer_key, area_key, total, status',
    'order_number',
  ],
  ['reviews', 'customer_id, rating, body', 'rating'],
  ['customer_wallets', 'balance', 'balance'],
  [
    'wallet_transactions',
    'type, amount, balance_after, note, actor_id, idempotency_key',
    'type, amount',
  ],
  ['loyalty_points', 'points', 'points'],
  ['loyalty_transactions', 'points', 'points'],
  ['customers', 'email, first_name, last_name, phone, notes, user_id, group_id', 'first_name'],
  ['customer_addresses', 'street', 'street'],
  ['newsletter_subscribers', 'email', 'email'],
  [
    'campaign_recipients',
    'email, status, subscriber_id, customer_id, provider_message_id, error, (sent_at IS NOT NULL) AS sent',
    'status, sent',
  ],
  ['sms_marketing_consents', 'user_id, customer_key, phone', 'phone'],
  ['store_whatsapp_consents', 'buyer_key, user_id, granted, revoked_source', 'buyer_key'],
  ['carts', 'customer_id', 'customer_id'],
  ['wishlists', 'user_id', 'user_id'],
];

async function stateOf(side: Side, w: { U: string; email: string }) {
  const out: Record<string, unknown> = {};
  for (const [t, cols, order] of TABLES) {
    const scope = t === 'customer_addresses' ? '1 = 1' : `store_id = '${ids.store}'`;
    const sql = `SELECT ${cols} FROM ${t} WHERE ${scope} ORDER BY ${order}`;
    const rows: any[] =
      side === 'd'
        ? (sqlite.prepare(sql).all() as any[])
        : ((await prisma.$queryRawUnsafe(sql)) as any[]);
    out[t] = rows.map(r =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => [
          k,
          typeof v === 'boolean'
            ? Number(v)
            : typeof v === 'bigint'
              ? Number(v)
              : v instanceof Date
                ? '<date>'
                : typeof v === 'string' && v.startsWith('{')
                  ? JSON.parse(v)
                  : v,
        ])
      )
    );
  }
  const user = await prisma.user.findUnique({
    where: { id: w.U },
    select: { email: true, firstName: true, lastName: true, phone: true, status: true },
  });
  out.user = user;
  return out;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const norm = (v: unknown, w: { U: string; side: Side }) => {
  let t = JSON.stringify(canon(v)) ?? 'null';
  // the shopper's id and the per-world tag/side/sequence markers, which differ by construction between the two worlds
  t = t
    .split(w.U)
    .join('<U>')
    .replace(new RegExp(`${tag}${w.side}\\d+`, 'gi'), '<k>');
  t = t.replace(/(own|stop)[0-9a-f]{0,0}/g, '$1').replace(/\+2010(12345678|99999999)/g, '<phone>');
  t = t.replace(/2010(12345678|99999999)/g, '<phone>');
  return JSON.parse(t.replace(UUID, '<id>').replace(/[0-9a-f]{64}/g, '<hash>'));
};

describe.skipIf(!hasDb)('shopper erasure: Postgres vs the store DO', () => {
  beforeAll(async () => {
    ids.owner = (
      await prisma.user.create({
        data: {
          email: `${tag}@o.test`,
          passwordHash: 'x',
          firstName: 'Es',
          lastName: 'Owner',
          role: 'store_admin',
        },
      })
    ).id;
    ids.store = (
      await prisma.store.create({ data: { name: tag, slug: tag, ownerId: ids.owner } })
    ).id;
    doRepo = buildDoRepo(ids.store);
  }, 90_000);
  afterAll(async () => {
    if (!ids.store) return;
    await withRlsBypass(async tx => {
      for (const t of [
        'campaignRecipient',
        'campaign',
        'newsletterSubscriber',
        'customerAddress',
        'customer',
        'loyaltyTransaction',
        'loyaltyPoints',
        'walletTransaction',
        'customerWallet',
        'smsMarketingConsent',
        'storeWhatsAppConsent',
        'wishlist',
        'cart',
        'review',
        'order',
        'product',
        'address',
      ])
        await (tx as any)[t].deleteMany({ where: { storeId: ids.store } }).catch(() => undefined);
      await tx.user.deleteMany({ where: { storeId: ids.store } }).catch(() => undefined);
      await tx.store.deleteMany({ where: { id: ids.store } }).catch(() => undefined);
      await tx.user.deleteMany({ where: { id: ids.owner } }).catch(() => undefined);
    });
  }, 60_000);

  it('the same rows survive, the same rows are anonymised, and the send cap counts the same', async () => {
    const p = await world('p');
    const d = await world('d');
    const capBefore = {
      p: await withRlsBypass(() => sentInLast24h(ids.store)),
      d: await withRepo(doRepo, () => sentInLast24h(ids.store)),
    };
    expect(capBefore).toEqual({ p: 1, d: 1 });
    const outP = await AuthService.eraseAccount(p.U);
    const outD = await withRepo(doRepo, () => AuthService.eraseAccount(d.U));
    const cap = {
      p: await withRlsBypass(() => sentInLast24h(ids.store)),
      d: await withRepo(doRepo, () => sentInLast24h(ids.store)),
    };
    // erasure never hands the store its send cap back
    expect(cap).toEqual({ p: 1, d: 1 });
    expect(outD).toEqual(outP);
    const sp = norm(await stateOf('p', p), p);
    const sd = norm(await stateOf('d', d), d);
    expect(sd).toEqual(sp);
    // and the legal-record rules really held (so the equality is not two empty states)
    const s = sp as any;
    expect(s.orders).toHaveLength(2);
    expect(s.orders[0]).toMatchObject({ customer_id: null, buyer_key: null, total: 1500 });
    expect(s.orders[0].shipping_address).toEqual({ anonymized: true });
    expect(s.reviews).toEqual([{ customer_id: null, rating: 5, body: 'great' }]);
    expect(s.customer_wallets).toEqual([{ balance: 0 }]);
    expect(s.wallet_transactions.map((t: any) => t.type).sort()).toEqual([
      'admin_adjust',
      'expire',
    ]);
    expect(s.wallet_transactions.every((t: any) => t.type === 'expire' || t.note === null)).toBe(
      true
    );
    expect(s.loyalty_points).toEqual([]);
    expect(s.campaign_recipients).toHaveLength(1);
    expect(s.campaign_recipients[0]).toMatchObject({
      email: expect.stringMatching(/^erased-.*@anonymized\.local$/),
      subscriber_id: null,
      provider_message_id: null,
      error: null,
      sent: 1,
    });
    expect(s.newsletter_subscribers).toEqual([]);
    expect(s.customers[0]).toMatchObject({
      first_name: 'Erased',
      last_name: 'User',
      phone: null,
      notes: null,
    });
    expect(s.store_whatsapp_consents).toHaveLength(1);
    expect(s.store_whatsapp_consents[0]).toMatchObject({
      user_id: null,
      granted: 0,
      revoked_source: 'whatsapp',
    });
  });

  it('an ambiguous CRM match scrubs nothing on either backend', async () => {
    const p = await world('p', { ambiguousCrm: true });
    const d = await world('d', { ambiguousCrm: true });
    const outP = await AuthService.eraseAccount(p.U);
    const outD = await withRepo(doRepo, () => AuthService.eraseAccount(d.U));
    expect(outP.crmAmbiguous).toBe(true);
    expect(outD).toEqual(outP);
    const sp = norm(await stateOf('p', p), p) as any;
    expect(norm(await stateOf('d', d), d)).toEqual(sp);
    // the other data subject's record is intact
    expect(sp.customers.map((c: any) => c.first_name)).toContain('Other');
  });

  it('an admin account is refused and nothing changes (the last super_admin is never erasable here)', async () => {
    const admin = await prisma.user.create({
      data: {
        email: `${tag}sa@x.test`,
        passwordHash: 'x',
        role: 'super_admin',
        firstName: 'Su',
        lastName: 'Per',
      },
    });
    await expect(AuthService.eraseAccount(admin.id)).rejects.toMatchObject({ statusCode: 403 });
    const staff = await prisma.user.create({
      data: {
        email: `${tag}st@x.test`,
        passwordHash: 'x',
        role: 'store_admin',
        firstName: 'St',
        lastName: 'Aff',
        storeId: ids.store,
      },
    });
    await expect(withRepo(doRepo, () => AuthService.eraseAccount(staff.id))).rejects.toMatchObject({
      statusCode: 403,
    });
    expect((await prisma.user.findUnique({ where: { id: admin.id } }))?.email).toBe(
      `${tag}sa@x.test`
    );
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, staff.id] } } });
  });
});
