/**
 * INFRA-CF-1 R3 (Ruling INSTAPAY-DO-1): InstaPay ORDER receipts moved to the StoreDO give the same answers and leave the same
 * rows on Postgres and on the DO. Each test is a SCENARIO driving the real services (upload, AI read, submit, reject, confirm);
 * it runs once on Postgres (unchanged code) and once with the DO money client over the real DO schema on SQLite. The scrubbed
 * traces (return values or error, then the receipts / order / payment rows) must be equal.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCfBindings } from '../../apps/api/src/cf/bindings';
import {
  claimInstapayReference,
  withClaimReleases,
} from '../../apps/api/src/lib/instapay-ref-claim';
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
import {
  makeMoneyClient,
  storeDb,
  withRepo,
  type StoreReads,
  type StoreWrites,
} from '../../apps/api/src/lib/repo-factory';
import { AppError } from '../../apps/api/src/middleware/error-handler';
import { META, canon, insertSqlite, openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { nodeSyncSql } from '../../packages/repo/test/node-sync-sql';
import { hasDb } from '../helpers/bundle-fixtures';
import { inngest } from '../../apps/api/src/lib/inngest/client';
import { InstapayReceiptService } from '../../apps/api/src/services/payment-providers/instapay-receipt.service';
import {
  fieldsFrom,
  freshReference,
  mockPrivateStorage,
  resetModel,
  uniqueImage,
  useRecordedModel,
} from '../helpers/instapay-receipt-fixtures';
import { InstapayService } from '../../apps/api/src/services/payment-providers/instapay.service';

const sfx = Date.now().toString(36);
let STORE = '';
let ownerId = '';
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
      .replace(/ORD-[A-Z0-9-]+/g, '<no>')
      .replace(/\b\d{12}\b/g, '<ref>')
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

const TOTAL = 123_450;
const HANDLE = 'demostore@instapay';
let n = 0;
/** An InstaPay order awaiting the merchant, paid to demostore@instapay, 1,234.50 EGP, mirrored into the DO. */
async function world(mirror: boolean) {
  const k = `${sfx}${++n}`;
  const order = await prisma.order.create({
    data: {
      storeId: STORE,
      orderNumber: `IP-${k}`,
      status: 'awaiting_payment_confirmation',
      paymentStatus: 'unpaid',
      subtotal: TOTAL,
      tax: 0,
      shipping: 0,
      discount: 0,
      total: TOTAL,
      currency: 'EGP',
      shippingAddress: {},
      billingAddress: {},
      paymentConfirmationExpiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  const payment = await prisma.payment.create({
    data: {
      orderId: order.id,
      provider: 'instapay',
      status: 'pending',
      amount: TOTAL,
      currency: 'EGP',
      metadata: { handle: HANDLE },
    },
  });
  if (mirror) {
    insertSqlite(sqlite, 'Order', [order] as never);
    insertSqlite(sqlite, 'Payment', [payment] as never);
  }
  return { order: order.id, payment: payment.id };
}
type W = { order: string; payment: string };

async function state(w: W) {
  const db = (await storeDb(STORE)) as any;
  const receipts = (await InstapayReceiptService.listForOrder(STORE, w.order)).map(r => ({
    status: r.status,
    reference: r.fields.reference,
    flags: [...r.flags].sort(),
    reviewNote: r.reviewNote,
    amount: r.fields.amountMinor,
    submitted: r.submittedAt !== null,
  }));
  const order = await db.order.findFirst({
    where: { id: w.order },
    select: { status: true, paymentStatus: true, paymentConfirmationExpiresAt: true },
  });
  const pay = await db.payment.findFirst({
    where: { orderId: w.order },
    select: { status: true, metadata: true },
  });
  const events = await db.paymentEvent.findMany({
    where: { orderId: w.order },
    select: { eventType: true, details: true },
    orderBy: { createdAt: 'asc' },
  });
  return {
    receipts,
    order: { ...order, paymentConfirmationExpiresAt: order.paymentConfirmationExpiresAt !== null },
    payment: {
      status: pay.status,
      customerReference: (pay.metadata as any)?.customerReference ?? null,
      hasReceiptId: !!(pay.metadata as any)?.receiptId,
    },
    events: events.map((e: any) => `${e.eventType}:${e.details?.reason ?? ''}`).sort(),
  };
}

async function parity(act: (w: W) => Promise<unknown>) {
  const run = async (on: typeof onPg, mirror: boolean) => {
    const w = await world(mirror);
    const out = await settle(() => on(() => act(w)));
    return scrub(
      { out, state: await on(() => state(w)) },
      { [w.order]: 'order', [w.payment]: 'payment' }
    );
  };
  const pg = await run(onPg, false);
  const dobj = await run(onDo, true);
  expect(dobj).toEqual(pg);
  return pg as any;
}

/** upload -> AI read -> (returns the receipt id) */
async function uploaded(w: W): Promise<string> {
  const v = await InstapayService.uploadReceipt(STORE, w.order, uniqueImage('receipt-sent'));
  await InstapayReceiptService.runExtraction(STORE, v.id);
  return v.id;
}
const submit = (w: W, receiptId: string, reference?: string) =>
  InstapayService.submitReceipt({
    storeId: STORE,
    orderId: w.order,
    receiptId,
    fields: fieldsFrom('receipt-sent', { reference: reference ?? freshReference() }),
  });

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: {
      email: `r3ip-${sfx}@example.test`,
      passwordHash: 'x'.repeat(60),
      firstName: 'R',
      lastName: 'I',
      role: 'store_admin',
      status: 'active',
      emailVerified: true,
    },
  });
  ownerId = owner.id;
  STORE = (
    await prisma.store.create({
      data: { name: 'R3Ip', slug: `r3ip-${sfx}`, ownerId: owner.id, status: 'active' },
    })
  ).id;
});
beforeEach(() => {
  mockPrivateStorage();
  useRecordedModel('receipt-sent');
  vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);
  vi.spyOn(InstapayService, 'notifyMerchant').mockResolvedValue(undefined as never);
});
afterAll(async () => {
  vi.restoreAllMocks();
  resetModel();
  await prisma.$disconnect();
});

describe.skipIf(!hasDb)('InstaPay order receipts on Postgres vs the DO', () => {
  it('upload, AI read, submit: the receipt is submitted, the hold is frozen, the payment remembers the reference', async () => {
    const t = await parity(async w => {
      const id = await uploaded(w);
      const view = await submit(w, id);
      return { status: view.status, flags: [...view.flags].sort() };
    });
    expect(t.out.ok.status).toBe('submitted');
    expect(t.state.order.paymentConfirmationExpiresAt).toBe(false);
    expect(t.state.payment.customerReference).not.toBeNull();
    expect(t.state.events).toContain('status_change:customer_receipt_submitted');
  });

  it('a second submit of the same receipt, and a second receipt while one waits, are refused', async () => {
    const again = await parity(async w => {
      const id = await uploaded(w);
      await submit(w, id);
      return submit(w, id);
    });
    expect(again.out.err.code).toBe('PROOF_PENDING_REVIEW');
    const second = await parity(async w => {
      await submit(w, await uploaded(w));
      return submit(w, await uploaded(w), freshReference());
    });
    expect(second.out.err.code).toBe('PROOF_PENDING_REVIEW');
  });

  it('the same transfer reference cannot pay twice (a second order of the store)', async () => {
    const ref = freshReference();
    const t = await parity(async w => {
      await submit(w, await uploaded(w), ref);
      const w2 = await world(true); // also in the DO mirror; harmless extra row on Postgres
      return submit(w2, await uploaded(w2), ref).catch((e: { code: string }) => ({
        refused: e.code,
      }));
    });
    expect(t.out.ok).toEqual({ refused: 'DUPLICATE_REFERENCE' });
  });

  it('reject frees the reference, restarts the hold and lets the shopper file the right receipt', async () => {
    const ref = freshReference();
    const t = await parity(async w => {
      const id = await uploaded(w);
      await submit(w, id, ref);
      const rejected = await InstapayService.rejectReceipt({
        storeId: STORE,
        orderId: w.order,
        receiptId: id,
        note: 'wrong amount',
        actorUserId: ownerId,
      });
      const refiled = await submit(w, await uploaded(w), ref);
      return { rejected: rejected.status, refiled: refiled.status };
    });
    expect(t.out.ok).toEqual({ rejected: 'rejected', refiled: 'submitted' });
    expect(t.state.receipts.map((r: any) => r.status).sort()).toEqual(['rejected', 'submitted']);
  });

  it('a rejected receipt cannot be submitted again', async () => {
    const t = await parity(async w => {
      const id = await uploaded(w);
      await submit(w, id);
      await InstapayService.rejectReceipt({
        storeId: STORE,
        orderId: w.order,
        receiptId: id,
        note: 'blurry',
        actorUserId: ownerId,
      });
      return submit(w, id);
    });
    expect(t.out.err.code).toBe('RECEIPT_NOT_DRAFT');
  });

  it('the merchant confirm approves the submitted receipt, once; a second tap changes nothing', async () => {
    const t = await parity(async w => {
      await submit(w, await uploaded(w));
      const first = await InstapayService.confirm({
        storeId: STORE,
        orderId: w.order,
        actorUserId: ownerId,
      });
      const second = await InstapayService.confirm({
        storeId: STORE,
        orderId: w.order,
        actorUserId: ownerId,
      });
      return { first: first.changed, second: second.changed };
    });
    expect(t.out.ok).toEqual({ first: true, second: false });
    expect(t.state.receipts[0].status).toBe('approved');
    expect(t.state.order.status).toBe('confirmed');
  });

  it('a seventh upload for one order is refused', async () => {
    const t = await parity(async w => {
      for (let i = 0; i < 6; i++)
        await InstapayService.uploadReceipt(STORE, w.order, uniqueImage('receipt-sent'));
      return InstapayService.uploadReceipt(STORE, w.order, uniqueImage('receipt-sent'));
    });
    expect(t.out.err.code).toBe('TOO_MANY_RECEIPTS');
  });
});

/**
 * INSTAPAY-DO-1, the Postgres half: a Postgres store's receipts claim their reference in D1 `entity_index` too, so a Postgres
 * store and a DO store share ONE uniqueness space. The D1 double runs the real statements on SQLite over the real migration.
 */
describe.skipIf(!hasDb)(
  'InstaPay reference claims: Postgres stores share the D1 uniqueness space',
  () => {
    const mig = fs.readFileSync(
      path.join(__dirname, '../../packages/cf-schema/migrations/platform/0001_init.sql'),
      'utf8'
    );
    const ddl = /CREATE TABLE IF NOT EXISTS "entity_index"[\s\S]*?\n\);/.exec(mig)![0];
    let d1db: DatabaseSync;
    const claims = () =>
      d1db
        .prepare("SELECT id, store_id, claim_ref FROM entity_index WHERE kind = 'instapay_ref'")
        .all() as any[];
    beforeEach(() => {
      d1db = new DatabaseSync(':memory:');
      d1db.exec(ddl);
      // the backend flag table (lib/store-backend.ts reads it once D1 is bound): this store is on Postgres
      d1db.exec(
        "CREATE TABLE stores (id TEXT PRIMARY KEY, storage_backend TEXT NOT NULL DEFAULT 'pg')"
      );
      d1db.prepare('INSERT INTO stores (id, storage_backend) VALUES (?, ?)').run(STORE, 'pg');
      setCfBindings({
        PLATFORM_DB: {
          prepare: (sql: string) => ({
            bind: (...v: unknown[]) => ({
              run: async () => ({
                meta: { changes: Number(d1db.prepare(sql).run(...(v as never[])).changes) },
              }),
              first: async () => (d1db.prepare(sql).get(...(v as never[])) as never) ?? null,
            }),
          }),
        },
      } as never);
    });
    afterEach(() => setCfBindings(undefined as never));

    it('a Postgres submit holds the reference in D1; a DO store of another tenant is refused it', async () => {
      const w = await world(false);
      const ref = freshReference();
      const id = await uploaded(w);
      await submit(w, id, ref);
      expect(claims()).toHaveLength(1);
      expect(claims()[0].claim_ref).toBe(id);
      expect(await claimInstapayReference(claims()[0].id, 'some-do-store', 'do-receipt')).toBe(
        'taken'
      );
    });

    it('a Postgres submit of a reference a DO store already holds is a 409 DUPLICATE_REFERENCE and writes nothing', async () => {
      const w = await world(false);
      const ref = freshReference();
      const id = await uploaded(w);
      const key = ref.replace(/\D/g, '');
      await claimInstapayReference(key, 'some-do-store', 'do-receipt');
      await expect(submit(w, id, ref)).rejects.toMatchObject({ code: 'DUPLICATE_REFERENCE' });
      expect(claims()).toHaveLength(1);
      expect(claims()[0].store_id).toBe('some-do-store');
      const r = await prisma.instapayReceipt.findUnique({ where: { id } });
      expect(r?.status).toBe('draft');
    });

    it('20 submits of one reference from 20 Postgres orders: one wins', async () => {
      const ref = freshReference();
      const ws = await Promise.all(Array.from({ length: 20 }, () => world(false)));
      const ids = await Promise.all(ws.map(w => uploaded(w)));
      const out = await Promise.allSettled(ws.map((w, i) => submit(w, ids[i], ref)));
      expect(out.filter(o => o.status === 'fulfilled')).toHaveLength(1);
      expect(claims()).toHaveLength(1);
    });

    it('rejecting the receipt frees the claim so the same transfer may be filed again', async () => {
      const w = await world(false);
      const ref = freshReference();
      const id = await uploaded(w);
      await submit(w, id, ref);
      expect(claims()).toHaveLength(1);
      await InstapayService.rejectReceipt({
        storeId: STORE,
        orderId: w.order,
        receiptId: id,
        note: 'wrong receiver',
        actorUserId: ownerId,
      });
      await new Promise(r => setTimeout(r, 50));
      expect(claims()).toHaveLength(0);
    });

    it('a rollback after the receipt was rejected leaves the claim HELD; a commit frees it; no scope refuses', async () => {
      const w = await world(false);
      const id = await uploaded(w);
      await submit(w, id, freshReference());
      expect(claims()).toHaveLength(1);
      const reject = () =>
        InstapayReceiptService.markReviewed(
          STORE,
          id,
          { status: 'rejected', note: 'wrong receiver' },
          ownerId
        );
      // the transaction that freed the reference fails after the write: nothing is released
      await expect(
        withClaimReleases(async () => {
          await reject();
          throw new Error('postgres transaction fails after the write');
        })
      ).rejects.toThrow('postgres transaction fails');
      expect(claims()).toHaveLength(1);
      // outside any release scope the free is refused (and the receipt is not even rejected twice: it is already rejected)
      await submit(w, await uploaded(w), freshReference()).catch(() => undefined);
      // a committed scope releases
      const w2 = await world(false);
      const id2 = await uploaded(w2);
      await submit(w2, id2, freshReference());
      const before = claims().length;
      await withClaimReleases(() =>
        InstapayReceiptService.markReviewed(
          STORE,
          id2,
          { status: 'rejected', note: 'wrong receiver' },
          ownerId
        )
      );
      expect(claims().length).toBe(before - 1);
      const w3 = await world(false);
      const id3 = await uploaded(w3);
      await submit(w3, id3, freshReference());
      await expect(
        InstapayReceiptService.markReviewed(
          STORE,
          id3,
          { status: 'rejected', note: 'wrong receiver' },
          ownerId
        )
      ).rejects.toThrow(/release refused/);
    });
  }
);
