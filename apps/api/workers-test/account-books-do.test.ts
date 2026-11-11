/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * Accounts and books on a Durable Object store that HAS orders and customers, Postgres absent (Ruling NZ-ACCT-1): the tax
 * report (JSON + .xlsx, fed by journal postings made by the `order/created` jobs run inline), the customer MFA endpoints (the
 * NZ-N9-1 refusal, never a 500), customer passkeys, the merchant resend-verification / forgot-password flows with no store,
 * and the billing grant paths (the daily billing cycle runs `sweepFreeMonthGrants` / `restoreRevokedGrants`). Each must answer
 * with no access to the Postgres client (`/__dev/pg-reaches`).
 *
 * Run: npm run -w apps/api cf:dry-run && npx vitest run --config vitest.workers.config.mts workers-test/account-books-do.test.ts
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
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
/** Poll until `fn` is truthy (a write applied off the request). */
async function until<T>(fn: () => Promise<T | null>, ms = 10_000): Promise<T | null> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v || Date.now() - t0 > ms) return v;
    await new Promise(r => setTimeout(r, 150));
  }
}
/** The Postgres reaches since the last reset, as readable lines (label + the first app frame). */
const reachReport = (r: Array<{ label: string; stack: string }>) =>
  r.map(x => `${x.label} @ ${x.stack.split('\n').find(l => l.includes('/src/')) ?? ''}`).join('\n');

describe.skipIf(e.E2E_DB === '1')(
  'accounts and books of a Durable Object store with orders and customers, Postgres absent',
  () => {
    let storeId = '';
    const productIds: string[] = [];
    const owner = 'owner-acct-do';
    const customerId = 'cust-acct-do-1';
    let merchant: Record<string, string> = {};
    let nSession = 0;

    /** A real storefront checkout (cart line, POST /public/orders, COD payment row), then the merchant marks it paid. */
    async function paidCodOrder(buyer: { bearer?: string; phone: string }, productId: string) {
      const h: Record<string, string> = {
        'x-store-id': storeId,
        'x-session-id': `sess-acct-do-${++nSession}`,
        ...(buyer.bearer ? { authorization: `Bearer ${buyer.bearer}` } : {}),
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
          paymentMethod: 'cod',
          shippingAddress: {
            firstName: 'Nour',
            lastName: 'Buyer',
            address1: '1 Test St',
            city: 'Cairo',
            phone: buyer.phone,
            country: 'EG',
          },
        }),
      });
      const text = await res.text();
      expect(res.status, text).toBeLessThan(300);
      const j = JSON.parse(text) as { data: { id?: string; order?: { id: string } } };
      const orderId = j.data.order?.id ?? j.data.id!;
      const pay = await api('/payments/create', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ orderId, provider: 'cod' }),
      });
      expect(pay.status, await pay.clone().text()).toBe(200);
      const paid = await api(`/stores/${storeId}/orders/${orderId}/mark-paid`, {
        method: 'POST',
        headers: merchant,
        body: JSON.stringify({}),
      });
      expect(paid.status, await paid.clone().text()).toBeLessThan(300);
      return orderId;
    }

    it('fixture: a DO store, a registered customer and guests with paid orders', async () => {
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
          .bind(`acct-do-marker-${i}`, k)
          .run();
      const created = await e.API.fetch('https://api.ebda.app/__dev/create-store', {
        method: 'POST',
        body: JSON.stringify({
          ownerId: owner,
          name: 'Books Shop',
          slug: 'acct-do-shop',
          operator: true,
        }),
      });
      expect(created.status).toBe(200);
      storeId = ((await created.json()) as { id: string }).id;
      // before any request (the plan answer is cached): a plan whose analytics tier is `advanced` (the insights pages gate on it)
      await e.PLATFORM_DB.prepare(
        "UPDATE store_subscriptions SET plan_code = 'pro', status = 'active' WHERE store_id = ?1"
      )
        .bind(storeId)
        .run();
      // the merchant switched on the basic books (the performance + cash-flow cards gate on it)
      // and the features the merchant screens below gate on
      for (const key of ['accounting.basic', 'accounting.tax_reports', 'coupons'])
        await e.PLATFORM_DB.prepare(
          'INSERT OR REPLACE INTO store_features (id, store_id, feature_key, enabled, enabled_at) VALUES (?1, ?2, ?3, 1, ?4)'
        )
          .bind(`acct-do-${key}`, storeId, key, Date.now())
          .run();
      for (const u of [owner, customerId])
        await authState(`user:tv:${u}`, [['set', `user:tv:${u}`, '0', {}]]);
      const sa = await accessToken({
        userId: owner,
        jti: 'j-acct-do-owner',
        role: 'store_admin',
        storeId,
      });
      merchant = { authorization: `Bearer ${sa}`, 'x-store-id': storeId };

      const wrote = await stub(storeId).mutate(storeId, {
        ops: [
          {
            model: 'PaymentConfig',
            op: 'create',
            args: {
              data: {
                id: crypto.randomUUID(),
                storeId,
                provider: 'cod',
                isEnabled: true,
                isDefault: true,
                testMode: true,
                displayName: 'cod',
              },
            },
          },
        ],
      });
      expect(wrote.ok, JSON.stringify(wrote)).toBe(true);

      // the super admin verified the VAT registration (ruling TAX-2): VAT may now be switched on
      const profiled = await stub(storeId).mutate(storeId, {
        actorRole: 'super_admin',
        ops: [
          {
            model: 'StoreTaxProfile',
            op: 'create',
            args: {
              data: {
                id: crypto.randomUUID(),
                storeId,
                status: 'verified',
                taxRegistrationNumber: '123456789',
                legalName: 'Books Shop LLC',
                verifiedAt: new Date().toISOString(),
              },
            },
          },
        ],
      });
      expect(profiled.ok, JSON.stringify(profiled)).toBe(true);
      // 14% VAT, exclusive, through the merchant API (the DO serves it): the sale postings then move account 2100
      const rate = await api(`/stores/${storeId}/tax/rates`, {
        method: 'POST',
        headers: merchant,
        body: JSON.stringify({ name: 'VAT', rate: 14, isActive: true }),
      });
      expect(rate.status, await rate.clone().text()).toBe(201);
      const cfg = await api(`/stores/${storeId}/tax/settings`, {
        method: 'PUT',
        headers: merchant,
        body: JSON.stringify({ taxEnabled: true, taxIncludedInPrice: false }),
      });
      expect(cfg.status, await cfg.clone().text()).toBe(200);

      const now = Date.now();
      for (const [i, name] of ['Gold ring', 'Silver chain'].entries()) {
        const id = crypto.randomUUID();
        productIds.push(id);
        const seeded = await e.API.fetch(`${BASE}/internal/store-do/${storeId}/seed`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer workers-test-seed-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            products: [
              {
                id,
                storeId,
                name,
                nameAr: i === 0 ? 'خاتم ذهب' : 'سلسلة فضة',
                slug: `acct-do-${i}`,
                sku: `SKU-${i}`,
                price: 5000 + i * 1000,
                costPrice: 2000,
                inventory: 100,
                status: 'active',
                createdAt: now,
                updatedAt: now,
              },
            ],
          }),
        });
        expect(seeded.status, await seeded.clone().text()).toBe(200);
      }

      // A registered customer (two orders: a repeat buyer), guest A (two orders, same phone: a repeat buyer), guest B (one).
      const customer = await accessToken({
        userId: customerId,
        jti: 'j-acct-do-cust',
        role: 'customer',
        storeId,
      });
      await paidCodOrder({ bearer: customer, phone: '+201000000101' }, productIds[0]);
      await paidCodOrder({ bearer: customer, phone: '+201000000101' }, productIds[1]);
      await paidCodOrder({ phone: '+201000000202' }, productIds[0]);
      await paidCodOrder({ phone: '+201000000202' }, productIds[0]);
      await paidCodOrder({ phone: '+201000000303' }, productIds[1]);
      const orders = await doRead<Array<{ customerId: string | null; paymentStatus: string }>>(
        storeId,
        'Order',
        { where: { storeId } }
      );
      expect(orders.length).toBe(5);
      expect(orders.filter(o => o.paymentStatus === 'paid').length).toBe(5);
      expect(orders.filter(o => o.customerId === customerId).length).toBe(2);
    }, 180_000);

    it('books: the tax report (JSON + xlsx) reads the DO journal (Ruling NZ-ACCT-1)', async () => {
      const orders = await doRead<Array<{ id: string; tax: number }>>(storeId, 'Order', {
        where: { storeId },
      });
      for (const o of orders) {
        const ran = await e.API.fetch('https://api.ebda.app/__dev/run-event', {
          method: 'POST',
          body: JSON.stringify({
            name: 'order/created',
            data: { orderId: o.id, storeId, paymentMethod: 'cod' },
          }),
        });
        const body = await ran.text();
        expect.soft(ran.status, body).toBe(200);
        const failed = (JSON.parse(body).jobs as Array<{ ok: boolean; id?: string }>).filter(
          // ci-outcomes needs a queue binding the harness does not have (unrelated to the books)
          j => !j.ok && j.id !== 'ci-outcomes'
        );
        expect.soft(failed, body.slice(0, 600)).toEqual([]);
      }
      const lines = await doRead<{ id: string }>(storeId, 'JournalEntry', { where: { storeId } });
      expect.soft((lines as unknown[]).length, 'journal entries posted').toBeGreaterThanOrEqual(5);
      await pgReaches(true);
      const q = '?from=2020-01-01&to=2099-12-31';
      const j = await api(`/stores/${storeId}/finance/reports/tax-report${q}`, {
        headers: merchant,
      });
      const jt = await j.text();
      expect.soft(j.status, jt.slice(0, 400)).toBe(200);
      let data: { rows?: unknown[]; transactions?: unknown[]; summary?: Record<string, number> } =
        {};
      try {
        data = JSON.parse(jt).data;
      } catch {
        /* reported above */
      }
      const rows = (data.rows ?? data.transactions ?? []) as Array<{
        kind: string;
        customerName: string | null;
        taxCollected: number;
      }>;
      expect.soft(rows.length, jt.slice(0, 400)).toBeGreaterThanOrEqual(5);
      expect.soft(rows.every(r => r.kind === 'sale' && r.taxCollected > 0)).toBe(true);
      expect
        .soft(
          rows.some(r => r.customerName !== null),
          'a customer name resolved'
        )
        .toBe(true);
      const x = await api(`/stores/${storeId}/finance/reports/tax-report.xlsx${q}`, {
        headers: merchant,
      });
      const xb = await x.arrayBuffer();
      expect.soft(x.status, new TextDecoder().decode(xb.slice(0, 300))).toBe(200);
      expect.soft(xb.byteLength).toBeGreaterThan(500);
      expect.soft(reachReport(await pgReaches(true))).toBe('');
    }, 120_000);

    it('auth: customer MFA is refused (never a 500), passkeys answer, merchant e-mail flows are generic (Ruling NZ-ACCT-1)', async () => {
      await pgReaches(true);
      const steps: string[] = [];
      const customer = await accessToken({
        userId: customerId,
        jti: 'j-acct-do-cust-mfa',
        role: 'customer',
        storeId,
      });
      const cH = { authorization: `Bearer ${customer}`, 'x-store-id': storeId };
      const post = async (
        name: string,
        path: string,
        body: unknown,
        headers: Record<string, string>
      ) => {
        const r = await api(path, { method: 'POST', headers, body: JSON.stringify(body) });
        const text = await r.text();
        steps.push(`${r.status} ${name} ${text.slice(0, 160)}`);
        return { status: r.status, text };
      };
      for (const [name, path, body] of [
        ['mfa enroll/begin', '/auth/mfa/enroll/begin', {}],
        ['mfa enroll/verify', '/auth/mfa/enroll/verify', { code: '123456' }],
        ['mfa disable', '/auth/mfa/disable', { code: '123456' }],
      ] as const) {
        const r = await post(name, path, body, cH);
        expect
          .soft([r.status, r.text.includes('MFA_UNAVAILABLE')], steps.join('\n'))
          .toEqual([409, true]);
      }
      // /verify takes a challenge token; a signed one is refused the same way (no Postgres user to verify against)
      const b64 = (v: ArrayBuffer | string) =>
        btoa(typeof v === 'string' ? v : String.fromCharCode(...new Uint8Array(v)))
          .replace(/=+$/, '')
          .replace(/\+/g, '-')
          .replace(/\//g, '_');
      const now = Math.floor(Date.now() / 1000);
      const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
      const pl = b64(
        JSON.stringify({
          userId: 'merchant-nobody',
          purpose: 'mfa',
          jti: crypto.randomUUID(),
          iss: 'ebda-api',
          aud: 'ebda-mfa-challenge',
          iat: now,
          exp: now + 300,
        })
      );
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode((env as unknown as { JWT_SECRET: string }).JWT_SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${head}.${pl}`));
      const v = await post(
        'mfa verify',
        '/auth/mfa/verify',
        { challengeToken: `${head}.${pl}.${b64(sig)}`, code: '123456' },
        {}
      );
      expect
        .soft([v.status, v.text.includes('MFA_UNAVAILABLE')], steps.join('\n'))
        .toEqual([409, true]);
      const list = await api('/auth/passkeys', {
        headers: { ...cH, origin: 'https://acct-do-shop.ebda.app' },
      });
      steps.push(`${list.status} passkey list`);
      expect.soft(list.status, steps.join('\n')).toBe(200);
      const rs = await post(
        'merchant resend-verification',
        '/auth/resend-verification',
        { email: 'merchant-nobody@example.com' },
        {}
      );
      expect.soft(rs.status, steps.join('\n')).toBeLessThan(300);
      const fp = await post(
        'merchant forgot-password',
        '/auth/forgot-password',
        { email: 'merchant-nobody@example.com' },
        {}
      );
      expect.soft(fp.status, steps.join('\n')).toBeLessThan(300);
      expect.soft(reachReport(await pgReaches(true)), steps.join('\n')).toBe('');
    }, 60_000);

    it('billing: recording a plan payment (the grant award path) records the payment with no Postgres reach (Ruling NZ-ACCT-1)', async () => {
      // the super admin records the store's first payment: runBillingEffects -> awardGrantsAfterPayment -> inOwnTx (a Postgres
      // transaction before NZ-ACCT-1, whose throw the effect runner swallows: the store simply never got its free month)
      await authState('user:tv:super-acct-do', [['set', 'user:tv:super-acct-do', '0', {}]]);
      const su = await accessToken({
        userId: 'super-acct-do',
        jti: 'j-acct-do-su',
        role: 'super_admin',
      });
      await e.PLATFORM_DB.prepare(
        "UPDATE plans SET price_monthly_minor = 100000, price_yearly_minor = 1000000 WHERE code = 'pro'"
      )
        .bind()
        .run();
      await pgReaches(true);
      const paid = await api(`/admin/stores/${storeId}/manual-payment`, {
        method: 'POST',
        headers: { authorization: `Bearer ${su}` },
        body: JSON.stringify({
          planCode: 'pro',
          interval: 'monthly',
          amountMinor: 100_000,
          method: 'instapay',
          reference: 'ACCT-DO-REF-1',
          paidAt: new Date().toISOString(),
        }),
      });
      const text = await paid.text();
      // a fresh payment is CREATED (201) and is not a replay: the award path ran past the D1 commit (main fixed the
      // commitManualPaymentD1 duplicate answer this case first observed)
      expect.soft(paid.status, text.slice(0, 300)).toBe(201);
      expect.soft(JSON.parse(text).data?.duplicate, text.slice(0, 300)).toBe(false);
      expect.soft(reachReport(await pgReaches(true)), text.slice(0, 300)).toBe('');
    }, 60_000);
  }
);
