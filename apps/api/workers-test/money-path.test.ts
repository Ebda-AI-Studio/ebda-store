/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * NEON-ZERO MONEY PATH (Postgres is gone from the Worker since 2026-11-05). The built Worker, Postgres absent (every Prisma
 * call throws POSTGRES_REMOVED), every cutover marker set, a store created on D1 + its StoreDO: drive the money routes the
 * storefront and the gateways really call and assert each one answers AND changes the money state in the StoreDO, with no
 * access to the Postgres client at all (`/__dev/pg-reaches`, DEV_STATS=1).
 *
 *   - POST /payments/create: COD (cod_pending row, replay = same row), InstaPay (hold + pending row, replay = same row)
 *   - signed gateway webhooks with the store's TEST keys: Paymob (HMAC-SHA512), Fawry (messageSignature), Kashier (HMAC +
 *     the confirm-before-apply call answered by the `gateway-stub` outbound service): 2xx, the payment `completed` and the
 *     order `paid` in the DO, a replay applies nothing twice, a forged signature is refused and writes nothing
 *   - the shopper's return URLs (/webhooks/payment/callback, /webhooks/payment/error), the payment reads
 *     (/payments/order/:orderId, /payments/:id/events, /payments/status/:ref) and the retry / refund entry points
 *
 * Run: npm run -w apps/api cf:dry-run && npx vitest run --config vitest.workers.config.mts workers-test/money-path.test.ts
 */
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { createCipheriv, createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { DEFAULT_PLAN_SEEDS } from '@ebda/shared';
import { accessToken, authState } from './helpers';

type DoAnswer = { ok: true; json: string } | { ok: false; code: string; message?: string };
const e = env as unknown as {
  API: { fetch(u: string, i?: RequestInit): Promise<Response> };
  E2E_DB: string;
  ENCRYPTION_KEY: string;
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
      moneyOp(storeId: string, op: string, argsJson: string, key?: string): Promise<DoAnswer>;
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
// The store's TEST credentials (sandbox mode), the secrets the signatures below are computed with.
const PAYMOB_HMAC = 'paymob-test-hmac-secret';
const FAWRY_KEY = 'fawry-test-secure-key';
const KASHIER_KEY = 'kashier-test-api-key';

let ip = 0;
const freshIp = () => `10.77.${(ip >> 8) & 255}.${ip++ & 255}`;

/** `encryption.service.ts` byte for byte: base64(salt 32 | iv 16 | tag 16 | ciphertext), AES-256-GCM, PBKDF2(sha256(key)). */
function encrypt(plain: string): string {
  const key = createHash('sha256').update(e.ENCRYPTION_KEY).digest();
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const c = createCipheriv('aes-256-gcm', pbkdf2Sync(key, salt, 10000, 32, 'sha256'), iv, {
    authTagLength: 16,
  });
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([salt, iv, c.getAuthTag(), enc]).toString('base64');
}

const stub = (storeId: string) => e.STORE_DO.get(e.STORE_DO.idFromName(storeId));
const unwrap = <T>(a: DoAnswer): T => {
  if (!a.ok) throw new Error(`DO refused: ${a.code} ${a.message ?? ''}`);
  return JSON.parse(a.json) as T;
};
async function doRead<T>(storeId: string, model: string, args: Record<string, unknown>) {
  return unwrap<T[]>(await stub(storeId).query(storeId, [{ model, op: 'findMany', args }]))[0];
}
const payments = (storeId: string, orderId: string) =>
  doRead<
    Array<{
      id: string;
      provider: string;
      status: string;
      amount: number;
      transactionId: string | null;
    }>
  >(storeId, 'Payment', { where: { orderId }, orderBy: { createdAt: 'asc' } });
const orderRow = async (storeId: string, orderId: string) =>
  (
    await doRead<Array<{ id: string; status: string; paymentStatus: string; total: number }>>(
      storeId,
      'Order',
      { where: { id: orderId } }
    )
  )[0];

async function pgReaches(reset = false): Promise<Array<{ label: string; stack: string }>> {
  const r = await e.API.fetch(`https://api.ebda.app/__dev/pg-reaches${reset ? '?reset=1' : ''}`);
  return ((await r.json()) as { reaches: Array<{ label: string; stack: string }> }).reaches;
}

/** Poll until `fn` is truthy (the webhook is applied by the jobs workflow, off the request). */
async function until<T>(fn: () => Promise<T>, ms = 15_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v || Date.now() - t0 > ms) return v;
    await new Promise(r => setTimeout(r, 150));
  }
}

const api = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  e.API.fetch(`${BASE}${path}`, {
    ...init,
    redirect: 'manual',
    headers: {
      'x-forwarded-for': freshIp(),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });

// --- the gateways' signatures, computed exactly as each provider documents them ---------------------------------------------
function paymobBody(ref: string, txnId: number, amountCents: number) {
  const obj = {
    amount_cents: amountCents,
    created_at: new Date().toISOString(),
    currency: 'EGP',
    error_occured: false,
    has_parent_transaction: false,
    id: txnId,
    integration_id: 1001,
    is_3d_secure: true,
    is_auth: false,
    is_capture: false,
    is_refunded: false,
    is_standalone_payment: true,
    is_voided: false,
    order: { id: ref },
    owner: 7,
    pending: false,
    source_data: { pan: '2346', sub_type: 'MasterCard', type: 'card' },
    success: true,
  };
  const fields = [
    'amount_cents',
    'created_at',
    'currency',
    'error_occured',
    'has_parent_transaction',
    'id',
    'integration_id',
    'is_3d_secure',
    'is_auth',
    'is_capture',
    'is_refunded',
    'is_standalone_payment',
    'is_voided',
    'order.id',
    'owner',
    'pending',
    'source_data.pan',
    'source_data.sub_type',
    'source_data.type',
    'success',
  ];
  const pick = (o: unknown, p: string) =>
    p
      .split('.')
      .reduce<unknown>((x, k) => (x && typeof x === 'object' ? (x as never)[k] : undefined), o);
  const text = (v: unknown) =>
    v === undefined || v === null
      ? ''
      : typeof v === 'boolean'
        ? v
          ? 'true'
          : 'false'
        : String(v);
  const hmac = createHmac('sha512', PAYMOB_HMAC)
    .update(fields.map(f => text(pick(obj, f))).join(''))
    .digest('hex');
  return { body: JSON.stringify({ type: 'TRANSACTION', obj }), hmac };
}
const egp = (minor: number) => (minor / 100).toFixed(2);
function fawryBody(merchantRef: string, fawryRef: string, amountMinor: number, key = FAWRY_KEY) {
  const n = {
    fawryRefNumber: fawryRef,
    merchantRefNumber: merchantRef,
    orderStatus: 'PAID',
    paymentMethod: 'CARD',
    paymentAmount: Number(egp(amountMinor)),
    orderAmount: Number(egp(amountMinor)),
  };
  const messageSignature = createHash('sha256')
    .update(
      n.fawryRefNumber +
        n.merchantRefNumber +
        egp(amountMinor) +
        egp(amountMinor) +
        n.orderStatus +
        n.paymentMethod +
        key
    )
    .digest('hex');
  return JSON.stringify({ ...n, messageSignature });
}
function kashierBody(merchantOrderId: string, transactionId: string, amountMinor: number) {
  const data: Record<string, unknown> = {
    merchantOrderId,
    amount: Number(egp(amountMinor)),
    currency: 'EGP',
    status: 'SUCCESS',
    transactionId,
    method: 'card',
    signatureKeys: ['amount', 'currency', 'merchantOrderId', 'method', 'status', 'transactionId'],
  };
  const keys = [...(data.signatureKeys as string[])].sort();
  const payload = keys.map(k => `${k}=${encodeURIComponent(String(data[k] ?? ''))}`).join('&');
  const sig = createHmac('sha256', KASHIER_KEY).update(payload).digest('hex');
  return { body: JSON.stringify({ event: 'pay', data }), sig };
}

describe.skipIf(e.E2E_DB === '1')(
  'money path for a Durable Object store, Postgres absent (POSTGRES_REMOVED)',
  () => {
    let storeId = '';
    let productId = '';
    let owner = '';
    let su = '';
    // A guest checkout (the common storefront case): one cart session per order, so the per-session hold cap never decides.
    let session = 'sess-money-0';
    let nSession = 0;
    const shopperHeaders = () => ({ 'x-store-id': storeId, 'x-session-id': session });
    const suHeaders = () => ({ authorization: `Bearer ${su}`, 'x-store-id': storeId });

    /** A real checkout through the storefront API: cart line, then POST /public/orders. */
    async function placeOrder(paymentMethod: string): Promise<{ id: string; total: number }> {
      session = `sess-money-${++nSession}`;
      const add = await api('/public/cart/items', {
        method: 'POST',
        headers: shopperHeaders(),
        body: JSON.stringify({ productId, quantity: 1 }),
      });
      expect(add.status, await add.clone().text()).toBeLessThan(300);
      const res = await api('/public/orders', {
        method: 'POST',
        headers: shopperHeaders(),
        body: JSON.stringify({
          paymentMethod,
          shippingAddress: {
            firstName: 'Money',
            lastName: 'Path',
            address1: '1 Test St',
            city: 'Cairo',
            // one buyer per order: the open-hold caps count per buyer, and this file places many unpaid orders
            phone: `+2010${String(1_000_000 + nSession).padStart(8, '0')}`,
            country: 'EG',
          },
        }),
      });
      const text = await res.text();
      expect(res.status, text).toBeLessThan(300);
      const j = JSON.parse(text) as {
        data: { id?: string; order?: { id: string; total: number }; total?: number };
      };
      const id = j.data.order?.id ?? j.data.id!;
      const row = await orderRow(storeId, id);
      return { id, total: row.total };
    }

    /** An online payment as recordProviderPayment writes it after the gateway accepted (the gateway call itself is not ours to test). */
    async function gatewayPayment(orderId: string, provider: string, ref: string, amount: number) {
      const r = unwrap<{ paymentId: string }>(
        await stub(storeId).moneyOp(
          storeId,
          'paymentCreate',
          JSON.stringify({ orderId, provider, amount, transactionId: ref })
        )
      );
      // NOT seeded by hand: the DO writes the id -> store rows (payment, `<provider>:<ref>`) to D1 before it answers.
      const indexed = await e.PLATFORM_DB.prepare(
        "SELECT store_id FROM entity_index WHERE kind = 'webhook' AND id = ?1"
      )
        .bind(`${provider}:${ref}`)
        .first<{ store_id: string }>();
      expect(indexed?.store_id).toBe(storeId);
      return r.paymentId;
    }

    it('fixture: markers, a store on D1 + its DO, its gateway configs (test keys), a product', async () => {
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
          .bind(`money-marker-${i}`, k)
          .run();
      owner = 'owner-money';
      const created = await e.API.fetch('https://api.ebda.app/__dev/create-store', {
        method: 'POST',
        body: JSON.stringify({
          ownerId: owner,
          name: 'Money Shop',
          slug: 'money-shop',
          operator: true,
        }),
      });
      expect(created.status).toBe(200);
      storeId = ((await created.json()) as { id: string }).id;
      // before any request (the feature answer is cached): the merchant switched both features on (D1 `store_features`, the platform family)
      for (const key of ['payment_abandonment', 'affiliate'])
        await e.PLATFORM_DB.prepare(
          'INSERT OR REPLACE INTO store_features (id, store_id, feature_key, enabled, enabled_at) VALUES (?1, ?2, ?3, 1, ?4)'
        )
          .bind(`money-${key}`, storeId, key, Date.now())
          .run();
      for (const u of [owner, 'super-money'])
        await authState(`user:tv:${u}`, [['set', `user:tv:${u}`, '0', {}]]);
      su = await accessToken({ userId: 'super-money', jti: 'j-money-su', role: 'super_admin' });

      const now = Date.now();
      const cfg = (provider: string, extra: Record<string, unknown>) => ({
        model: 'PaymentConfig',
        op: 'create',
        args: {
          data: {
            id: crypto.randomUUID(),
            storeId,
            provider,
            isEnabled: true,
            isDefault: provider === 'paymob',
            testMode: true,
            displayName: provider,
            ...extra,
          },
        },
      });
      const wrote = await stub(storeId).mutate(storeId, {
        ops: [
          cfg('cod', {}),
          cfg('instapay', { settings: { handle: 'money@instapay', expiryHours: 24 } }),
          cfg('paymob', {
            apiKey: encrypt('sk_test_money'),
            secretKey: encrypt('paymob-api-key'),
            webhookSecret: encrypt(PAYMOB_HMAC),
            settings: { publicKey: 'pk_test_money', integrationIds: { card: 1001 } },
          }),
          cfg('fawry', {
            apiKey: encrypt(FAWRY_KEY),
            merchantId: encrypt('fawry-merchant'),
            webhookSecret: encrypt(FAWRY_KEY),
          }),
          cfg('kashier', {
            apiKey: encrypt(KASHIER_KEY),
            secretKey: encrypt('kashier-secret'),
            merchantId: encrypt('MID-1'),
          }),
        ],
      });
      expect(wrote.ok, JSON.stringify(wrote)).toBe(true);

      productId = crypto.randomUUID();
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
              name: 'Money Product',
              slug: 'money-product',
              price: 5000,
              inventory: 100,
              status: 'active',
              createdAt: now,
              updatedAt: now,
            },
          ],
        }),
      });
      expect(seeded.status).toBe(200);

      await pgReaches(true);
    }, 120_000);

    it('POST /payments/create COD: 200, a cod_pending row in the DO; a replay returns the same row', async () => {
      const o = await placeOrder('cod');
      const res = await api('/payments/create', {
        method: 'POST',
        headers: shopperHeaders(),
        body: JSON.stringify({ orderId: o.id, provider: 'cod' }),
      });
      const text = await res.text();
      expect(res.status, text).toBe(200);
      const first = JSON.parse(text).data as { transactionId: string; cod: boolean };
      expect(first.cod).toBe(true);
      const rows = await payments(storeId, o.id);
      expect(rows.map(r => [r.provider, r.status, r.amount])).toEqual([
        ['cod', 'cod_pending', o.total],
      ]);
      const again = await api('/payments/create', {
        method: 'POST',
        headers: shopperHeaders(),
        body: JSON.stringify({ orderId: o.id, provider: 'cod' }),
      });
      expect(again.status).toBe(200);
      expect(((await again.json()) as { data: { transactionId: string } }).data.transactionId).toBe(
        first.transactionId
      );
      expect(await payments(storeId, o.id)).toHaveLength(1);
      // the payment read of the order (a guest order: read as the platform admin)
      const mine = await api(`/payments/order/${o.id}`, { headers: suHeaders() });
      expect(mine.status, await mine.clone().text()).toBe(200);
      expect(((await mine.json()) as { data: { payment: { id: string } } }).data.payment.id).toBe(
        rows[0]!.id
      );
      expect(await pgReaches(true)).toEqual([]);
    }, 60_000);

    it('POST /payments/create InstaPay: 200 with instructions, the order on hold and a pending row; a replay creates nothing', async () => {
      const o = await placeOrder('instapay');
      const res = await api('/payments/create', {
        method: 'POST',
        headers: shopperHeaders(),
        body: JSON.stringify({ orderId: o.id, provider: 'instapay' }),
      });
      const text = await res.text();
      expect(res.status, text).toBe(200);
      const body = JSON.parse(text).data as {
        transactionId: string;
        instapay: { amountMinor: number; handle?: string };
      };
      expect(body.instapay.amountMinor).toBe(o.total);
      expect(body.instapay.handle).toBe('money@instapay');
      expect((await orderRow(storeId, o.id)).status).toBe('awaiting_payment_confirmation');
      const rows = await payments(storeId, o.id);
      expect(rows.map(r => [r.provider, r.status])).toEqual([['instapay', 'pending']]);
      const again = await api('/payments/create', {
        method: 'POST',
        headers: shopperHeaders(),
        body: JSON.stringify({ orderId: o.id, provider: 'instapay' }),
      });
      expect(again.status).toBe(200);
      expect(((await again.json()) as { data: { transactionId: string } }).data.transactionId).toBe(
        body.transactionId
      );
      expect(await payments(storeId, o.id)).toHaveLength(1);
      const view = await api(`/payments/instapay/${o.id}`, { headers: shopperHeaders() });
      expect(view.status, await view.clone().text()).toBe(200);
      expect(await pgReaches(true)).toEqual([]);
    }, 60_000);

    const gateways: Array<{
      provider: 'paymob' | 'fawry' | 'kashier';
      /** `txn`: another gateway transaction for the same reference (a different signed event) */
      deliver: (ref: string, amount: number, forged?: boolean, txn?: string) => Promise<Response>;
    }> = [
      {
        provider: 'paymob',
        deliver: (ref, amount, forged, txn) => {
          // one gateway transaction per reference: a redelivery is the same signed transaction
          const { body, hmac } = paymobBody(
            ref,
            900_000 + (parseInt(ref.slice(-6), 16) % 99_999) + (txn ? 100_000 : 0),
            amount
          );
          return api(
            `/webhooks/payment/paymob/s/${storeId}?hmac=${forged ? 'f'.repeat(128) : hmac}`,
            {
              method: 'POST',
              body,
            }
          );
        },
      },
      {
        provider: 'fawry',
        deliver: (ref, amount, forged, txn) =>
          api('/webhooks/payment/fawry', {
            method: 'POST',
            body: fawryBody(
              ref,
              `FR${txn ?? ''}-${ref}`,
              amount,
              forged ? 'not-the-key' : FAWRY_KEY
            ),
          }),
      },
      {
        provider: 'kashier',
        deliver: (ref, amount, forged, txn) => {
          const { body, sig } = kashierBody(ref, `KTX${txn ?? ''}-${ref}`, amount);
          return api('/webhooks/payment/kashier', {
            method: 'POST',
            headers: { 'x-kashier-signature': forged ? '0'.repeat(64) : sig },
            body,
          });
        },
      },
    ];

    for (const g of gateways)
      it(`${g.provider} webhook, VALID signature with the store's test key: 2xx, payment completed + order paid in the DO, replay applies once, forged refused`, async () => {
        const o = await placeOrder(g.provider);
        const ref = `${g.provider.toUpperCase()}-${o.id.slice(0, 8)}`;
        const paymentId = await gatewayPayment(o.id, g.provider, ref, o.total);
        await pgReaches(true);

        const forged = await g.deliver(ref, o.total, true);
        expect(forged.status, await forged.clone().text()).toBeGreaterThanOrEqual(400);
        expect(forged.status).toBeLessThan(500);
        expect((await payments(storeId, o.id))[0]!.status).toBe('pending');

        // review I-4: a VALIDLY signed `completed` for another amount is recorded, never confirms the order
        const wrong = await g.deliver(ref, o.total + 1000, false, 'X');
        expect(wrong.status, await wrong.clone().text()).toBe(200);
        const held = await until(async () => {
          const ev = await doRead<Array<{ details: { reason?: string } | string }>>(
            storeId,
            'PaymentEvent',
            { where: { paymentId, eventType: 'reconciliation' } }
          );
          return ev.length > 0 ? ev : null;
        });
        expect(JSON.stringify(held)).toContain('paid_amount_mismatch');
        expect((await payments(storeId, o.id))[0]!.status).toBe('pending');
        expect((await orderRow(storeId, o.id)).paymentStatus).toBe('unpaid');

        const res = await g.deliver(ref, o.total);
        expect(res.status, await res.clone().text()).toBe(200);
        const paid = await until(async () => {
          const p = (await payments(storeId, o.id))[0]!;
          return p.status === 'completed' ? p : null;
        });
        expect(paid?.id).toBe(paymentId);
        expect((await orderRow(storeId, o.id)).paymentStatus).toBe('paid');

        const events = async () =>
          (
            await doRead<Array<{ id: string }>>(storeId, 'PaymentEvent', {
              where: { paymentId },
            })
          ).length;
        const before = await events();
        const replay = await g.deliver(ref, o.total);
        expect(replay.status, await replay.clone().text()).toBe(200);
        await new Promise(r => setTimeout(r, 1500));
        expect((await payments(storeId, o.id)).map(p => p.status)).toEqual(['completed']);
        expect(await events()).toBe(before);

        // the shopper's return URLs for this reference: a redirect, never a Postgres failure
        const back = await api(
          g.provider === 'paymob'
            ? `/webhooks/payment/callback?order=${ref}`
            : g.provider === 'kashier'
              ? `/webhooks/payment/callback?merchantOrderId=${ref}`
              : `/webhooks/payment/callback?merchantRefNumber=${ref}`
        );
        expect(back.status).toBe(302);
        const err = await api(`/webhooks/payment/error?transaction_id=${ref}`);
        expect(err.status).toBe(302);
        expect(err.headers.get('location') ?? '').toContain('money-shop');

        // the merchant's payment timeline and the status read of the reference
        const sa = await accessToken({
          userId: owner,
          jti: `j-${ref}`,
          role: 'store_admin',
          storeId,
        });
        const timeline = await api(`/payments/${paymentId}/events`, {
          headers: { authorization: `Bearer ${sa}`, 'x-store-id': storeId },
        });
        expect(timeline.status, await timeline.clone().text()).toBe(200);
        expect(
          ((await timeline.json()) as { data: { events: unknown[] } }).data.events.length
        ).toBeGreaterThan(0);
        const status = await api(`/payments/status/${ref}?provider=${g.provider}`, {
          headers: { authorization: `Bearer ${sa}`, 'x-store-id': storeId },
        });
        // the provider is asked through the stub gateway; whatever it answers, nothing reaches Postgres
        expect(
          ((await status.clone().json()) as { error?: { code?: string } }).error?.code
        ).not.toBe('POSTGRES_REMOVED');
        expect(await pgReaches(true)).toEqual([]);
      }, 90_000);

    it('merchant money reports and the affiliate payout answer from the DO (no Postgres reach, never a 5xx)', async () => {
      await pgReaches(true);
      const sa = await accessToken({
        userId: owner,
        jti: 'j-money-rep',
        role: 'store_admin',
        storeId,
      });
      const h = { authorization: `Bearer ${sa}`, 'x-store-id': storeId };
      const want: Array<[string, number]> = [
        [`/stores/${storeId}/payment-abandonments`, 200],
        [`/stores/${storeId}/payment-abandonments/stats`, 200],
        // the affiliate is looked up on the DO: an unknown one is a 404, never a Postgres 500
        [`/stores/${storeId}/affiliates/${crypto.randomUUID()}/payouts`, 404],
      ];
      for (const [path, status] of want) {
        const r = await api(path, { headers: h });
        expect(r.status, `${path} ${await r.clone().text()}`).toBe(status);
      }
      // money out: the DO payout section refuses an unknown affiliate (404) and writes nothing
      const payout = await api(`/stores/${storeId}/affiliates/${crypto.randomUUID()}/payouts`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ amount: 100 }),
      });
      expect(payout.status, await payout.clone().text()).toBe(404);
      expect(await pgReaches(true)).toEqual([]);
    }, 60_000);

    it('review I-2 / NEW-1: while D1 refuses the payment index row every create (first and retry) is 503; once it is back the retry is 200 and the row is in D1 BEFORE the answer', async () => {
      const o = await placeOrder('cod');
      // D1 refuses every new `payment` index row (an outage of the write, reads still work)
      await e.PLATFORM_DB.prepare(
        "CREATE TRIGGER money_test_index_outage BEFORE INSERT ON entity_index WHEN NEW.kind = 'payment' BEGIN SELECT RAISE(ABORT, 'test outage'); END"
      ).run();
      const create = () =>
        api('/payments/create', {
          method: 'POST',
          headers: shopperHeaders(),
          body: JSON.stringify({ orderId: o.id, provider: 'cod' }),
        });
      for (const attempt of ['first', 'retry while D1 is still down']) {
        const r = await create();
        const j = (await r.json()) as { error?: { code?: string } };
        expect(r.status, `${attempt}: ${JSON.stringify(j)}`).toBe(503);
        expect(j.error?.code).toBe('ENTITY_INDEX_UNAVAILABLE');
      }
      const rows = await payments(storeId, o.id);
      expect(rows).toHaveLength(1); // the section committed once; the reference was never handed out
      expect((await orderRow(storeId, o.id)).status).toBe('pending'); // not rolled back under the shopper
      await e.PLATFORM_DB.prepare('DROP TRIGGER money_test_index_outage').run();
      const ok = await create();
      expect(ok.status, await ok.clone().text()).toBe(200);
      expect(((await ok.json()) as { data: { transactionId: string } }).data.transactionId).toBe(
        rows[0]!.id
      );
      // routable at the moment the reference was handed out: no polling
      const indexed = await e.PLATFORM_DB.prepare(
        "SELECT store_id FROM entity_index WHERE kind = 'payment' AND id = ?1"
      )
        .bind(rows[0]!.id)
        .first<{ store_id: string }>();
      expect(indexed?.store_id).toBe(storeId);
      expect(await payments(storeId, o.id)).toHaveLength(1);
    }, 60_000);

    it('review NEW-2: a D1 outage of the ORDER index does not fail a committed checkout (its post-commit work runs on the first answer); a keyed retry replays the same order', async () => {
      await e.PLATFORM_DB.prepare(
        "CREATE TRIGGER money_test_order_outage BEFORE INSERT ON entity_index WHEN NEW.kind = 'order' BEGIN SELECT RAISE(ABORT, 'test outage'); END"
      ).run();
      try {
        session = `sess-money-${++nSession}`;
        const add = await api('/public/cart/items', {
          method: 'POST',
          headers: shopperHeaders(),
          body: JSON.stringify({ productId, quantity: 1 }),
        });
        expect(add.status).toBeLessThan(300);
        const key = `checkout-${crypto.randomUUID()}`;
        const body = JSON.stringify({
          paymentMethod: 'cod',
          shippingAddress: {
            firstName: 'Keyed',
            lastName: 'Checkout',
            address1: '1 Test St',
            city: 'Cairo',
            phone: `+2010${String(2_000_000 + nSession).padStart(8, '0')}`,
            country: 'EG',
          },
        });
        const first = await api('/public/orders', {
          method: 'POST',
          headers: { ...shopperHeaders(), 'idempotency-key': key },
          body,
        });
        const ft = await first.text();
        expect(first.status, ft).toBeLessThan(300);
        const id = ((JSON.parse(ft) as { data: { id?: string; order?: { id: string } } }).data.order
          ?.id ?? (JSON.parse(ft) as { data: { id: string } }).data.id) as string;
        const again = await api('/public/orders', {
          method: 'POST',
          headers: { ...shopperHeaders(), 'idempotency-key': key },
          body,
        });
        const at = await again.text();
        expect(again.status, at).toBeLessThan(300);
        const id2 = ((JSON.parse(at) as { data: { id?: string; order?: { id: string } } }).data
          .order?.id ?? (JSON.parse(at) as { data: { id: string } }).data.id) as string;
        expect(id2).toBe(id);
      } finally {
        await e.PLATFORM_DB.prepare('DROP TRIGGER IF EXISTS money_test_order_outage').run();
      }
    }, 60_000);

    it('review I-3: a Fawry reference-code payment keeps its instruction; a second create hands back the SAME reference', async () => {
      session = `sess-fawry-ref-${++nSession}`;
      const cart = await api('/public/cart/items', {
        method: 'POST',
        headers: shopperHeaders(),
        body: JSON.stringify({ productId, quantity: 1 }),
      });
      expect(cart.status).toBeLessThan(300);
      const placed = await api('/public/orders', {
        method: 'POST',
        headers: shopperHeaders(),
        body: JSON.stringify({
          paymentMethod: 'fawry',
          shippingAddress: {
            firstName: 'Fawry',
            lastName: 'Shopper',
            address1: '1 Test St',
            city: 'Cairo',
            phone: '+201000000001',
            email: 'fawry-shopper@exit-test.invalid',
            country: 'EG',
          },
        }),
      });
      expect(placed.status, await placed.clone().text()).toBeLessThan(300);
      const pj = (await placed.json()) as { data: { id?: string; order?: { id: string } } };
      const orderId = pj.data.order?.id ?? pj.data.id!;
      const create = () =>
        api('/payments/create', {
          method: 'POST',
          headers: shopperHeaders(),
          body: JSON.stringify({ orderId, provider: 'fawry', method: 'payatfawry' }),
        });
      const a = await create();
      const at = await a.text();
      expect(a.status, at).toBe(200);
      const first = JSON.parse(at).data as { instruction?: { kind: string; code: string } };
      expect(first.instruction?.kind).toBe('reference-code');
      const b = await create();
      expect(b.status, await b.clone().text()).toBe(200);
      const second = ((await b.json()) as { data: { instruction?: { code: string } } }).data;
      expect(second.instruction?.code).toBe(first.instruction!.code);
      expect(await payments(storeId, orderId)).toHaveLength(1);
    }, 60_000);

    it('refund and retry entry points resolve and read the payment on the DO (no Postgres reach)', async () => {
      const o = await placeOrder('paymob');
      const ref = `RF-${o.id.slice(0, 8)}`;
      await gatewayPayment(o.id, 'paymob', ref, o.total);
      await pgReaches(true);
      const refund = await api('/payments/refund', {
        method: 'POST',
        headers: suHeaders(),
        body: JSON.stringify({ transactionId: ref, provider: 'paymob', amount: 100 }),
      });
      const rj = (await refund.json()) as { error?: { code?: string } };
      expect(rj.error?.code).not.toBe('POSTGRES_REMOVED');
      expect(rj.error?.code).not.toBe('NOT_FOUND');
      const unknown = await api('/payments/refund', {
        method: 'POST',
        headers: suHeaders(),
        body: JSON.stringify({ transactionId: 'no-such-ref', provider: 'paymob' }),
      });
      expect(unknown.status).toBe(404);
      const retry = await api(`/payments/retry/${crypto.randomUUID()}`, {
        method: 'POST',
        headers: suHeaders(),
        body: '{}',
      });
      expect(retry.status).toBe(404);
      expect(await pgReaches(true)).toEqual([]);
    }, 60_000);
  }
);
