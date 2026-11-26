/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * END-TO-END MONEY JOURNEYS on a Durable Object store, Postgres absent: the built Worker, a store on D1 + its StoreDO, the
 * storefront and merchant routes the real screens call, and the BOOKS at the end of each journey. The sibling files prove a
 * step each (money-path: payment create + gateway webhooks; merchant-orders-do: the InstaPay refund record; workers-do/*:
 * one DO operation under concurrency); this file walks a whole journey and checks the per-order journal it leaves.
 *
 *   J1 COD: checkout -> payment row -> confirmed -> shipped -> delivered -> payment completed + order paid -> sale + COGS
 *      entries, balanced, cash on the COD account (1020) = the order total; a repeated "delivered" books nothing twice.
 *   J2 InstaPay: checkout -> receipt upload (R2) + submit -> the merchant's confirm-instapay route -> paid -> sale entry,
 *      cash on 1000 = the total; a second order submitting the SAME transfer reference is refused.
 *   J3 refund: on the J2 order, a partial InstaPay refund -> payment partially_refunded, refundable = total - partial
 *      (the admin's payment read) -> a refund entry, balanced, crediting cash by the partial; a refund over the remainder
 *      is 400 and changes nothing.
 *
 * Unknown is never zero: every money figure read below is first asserted to be a finite number (a missing field, a null
 * or a failed read must fail the journey, never pass as 0 because 0 is what the arithmetic expected).
 *
 * Run: npm run -w apps/api cf:dry-run && npx vitest run --config vitest.workers.config.mts workers-test/money-journeys.test.ts
 */
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { DEFAULT_PLAN_SEEDS } from '@ebda/shared';
import { accessToken, authState } from './helpers';

type DoAnswer = { ok: true; json: string } | { ok: false; code: string; message?: string };

const e = env as unknown as {
  API: { fetch(u: string, i?: RequestInit): Promise<Response> };
  E2E_DB: string;
  PLATFORM_DB: {
    prepare(sql: string): {
      bind(...v: unknown[]): { run(): Promise<unknown>; first<T>(): Promise<T | null> };
    };
  };
  TEST_PLATFORM_MIGRATIONS: unknown[];
  STORE_DO: {
    idFromName(n: string): unknown;
    get(id: unknown): {
      mutate(storeId: string, m: unknown): Promise<DoAnswer>;
      query(storeId: string, q: unknown[]): Promise<DoAnswer>;
    };
  };
};

const BASE = 'https://api.ebda.app/api/v1';
const MARKER_KEYS = [
  'platform_cutover.billing',
  'platform_cutover.access',
  'platform_cutover.platform',
  'platform_cutover.inbox',
  'platform_cutover.ai-usage',
  'platform_cutover.analytics',
  'platform_cutover.payments',
  'platform_cutover.ops',
  'platform_cutover.audit',
  'customer_auth_cutover.__all',
];
let ip = 0;
const freshIp = () => `10.79.${(ip >> 8) & 255}.${ip++ & 255}`;

const stub = (storeId: string) => e.STORE_DO.get(e.STORE_DO.idFromName(storeId));
const unwrap = <T>(a: DoAnswer): T => {
  if (!a.ok) throw new Error(`DO refused: ${a.code} ${a.message ?? ''}`);
  return JSON.parse(a.json) as T;
};
async function doRead<T>(storeId: string, model: string, args: Record<string, unknown>) {
  return unwrap<T[]>(await stub(storeId).query(storeId, [{ model, op: 'findMany', args }]))[0];
}
async function pgReaches(reset = false): Promise<Array<{ label: string; stack: string }>> {
  const r = await e.API.fetch(`https://api.ebda.app/__dev/pg-reaches${reset ? '?reset=1' : ''}`);
  return ((await r.json()) as { reaches: Array<{ label: string; stack: string }> }).reaches;
}
const api = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  e.API.fetch(`${BASE}${path}`, {
    ...init,
    redirect: 'manual',
    headers: {
      'cf-connecting-ip': freshIp(),
      ...(init.body !== undefined && !(init.body instanceof FormData)
        ? { 'content-type': 'application/json' }
        : {}),
      ...init.headers,
    },
  });
/** Poll until `fn` is truthy (the post-payment fan-out runs off the request). */
async function until<T>(fn: () => Promise<T | null | undefined>, ms = 20_000): Promise<T | null> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v || Date.now() - t0 > ms) return v ?? null;
    await new Promise(r => setTimeout(r, 200));
  }
}

/** Unknown is never zero: a money figure must be a real, finite number before any arithmetic is checked. */
function known(v: unknown, what: string): number {
  expect(typeof v, `${what} is a known number (got ${JSON.stringify(v)})`).toBe('number');
  expect(Number.isFinite(v as number), `${what} is finite`).toBe(true);
  return v as number;
}

/** A 1x1 PNG: the receipt screenshot the shopper uploads (the AI pre-fill is not configured here, the shopper types). */
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  ),
  c => c.charCodeAt(0)
);

describe.skipIf(e.E2E_DB === '1')(
  'end-to-end money journeys on a Durable Object store, down to the journal',
  () => {
    let storeId = '';
    let productId = '';
    const owner = 'owner-journeys';
    let merchant: Record<string, string> = {};
    let nSession = 0;
    const PRICE = 5000;
    const COST = 2000;

    /** A real storefront checkout (cart line, POST /public/orders, payment row); returns the order and its guest view token. */
    async function checkout(method: 'cod' | 'instapay') {
      const h: Record<string, string> = {
        'x-store-id': storeId,
        'x-session-id': `sess-journeys-${++nSession}`,
      };
      const add = await api('/public/cart/items', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ productId, quantity: 2 }),
      });
      expect(add.status, await add.clone().text()).toBeLessThan(300);
      const res = await api('/public/orders', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({
          paymentMethod: method,
          shippingAddress: {
            firstName: 'Journey',
            lastName: 'Buyer',
            address1: '1 Test St',
            city: 'Cairo',
            phone: `+2010${String(5_000_000 + nSession).padStart(8, '0')}`,
            country: 'EG',
          },
        }),
      });
      const text = await res.text();
      expect(res.status, text).toBeLessThan(300);
      const j = JSON.parse(text) as {
        data: { id?: string; viewToken?: string; order?: { id: string; viewToken?: string } };
      };
      const orderId = j.data.order?.id ?? j.data.id!;
      const viewToken = j.data.viewToken ?? j.data.order?.viewToken ?? '';
      const pay = await api('/payments/create', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ orderId, provider: method }),
      });
      expect(pay.status, await pay.clone().text()).toBe(200);
      const total = known((await order(orderId)).total, 'order total');
      expect(total).toBeGreaterThan(0);
      return { orderId, viewToken, total };
    }

    const order = async (orderId: string) =>
      (
        await doRead<Array<{ status: string; paymentStatus: string; total: number }>>(
          storeId,
          'Order',
          { where: { id: orderId } }
        )
      )[0];
    const payment = async (orderId: string, provider: string) =>
      (
        await doRead<Array<{ status: string; amount: number; refundedAmount: number }>>(
          storeId,
          'Payment',
          { where: { orderId, provider } }
        )
      )[0];
    const setStatus = async (orderId: string, to: string) => {
      const r = await api(`/stores/${storeId}/orders/${orderId}/status`, {
        method: 'PUT',
        headers: merchant,
        body: JSON.stringify({ status: to }),
      });
      return { status: r.status, text: await r.text() };
    };

    /** The journal of one order: each entry whose source id is the order (`<id>`, `<id>:cogs`, `<id>:...`), with its lines. */
    async function books(orderId: string) {
      const accounts = await doRead<Array<{ id: string; code: string }>>(storeId, 'Account', {
        where: { storeId },
      });
      const code = new Map(accounts.map(a => [a.id, a.code]));
      const entries = await doRead<
        Array<{ id: string; source: string; sourceId: string | null; status: string }>
      >(storeId, 'JournalEntry', { where: { storeId, source: 'order' } });
      const mine = entries.filter(
        x => x.sourceId === orderId || (x.sourceId ?? '').startsWith(`${orderId}:`)
      );
      const out: Array<{
        sourceId: string;
        status: string;
        lines: Array<{ code: string; debit: number; credit: number }>;
      }> = [];
      for (const en of mine) {
        const lines = await doRead<Array<{ accountId: string; debit: number; credit: number }>>(
          storeId,
          'JournalLine',
          { where: { entryId: en.id } }
        );
        out.push({
          sourceId: en.sourceId ?? '',
          status: en.status,
          lines: lines.map(l => ({
            code: code.get(l.accountId) ?? '?',
            debit: known(l.debit, `debit of ${en.sourceId}`),
            credit: known(l.credit, `credit of ${en.sourceId}`),
          })),
        });
      }
      return out;
    }
    /** An entry balances: debits equal credits, and it is not empty. */
    function balanced(entry: {
      sourceId: string;
      lines: Array<{ debit: number; credit: number }>;
    }) {
      const dr = entry.lines.reduce((s, l) => s + l.debit, 0);
      const cr = entry.lines.reduce((s, l) => s + l.credit, 0);
      expect(dr, `${entry.sourceId} has lines`).toBeGreaterThan(0);
      expect(dr, `${entry.sourceId} balances`).toBe(cr);
    }
    const sum = (
      entry: { lines: Array<{ code: string; debit: number; credit: number }> },
      code: string,
      side: 'debit' | 'credit'
    ) => entry.lines.filter(l => l.code === code).reduce((s, l) => s + l[side], 0);

    it('fixture: a DO store with the books on, COD + InstaPay, a costed product', async () => {
      await applyD1Migrations(e.PLATFORM_DB as never, e.TEST_PLATFORM_MIGRATIONS as never);
      for (const p of DEFAULT_PLAN_SEEDS)
        await e.PLATFORM_DB.prepare(
          'INSERT OR IGNORE INTO plans (id, code, name_en, name_ar, feature_tier, limits, price_monthly_minor, price_yearly_minor) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)'
        )
          .bind(
            `plan-${p.code}`,
            p.code,
            p.nameEn,
            p.nameAr,
            p.featureTier,
            JSON.stringify(p.limits),
            p.priceMonthlyMinor,
            p.priceYearlyMinor
          )
          .run();
      for (const [i, k] of MARKER_KEYS.entries())
        await e.PLATFORM_DB.prepare(
          'INSERT OR REPLACE INTO system_settings (id, key, value) VALUES (?1, ?2, \'{"on":true}\')'
        )
          .bind(`journeys-marker-${i}`, k)
          .run();
      const created = await e.API.fetch('https://api.ebda.app/__dev/create-store', {
        method: 'POST',
        body: JSON.stringify({
          ownerId: owner,
          name: 'Journeys Shop',
          slug: 'journeys-shop',
          operator: true,
        }),
      });
      expect(created.status).toBe(200);
      storeId = ((await created.json()) as { id: string }).id;
      // before any request (the plan / feature answers are cached): a paid plan with the basic books switched on
      await e.PLATFORM_DB.prepare(
        "UPDATE store_subscriptions SET plan_code = 'pro', status = 'active' WHERE store_id = ?1"
      )
        .bind(storeId)
        .run();
      await e.PLATFORM_DB.prepare(
        'INSERT OR REPLACE INTO store_features (id, store_id, feature_key, enabled, enabled_at) VALUES (?1, ?2, ?3, 1, ?4)'
      )
        .bind('journeys-accounting', storeId, 'accounting.basic', Date.now())
        .run();
      await authState(`user:tv:${owner}`, [['set', `user:tv:${owner}`, '0', {}]]);
      const sa = await accessToken({
        userId: owner,
        jti: 'j-journeys-owner',
        role: 'store_admin',
        storeId,
      });
      merchant = { authorization: `Bearer ${sa}`, 'x-store-id': storeId };

      const cfg = (provider: string, extra: Record<string, unknown>) => ({
        model: 'PaymentConfig',
        op: 'create',
        args: {
          data: {
            id: crypto.randomUUID(),
            storeId,
            provider,
            isEnabled: true,
            isDefault: provider === 'cod',
            testMode: true,
            displayName: provider,
            ...extra,
          },
        },
      });
      const wrote = await stub(storeId).mutate(storeId, {
        ops: [
          cfg('cod', {}),
          cfg('instapay', { settings: { handle: 'journeys@instapay', expiryHours: 24 } }),
        ],
      });
      expect(wrote.ok, JSON.stringify(wrote)).toBe(true);

      productId = crypto.randomUUID();
      const now = Date.now();
      const seeded = await e.API.fetch(`${BASE}/internal/store-do/${storeId}/seed`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer workers-test-seed-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          products: [
            {
              id: productId,
              storeId,
              name: 'Journey Lamp',
              nameAr: 'أباجورة',
              slug: 'journey-lamp',
              sku: 'JRN-1',
              price: PRICE,
              costPrice: COST,
              inventory: 100,
              status: 'active',
              createdAt: now,
              updatedAt: now,
            },
          ],
        }),
      });
      expect(seeded.status, await seeded.clone().text()).toBe(200);
      // the seed channel writes no cost price (cf/store-do/repo.ts seed): set it as the merchant's product edit would
      const costed = await stub(storeId).mutate(storeId, {
        ops: [
          {
            model: 'Product',
            op: 'update',
            args: { where: { id: productId, storeId }, data: { costPrice: COST } },
          },
        ],
      });
      expect(costed.ok, JSON.stringify(costed)).toBe(true);
      const prod = (
        await doRead<Array<{ costPrice: number | null }>>(storeId, 'Product', {
          where: { id: productId },
        })
      )[0];
      expect(known(prod?.costPrice, 'product cost price')).toBe(COST);
      await pgReaches(true);
    }, 180_000);

    it('J1 COD: checkout -> shipped -> delivered -> paid -> sale + COGS booked, balanced; a second "delivered" books nothing', async () => {
      const { orderId, total } = await checkout('cod');
      expect(await order(orderId)).toMatchObject({ paymentStatus: 'unpaid' });
      expect((await payment(orderId, 'cod'))?.status).toBe('cod_pending');
      for (const to of ['confirmed', 'shipped', 'delivered']) {
        const r = await setStatus(orderId, to);
        expect(r.status, `${to}: ${r.text.slice(0, 200)}`).toBeLessThan(300);
      }
      // cash collected at the door: the payment completes and the order is paid (codCollectedOnDelivery)
      expect(await order(orderId)).toMatchObject({ status: 'delivered', paymentStatus: 'paid' });
      const pay = await payment(orderId, 'cod');
      expect(pay?.status).toBe('completed');
      expect(known(pay?.amount, 'COD payment amount')).toBe(total);

      // the post-payment fan-out books the sale (order/created -> accounting-post-order-journal)
      const posted = await until(async () => {
        const b = await books(orderId);
        return b.some(x => x.sourceId === orderId) && b.some(x => x.sourceId === `${orderId}:cogs`)
          ? b
          : null;
      });
      expect(posted, 'sale + COGS entries posted').not.toBeNull();
      const sale = posted!.find(x => x.sourceId === orderId)!;
      const cogs = posted!.find(x => x.sourceId === `${orderId}:cogs`)!;
      balanced(sale);
      balanced(cogs);
      expect(sum(sale, '1020', 'debit'), 'cash on the COD account = the order total').toBe(total);
      expect(sum(cogs, '5000', 'debit'), 'COGS = qty x cost').toBe(2 * COST);
      expect(sum(cogs, '1200', 'credit'), 'inventory out = COGS').toBe(2 * COST);

      // a repeated "delivered" (a double click, a courier webhook racing the merchant) books nothing twice
      await setStatus(orderId, 'delivered');
      const again = await books(orderId);
      expect(again.filter(x => x.sourceId === orderId)).toHaveLength(1);
      expect(again.filter(x => x.sourceId === `${orderId}:cogs`)).toHaveLength(1);
      expect(reachReport(await pgReaches())).toBe('');
    }, 120_000);

    let instapayOrder = { orderId: '', total: 0 };
    const REF = '123456789012';

    it('J2 InstaPay: receipt upload + submit -> merchant confirm -> paid -> sale booked on 1000; the same transfer reference on another order is refused', async () => {
      const { orderId, viewToken, total } = await checkout('instapay');
      instapayOrder = { orderId, total };
      expect(viewToken, 'the guest checkout hands back its view token').not.toBe('');
      const shopper = { 'x-store-id': storeId, 'x-order-view-token': viewToken };

      const receiptId = async (oid: string, h: Record<string, string>) => {
        const form = new FormData();
        form.append('file', new Blob([PNG], { type: 'image/png' }), 'receipt.png');
        const up = await api(`/payments/instapay/${oid}/receipt`, {
          method: 'POST',
          headers: h,
          body: form,
        });
        const text = await up.text();
        expect(up.status, text.slice(0, 300)).toBe(201);
        return (JSON.parse(text) as { data: { receipt: { id: string } } }).data.receipt.id;
      };
      const submit = (oid: string, rid: string, h: Record<string, string>, amountMinor: number) =>
        api(`/payments/instapay/${oid}/receipt/${rid}/submit`, {
          method: 'POST',
          headers: h,
          body: JSON.stringify({
            amountMinor,
            reference: REF,
            transferDate: '2026-11-17',
            transferTime: '12:30',
            payerName: 'N*** B***',
          }),
        });

      const rid = await receiptId(orderId, shopper);
      const sub = await submit(orderId, rid, shopper, total);
      expect(sub.status, (await sub.clone().text()).slice(0, 300)).toBe(201);

      // the merchant saw the money and confirms through the real route (this IS the approval of the receipt)
      const conf = await api(`/stores/${storeId}/orders/${orderId}/confirm-instapay`, {
        method: 'POST',
        headers: merchant,
        body: JSON.stringify({}),
      });
      expect(conf.status, (await conf.clone().text()).slice(0, 300)).toBe(200);
      expect((await order(orderId)).paymentStatus).toBe('paid');
      const pay = await payment(orderId, 'instapay');
      expect(pay?.status).toBe('completed');
      expect(known(pay?.amount, 'InstaPay payment amount')).toBe(total);

      const posted = await until(async () => {
        const b = await books(orderId);
        return b.find(x => x.sourceId === orderId) ?? null;
      });
      expect(posted, 'sale entry posted').not.toBeNull();
      balanced(posted!);
      expect(sum(posted!, '1000', 'debit'), 'cash on the InstaPay account = the order total').toBe(
        total
      );

      // a second order claiming the SAME bank transfer is refused: one transfer pays one order
      const other = await checkout('instapay');
      const otherShopper = { 'x-store-id': storeId, 'x-order-view-token': other.viewToken };
      const rid2 = await receiptId(other.orderId, otherShopper);
      const dup = await submit(other.orderId, rid2, otherShopper, other.total);
      const dupText = await dup.text();
      expect(dup.status, dupText.slice(0, 300)).toBe(409);
      expect(dupText).toContain('DUPLICATE_REFERENCE');
      expect((await order(other.orderId)).paymentStatus).not.toBe('paid');
      expect(reachReport(await pgReaches())).toBe('');
    }, 120_000);

    it('J3 refund: a partial InstaPay refund leaves the right refundable balance and a balanced refund entry; over the remainder is 400', async () => {
      const { orderId, total } = instapayOrder;
      expect(orderId, 'J2 ran first').not.toBe('');
      const PART = 1000;
      const refund = (reference: string, amountMinor: number) =>
        api(`/stores/${storeId}/orders/${orderId}/instapay-refund`, {
          method: 'POST',
          headers: merchant,
          body: JSON.stringify({
            reference,
            refundDate: '2026-11-17',
            refundTime: '13:00',
            recipientName: 'N*** B***',
            amountMinor,
          }),
        });
      const part = await refund('90001111', PART);
      expect(part.status, (await part.clone().text()).slice(0, 300)).toBeLessThan(300);

      // the admin's payment read: the refundable balance is what was paid minus what went back
      const read = await api(`/payments/order/${orderId}`, { headers: merchant });
      const readText = await read.text();
      expect(read.status, readText.slice(0, 300)).toBe(200);
      const p = (JSON.parse(readText) as { data: { payment: Record<string, unknown> } }).data
        .payment;
      const paid = known(p.amount, 'payment amount');
      const refunded = known(p.refundedAmount, 'refunded amount');
      expect(p.status).toBe('partially_refunded');
      expect(paid).toBe(total);
      expect(refunded).toBe(PART);
      expect(paid - refunded, 'refundable balance').toBe(total - PART);

      // the books: an entry for this refund, balanced, giving the cash back
      const refundEntry = await until(async () => {
        const b = await books(orderId);
        return (
          b.find(
            x =>
              x.sourceId !== orderId &&
              x.sourceId !== `${orderId}:cogs` &&
              x.lines.some(l => l.credit > 0 && /^10[0-9]{2}$/.test(l.code))
          ) ?? null
        );
      });
      expect(refundEntry, 'a refund entry posted').not.toBeNull();
      balanced(refundEntry!);
      expect(
        refundEntry!.lines
          .filter(l => /^10[0-9]{2}$/.test(l.code))
          .reduce((s, l) => s + l.credit, 0),
        'cash given back = the partial refund'
      ).toBe(PART);

      // over the remainder: refused, nothing changes
      const over = await refund('90002222', total - PART + 1);
      expect(over.status, (await over.clone().text()).slice(0, 300)).toBe(400);
      const after = await payment(orderId, 'instapay');
      expect(known(after?.refundedAmount, 'refunded amount after the refusal')).toBe(PART);
      expect(after?.status).toBe('partially_refunded');
      expect(reachReport(await pgReaches())).toBe('');
    }, 120_000);
  }
);

/** The Postgres reaches since the last reset, as readable lines (label + the first app frame). */
function reachReport(r: Array<{ label: string; stack: string }>): string {
  return r
    .map(x => `${x.label} @ ${x.stack.split('\n').find(l => l.includes('/src/')) ?? ''}`)
    .join('\n');
}
