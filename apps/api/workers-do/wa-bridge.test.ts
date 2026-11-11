import { describe, expect, it, vi } from 'vitest';
import { env, applyD1Migrations, runInDurableObject } from 'cloudflare:test';
import type { StoreDO } from '../src/cf/store-do/store-do';
import { setCfBindings, type CfBindings } from '../src/cf/bindings';

// WA-RPC (audit): the REAL do-port against a REAL StoreDO on workerd. Proves createOrderFromChat idempotency (one order, one stock
// movement, however often the key replays), stock refusal, recordCodOutcome (confirm / refuse / no_reply / replay / late refusal
// never undoes a confirmed order), tenant isolation, addresses (find-or-create, idempotent) and the gate.
const sent: Array<{ name: string }> = [];
vi.mock('../src/lib/inngest/client', async orig => {
  const real = (await orig()) as { inngest: Record<string, unknown> };
  return {
    ...real,
    inngest: new Proxy(real.inngest, {
      get: (t, k) =>
        k === 'send'
          ? async (e: { name: string }) => {
              sent.push(e);
            }
          : t[k as string],
    }),
  };
});
vi.mock('../src/lib/derived-secret', () => ({ derivedSecret: () => Buffer.alloc(32, 7) }));
// plan feature flags are read from the platform tables, which this DB-less lane does not stand up (not the code under test)
vi.mock('../src/services/feature.service', async orig => {
  const real = (await orig()) as Record<string, unknown>;
  const stub = { isFeatureEnabled: async () => true, getStoreFeatures: async () => ({}) };
  return { ...real, FeatureService: stub, featureService: stub };
});
const seen = new Set<string>();
vi.mock('../src/services/redis.service', () => ({
  redis: {
    exists: async (k: string) => (seen.has(k) ? 1 : 0),
    set: async (k: string) => {
      seen.add(k);
      return 'OK';
    },
  },
}));

import { createPostgresRemovedClient, runWithRequestDb } from '@ebda/database';
import { createBridge } from '../src/lib/wa/bridge/service';
import { redeemWaCheckout } from '../src/lib/wa/bridge/redeem';
import { createDoPort } from '../src/lib/wa/bridge/do-port';

const e = env as unknown as {
  PLATFORM_DB: D1Database;
  TEST_PLATFORM_MIGRATIONS: unknown[];
  STORE_DO: DurableObjectNamespace<StoreDO>;
};
const A = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
const B = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
const BK = 'e8771d4105457e95d06a8589827d6c09043f73bb1750f2ef525bccbc22d67edd';
const buyer = {
  buyerKey: BK,
  phoneE164: '+201001234567',
  name: 'Mona Adel',
  locale: 'ar' as const,
};
const stub = (id: string) => e.STORE_DO.get(e.STORE_DO.idFromName(id));
const sql = <T>(id: string, q: string, ...a: unknown[]) =>
  runInDurableObject(stub(id), (_i, s) => s.storage.sql.exec(q, ...a).toArray() as T[]);
const num = async (id: string, q: string) => (await sql<{ n: number }>(id, q))[0]!.n;
// Calls run inside the same request wrapper the Worker uses (worker.ts withWorkerContext): any Prisma call is POSTGRES_REMOVED.
const inner = createBridge({
  port: createDoPort(),
  storefrontUrl: async () => 'https://shop.example',
});
const bridge = () =>
  new Proxy(inner, {
    get:
      (t, k) =>
      (...a: unknown[]) =>
        runWithRequestDb(
          () => createPostgresRemovedClient(() => undefined),
          () =>
            (t as never as Record<string, (...x: unknown[]) => Promise<unknown>>)[k as string]!(
              ...a
            )
        ),
  }) as typeof inner;

async function seedStore(id: string, slug: string, stock: number) {
  const T = Date.now();
  await e.PLATFORM_DB.prepare(
    "INSERT INTO stores (id, name, slug, owner_id, storage_backend, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'owner', 'do', 'active', ?4, ?4)"
  )
    .bind(id, `Shop ${slug}`, slug, T)
    .run();
  await stub(id).seed({
    store: { id, slug, name: `Shop ${slug}`, currency: 'EGP', createdAt: T, updatedAt: T },
    products: [
      {
        id: `${slug}-p1`,
        storeId: id,
        name: 'Widget',
        slug: 'widget',
        price: 10000,
        inventory: stock,
        status: 'active',
        hasVariants: false,
        createdAt: T,
        updatedAt: T,
      },
    ],
  });
  await sql(
    id,
    "INSERT OR IGNORE INTO store_profile (store_id, name, slug, owner_id) VALUES (?, 'Shop', ?, 'owner')",
    id,
    slug
  );
  await sql(
    id,
    "INSERT INTO store_whatsapp_links (store_id, linked, entitlement_automation, entitlement_status, entitlement_valid_until) VALUES (?, 1, 1, 'active', ?)",
    id,
    Date.now() + 86_400_000
  );
  for (const [p, extra] of [
    ['cod', '{}'],
    ['instapay', '{"handle":"shop@instapay","accountName":"Shop"}'],
  ] as const)
    await sql(
      id,
      'INSERT INTO payment_configs (id, store_id, provider, is_enabled, settings) VALUES (?, ?, ?, 1, ?)',
      `pc-${p}-${id}`,
      id,
      p,
      extra
    );
}

describe('WhatsAppBridge on a real StoreDO', () => {
  it('fixture: two stores, one with 3 in stock', async () => {
    setCfBindings(e as unknown as CfBindings);
    await applyD1Migrations(e.PLATFORM_DB, e.TEST_PLATFORM_MIGRATIONS as never);
    await seedStore(A, 'shop-a', 3);
    await seedStore(B, 'shop-b', 50);
  });

  it('profile + catalog come from the store; an unknown store is not_found and an unlinked one not_linked', async () => {
    const b = bridge();
    const p = await b.getStoreProfile(A);
    expect(p).toMatchObject({
      ok: true,
      value: {
        name: 'Shop shop-a',
        currency: 'EGP',
        codEnabled: true,
        paymentMethods: ['cod', 'instapay'],
      },
    });
    const cat = await b.listCatalog(A, null, 10);
    expect(cat.ok && cat.value.items.map(i => i.priceMinor)).toEqual([10000]);
    expect(await b.getStoreProfile('0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c')).toMatchObject({
      ok: false,
      reason: 'not_found',
    });
    await sql(B, 'UPDATE store_whatsapp_links SET linked = 0');
    expect(await b.getStoreProfile(B)).toMatchObject({ ok: false, reason: 'not_linked' });
    await sql(B, 'UPDATE store_whatsapp_links SET linked = 1');
  });

  it("createOrderFromChat: the same key five times, concurrently, is ONE order and ONE stock movement; the total is the Store's", async () => {
    const b = bridge();
    const req = {
      items: [{ variantId: 'shop-a-p1', quantity: 2 }],
      buyer,
      address: { area: 'Maadi', street: '9 Road 233' },
      paymentMethod: 'cod',
      idempotencyKey: 'idem-key-aaaa1',
    };
    const answers = await Promise.all(
      Array.from({ length: 5 }, () => b.createOrderFromChat(A, req))
    );
    const ids = new Set(answers.map(a => (a.ok ? a.value.orderId : a.reason)));
    expect(ids.size).toBe(1);
    expect(answers[0]).toMatchObject({ ok: true, value: { totalMinor: expect.any(Number) } });
    expect(await num(A, 'SELECT count(*) AS n FROM orders')).toBe(1);
    expect(await num(A, 'SELECT inventory AS n FROM products')).toBe(1);
    expect(await num(A, 'SELECT count(*) AS n FROM inventory_history')).toBe(1);
    expect(
      (
        await sql<{ source: string; payment_status: string }>(
          A,
          'SELECT source, payment_status FROM orders'
        )
      )[0]
    ).toMatchObject({ source: 'whatsapp', payment_status: 'unpaid' });
    expect(sent.some(x => x.name === 'order/created')).toBe(true);
  });

  it('stock: the last unit goes to exactly one of two concurrent orders, the other is out_of_stock and takes nothing', async () => {
    const b = bridge();
    const mk = (k: string) =>
      b.createOrderFromChat(A, {
        items: [{ variantId: 'shop-a-p1', quantity: 1 }],
        buyer,
        address: { area: 'x', street: 'y' },
        paymentMethod: 'cod',
        idempotencyKey: k,
      });
    const [r1, r2] = await Promise.all([mk('idem-key-bbbb1'), mk('idem-key-bbbb2')]);
    expect([r1.ok, r2.ok].sort()).toEqual([false, true]);
    const lost = (r1.ok ? r2 : r1) as { reason: string; outOfStock?: string[] };
    expect(lost).toMatchObject({ reason: 'out_of_stock', outOfStock: ['shop-a-p1'] });
    expect(await num(A, 'SELECT inventory AS n FROM products')).toBe(0);
    expect(await num(A, 'SELECT count(*) AS n FROM orders')).toBe(2);
  });

  it('a disabled payment method is refused without writing', async () => {
    const r = await bridge().createOrderFromChat(B, {
      items: [{ variantId: 'shop-b-p1', quantity: 1 }],
      buyer,
      address: { area: 'x', street: 'y' },
      paymentMethod: 'link',
      idempotencyKey: 'idem-key-cccc1',
    });
    expect(r).toMatchObject({ ok: false, reason: 'payment_method_disabled' });
    expect(await num(B, 'SELECT count(*) AS n FROM orders')).toBe(0);
  });

  it('recordCodOutcome: confirm moves pending to confirmed once; a replay is a no-op; a refusal cancels once and restocks once', async () => {
    const b = bridge();
    const first = (
      await sql<{ id: string; order_number: string }>(
        A,
        'SELECT id, order_number FROM orders ORDER BY created_at LIMIT 1'
      )
    )[0]!;
    // make the order older than the answer (the consumer ignores an answer that predates the order)
    const at = new Date(Date.now() + 5000).toISOString();
    const r = await b.recordCodOutcome(A, {
      orderId: first.id,
      outcome: 'confirmed',
      at,
      idempotencyKey: 'idem-cod-0001',
    });
    expect(r).toEqual({ ok: true, value: { orderNumber: first.order_number } });
    expect(
      (await sql<{ status: string }>(A, 'SELECT status FROM orders WHERE id = ?', first.id))[0]!
        .status
    ).toBe('confirmed');
    expect(
      await b.recordCodOutcome(A, {
        orderId: first.id,
        outcome: 'confirmed',
        at,
        idempotencyKey: 'idem-cod-0001',
      })
    ).toEqual(r);
    await b.recordCodOutcome(A, {
      orderId: first.id,
      outcome: 'refused',
      at,
      idempotencyKey: 'idem-cod-0002',
    });
    // a refusal on a confirmed, still-unshipped, unpaid COD order cancels it and puts the 2 units back ONCE; a second refusal is a no-op
    expect(
      (await sql<{ status: string }>(A, 'SELECT status FROM orders WHERE id = ?', first.id))[0]!
        .status
    ).toBe('cancelled');
    expect(await num(A, 'SELECT inventory AS n FROM products')).toBe(2);
    await b.recordCodOutcome(A, {
      orderId: first.id,
      outcome: 'refused',
      at,
      idempotencyKey: 'idem-cod-0003',
    });
    expect(await num(A, 'SELECT inventory AS n FROM products')).toBe(2);
    // a confirmation arriving after the cancel does not resurrect it
    await b.recordCodOutcome(A, {
      orderId: first.id,
      outcome: 'confirmed',
      at,
      idempotencyKey: 'idem-cod-0006',
    });
    expect(
      (await sql<{ status: string }>(A, 'SELECT status FROM orders WHERE id = ?', first.id))[0]!
        .status
    ).toBe('cancelled');
  });

  it('recordCodOutcome: no_reply changes nothing; an order of another store is not_found (tenant isolation)', async () => {
    const b = bridge();
    const o = (
      await sql<{ id: string }>(A, "SELECT id FROM orders WHERE status = 'pending' LIMIT 1")
    )[0]!;
    await b.recordCodOutcome(A, {
      orderId: o.id,
      outcome: 'no_reply',
      at: new Date(Date.now() + 5000).toISOString(),
      idempotencyKey: 'idem-cod-0004',
    });
    expect(
      (await sql<{ status: string }>(A, 'SELECT status FROM orders WHERE id = ?', o.id))[0]!.status
    ).toBe('pending');
    expect(
      await b.recordCodOutcome(B, {
        orderId: o.id,
        outcome: 'refused',
        at: new Date().toISOString(),
        idempotencyKey: 'idem-cod-0005',
      })
    ).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await b.getOrderStatus(B, 'whatever', BK)).toMatchObject({
      ok: false,
      reason: 'not_found',
    });
  });

  it('addresses: saved find-or-create by buyer key, idempotent, tenant-scoped; the inline order address is remembered', async () => {
    const b = bridge();
    const a1 = await b.saveCustomerAddress(B, BK, {
      label: 'Work',
      area: 'Zamalek',
      street: '1 Brazil St',
    });
    const a2 = await b.saveCustomerAddress(B, BK, {
      label: 'Work',
      area: 'Zamalek',
      street: '1 Brazil St',
    });
    expect(a1.ok && a2.ok && a1.value.address.id === a2.value.address.id).toBe(true);
    expect(await num(B, 'SELECT count(*) AS n FROM customers WHERE buyer_key IS NOT NULL')).toBe(1);
    expect(await b.getCustomerAddresses(B, BK)).toMatchObject({
      ok: true,
      value: { items: [{ area: 'Zamalek' }] },
    });
    // store A got the buyer's address from the order placed there, store B's data is not visible in A
    const inA = await b.getCustomerAddresses(A, BK);
    expect(inA.ok && inA.value.items.map(i => i.area)).toEqual(
      expect.not.arrayContaining(['Zamalek'])
    );
    // an order by saved addressId
    const ord = await b.createOrderFromChat(B, {
      items: [{ variantId: 'shop-b-p1', quantity: 1 }],
      buyer,
      addressId: a1.ok ? a1.value.address.id : '',
      paymentMethod: 'instapay',
      idempotencyKey: 'idem-key-dddd1',
    });
    expect(ord).toMatchObject({ ok: true, value: { instapay: { ipa: 'shop@instapay' } } });
    const st = await b.listCustomerOrders(B, BK, 5);
    expect(st.ok && st.value.items.length).toBe(1);
    expect(
      await b.getOrderStatus(B, ord.ok ? ord.value.orderNumber : '', 'f'.repeat(64))
    ).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('checkout link (WA-RPC-F1): redeems into a session cart once, re-priced by the Store; a replay adds nothing; another store or a forged token is refused', async () => {
    const link = await bridge().createCheckoutLink(B, {
      items: [{ variantId: 'shop-b-p1', quantity: 2 }],
      buyer,
    });
    expect(link.ok).toBe(true);
    const token = new URL(
      (link as { value: { checkoutUrl: string } }).value.checkoutUrl
    ).searchParams.get('t')!;
    const run = <T>(f: () => Promise<T>) =>
      runWithRequestDb(() => createPostgresRemovedClient(() => undefined), f);
    const first = await run(() => redeemWaCheckout(B, token, 'sess-1'));
    expect(first).toEqual({ redeemed: true, added: 1, unavailable: 0 });
    expect(await run(() => redeemWaCheckout(B, token, 'sess-1'))).toEqual({
      redeemed: true,
      added: 0,
      unavailable: 0,
    });
    expect(await num(B, 'SELECT count(*) AS n FROM cart_items')).toBe(1);
    expect(await num(B, 'SELECT quantity AS n FROM cart_items')).toBe(2);
    expect(await run(() => redeemWaCheckout(A, token, 'sess-2'))).toEqual({
      redeemed: false,
      reason: 'invalid',
    });
    expect(await run(() => redeemWaCheckout(B, token.slice(0, -3) + 'AAA', 'sess-3'))).toEqual({
      redeemed: false,
      reason: 'invalid',
    });
  });
});
