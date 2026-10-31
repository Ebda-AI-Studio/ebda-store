/**
 * INFRA-CF-1 last-mile R1 (Ruling CF-RETURNS-1): the Return row lifecycle and the partial-return journal moved to the StoreDO
 * give the same answer and leave the same rows on Postgres and on the DO. Each test is a SCENARIO driving the real
 * `ReturnService` / `postPartialReturnJournal`; it runs once on Postgres (the unchanged code) and once with the DO money client
 * over the real DO schema on SQLite (real wire codec, `answerMoneyOp`, `runMoneyOp`), each in its own identical world. The
 * scrubbed traces (return value or error status+code, then return, item, wallet, stock and journal rows) must be equal.
 * Postgres restocks in the `order/refunded` fanout (run inline here), the DO inside the completion section.
 * Not compared: `reversal_applied_at`. The fanout stamps it when it has run; on a DO store that is the jobs port (the row stays
 * armed, so the stuck-reversal sweep keeps covering the GL entry and the notifications).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@ebda/database';
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
import { ReturnService } from '../../apps/api/src/services/return.service';
import { EmailService } from '../../apps/api/src/services/email.service';
import { featureService } from '../../apps/api/src/services/feature.service';
import { handleOrderRefunded } from '../../apps/api/src/lib/inngest/functions/order-refunded';
import {
  postAmountOnlyRefundJournal,
  postPartialReturnJournal,
} from '../../apps/api/src/services/accounting/posting/partial-return-posting';
import {
  makeMoneyClient,
  storeDb,
  storeMoney,
  withRepo,
  type StoreReads,
  type StoreWrites,
} from '../../apps/api/src/lib/repo-factory';
import { AppError } from '../../apps/api/src/middleware/error-handler';
import { META, canon, insertSqlite, openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { nodeSyncSql } from '../../packages/repo/test/node-sync-sql';
import { hasDb } from '../helpers/bundle-fixtures';

const sfx = Date.now().toString(36);
let STORE = '';
const sqlite = openSqlite();

function doRepo() {
  const sql = nodeSqlRunner(sqlite);
  ensureIdempotencySchema(sql);
  const sync = nodeSyncSql(sqlite);
  ensureMoneyOpsSchema(sync);
  const lite = createPrismaLite(META as never, sql, 'store-do', { storeId: STORE }) as never;
  const c = createDoClient(
    q => runReads(lite, q),
    m => runWrites(lite, sql, m)
  ) as never;
  const money = makeMoneyClient(async (op, args, key) => {
    const r = answerMoneyOp(sync, STORE, op, encodeRpc(args), key);
    if (!r.ok) throw new AppError(r.status, r.code, r.message, r.meta);
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
      .replace(/RET-[A-Z0-9-]+/g, '<ret>')
      .replace(/ORD-[A-Za-z0-9-]+/g, '<no>')
      .replace(/JE-\d{4}-\d+/g, '<je>')
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
const inlineStep = { run: <T>(_id: string, fn: () => Promise<T>) => fn() };

interface World {
  order: string;
  customer: string;
  items: { tee: string; cap: string };
  products: { tee: string; cap: string };
  names: Record<string, string>;
}
let n = 0;
const ACCOUNTS: Array<[string, string, 'asset' | 'liability' | 'revenue' | 'expense']> = [
  ['1000', 'Cash', 'asset'],
  ['1020', 'COD Clearing', 'asset'],
  ['1200', 'Inventory', 'asset'],
  ['2100', 'Tax Payable', 'liability'],
  ['2150', 'Customer Wallet', 'liability'],
  ['2160', 'Store Credit', 'liability'],
  ['4000', 'Sales', 'revenue'],
  ['4090', 'Sales Returns', 'revenue'],
  ['5000', 'COGS', 'expense'],
];
const accountId: Record<string, string> = {};

async function world(
  mirror: boolean,
  o: {
    walletAmount?: number;
    discount?: number;
    tax?: number;
    days?: number | null;
    sale?: boolean;
  } = {}
): Promise<World> {
  const k = `${sfx}${++n}`;
  const user = await prisma.user.create({
    data: {
      email: `ret-${k}@example.test`,
      passwordHash: 'x',
      firstName: 'R',
      lastName: 'T',
      role: 'customer',
      status: 'active',
      emailVerified: true,
      storeId: STORE,
    },
  });
  const tee = await prisma.product.create({
    data: {
      storeId: STORE,
      name: 'Tee',
      slug: `tee-${k}`,
      price: 10_000,
      status: 'active',
      inventory: 3,
      trackInventory: true,
    },
  });
  const cap = await prisma.product.create({
    data: {
      storeId: STORE,
      name: 'Cap',
      slug: `cap-${k}`,
      price: 5_000,
      status: 'active',
      inventory: 4,
      trackInventory: true,
    },
  });
  const discount = o.discount ?? 2_500;
  const tax = o.tax ?? 3_150;
  const order = await prisma.order.create({
    data: {
      storeId: STORE,
      customerId: user.id,
      orderNumber: `ORD-${k}`,
      status: 'delivered',
      paymentStatus: 'paid',
      subtotal: 25_000,
      tax,
      shipping: 0,
      discount,
      total: 25_000 - discount + tax,
      walletAmount: o.walletAmount ?? 0,
      currency: 'EGP',
      shippingAddress: {},
      billingAddress: {},
      deliveredAt: new Date(Date.now() - 86_400_000),
    },
  });
  const i1 = await prisma.orderItem.create({
    data: {
      orderId: order.id,
      productId: tee.id,
      productName: 'Tee',
      quantity: 2,
      price: 10_000,
      total: 20_000,
      costPrice: 4_000,
    },
  });
  const i2 = await prisma.orderItem.create({
    data: {
      orderId: order.id,
      productId: cap.id,
      productName: 'Cap',
      quantity: 1,
      price: 5_000,
      total: 5_000,
      costPrice: 2_000,
    },
  });
  await prisma.payment.create({
    data: {
      orderId: order.id,
      provider: 'paymob',
      status: 'completed',
      amount: order.total,
      currency: 'EGP',
    },
  });
  await prisma.store.update({ where: { id: STORE }, data: { returnWindowDays: o.days ?? null } });
  const names: Record<string, string> = {
    [user.id]: 'customer',
    [order.id]: 'order',
    [i1.id]: 'tee-line',
    [i2.id]: 'cap-line',
    [tee.id]: 'tee',
    [cap.id]: 'cap',
  };
  let sale: { id: string } | null = null;
  if (o.sale !== false) {
    const total = order.total;
    const mk = (sourceId: string, lines: Array<[string, number, number]>, no: string) =>
      prisma.journalEntry.create({
        data: {
          storeId: STORE,
          entryNumber: `JE-SALE-${k}-${no}`,
          postedAt: new Date(),
          source: 'order',
          sourceId,
          status: 'posted',
          lines: {
            create: lines.map(([code, debit, credit]) => ({
              accountId: accountId[code],
              debit,
              credit,
            })),
          },
        },
        include: { lines: true },
      });
    const e1 = await mk(
      order.id,
      [
        ['1000', total, 0],
        ['4000', 0, 25_000 - discount],
        ['2100', 0, tax],
      ],
      'a'
    );
    const e2 = await mk(
      `${order.id}:cogs`,
      [
        ['5000', 10_000, 0],
        ['1200', 0, 10_000],
      ],
      'b'
    );
    sale = e1;
    if (mirror) {
      for (const e of [e1, e2]) {
        const { lines, ...head } = e;
        insertSqlite(sqlite, 'JournalEntry', [head] as never);
        insertSqlite(sqlite, 'JournalLine', lines as never);
      }
    }
  }
  void sale;
  if (mirror) {
    insertSqlite(sqlite, 'Product', [tee, cap] as never);
    insertSqlite(sqlite, 'Order', [order] as never);
    insertSqlite(sqlite, 'OrderItem', [i1, i2] as never);
    sqlite
      .prepare(
        `INSERT INTO customers (id, store_id, first_name, last_name, user_id) VALUES (?, ?, 'R', 'T', ?)`
      )
      .run(`crm-${user.id}`, STORE, user.id); // the CRM id DIFFERS from the platform user id (Ruling CF-FIX-2)
    sqlite.prepare('DELETE FROM store_config WHERE store_id = ?').run(STORE);
    sqlite
      .prepare('INSERT INTO store_config (store_id, return_window_days) VALUES (?, ?)')
      .run(STORE, o.days ?? null);
  }
  return {
    order: order.id,
    customer: user.id,
    items: { tee: i1.id, cap: i2.id },
    products: { tee: tee.id, cap: cap.id },
    names,
  };
}

const item = (w: World, which: 'tee' | 'cap', quantity: number) => ({
  orderItemId: w.items[which],
  productId: w.products[which],
  productName: which === 'tee' ? 'Tee' : 'Cap',
  quantity,
});
const mkReturn = async (
  w: World,
  items: ReturnType<typeof item>[],
  extra: Record<string, unknown> = {}
) => {
  const r = await ReturnService.create(STORE, {
    orderId: w.order,
    customerId: w.customer,
    type: 'return',
    reason: 'wrong size',
    items,
    ...extra,
  } as never);
  // an include has no defined row order: compare the items as a set
  r.items.sort((a, b) => a.productName.localeCompare(b.productName));
  return r;
};
const received = async (id: string) => {
  await ReturnService.approve(STORE, id, 'actor-1', 'ok');
  await ReturnService.markReceived(STORE, id, 'actor-1');
};

/** Postgres reverses stock in the fanout (the DO already did in the completion section): run it inline there. */
const fanout = async (
  w: World,
  retId: string,
  items: Array<{ orderItemId: string; quantity: number }>,
  full = false
) => {
  if (await storeMoney(STORE)) return;
  await handleOrderRefunded(
    w.order,
    STORE,
    true,
    false,
    inlineStep,
    full ? undefined : { items, refundKey: retId }
  );
};

async function state(w: World) {
  const db = (await storeDb(STORE)) as any;
  const returns = await db.return.findMany({
    where: { orderId: w.order },
    select: {
      status: true,
      type: true,
      reason: true,
      reasonDetail: true,
      customerNotes: true,
      refundAmount: true,
      refundMethod: true,
      refundedAt: true,
      reversalRequestedAt: true,
      trackingNumber: true,
      approvedBy: true,
      approvedAt: true,
      rejectedBy: true,
      rejectionReason: true,
      adminNotes: true,
      shippedAt: true,
      receivedAt: true,
      items: {
        select: {
          orderItemId: true,
          productId: true,
          productName: true,
          quantity: true,
          reason: true,
          condition: true,
          tierAdjustment: true,
          tierCarry: true,
          adjustmentOverridden: true,
          adjustmentOverrideReason: true,
          adjustmentOverrideBy: true,
        },
      },
    },
  });
  const present = (v: unknown) => (v == null ? null : 'set');
  const wallets = await db.customerWallet.findMany({
    where: { customerId: w.customer },
    select: { balance: true },
  });
  const txns = await db.walletTransaction.findMany({
    where: { customerId: w.customer },
    select: {
      amount: true,
      type: true,
      idempotencyKey: true,
      returnId: true,
      orderId: true,
      balanceAfter: true,
    },
  });
  const stock = await db.product.findMany({
    where: { id: { in: [w.products.tee, w.products.cap] } },
    select: { id: true, inventory: true },
  });
  const entries = await db.journalEntry.findMany({
    where: { storeId: STORE, sourceId: { startsWith: w.order } },
    select: {
      sourceId: true,
      status: true,
      memo: true,
      memoAr: true,
      lines: {
        select: { accountId: true, debit: true, credit: true, lineMemo: true, refTable: true },
      },
    },
  });
  const code = (id: string) => Object.entries(accountId).find(([, v]) => v === id)?.[0] ?? id;
  const key = (r: unknown) => JSON.stringify(r).replace(UUID, '');
  const rk = (r: any) =>
    `${r.type}|${r.status}|${r.refundAmount}|${r.items.map((i: any) => `${i.productName}${i.quantity}`).join(',')}`;
  return {
    returns: returns
      .map((r: any) => ({
        ...r,
        refundedAt: present(r.refundedAt),
        reversalRequestedAt: present(r.reversalRequestedAt),
        approvedAt: present(r.approvedAt),
        shippedAt: present(r.shippedAt),
        receivedAt: present(r.receivedAt),
        items: r.items.sort((a: any, b: any) => key(a).localeCompare(key(b))),
      }))
      .sort((a: any, b: any) => rk(a).localeCompare(rk(b))),
    wallets,
    txns: txns.sort((a: any, b: any) => key(a).localeCompare(key(b))),
    stock: stock
      .sort((a: any, b: any) => a.inventory - b.inventory || a.id.localeCompare(b.id))
      .map((s: any) => s.inventory),
    journal: entries
      .map((e: any) => ({
        ...e,
        lines: e.lines
          .map((l: any) => ({ ...l, accountId: code(l.accountId) }))
          .sort((a: any, b: any) => key(a).localeCompare(key(b))),
      }))
      .sort((a: any, b: any) => key(a).localeCompare(key(b))),
  };
}

type WorldOpts = Parameters<typeof world>[1];
/** Both backends run the scenario in their own identical world; the scrubbed traces must be equal. */
async function parity(scenario: (w: World) => Promise<unknown>, opts: WorldOpts = {}) {
  const run = async (on: typeof onPg, mirror: boolean) => {
    const w = await world(mirror, opts);
    const out = await settle(() => on(() => scenario(w)));
    return scrub({ out, state: await on(() => state(w)) }, w.names);
  };
  const pg = await run(onPg, false);
  const dobj = await run(onDo, true);
  if (process.env.DEBUG_PARITY)
    (await import('node:fs')).writeFileSync(
      `/tmp/r1-${process.env.DEBUG_PARITY}-${n}.json`,
      JSON.stringify({ pg, dobj }, null, 1)
    );
  expect(dobj).toEqual(pg);
  return pg as any;
}

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: {
      email: `r1-${sfx}@example.test`,
      passwordHash: 'x'.repeat(60),
      firstName: 'R',
      lastName: 'One',
      role: 'store_admin',
      status: 'active',
      emailVerified: true,
    },
  });
  STORE = (
    await prisma.store.create({
      data: { name: 'R1', slug: `r1-${sfx}`, ownerId: owner.id, status: 'active' },
    })
  ).id;
  for (const [code, nameEn, type] of ACCOUNTS) {
    const a = await prisma.account.create({
      data: { storeId: STORE, code, nameEn, type, isSystem: true },
    });
    accountId[code] = a.id;
    insertSqlite(sqlite, 'Account', [a] as never);
  }
});
let walletOn = false;
beforeEach(() => {
  walletOn = false;
  vi.spyOn(EmailService, 'sendReturnConfirmation').mockResolvedValue(undefined as never);
  vi.spyOn(EmailService, 'sendReturnStatusUpdate').mockResolvedValue(undefined as never);
  vi.spyOn(featureService, 'isFeatureEnabled').mockImplementation(async () => walletOn);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.$disconnect();
});

describe.skipIf(!hasDb)(
  'returns: Postgres and the DO give the same answer and the same rows',
  () => {
    it('create: the estimate, the items and the pending row', async () => {
      const t = await parity(async w => mkReturn(w, [item(w, 'tee', 1), item(w, 'cap', 1)]));
      expect(t.state.returns[0]).toMatchObject({ status: 'pending', refundAmount: 15_000 });
    });

    it('create: over-claim across requests, a rejected request releases its claim', async () => {
      const t = await parity(async w => {
        const a = (await mkReturn(w, [item(w, 'tee', 2)])) as { id: string };
        const over = await settle(() => mkReturn(w, [item(w, 'tee', 1)]));
        await ReturnService.reject(STORE, a.id, 'actor-1', 'no');
        const again = await mkReturn(w, [item(w, 'tee', 2)]);
        return { over, again: (again as { status: string }).status };
      });
      expect(t.out.ok.over.err.code).toBe('INVALID_QUANTITY');
    });

    it('create: foreign customer, empty request, closed window, expired window', async () => {
      await parity(async w => {
        const foreign = await settle(() =>
          ReturnService.create(STORE, {
            orderId: w.order,
            customerId: w.order,
            type: 'return',
            reason: 'x',
            items: [item(w, 'tee', 1)],
          } as never)
        );
        const empty = await settle(() => mkReturn(w, []));
        return { foreign, empty };
      });
      const closed = await parity(async w => settle(() => mkReturn(w, [item(w, 'tee', 1)])), {
        days: 0,
      });
      expect(closed.out.ok.err).toMatchObject({ code: 'RETURN_WINDOW_CLOSED', status: 422 });
      await parity(async w => settle(() => mkReturn(w, [item(w, 'tee', 1)])), { days: 30 });
    });

    it('status changes and tracking: approve, ship, receive, reject keep the same columns', async () => {
      await parity(async w => {
        const a = (await mkReturn(w, [item(w, 'tee', 1)])) as { id: string };
        await ReturnService.approve(STORE, a.id, 'actor-1', 'fine');
        await ReturnService.updateTracking(STORE, a.id, 'TRK-1');
        await ReturnService.updateStatus(STORE, a.id, 'shipped' as never, 'actor-1');
        await ReturnService.markReceived(STORE, a.id, 'actor-1');
        const b = (await mkReturn(w, [item(w, 'cap', 1)])) as { id: string };
        await ReturnService.reject(STORE, b.id, 'actor-2', 'damaged');
        return settle(() => ReturnService.getById(STORE, 'nope'));
      });
    });

    it('complete: a partial return on a manual method, then a second one: refund amounts, rows, stock and the journal', async () => {
      const t = await parity(async w => {
        const a = (await mkReturn(w, [item(w, 'tee', 1)])) as { id: string };
        await received(a.id);
        const done1 = await ReturnService.complete(STORE, a.id, 'actor-1', 'manual');
        await fanout(w, a.id, [{ orderItemId: w.items.tee, quantity: 1 }]);
        const j1 = await postPartialReturnJournal({
          orderId: w.order,
          refundKey: a.id,
          items: [{ orderItemId: w.items.tee, quantity: 1 }],
          storeId: STORE,
        });
        const b = (await mkReturn(w, [item(w, 'tee', 1), item(w, 'cap', 1)])) as { id: string };
        await received(b.id);
        const done2 = await ReturnService.complete(STORE, b.id, 'actor-1', 'bank_transfer');
        await fanout(w, b.id, [
          { orderItemId: w.items.tee, quantity: 1 },
          { orderItemId: w.items.cap, quantity: 1 },
        ]);
        const j2 = await postPartialReturnJournal({
          orderId: w.order,
          refundKey: b.id,
          items: [
            { orderItemId: w.items.tee, quantity: 1 },
            { orderItemId: w.items.cap, quantity: 1 },
          ],
          storeId: STORE,
        });
        const replay = await postPartialReturnJournal({
          orderId: w.order,
          refundKey: b.id,
          items: [{ orderItemId: w.items.tee, quantity: 1 }],
          storeId: STORE,
        });
        return {
          r1: { status: done1.status, amount: done1.refundAmount },
          r2: { status: done2.status, amount: done2.refundAmount },
          j1,
          j2,
          replay,
        };
      });
      expect(t.out.ok.r1.amount + t.out.ok.r2.amount).toBe(25_000 - 2_500 + 3_150);
      expect(t.state.stock).toEqual([5, 5]); // tee 3 + 2 back, cap 4 + 1 back
    });

    it('complete: a full return reverses the order effects and posts no partial journal row', async () => {
      await parity(async w => {
        const a = (await mkReturn(w, [item(w, 'tee', 2), item(w, 'cap', 1)])) as { id: string };
        await received(a.id);
        const done = await ReturnService.complete(STORE, a.id, 'actor-1', 'manual');
        await fanout(w, a.id, [], true);
        return { status: done.status };
      });
    });

    it('complete: store credit with the wallet feature on credits the wallet once and the journal books the liability leg', async () => {
      walletOn = true;
      const t = await parity(async w => {
        const a = (await mkReturn(w, [item(w, 'tee', 1)])) as { id: string };
        await received(a.id);
        const done = await ReturnService.complete(STORE, a.id, 'actor-1', 'store_credit');
        await fanout(w, a.id, [{ orderItemId: w.items.tee, quantity: 1 }]);
        const j = await postPartialReturnJournal({
          orderId: w.order,
          refundKey: a.id,
          items: [{ orderItemId: w.items.tee, quantity: 1 }],
          storeId: STORE,
        });
        const again = await settle(() =>
          ReturnService.complete(STORE, a.id, 'actor-1', 'store_credit')
        );
        return { amount: done.refundAmount, j, again };
      });
      expect(t.state.wallets[0].balance).toBe(t.out.ok.amount);
      expect(t.state.txns).toHaveLength(1);
      expect(t.out.ok.again.err.code).toBe('INVALID_STATUS');
    });

    it('complete: store credit with the feature off records the amount and moves no wallet', async () => {
      const t = await parity(async w => {
        const a = (await mkReturn(w, [item(w, 'tee', 1)])) as { id: string };
        await received(a.id);
        const done = await ReturnService.complete(STORE, a.id, 'actor-1', 'store_credit');
        await fanout(w, a.id, [{ orderItemId: w.items.tee, quantity: 1 }]);
        await postPartialReturnJournal({
          orderId: w.order,
          refundKey: a.id,
          items: [{ orderItemId: w.items.tee, quantity: 1 }],
          storeId: STORE,
        });
        return done.refundAmount;
      });
      expect(t.state.txns).toHaveLength(0);
    });

    it('complete: refusals are the same (not received, double complete, exchange to a gateway)', async () => {
      await parity(async w => {
        const a = (await mkReturn(w, [item(w, 'tee', 1)])) as { id: string };
        const early = await settle(() => ReturnService.complete(STORE, a.id, 'actor-1', 'manual'));
        await received(a.id);
        await ReturnService.complete(STORE, a.id, 'actor-1', 'manual');
        await fanout(w, a.id, [{ orderItemId: w.items.tee, quantity: 1 }]);
        const twice = await settle(() => ReturnService.complete(STORE, a.id, 'actor-1', 'manual'));
        const x = (await mkReturn(w, [item(w, 'cap', 1)], { type: 'exchange' })) as { id: string };
        await received(x.id);
        const gateway = await settle(() =>
          ReturnService.complete(STORE, x.id, 'actor-1', 'original')
        );
        return { early, twice, gateway };
      });
    });

    it('complete: an order paid partly from the wallet keeps the same figures on a store-credit completion', async () => {
      walletOn = true;
      await parity(
        async w => {
          const a = (await mkReturn(w, [item(w, 'tee', 1)])) as { id: string };
          await received(a.id);
          const done = await ReturnService.complete(STORE, a.id, 'actor-1', 'store_credit');
          await fanout(w, a.id, [{ orderItemId: w.items.tee, quantity: 1 }]);
          return done.refundAmount;
        },
        { walletAmount: 5_000 }
      );
    });

    it('refundPreview and the listings read the same', async () => {
      await parity(async w => {
        const a = (await mkReturn(w, [item(w, 'tee', 1)])) as { id: string };
        await received(a.id);
        const prev = await settle(() => ReturnService.refundPreview(STORE, a.id));
        const list = await ReturnService.list(STORE, {});
        const mine = await ReturnService.getCustomerReturns(STORE, w.customer, {});
        const stats = await ReturnService.getStats(STORE);
        return {
          prev: (prev as any).ok ? { ...(prev as any).ok, returnId: 'x' } : prev,
          listed: list.returns.filter((r: any) => r.orderId === w.order).length,
          mine: mine.meta.total,
          statsHasReason: stats.byReason.some(r => r.reason === 'wrong size'),
        };
      });
    });

    it('the amount-only refund journal books once per key and skips an unknown order', async () => {
      await parity(async w => {
        const a = await postAmountOnlyRefundJournal({
          orderId: w.order,
          refundKey: 'refund:abc',
          amount: 700,
          storeId: STORE,
        });
        const b = await postAmountOnlyRefundJournal({
          orderId: w.order,
          refundKey: 'refund:abc',
          amount: 700,
          storeId: STORE,
        });
        const c = await postAmountOnlyRefundJournal({
          orderId: w.order,
          refundKey: 'refund:zero',
          amount: 0,
          storeId: STORE,
        });
        return { a, b, c };
      });
    });

    it('the partial journal skips as Postgres does: no sale entry, unknown order', async () => {
      const t = await parity(
        async w => {
          const none = await postPartialReturnJournal({
            orderId: w.order,
            refundKey: 'k1',
            items: [{ orderItemId: w.items.tee, quantity: 1 }],
            storeId: STORE,
          });
          return none;
        },
        { sale: false }
      );
      expect(t.out.ok.skipped).toBe('no-original-entry');
    });
  }
);
