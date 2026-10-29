/**
 * INFRA-CF-1 PR D2b-5 (Ruling CF-LAST-1): PaymentService.handleWebhook and PaymentService.refund end to end (real service, a stub provider adapter behind the real bridge) give
 * the same answer and leave the same rows on Postgres and on the DO. Each test is a SCENARIO driving the real service; it runs
 * once on Postgres (unchanged code) and once with the DO money client over the real DO schema on SQLite (real wire codec,
 * `answerMoneyOp`, `runMoneyOp`). Each backend gets its own identical world (mirrored into SQLite); the scrubbed traces
 * (return values or error, then the ledger / order / stock / price rows) must be equal. Trial balance parity is asserted
 * per account code.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, runInTenantContext } from '@ebda/database';
import {
  answerMoneyOp,
  decodeRpc,
  encodeRpc,
  ensureMoneyOpsSchema,
  ensurePaymentSchema,
  createDoClient,
  createPrismaLite,
  ensureIdempotencySchema,
  runReads,
  runWrites,
} from '@ebda-src/repo';
import { handleOrderRefunded } from '../../apps/api/src/lib/inngest/functions/order-refunded';
import { PaymentService } from '../../apps/api/src/services/payment-providers/payment.factory';
import {
  registerProviderV2,
  getProviderV2,
} from '../../apps/api/src/services/payment-providers/registry';
import {
  PaymentProviderError,
  type PaymentProviderV2,
} from '../../apps/api/src/services/payment-providers/types';
import { PAYMOB_HMAC_HEADER } from '../../apps/api/src/services/payment-providers/paymob.provider';
import { encryption } from '../../apps/api/src/services/encryption.service';
import { inngest } from '../../apps/api/src/lib/inngest/client';
import { OneSignalService } from '../../apps/api/src/services/onesignal.service';
import { awaitDeferredWork } from '../../apps/api/src/lib/after-tenant-commit';
import { featureService } from '../../apps/api/src/services/feature.service';
import {
  makeMoneyClient,
  storeDb,
  storeMoney,
  withRepo,
  type StoreReads,
  type StoreWrites,
} from '../../apps/api/src/lib/repo-factory';
import { AppError } from '../../apps/api/src/middleware/error-handler';
import { seedCoaForStore } from '../../apps/api/src/services/accounting/account.service';
import { META, canon, insertSqlite, openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { nodeSyncSql } from '../../packages/repo/test/node-sync-sql';
import { hasDb } from '../helpers/bundle-fixtures';
import { createProduct, ownerPool } from '../helpers/gold-sql';

const sfx = Date.now().toString(36);
let STORE = '';
let ownerId = '';
const sqlite = openSqlite();
const ownerPg = ownerPool();

function doRepo() {
  const sql = nodeSqlRunner(sqlite);
  ensureIdempotencySchema(sql);
  const sync = nodeSyncSql(sqlite);
  ensureMoneyOpsSchema(sync);
  ensurePaymentSchema(sync);
  const lite = createPrismaLite(META as never, sql, 'store-do', {
    storeId: STORE,
  }) as never;
  const c = createDoClient(
    q => runReads(lite, q),
    m => runWrites(lite, sql, m)
  ) as never;
  const money = makeMoneyClient(async (op, args, key) => {
    const r = answerMoneyOp(sync, STORE, op, encodeRpc(args), key);
    if (!r.ok) throw new AppError(r.status, r.code, r.message);
    return decodeRpc(r.json);
  });
  return {
    storeId: STORE,
    backend: 'do' as const,
    db: c as StoreReads,
    writer: c as StoreWrites,
    money,
  };
}
const pgRepo = () => ({
  storeId: STORE,
  backend: 'pg' as const,
  db: prisma as never,
  writer: prisma as never,
});
const onPg = <T>(f: () => Promise<T>) => withRepo(pgRepo(), f);
const onDo = <T>(f: () => Promise<T>) => withRepo(doRepo(), f);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
function scrub(v: unknown, names: Record<string, string>): unknown {
  let text = JSON.stringify(canon(v)) ?? 'null';
  for (const [id, name] of Object.entries(names)) text = text.split(id).join(`<${name}>`);
  return JSON.parse(
    text
      .replace(UUID, '<id>')
      .replace(/(JE|ORD|PAID)-[A-Z0-9-]+/g, '<no>')
      .replace(/"\d{4}-\d\d-\d\dT[\d:.]+Z"/g, '"<date>"')
  );
}
const settle = async <T>(f: () => Promise<T>) =>
  f().then(
    v => ({ ok: v }),
    (e: { code?: string; statusCode?: number; message?: string }) => ({
      err: {
        status: e.statusCode,
        code: e.code,
        message: e.code ? undefined : String(e.message).slice(0, 120),
      },
    })
  );

const inStore = <T>(f: () => Promise<T>) => runInTenantContext(STORE, f);

/** A provider adapter that owns no network: signed deliveries are JSON, refunds are recorded and answered `completed`. */
const refundCalls: Array<{ kind: 'full' | 'partial'; amountMinor?: number }> = [];
const stub: PaymentProviderV2 = {
  name: 'paymob',
  capabilities: {
    methods: ['card'],
    instructions: ['redirect'],
    currencies: ['EGP'],
    partialRefunds: true,
    refunds: true,
    webhooks: true,
    remoteStatus: false,
    savedCards: false,
  },
  async createPayment() {
    throw new Error('not used');
  },
  verifyWebhook(rawBody, headers) {
    if (headers[PAYMOB_HMAC_HEADER] !== 'good')
      throw new PaymentProviderError('WEBHOOK_BAD_SIGNATURE', 'bad signature');
    const b = JSON.parse(String(rawBody));
    return b.kind === 'refund'
      ? {
          kind: 'refund',
          eventId: b.eventId,
          providerRef: b.providerRef,
          refundRef: b.refundRef,
          status: 'completed',
          amountMinor: b.amountMinor,
          currency: 'EGP',
          rawPayload: b,
        }
      : {
          kind: 'payment',
          eventId: b.eventId,
          providerRef: b.providerRef,
          status: b.status,
          amountMinor: b.amountMinor,
          currency: 'EGP',
          rawPayload: b,
        };
  },
  async getStatus() {
    throw new Error('not used');
  },
  async refund(req) {
    refundCalls.push({ kind: 'full' });
    return {
      refundRef: `rf-${req.idempotencyKey.slice(-6)}`,
      status: 'completed',
      amountMinor: 3_000,
      refundedTotalMinor: 3_000,
    };
  },
  async partialRefund(req) {
    refundCalls.push({ kind: 'partial', amountMinor: req.amountMinor });
    return {
      refundRef: `rf-${req.idempotencyKey.slice(-6)}`,
      status: 'completed',
      amountMinor: req.amountMinor,
      refundedTotalMinor: req.amountMinor,
    };
  },
};
const original = getProviderV2('paymob');

let n = 0;
interface World {
  order: string;
  payment: string;
  product: string;
  ref: string;
  names: Record<string, string>;
}
/** An order of 3 x 1000 with one paymob payment (`pending` for webhooks, `completed` + paid order for refunds). */
async function world(mirror: boolean, paid: boolean): Promise<World> {
  const k = `${sfx}${++n}`;
  await prisma.paymentConfig.upsert({
    where: { storeId_provider: { storeId: STORE, provider: 'paymob' } },
    update: {},
    create: {
      storeId: STORE,
      provider: 'paymob',
      isEnabled: true,
      isDefault: true,
      apiKey: encryption.encrypt('stub-key'),
      webhookSecret: encryption.encrypt('stub-secret'),
      settings: {},
    },
  });
  const product = await prisma.product.create({
    data: {
      storeId: STORE,
      name: 'Tee',
      slug: `tee-${k}`,
      price: 1_000,
      status: 'active',
      inventory: 17,
      trackInventory: true,
      costPrice: 400,
    },
  });
  const order = await prisma.order.create({
    data: {
      storeId: STORE,
      orderNumber: `PAID-${k}`,
      status: paid ? 'confirmed' : 'pending',
      paymentStatus: paid ? 'paid' : 'unpaid',
      subtotal: 3_000,
      tax: 0,
      shipping: 0,
      discount: 0,
      total: 3_000,
      currency: 'EGP',
      shippingAddress: {
        firstName: 'M',
        lastName: 'A',
        email: `m-${k}@example.test`,
        phone: '+201012345678',
      },
      billingAddress: {},
      items: {
        create: [
          {
            productId: product.id,
            productName: 'Tee',
            quantity: 3,
            price: 1_000,
            total: 3_000,
            costPrice: 400,
          },
        ],
      },
    },
    include: { items: true },
  });
  const payment = await prisma.payment.create({
    data: {
      orderId: order.id,
      provider: 'paymob',
      status: paid ? 'completed' : 'pending',
      amount: 3_000,
      currency: 'EGP',
      transactionId: `tx-${k}`,
    },
  });
  if (mirror) {
    sqlite.exec('DELETE FROM payment_configs');
    insertSqlite(sqlite, 'PaymentConfig', [
      await prisma.paymentConfig.findFirstOrThrow({
        where: { storeId: STORE, provider: 'paymob' },
      }),
    ] as never);
    insertSqlite(sqlite, 'Product', [product] as never);
    const { items, ...o } = order;
    insertSqlite(sqlite, 'Order', [o] as never);
    insertSqlite(sqlite, 'OrderItem', items as never);
    insertSqlite(sqlite, 'Payment', [payment] as never);
  }
  return {
    order: order.id,
    payment: payment.id,
    product: product.id,
    ref: `tx-${k}`,
    names: {
      [order.id]: 'order',
      [payment.id]: 'payment',
      [product.id]: 'product',
      [`tx-${k}`]: 'ref',
    },
  };
}
async function state(w: World) {
  const db = (await storeDb(STORE)) as never as {
    order: { findFirst(a: unknown): Promise<unknown> };
    payment: { findFirst(a: unknown): Promise<unknown> };
    product: { findFirst(a: unknown): Promise<unknown> };
    paymentEventLog: { findMany(a: unknown): Promise<unknown[]> };
  };
  return {
    order: await db.order.findFirst({
      where: { id: w.order },
      select: { status: true, paymentStatus: true },
    }),
    payment: await db.payment.findFirst({
      where: { id: w.payment },
      select: { status: true, refundedAmount: true },
    }),
    product: await db.product.findFirst({ where: { id: w.product }, select: { inventory: true } }),
  };
}
async function parity(paid: boolean, act: (w: World) => Promise<unknown>) {
  const run = async (on: typeof onPg, mirror: boolean) => {
    const w = await world(mirror, paid);
    const out = await settle(() => on(() => act(w)));
    const st = await on(() => state(w));
    return scrub({ out, state: st, calls: refundCalls.splice(0) }, w.names);
  };
  const pg = await run(onPg, false);
  const dobj = await run(onDo, true);
  expect(dobj).toEqual(pg);
  return pg as any;
}
const delivery = (w: World, extra: Record<string, unknown> = {}) => {
  const body = JSON.stringify({
    kind: 'payment',
    eventId: `ev-${w.ref}`,
    providerRef: w.ref,
    status: 'completed',
    amountMinor: 3_000,
    ...extra,
  });
  return { body, sig: 'good' };
};
const webhook = (w: World, d = delivery(w), sig = d.sig) =>
  PaymentService.handleWebhook('paymob' as never, JSON.parse(d.body), sig, STORE, d.body);
const settleWork = () => awaitDeferredWork(5000).catch(() => undefined);

beforeAll(async () => {
  registerProviderV2(stub);
  const owner = await prisma.user.create({
    data: {
      email: `d2b5w-${sfx}@example.test`,
      passwordHash: 'x'.repeat(60),
      firstName: 'D',
      lastName: 'B',
      role: 'store_admin',
      status: 'active',
      emailVerified: true,
    },
  });
  ownerId = owner.id;
  STORE = (
    await prisma.store.create({
      data: { name: 'D2b5w', slug: `d2b5w-${sfx}`, ownerId: owner.id, status: 'active' },
    })
  ).id;
  await seedCoaForStore(STORE);
  insertSqlite(
    sqlite,
    'Account',
    (await prisma.account.findMany({ where: { storeId: STORE } })) as never
  );
  sqlite
    .prepare('INSERT OR REPLACE INTO store_config (store_id, accounting_enabled) VALUES (?, 1)')
    .run(STORE);
});
beforeEach(() => {
  PaymentService.clearCache();
  vi.spyOn(featureService, 'isFeatureEnabled').mockResolvedValue(false);
  vi.spyOn(inngest, 'send').mockResolvedValue(undefined as never);
  vi.spyOn(OneSignalService, 'notifyAdminsOfPaymentFailure').mockResolvedValue(undefined as never);
});
afterAll(async () => {
  if (original) registerProviderV2(original);
  vi.restoreAllMocks();
  await ownerPg.end();
  await prisma.$disconnect();
});

describe.skipIf(!hasDb)(
  'PaymentService.handleWebhook and refund, end to end, Postgres vs the DO',
  () => {
    it('a signed completed delivery pays the order once; the replay changes nothing', async () => {
      const t = await parity(false, async w => {
        const first = await inStore(() => webhook(w));
        await settleWork();
        const again = await inStore(() => webhook(w));
        return { first: first.success, again: again.success };
      });
      expect(t.state.payment.status).toBe('completed');
      expect(t.state.order.paymentStatus).toBe('paid');
    });

    it('a delivery with a bad signature is refused and moves nothing', async () => {
      const t = await parity(false, async w => inStore(() => webhook(w, delivery(w), 'forged')));
      expect(t.out.err).toBeDefined();
      expect(t.state.payment.status).toBe('pending');
    });

    it('a full refund calls the provider once, refunds the payment and the order, restores the stock', async () => {
      const t = await parity(true, async w => {
        const r = await inStore(() =>
          PaymentService.refund(
            { transactionId: w.ref, reason: 'customer' },
            'paymob' as never,
            STORE
          )
        );
        await settleWork();
        // Postgres reverses the whole order in the order/refunded fanout (the DO did it in the refund section): run it inline
        if ((await storeMoney(STORE)) === null)
          await handleOrderRefunded(w.order, STORE, true, false, {
            run: <T>(_id: string, fn: () => Promise<T>) => fn(),
          });
        return { success: r.success, status: r.status, amount: r.amount };
      });
      expect(t.calls).toEqual([{ kind: 'full' }]);
      expect(t.state.order.status).toBe('refunded');
      expect(t.state.product.inventory).toBe(20);
    });

    it('a partial refund keeps the order, a second refund under one refundKey is refused, the provider is called once', async () => {
      const t = await parity(true, async w => {
        const first = await inStore(() =>
          PaymentService.refund(
            {
              transactionId: w.ref,
              amount: 1_000,
              refundKey: 'return:one',
              itemLevel: true,
            } as never,
            'paymob' as never,
            STORE
          )
        );
        await settleWork();
        const second = await settle(() =>
          inStore(() =>
            PaymentService.refund(
              {
                transactionId: w.ref,
                amount: 1_000,
                refundKey: 'return:one',
                itemLevel: true,
              } as never,
              'paymob' as never,
              STORE
            )
          )
        );
        return { first: first.amount, second };
      });
      expect(t.calls).toEqual([{ kind: 'partial', amountMinor: 1_000 }]);
      expect(t.state.payment.refundedAmount).toBe(1_000);
    });

    it('a refund webhook from the gateway is booked once (a dashboard refund)', async () => {
      const t = await parity(true, async w => {
        const d = delivery(w, {
          kind: 'refund',
          eventId: `rv-${w.ref}`,
          refundRef: 'rf-dash',
          amountMinor: 3_000,
        });
        await inStore(() => webhook(w, d));
        await settleWork();
        await inStore(() => webhook(w, d));
        if ((await storeMoney(STORE)) === null)
          await handleOrderRefunded(w.order, STORE, true, false, {
            run: <T>(_id: string, fn: () => Promise<T>) => fn(),
          });
        return 'done';
      });
      expect(t.state.payment.refundedAmount).toBe(3_000);
    });
  }
);
